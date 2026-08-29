/**
 * Tests for the single notes gate.
 *
 * Regression coverage for a divergence bug: the rule "are notes enabled for
 * this request" was computed independently in four places, and the copy in
 * `chat-handler.ts` that guarded per-message note injection omitted the
 * plan/mode condition. A free Ask-mode user therefore got a contradictory
 * state — the system prompt said notes were disabled, the 4 note tools were
 * not registered, yet their notes were still injected into the last user
 * message. These cases pin the rule so the copies cannot drift again.
 */
import { areNotesEnabled } from "@/lib/notes/gate";
import type { SubscriptionTier } from "@/types/chat";

const PAID_TIERS: SubscriptionTier[] = ["pro", "pro-plus", "ultra", "team"];

describe("areNotesEnabled", () => {
  describe("plan and mode availability", () => {
    it("disables notes for free users in ask mode", () => {
      // The exact case that was broken: this must be false so the prompt,
      // the tool registry, and message injection all agree.
      expect(areNotesEnabled("ask", "free", undefined)).toBe(false);
    });

    it("enables notes for free users in agent mode", () => {
      // Agent mode relies on notes to carry state across a long run, so they
      // are available regardless of plan.
      expect(areNotesEnabled("agent", "free", undefined)).toBe(true);
    });

    it("enables notes for every paid tier in both modes", () => {
      for (const tier of PAID_TIERS) {
        expect(areNotesEnabled("ask", tier, undefined)).toBe(true);
        expect(areNotesEnabled("agent", tier, undefined)).toBe(true);
      }
    });
  });

  describe("user toggle", () => {
    it("defaults to enabled when the preference is absent", () => {
      expect(areNotesEnabled("agent", "pro", undefined)).toBe(true);
      expect(areNotesEnabled("agent", "pro", null)).toBe(true);
      expect(areNotesEnabled("agent", "pro", {})).toBe(true);
      expect(areNotesEnabled("agent", "pro", { include_notes: undefined })).toBe(
        true,
      );
    });

    it("respects an explicit opt-out even on a paid plan", () => {
      expect(areNotesEnabled("ask", "ultra", { include_notes: false })).toBe(
        false,
      );
      expect(areNotesEnabled("agent", "ultra", { include_notes: false })).toBe(
        false,
      );
    });

    it("respects an explicit opt-in", () => {
      expect(areNotesEnabled("agent", "pro", { include_notes: true })).toBe(
        true,
      );
    });

    it("keeps notes off for free ask mode even when opted in", () => {
      // The toggle cannot grant access the plan does not include.
      expect(areNotesEnabled("ask", "free", { include_notes: true })).toBe(
        false,
      );
    });
  });
});
