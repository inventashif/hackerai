import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export type KiroAuthMethod = "api_key" | "oauth";

export interface KiroAuthState {
  method: KiroAuthMethod;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  region: string;
  profileArn?: string;
}

function fingerprint(): string {
  try {
    const host = os.hostname();
    const user = os.userInfo().username;
    return crypto.createHash("sha256").update(`${host}-${user}-kiro-gateway`).digest("hex").slice(0, 16);
  } catch {
    return crypto.createHash("sha256").update("default-kiro-gateway").digest("hex").slice(0, 16);
  }
}

export const KIRO_FINGERPRINT = fingerprint();

async function readSqliteToken(): Promise<KiroAuthState | null> {
  const dbPath =
    process.env.KIRO_DB_PATH?.trim() ||
    process.env.KIRO_CLI_DB_FILE?.trim() ||
    path.join(os.homedir(), ".local", "share", "kiro-cli", "data.sqlite3");

  try {
    await fs.access(dbPath);
  } catch {
    return null;
  }

  // Use better-sqlite3 if available, otherwise try sqlite via exec
  try {
    // Runtime-only import to avoid a hard dependency and Turbopack resolution warning.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as any;
    const db = new Database(dbPath, { readonly: true });
    const keys = ["kirocli:social:token", "kirocli:odic:token", "codewhisperer:odic:token"];
    for (const key of keys) {
      const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(key) as { value: string } | undefined;
      if (row?.value) {
        const data = JSON.parse(row.value);
        const expiresAt = data.expires_at ? new Date(data.expires_at) : undefined;
        db.close();
        return {
          method: "oauth",
          accessToken: data.access_token ?? data.accessToken,
          refreshToken: data.refresh_token ?? data.refreshToken,
          expiresAt,
          region: data.region || "us-east-1",
          profileArn: data.profile_arn ?? data.profileArn,
        };
      }
    }
    db.close();
  } catch {
    // Fallback: try python sqlite read
    try {
      const { execSync } = await import("node:child_process");
      const out = execSync(
        `python3 -c "import sqlite3, json, sys; db=sqlite3.connect('${dbPath.replace(/'/g, "'\"'\"'")}'); c=db.cursor();\nfor k in ['kirocli:social:token','kirocli:odic:token','codewhisperer:odic:token']:\n c.execute('SELECT value FROM auth_kv WHERE key=?',(k,))\n r=c.fetchone()\n if r:\n  print(r[0])\n  sys.exit(0)\n"`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      if (out) {
        const data = JSON.parse(out);
        return {
          method: "oauth",
          accessToken: data.access_token ?? data.accessToken,
          refreshToken: data.refresh_token ?? data.refreshToken,
          expiresAt: data.expires_at ? new Date(data.expires_at) : undefined,
          region: data.region || "us-east-1",
          profileArn: data.profile_arn ?? data.profileArn,
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function resolveKiroAuth(): Promise<KiroAuthState | null> {
  const apiKey = process.env.KIRO_API_KEY?.trim();
  if (apiKey && apiKey.startsWith("ksk_")) {
    return {
      method: "api_key",
      accessToken: apiKey,
      region: process.env.KIRO_REGION?.trim() || process.env.KIRO_API_REGION?.trim() || "us-east-1",
    };
  }
  const sqlite = await readSqliteToken();
  if (sqlite) return sqlite;
  // Also support direct refresh token env
  const refreshToken = process.env.KIRO_REFRESH_TOKEN?.trim();
  if (refreshToken) {
    return {
      method: "oauth",
      accessToken: process.env.KIRO_ACCESS_TOKEN?.trim() || "",
      refreshToken,
      region: process.env.KIRO_REGION?.trim() || "us-east-1",
      profileArn: process.env.KIRO_PROFILE_ARN?.trim(),
    };
  }
  return null;
}

export function getKiroEndpoint(region: string, method: KiroAuthMethod): string {
  if (method === "api_key") {
    return `https://q.${region}.amazonaws.com`;
  }
  return `https://runtime.${region}.kiro.dev`;
}

export function buildKiroHeaders(auth: KiroAuthState): Record<string, string> {
  const fp = KIRO_FINGERPRINT;
  const base: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": "attempt=1; max=3",
  };
  if (auth.method === "api_key") {
    return {
      ...base,
      tokentype: "API_KEY",
      "Content-Type": "application/json",
      "User-Agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${fp}`,
      "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${fp}`,
    };
  }
  return {
    ...base,
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/win32#10.0.19044 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-${fp}`,
    "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${fp}`,
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
  };
}

export function isTokenExpired(auth: KiroAuthState, skewMs = 10 * 60 * 1000): boolean {
  if (!auth.expiresAt) return false;
  return Date.now() + skewMs >= auth.expiresAt.getTime();
}

export async function refreshKiroToken(auth: KiroAuthState): Promise<KiroAuthState | null> {
  if (auth.method === "api_key" || !auth.refreshToken) return null;
  const region = auth.region;
  // Detect social vs SSO by presence of clientId in DB (we don't have it here)
  // Try social first (Kiro Desktop Auth), then SSO
  const socialUrl = `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
  try {
    const res = await fetch(socialUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });
    if (res.ok) {
      const data = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresAt?: string };
      if (data.accessToken) {
        return {
          ...auth,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? auth.refreshToken,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : auth.expiresAt,
        };
      }
    }
  } catch {
    // fall through to SSO attempt
  }
  // SSO OIDC attempt would need clientId/clientSecret from DB; not available via this path
  return null;
}
