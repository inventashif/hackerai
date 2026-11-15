const mockSpawn = jest.fn();

jest.mock(
  "node-pty",
  () => ({
    spawn: (...args: unknown[]) => mockSpawn(...args),
  }),
  { virtual: true },
);

import { ProcessRunner } from "../process-runner";

type ExitListener = (event: { exitCode?: number }) => void;

const makePtyProcess = () => {
  let exitListener: ExitListener | undefined;
  return {
    pid: 1234,
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    onData: jest.fn(),
    onExit: jest.fn((listener: ExitListener) => {
      exitListener = listener;
    }),
    __exit: (exitCode = 0) => exitListener?.({ exitCode }),
  };
};

describe("ProcessRunner cleanup", () => {
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);
    mockSpawn.mockReset();
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("treats ESRCH during stop as an already-stopped process", () => {
    const proc = makePtyProcess();
    proc.kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    mockSpawn.mockReturnValue(proc);

    const runner = new ProcessRunner();
    runner.run("session-1", "echo hi");

    expect(runner.stop("session-1")).toBe(false);
    expect(runner.isRunning("session-1")).toBe(false);
    runner.dispose();
  });

  it("drops local tracking after SIGKILL escalation", () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);

    const runner = new ProcessRunner();
    runner.run("session-1", "sleep 10");

    expect(runner.stop("session-1")).toBe(true);
    jest.advanceTimersByTime(5_000);

    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(runner.isRunning("session-1")).toBe(false);
    runner.dispose();
  });

  it("catches unexpected SIGKILL errors during escalation", () => {
    const proc = makePtyProcess();
    proc.kill.mockImplementation((signal?: string) => {
      if (signal === "SIGKILL") {
        throw new Error("permission denied");
      }
    });
    mockSpawn.mockReturnValue(proc);
    const errorListener = jest.fn();

    const runner = new ProcessRunner();
    runner.on("error", errorListener);
    runner.run("session-1", "sleep 10");

    expect(runner.stop("session-1")).toBe(true);
    expect(() => jest.advanceTimersByTime(5_000)).not.toThrow();

    expect(errorListener).toHaveBeenCalledWith("session-1", expect.any(Error));
    runner.dispose();
  });
});

describe("ProcessRunner status retention", () => {
  let setIntervalSpy: jest.SpyInstance;

  const makeDataPtyProcess = () => {
    let dataListener: ((data: string) => void) | undefined;
    let exitListener: ExitListener | undefined;
    return {
      pid: 1234,
      write: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      onData: jest.fn((listener: (data: string) => void) => {
        dataListener = listener;
      }),
      onExit: jest.fn((listener: ExitListener) => {
        exitListener = listener;
      }),
      __emit: (data: string) => dataListener?.(data),
      __exit: (exitCode = 0) => exitListener?.({ exitCode }),
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);
    mockSpawn.mockReset();
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("reports running status with pid and retained tail", () => {
    const proc = makeDataPtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    runner.run("session-1", "sleep 300");

    proc.__emit("hello\n");

    expect(runner.getStatus("session-1")).toEqual({
      status: "running",
      pid: 1234,
      outputTail: "hello\n",
    });
    runner.dispose();
  });

  it("reports exited status with exit code and tail after exit", () => {
    const proc = makeDataPtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    runner.run("session-1", "echo done");

    proc.__emit("done\n");
    proc.__exit(3);

    expect(runner.getStatus("session-1")).toEqual({
      status: "exited",
      pid: 1234,
      exitCode: 3,
      outputTail: "done\n",
    });
    runner.dispose();
  });

  it("returns unknown for never-seen sessions", () => {
    const runner = new ProcessRunner();
    expect(runner.getStatus("nope")).toEqual({ status: "unknown" });
    runner.dispose();
  });

  it("forgets exited sessions after the retention window", () => {
    const proc = makeDataPtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    runner.run("session-1", "echo done");
    proc.__exit(0);

    expect(runner.getStatus("session-1").status).toBe("exited");
    jest.advanceTimersByTime(30 * 60 * 1000 + 1);

    expect(runner.getStatus("session-1")).toEqual({ status: "unknown" });
    runner.dispose();
  });

  it("caps the retained tail", () => {
    const proc = makeDataPtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    runner.run("session-1", "yes");

    proc.__emit("x".repeat(70 * 1024));
    const status = runner.getStatus("session-1");

    expect(status.status).toBe("running");
    expect(status.outputTail).toHaveLength(16 * 1024);
    runner.dispose();
  });
});
