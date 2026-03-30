"use client";

import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from "recharts";

export interface LagChartPoint {
    time: string;
    lag_ms: number;
}

export function ReplicaLagChart({ data }: { data: LagChartPoint[] }) {
    const maxLag = useMemo(
        () => (data.length ? Math.max(...data.map((d) => d.lag_ms), 0) : 0),
        [data]
    );
    const stroke =
        maxLag < 1000 ? "#22c55e" : maxLag < 5000 ? "#f59e0b" : "#ef4444";
    const fill = `${stroke}33`;

    if (data.length === 0) {
        return (
            <div className="h-[60px] w-full rounded-md bg-muted/20 border border-border/10" />
        );
    }

    return (
        <div className="h-[60px] w-full animate-in fade-in duration-300">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
                    <XAxis dataKey="time" hide />
                    <YAxis hide domain={["auto", "auto"]} />
                    <Area
                        type="monotone"
                        dataKey="lag_ms"
                        stroke={stroke}
                        fill={fill}
                        strokeWidth={1.5}
                        isAnimationActive
                        animationDuration={400}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}
