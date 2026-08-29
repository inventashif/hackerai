import {
  isE2BDisabled,
  isInProcessAgentEnabled,
  isOpenCodeZenEnabled,
  isPersonalMode,
} from "../personal-mode";

describe("personal mode flags", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PERSONAL_MODE;
    delete process.env.NEXT_PUBLIC_PERSONAL_MODE;
    delete process.env.DISABLE_E2B;
    delete process.env.NEXT_PUBLIC_DISABLE_E2B;
    delete process.env.OPENCODE_ZEN_API_KEY;
    delete process.env.OPENCODE_ZEN_ENABLED;
    delete process.env.PERSONAL_IN_PROCESS_AGENT;
    delete process.env.NEXT_PUBLIC_PERSONAL_IN_PROCESS_AGENT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("is off by default", () => {
    expect(isPersonalMode()).toBe(false);
    expect(isE2BDisabled()).toBe(false);
    expect(isInProcessAgentEnabled()).toBe(false);
    expect(isOpenCodeZenEnabled()).toBe(false);
  });

  it("enables the local-only stack from PERSONAL_MODE", () => {
    process.env.PERSONAL_MODE = "true";
    expect(isPersonalMode()).toBe(true);
    expect(isE2BDisabled()).toBe(true);
    expect(isInProcessAgentEnabled()).toBe(true);
  });

  it("treats an OpenCode Zen key as enabled", () => {
    process.env.OPENCODE_ZEN_API_KEY = "zen-test-key";
    expect(isOpenCodeZenEnabled()).toBe(true);
  });
});
