import { config } from "dotenv";
import { createHash } from "node:crypto";

config({ path: process.env.VERIFY_ENV_FILE, override: true, quiet: true });
const { openFileSandbox } = await import("../lib/file-explorer/remote-sandbox");
const { vmFileUrl } = await import("../lib/file-explorer/vm-storage");
const sandbox = await openFileSandbox("user_personal_local");
try {
  const root = "/home/azureuser/gbbp18-recon/bug-reports";
  const entries = await sandbox.files.listDetailed(root);
  console.log(
    JSON.stringify({
      directory: root,
      count: entries.length,
      files: entries.map((entry) => entry.name),
    }),
  );
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const response = await fetch(vmFileUrl("read", entry.path));
    if (!response.ok) throw new Error(`VM read returned ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    console.log(
      JSON.stringify({
        name: entry.name,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      }),
    );
  }
} finally {
  await sandbox.close();
}
