import {
  canUseExtraUsage,
  canUseMaxModel,
  coerceSelectedModel,
  isKiroModel,
  isSelectedModel,
  normalizeMaxModelForSubscription,
  normalizeSelectedModelForSubscription,
  normalizeSelectedModelOverrideForSubscription,
  withExtraUsageBillingForModel,
} from "../chat";

describe("Kiro gateway model ids", () => {
  it("recognizes prefixed ids so new gateway models need no code change", () => {
    expect(isKiroModel("kiro-claude-opus-5")).toBe(true);
    expect(isKiroModel("kiro-qwen3-coder-next")).toBe(true);
    // Not in the static catalog, but still valid via the prefix rule.
    expect(isKiroModel("kiro-some-future-model")).toBe(true);
  });

  it("rejects the bare prefix and unrelated ids", () => {
    expect(isKiroModel("kiro-")).toBe(false);
    expect(isKiroModel("kiro")).toBe(false);
    expect(isKiroModel("hackerai-pro")).toBe(false);
    expect(isKiroModel("deepseek-v4-flash-free")).toBe(false);
    expect(isKiroModel(null)).toBe(false);
  });

  it("survives a coerce round-trip instead of falling back to auto", () => {
    // Regression: these ids previously returned null and callers reset to "auto",
    // so a Kiro selection could never persist.
    expect(coerceSelectedModel("kiro-claude-opus-5")).toBe("kiro-claude-opus-5");
    expect(coerceSelectedModel("kiro-auto")).toBe("kiro-auto");
    expect(isSelectedModel("kiro-claude-sonnet-4.5")).toBe(true);
  });

  it("still rejects unrecognized values", () => {
    expect(coerceSelectedModel("kiro-")).toBeNull();
    expect(coerceSelectedModel("totally-unknown")).toBeNull();
    // Prototype keys must not leak through via `in`.
    expect(coerceSelectedModel("toString")).toBeNull();
    expect(coerceSelectedModel("constructor")).toBeNull();
  });
});

describe("normalizeSelectedModelForSubscription", () => {
  it("forces free users to auto even when a paid model is stored", () => {
    expect(normalizeSelectedModelForSubscription("hackerai-pro", "free")).toBe(
      "auto",
    );
    expect(normalizeSelectedModelForSubscription("hackerai-max", "free")).toBe(
      "auto",
    );
  });

  it("preserves paid users' selected model and defaults missing values to auto", () => {
    expect(normalizeSelectedModelForSubscription("hackerai-pro", "pro")).toBe(
      "hackerai-pro",
    );
    expect(normalizeSelectedModelForSubscription("hackerai-max", "ultra")).toBe(
      "hackerai-max",
    );
    expect(normalizeSelectedModelForSubscription(null, "ultra")).toBe("auto");
    expect(normalizeSelectedModelForSubscription(undefined, "team")).toBe(
      "auto",
    );
  });

  it("preserves paid Max until entitlement-aware routing", () => {
    expect(normalizeSelectedModelForSubscription("hackerai-max", "pro")).toBe(
      "hackerai-max",
    );
    expect(
      normalizeSelectedModelForSubscription("hackerai-max", "pro-plus"),
    ).toBe("hackerai-max");
    expect(normalizeSelectedModelForSubscription("hackerai-max", "team")).toBe(
      "hackerai-max",
    );
  });
});

describe("normalizeSelectedModelOverrideForSubscription", () => {
  it("forces free users to auto even when no override was sent", () => {
    expect(normalizeSelectedModelOverrideForSubscription(null, "free")).toBe(
      "auto",
    );
    expect(
      normalizeSelectedModelOverrideForSubscription(undefined, "free"),
    ).toBe("auto");
  });

  it("preserves missing paid overrides as undefined", () => {
    expect(
      normalizeSelectedModelOverrideForSubscription(undefined, "pro"),
    ).toBeUndefined();
    expect(
      normalizeSelectedModelOverrideForSubscription(null, "ultra"),
    ).toBeUndefined();
  });

  it("preserves explicit paid overrides until entitlement-aware routing", () => {
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-max", "ultra"),
    ).toBe("hackerai-max");
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-max", "team"),
    ).toBe("hackerai-max");
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-pro", "team"),
    ).toBe("hackerai-pro");
  });
});

describe("Max model entitlement helpers", () => {
  it("allows Max for Ultra users", () => {
    expect(canUseMaxModel("ultra")).toBe(true);
  });

  it("allows Max for paid users with usable extra usage", () => {
    const extraUsageConfig = {
      enabled: true,
      hasBalance: true,
      balanceDollars: 10,
      autoReloadEnabled: false,
    };

    expect(canUseExtraUsage(extraUsageConfig)).toBe(true);
    expect(canUseMaxModel("pro", { extraUsageConfig })).toBe(true);
    expect(
      normalizeMaxModelForSubscription("hackerai-max", "pro", {
        extraUsageConfig,
      }),
    ).toBe("hackerai-max");
  });

  it("downgrades Max for paid users without usable extra usage", () => {
    expect(canUseMaxModel("pro")).toBe(false);
    expect(normalizeMaxModelForSubscription("hackerai-max", "pro")).toBe(
      "hackerai-pro",
    );
    expect(
      normalizeMaxModelForSubscription("hackerai-max", "pro-plus", {
        extraUsageConfig: {
          enabled: true,
          hasBalance: true,
          balanceDollars: 10,
          autoReloadEnabled: false,
          monthlyRemainingDollars: 0,
        },
      }),
    ).toBe("hackerai-pro");
  });

  it("bills Max entirely through Extra Usage outside Ultra", () => {
    const extraUsageConfig = {
      enabled: true,
      hasBalance: true,
      autoReloadEnabled: false,
    };

    expect(
      withExtraUsageBillingForModel(
        extraUsageConfig,
        "hackerai-max",
        "pro-plus",
      ),
    ).toEqual({
      ...extraUsageConfig,
      chargeAllUsage: true,
    });
    expect(
      withExtraUsageBillingForModel(extraUsageConfig, "hackerai-max", "ultra"),
    ).toBe(extraUsageConfig);
    expect(
      withExtraUsageBillingForModel(
        extraUsageConfig,
        "hackerai-pro",
        "pro-plus",
      ),
    ).toBe(extraUsageConfig);
  });
});
