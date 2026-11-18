import { config } from "dotenv";
import { createHash } from "node:crypto";

config({ path: process.env.VERIFY_ENV_FILE, override: true, quiet: true });
const { vmFileUrl } = await import("../lib/file-explorer/vm-storage");
{
  const root = "/home/azureuser/gbbp18-recon/bug-reports";
  const listing = await fetch(vmFileUrl("list", root));
  if (!listing.ok) throw new Error(`VM listing returned ${listing.status}`);
  const { entries } = (await listing.json()) as {
    entries: Array<{ name: string; path: string; type: string }>;
  };
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
}
