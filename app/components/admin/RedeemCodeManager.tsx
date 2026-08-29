"use client";

import * as React from "react";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export function RedeemCodeManager() {
  const generate = useMutation(api.redeemCodes.generateCodes as any);
  const [tier, setTier] = useState<"pro" | "pro-plus" | "ultra" | "team">("pro");
  const [durationType, setDurationType] = useState<"hours" | "days" | "months">("days");
  const [durationValue, setDurationValue] = useState(30);
  const [count, setCount] = useState(5);
  const [prefix, setPrefix] = useState("IVT");
  const [notes, setNotes] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const res = await generate({ tier, duration_type: durationType, duration_value: durationValue, count, prefix, notes: notes || undefined });
      setCodes(res.codes ?? []);
      toast.success(`Generated ${res.codes?.length ?? 0} codes`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    const csv = ["code,tier,duration_type,duration_value", ...codes.map((c) => `${c},${tier},${durationType},${durationValue}`)].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ivt-codes-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h3 className="font-semibold">Redeem Code Manager (Admin)</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div>
          <Label>Tier</Label>
          <select value={tier} onChange={(e) => setTier(e.target.value as any)} className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm">
            <option value="pro">pro</option>
            <option value="pro-plus">pro-plus</option>
            <option value="ultra">ultra</option>
            <option value="team">team</option>
          </select>
        </div>
        <div>
          <Label>Duration type</Label>
          <select value={durationType} onChange={(e) => setDurationType(e.target.value as any)} className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm">
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="months">months</option>
          </select>
        </div>
        <div>
          <Label>Duration value</Label>
          <Input type="number" value={durationValue} onChange={(e) => setDurationValue(parseInt(e.target.value) || 1)} className="mt-1" />
        </div>
        <div>
          <Label>Count (1-500)</Label>
          <Input type="number" value={count} onChange={(e) => setCount(parseInt(e.target.value) || 1)} className="mt-1" />
        </div>
        <div>
          <Label>Prefix</Label>
          <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} className="mt-1" placeholder="IVT" />
        </div>
        <div>
          <Label>Notes</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" placeholder="optional" />
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleGenerate} disabled={loading}>{loading ? "Generating…" : `Generate ${count} codes`}</Button>
        {codes.length > 0 && <Button variant="outline" onClick={handleExport}>Export CSV</Button>}
      </div>
      {codes.length > 0 && (
        <div className="max-h-64 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs">
          {codes.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
      )}
    </div>
  );
}
