import type { ReasoningTier } from "@/types/chat";

export function getReasoningSection(tier: ReasoningTier): string {
  switch (tier) {
    case "quick":
      return `<reasoning_depth>quick</reasoning_depth>
Quick reasoning: Be concise and direct. Give the best useful answer with minimal deliberation. Skip edge cases unless the user explicitly asks. Prefer short, actionable outputs.`;
    case "thorough":
      return `<reasoning_depth>thorough</reasoning_depth>
Thorough reasoning: Provide complete, well-structured analysis. Cover common cases, major edge cases, and trade-offs. Use step-by-step reasoning where helpful and verify tool results before concluding.`;
    case "deep":
      return `<reasoning_depth>deep</reasoning_depth>
Deep reasoning: Perform exhaustive, first-principles analysis. Chain attack surfaces, enumerate edge cases, consider defense-in-depth, and validate every assumption. Leave no stone unturned. Explicitly state uncertainties and residual risks.`;
    default:
      return `<reasoning_depth>thorough</reasoning_depth>`;
  }
}
