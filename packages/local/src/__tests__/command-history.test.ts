import { CommandHistory } from "../command-history";

describe("CommandHistory", () => {
  let history: CommandHistory;

  beforeEach(() => {
    history = new CommandHistory();
  });

  afterEach(() => {
    history.dispose();
    jest.useRealTimers();
  });

  it("reports a running command with its pid and output tail", () => {
    history.start("cmd-1", 4242);
    history.append("cmd-1", "hello ");
    history.append("cmd-1", "world");

    expect(history.getStatus("cmd-1")).toEqual({
      status: "running",
      pid: 4242,
      outputTail: "hello world",
    });
  });

  it("reports an exited command with its exit code and tail", () => {
    history.start("cmd-1", 4242);
    history.append("cmd-1", "done\n");
    history.recordExit("cmd-1", 3);

    expect(history.getStatus("cmd-1")).toEqual({
      status: "exited",
      pid: 4242,
      exitCode: 3,
      outputTail: "done\n",
    });
  });

  it("reports unknown for a command it never saw", () => {
    expect(history.getStatus("cmd-nope")).toEqual({ status: "unknown" });
  });

  it("keeps exited commands queryable for the retention window, then forgets them", () => {
    jest.useFakeTimers();
    history.start("cmd-1", 4242);
    history.append("cmd-1", "out");
    history.recordExit("cmd-1", 0);

    jest.advanceTimersByTime(29 * 60 * 1000);
    expect(history.getStatus("cmd-1").status).toBe("exited");

    jest.advanceTimersByTime(60 * 1000 + 1);
    expect(history.getStatus("cmd-1")).toEqual({ status: "unknown" });
  });

  it("caps the status tail at 16KB", () => {
    history.start("cmd-1", 4242);
    history.append("cmd-1", "x".repeat(100 * 1024));
    history.recordExit("cmd-1", 0);

    const status = history.getStatus("cmd-1");
    expect(status.outputTail).toHaveLength(16 * 1024);
  });

  it("evicts the oldest exited command past the 256 cap", () => {
    for (let i = 0; i < 257; i++) {
      history.start(`cmd-${i}`, 1000 + i);
      history.recordExit(`cmd-${i}`, 0);
    }
    expect(history.getStatus("cmd-0")).toEqual({ status: "unknown" });
    expect(history.getStatus("cmd-256").status).toBe("exited");
  });

  it("never evicts a running command, even past the cap", () => {
    history.start("long-runner", 4242);
    for (let i = 0; i < 300; i++) {
      history.start(`cmd-${i}`, 1000 + i);
      history.recordExit(`cmd-${i}`, 0);
    }
    expect(history.getStatus("long-runner").status).toBe("running");
    // Exited entries still get trimmed: only the newest 255 exited remain.
    expect(history.getStatus("cmd-0")).toEqual({ status: "unknown" });
    expect(history.getStatus("cmd-299").status).toBe("exited");
  });

  it("keeps all running commands queryable when every entry is running", () => {
    for (let i = 0; i < 260; i++) {
      history.start(`cmd-${i}`, 1000 + i);
    }
    expect(history.getStatus("cmd-0").status).toBe("running");
    expect(history.getStatus("cmd-259").status).toBe("running");
  });

  it("restarting a command clears its stale exit state", () => {
    history.start("cmd-1", 1111);
    history.recordExit("cmd-1", 0);
    expect(history.getStatus("cmd-1").status).toBe("exited");

    history.start("cmd-1", 2222);
    expect(history.getStatus("cmd-1")).toEqual({
      status: "running",
      pid: 2222,
    });
  });
});
