const mockSet = jest.fn();
const mockGet = jest.fn();
const mockDel = jest.fn();

jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: jest.fn(() => ({
    set: mockSet,
    get: mockGet,
    del: mockDel,
  })),
}));

import {
  deletePtySessionRecord,
  loadPtySessionRecord,
  savePtySessionRecord,
  type PtySessionRecord,
} from "../utils/pty-session-registry";

const record: PtySessionRecord = {
  handleUuid: "uuid-1",
  managerId: "abcd1234",
  chatId: "chat-1",
  sandboxIdentity: "connection:conn-1",
  originalCommand: "sleep 300",
  kind: "command",
  pid: 999,
  createdAt: 1_700_000_000_000,
  cols: 120,
  rows: 30,
};

describe("pty-session-registry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("saves the record under the chat+manager key with a 1h TTL", async () => {
    mockSet.mockResolvedValue("OK");
    await savePtySessionRecord(record);
    expect(mockSet).toHaveBeenCalledWith(
      "pty-session:chat-1:abcd1234",
      record,
      { ex: 3600 },
    );
  });

  it("loads a valid record", async () => {
    mockGet.mockResolvedValue(record);
    await expect(loadPtySessionRecord("chat-1", "abcd1234")).resolves.toEqual(
      record,
    );
    expect(mockGet).toHaveBeenCalledWith("pty-session:chat-1:abcd1234");
  });

  it("returns null for missing or malformed records", async () => {
    mockGet.mockResolvedValueOnce(null);
    await expect(loadPtySessionRecord("chat-1", "nope")).resolves.toBeNull();
    mockGet.mockResolvedValueOnce({ managerId: "x" });
    await expect(loadPtySessionRecord("chat-1", "x")).resolves.toBeNull();
  });

  it("deletes the record", async () => {
    mockDel.mockResolvedValue(1);
    await deletePtySessionRecord("chat-1", "abcd1234");
    expect(mockDel).toHaveBeenCalledWith("pty-session:chat-1:abcd1234");
  });

  it("fails soft when Redis throws", async () => {
    mockSet.mockRejectedValueOnce(new Error("boom"));
    mockGet.mockRejectedValueOnce(new Error("boom"));
    mockDel.mockRejectedValueOnce(new Error("boom"));
    await expect(savePtySessionRecord(record)).resolves.toBeUndefined();
    await expect(loadPtySessionRecord("chat-1", "abcd1234")).resolves.toBeNull();
    await expect(
      deletePtySessionRecord("chat-1", "abcd1234"),
    ).resolves.toBeUndefined();
  });
});
