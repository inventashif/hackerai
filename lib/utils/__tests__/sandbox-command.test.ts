import { describe, it, expect } from "@jest/globals";
import {
  LOCAL_CONVEX_URL,
  buildLocalSandboxCommand,
  buildRemoteSandboxCommand,
} from "../sandbox-command";

describe("buildLocalSandboxCommand", () => {
  it("always uses the permanent localhost backend", () => {
    const cmd = buildLocalSandboxCommand("hsb_test123");

    expect(cmd).toContain("--token hsb_test123");
    expect(cmd).toContain(`--convex-url ${LOCAL_CONVEX_URL}`);
    expect(cmd).not.toContain("trycloudflare");
    expect(cmd).not.toContain("--centrifugo-url");
  });
});

describe("buildRemoteSandboxCommand", () => {
  const publicConvex = "https://abc.trycloudflare.com";
  const publicWs = "wss://xyz.trycloudflare.com/connection/websocket";

  it("passes both public callbacks so a remote machine never dials localhost", () => {
    const cmd = buildRemoteSandboxCommand("hsb_test123", publicConvex, publicWs);

    expect(cmd).not.toBeNull();
    expect(cmd).toContain("--token hsb_test123");
    expect(cmd).toContain(`--convex-url ${publicConvex}`);
    expect(cmd).toContain(`--centrifugo-url ${publicWs}`);
    expect(cmd).not.toContain("localhost");
    expect(cmd).not.toContain("127.0.0.1");
  });

  it("uses the published npx package, never a repo-local node path", () => {
    const cmd = buildRemoteSandboxCommand("hsb_test123", publicConvex, publicWs);

    expect(cmd?.startsWith("npx @hackerai/local@latest")).toBe(true);
    expect(cmd).not.toContain("packages/local");
  });

  it("returns null while either tunnel is down", () => {
    expect(buildRemoteSandboxCommand("t", "", publicWs)).toBeNull();
    expect(buildRemoteSandboxCommand("t", publicConvex, "")).toBeNull();
    expect(buildRemoteSandboxCommand("t", "", "")).toBeNull();
  });
});
