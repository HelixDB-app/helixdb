"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Activity, Clock3, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";

type CrashSummary = {
    totals: { total: number; last24h: number; last7d: number };
    topSignatures: Array<{ _id: string; count: number; lastSeen: string; sampleMessage: string }>;
    byVersion: Array<{ _id: string; count: number }>;
    byPlatform: Array<{ _id: string | null; count: number }>;
};

function formatNumber(value: number) {
    return value.toLocaleString();
}

export function CrashAnalyticsPanel() {
    const [data, setData] = useState<CrashSummary | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/crash-reports/summary")
            .then((res) => res.json())
            .then((json) => {
                if (!cancelled) setData(json);
            })
            .catch(() => {
                if (!cancelled) setError("Crash analytics unavailable");
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const totals = data?.totals;

    return (
        <div className="fixed right-4 bottom-16 z-30 w-[360px] max-w-[92vw] space-y-2 text-foreground">
            <Card className="border-border/50 bg-background/90 p-3 shadow-xl backdrop-blur-md">
                <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Activity className="h-4 w-4 text-emerald-400" />
                        <p className="text-sm font-semibold">Crash Analytics</p>
                    </div>
                    <Badge variant="outline" className="border-emerald-400/40 text-[10px] uppercase tracking-[0.14em]">
                        Live
                    </Badge>
                </div>
                {error ? (
                    <p className="text-xs text-muted-foreground">{error}</p>
                ) : !totals ? (
                    <p className="text-xs text-muted-foreground">Loading crash telemetry…</p>
                ) : (
                    <div className="space-y-2">
                        <div className="grid grid-cols-3 gap-2 text-center">
                            <Stat label="24h" value={formatNumber(totals.last24h)} />
                            <Stat label="7d" value={formatNumber(totals.last7d)} />
                            <Stat label="All" value={formatNumber(totals.total)} />
                        </div>
                        {data?.topSignatures?.length ? (
                            <div className="rounded-lg border border-border/40 bg-muted/40 p-2">
                                <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-foreground/80">
                                    <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
                                    Top recent crashes
                                </p>
                                <div className="space-y-1">
                                    {data.topSignatures.map((item) => (
                                        <div key={item._id} className="rounded-md bg-background/60 px-2 py-1">
                                            <p className="truncate text-[11px] font-medium">{item.sampleMessage}</p>
                                            <p className="text-[10px] text-muted-foreground">
                                                {item.count} hits • id {item._id}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span className="flex items-center gap-1">
                                <Cpu className="h-3.5 w-3.5" />
                                Platforms
                            </span>
                            <span>
                                {data?.byPlatform
                                    ?.map((p) => `${p._id || "unknown"} (${p.count})`)
                                    .slice(0, 3)
                                    .join(" · ") || "—"}
                            </span>
                        </div>
                    </div>
                )}
            </Card>
            <Button
                size="sm"
                variant="outline"
                className="w-full justify-center gap-2 border-border/60 bg-background/90 text-[12px] backdrop-blur"
                onClick={() => {
                    // simple refresh button
                    setData(null);
                    setError(null);
                    fetch("/api/crash-reports/summary")
                        .then((res) => res.json())
                        .then((json) => setData(json))
                        .catch(() => setError("Crash analytics unavailable"));
                }}
            >
                <Clock3 className="h-3.5 w-3.5" />
                Refresh crash stats
            </Button>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-border/40 bg-background/60 px-2 py-1.5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
            <p className={cn("text-sm font-semibold")}>{value}</p>
        </div>
    );
}
