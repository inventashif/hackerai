"use client";

import * as React from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import type { ReasoningTier, SubscriptionTier } from "@/types/chat";
import { canUseReasoningTier, getDefaultReasoningTier } from "@/types/chat";
import { readReasoningTier, writeReasoningTier } from "@/lib/utils/client-storage";
import { cn } from "@/lib/utils";

const TIERS: Array<{ id: ReasoningTier; label: string; short: string }> = [
  { id: "quick", label: "Quick", short: "Quick" },
  { id: "thorough", label: "Thorough", short: "Thorough" },
  { id: "deep", label: "Deep", short: "Deep" },
];

export function ReasoningTierToggle({
  value,
  onChange,
  subscription,
}: {
  value: ReasoningTier | null | undefined;
  onChange: (tier: ReasoningTier) => void;
  subscription: SubscriptionTier;
}) {
  const effective = value ?? getDefaultReasoningTier(subscription);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-1 rounded-full border bg-muted/30 p-0.5">
        {TIERS.map((t) => {
          const locked = !canUseReasoningTier(t.id, subscription);
          const selected = effective === t.id;
          const btn = (
            <Button
              key={t.id}
              variant={selected ? "default" : "ghost"}
              size="sm"
              disabled={locked}
              onClick={() => !locked && onChange(t.id)}
              className={cn(
                "h-7 rounded-full px-2.5 text-xs font-medium",
                selected ? "shadow-sm" : "text-muted-foreground hover:text-foreground",
                locked && "opacity-60",
              )}
              aria-pressed={selected}
              title={locked ? "Deep requires Pro or higher" : t.label}
            >
              {locked && <Lock className="mr-1 h-3 w-3" />}
              {t.short}
            </Button>
          );
          if (!locked) return btn;
          return (
            <Tooltip key={t.id}>
              <TooltipTrigger asChild>{btn}</TooltipTrigger>
              <TooltipContent side="top">Deep reasoning requires Pro or higher</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
