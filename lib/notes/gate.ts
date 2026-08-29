import type { ChatMode, SubscriptionTier } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";

/**
 * Minimal structural shape needed from `UserCustomization`. Kept narrow rather
 * than importing the full type so this module stays dependency-light and safe
 * to import from prompt building, the chat route, and Trigger.dev tasks alike.
 */
type NotesPreference = { readonly include_notes?: boolean } | null | undefined;

/**
 * Single source of truth for "are the note tools active for this request".
 *
 * Two independent conditions:
 *   1. Plan/mode availability — notes are a paid feature in Ask mode, but
 *      available to everyone in Agent mode (the agent relies on them to carry
 *      state across a long run).
 *   2. The user's own `include_notes` toggle, which defaults on.
 *
 * This must gate the tool registry, the system-prompt section, AND the
 * per-message note injection together. They previously computed the rule
 * separately, and a free Ask-mode user hit a contradictory state: the prompt
 * said "the notes tool is disabled", the 4 tools were absent, yet their notes
 * were still injected into the last user message — so the model was handed
 * content it had no way to act on.
 */
export function areNotesEnabled(
  mode: ChatMode,
  subscription: SubscriptionTier,
  userCustomization: NotesPreference,
): boolean {
  const availableForPlanAndMode =
    subscription !== "free" || isAgentMode(mode);

  return availableForPlanAndMode && (userCustomization?.include_notes ?? true);
}
