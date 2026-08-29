"use client";

import * as React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";

export function RedeemCodeDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<null | { tier: string; duration_type: string; duration_value: number }>(null);

  const handleRedeem = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      toast.error("Enter a code");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
      toast.success(`Redeemed ${json.tier} for ${json.duration_value} ${json.duration_type}`);
      setCode("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="text-xs">Have a code? Redeem</Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Redeem code</DialogTitle>
          <DialogDescription>Enter your IVT code to activate your plan. Single-use.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="IVT-XXXXXX" className="font-mono" autoFocus />
          <Button onClick={handleRedeem} disabled={loading || !code.trim()}>{loading ? "Redeeming…" : "Redeem"}</Button>
        </div>
        {result && (
          <div className="rounded-md border bg-muted/20 p-3 text-sm">
            <div className="font-medium">Activated {result.tier}</div>
            <div className="text-muted-foreground">{result.duration_value} {result.duration_type}</div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
