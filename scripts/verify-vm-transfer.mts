import { config } from "dotenv";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

config({ path: process.env.VERIFY_ENV_FILE, quiet: true, override: true });
const { vmFileUrl, MAX_VM_UPLOAD_BYTES } =
  await import("../lib/file-explorer/vm-storage");
const sizes = process.argv.includes("--large")
  ? [1024, 6 * 1024 * 1024, MAX_VM_UPLOAD_BYTES]
  : [1024];
for (const size of sizes) {
  const file = `/upload/verification-${crypto.randomUUID()}.bin`;
  const digest = createHash("sha256");
  const block = Buffer.alloc(64 * 1024, 0x5a);
  async function* source() {
    for (let sent = 0; sent < size; sent += block.length) {
      const part = block.subarray(0, Math.min(block.length, size - sent));
      digest.update(part);
      yield part;
    }
  }
  try {
    const response = await fetch(vmFileUrl("write", file, { size }), {
      method: "PUT",
      body: Readable.toWeb(Readable.from(source())) as ReadableStream,
      duplex: "half",
      headers: { "Content-Length": String(size) },
    } as RequestInit);
    assert.equal(response.status, 200, "Upload must be acknowledged by VM");
    const stat = await fetch(vmFileUrl("stat", file), { method: "HEAD" });
    assert.equal(stat.status, 200);
    assert.equal(Number(stat.headers.get("content-length")), size);
    const read = await fetch(vmFileUrl("read", file));
    assert.equal(read.status, 200);
    const downloaded = createHash("sha256");
    let received = 0;
    for await (const part of read.body!) {
      received += part.length;
      downloaded.update(part);
    }
    assert.equal(received, size);
    const expected = digest.digest("hex");
    assert.equal(downloaded.digest("hex"), expected);
    console.log(
      JSON.stringify({
        bytes: size,
        upload: "acknowledged",
        VMSize: "matched",
        downloadSHA256: expected,
      }),
    );
  } finally {
    const deleted = await fetch(vmFileUrl("delete", file), {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
  }
}
assert.throws(() =>
  vmFileUrl("write", "/upload/oversized-test", {
    size: MAX_VM_UPLOAD_BYTES + 1,
  }),
);
console.log("Over-500-MB ticket rejected; verification files deleted.");
