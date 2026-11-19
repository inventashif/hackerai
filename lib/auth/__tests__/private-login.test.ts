/** @jest-environment node */
import { scryptSync } from "node:crypto";
import { NextRequest } from "next/server";
import { sameOrigin, verifyLoginCredentials } from "../login-security";
import { POST } from "@/app/api/auth/login/route";
import { handlePersonalProxy } from "../personal-proxy";

// These tests intentionally run the production-cost scrypt derivation.
jest.setTimeout(30_000);

jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("../personal-jwt", () => ({
  signPersonalSessionToken: jest.fn().mockResolvedValue("signed-session"),
  serializePersonalSessionCookie: jest
    .fn()
    .mockReturnValue("hackerai-session=signed-session; HttpOnly; SameSite=Lax"),
  verifyPersonalSessionToken: jest.fn().mockRejectedValue(new Error("invalid")),
  signPersonalAccessToken: jest.fn(),
}));
const { getConvexClient } = jest.requireMock("@/lib/db/convex-client");

describe("private login boundary", () => {
  const original = { ...process.env };
  const mutation = jest.fn();
  beforeAll(() => {
    process.env.PERSONAL_MODE = "true";
    process.env.PERSONAL_JWT_ISSUER = "https://app.example";
    process.env.CONVEX_SERVICE_ROLE_KEY = "unit-test-only";
    process.env.PERSONAL_LOGIN_EMAIL = "owner@example.test";
    const salt = "a".repeat(32);
    process.env.PERSONAL_LOGIN_PASSWORD_HASH = `scrypt$${salt}$${scryptSync("unit-test-password", salt, 64, { N: 65536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 }).toString("hex")}`;
  });
  afterAll(() => {
    process.env = original;
  });
  beforeEach(() => {
    mutation.mockReset();
    getConvexClient.mockReturnValue({ mutation });
    mutation.mockResolvedValue({ allowed: true, retryAfter: 0 });
  });
  function request(body: unknown, origin = "https://app.example") {
    return new NextRequest("https://app.example/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  }
  it("checks the password and account server-side", async () => {
    await expect(
      verifyLoginCredentials("owner@example.test", "unit-test-password"),
    ).resolves.toBe(true);
    await expect(
      verifyLoginCredentials("owner@example.test", "wrong"),
    ).resolves.toBe(false);
    await expect(
      verifyLoginCredentials("other@example.test", "unit-test-password"),
    ).resolves.toBe(false);
    await expect(verifyLoginCredentials({}, [])).resolves.toBe(false);
  });
  it("rejects cross-site and missing origins", () => {
    expect(sameOrigin(request({}, "https://evil.example"))).toBe(false);
    expect(sameOrigin(new Request("https://app.example"))).toBe(false);
  });
  it("rejects bad credentials without issuing cookies", async () => {
    const response = await POST(
      request({ email: "owner@example.test", password: "wrong" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("persists a session before issuing an HttpOnly cookie", async () => {
    const response = await POST(
      request({ email: "owner@example.test", password: "unit-test-password" }),
    );
    expect(response.status).toBe(200);
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await response.json()).toEqual({ success: true });
  });
  it("honors shared throttling and fails closed on storage failure", async () => {
    mutation.mockResolvedValueOnce({ allowed: false, retryAfter: 300 });
    expect((await POST(request({}))).status).toBe(429);
    mutation.mockRejectedValueOnce(new Error("offline"));
    expect((await POST(request({}))).status).toBe(503);
  });
  it.each([
    "/",
    "/c/private-chat",
    "/share/private",
    "/download",
    "/c/private.csv",
    "/api/auth/personal-token",
    "/api/sandbox/files",
    "/api/chat",
  ])("denies anonymous %s and spoofed auth headers", async (path) => {
    const response = await handlePersonalProxy(
      new NextRequest(`https://app.example${path}`, {
        headers: {
          "x-personal-access-token": "spoofed",
          "x-workos-session": "spoofed",
        },
      }),
    );
    expect(response.status).toBe(path.startsWith("/api/") ? 401 : 307);
  });
  it.each(["/signup", "/signup/auth", "/register"])(
    "disables registration %s",
    async (path) => {
      expect(
        (
          await handlePersonalProxy(
            new NextRequest(`https://app.example${path}`),
          )
        ).status,
      ).toBe(404);
    },
  );
});
