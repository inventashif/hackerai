#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const readLocalDeployment = () => {
  const fromEnv = process.env.CONVEX_DEPLOYMENT?.trim() || "";
  const envPath = path.join(process.cwd(), ".env.local");
  let fromFile = "";
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf8").match(
      /^CONVEX_DEPLOYMENT=(.*)$/m,
    );
    fromFile = (match?.[1] || "").trim();
    if (
      (fromFile.startsWith('"') && fromFile.endsWith('"')) ||
      (fromFile.startsWith("'") && fromFile.endsWith("'"))
    ) {
      fromFile = fromFile.slice(1, -1);
    }
    fromFile = fromFile.split(/\s+#/)[0].trim();
  }
  return fromFile || fromEnv.split(/\s+#/)[0].trim();
};

const existingDeployment = readLocalDeployment();
if (/^local:[A-Za-z0-9._-]+$/.test(existingDeployment)) {
  console.log(`[convex-local] Using existing ${existingDeployment}`);
  process.exit(0);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const selectArgs = ["exec", "convex", "deployment", "select", "local"];
const createArgs = [
  "exec",
  "convex",
  "deployment",
  "create",
  "local",
  "--select",
];

const replayOutput = (result) => {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
};

const exitForResult = (result, action) => {
  if (result.error) {
    console.error(
      `[convex-local] failed to ${action}: ${result.error.message}`,
    );
    process.exit(1);
  }

  process.exit(result.status ?? 1);
};

const selection = spawnSync(pnpmCommand, selectArgs, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (selection.error) {
  exitForResult(selection, "select the local deployment");
}

if (selection.status === 0) {
  replayOutput(selection);
  process.exit(0);
}

const selectionOutput = `${selection.stdout ?? ""}\n${selection.stderr ?? ""}`;

if (!selectionOutput.includes("No local deployment found.")) {
  replayOutput(selection);
  exitForResult(selection, "select the local deployment");
}

console.log(
  "[convex-local] No local deployment found; creating one for this worktree.",
);

const creation = spawnSync(pnpmCommand, createArgs, {
  stdio: "inherit",
});

exitForResult(creation, "create the local deployment");
