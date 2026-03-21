"use client";

import { useMemo, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { dbListSchemas, dbListTables, dbExecuteQuery } from "@/lib/db-platform";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type BenchRow = {
  name: string;
  ms: number;
  meta?: string;
};

function fmt(ms: number) {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export default function BenchmarksPage() {
  const { isConnected, connectionId } = useConnectionStore();
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tableSchema, setTableSchema] = useState("public");
  const [sql, setSql] = useState('SELECT now() AS "now"');

  const canRun = isConnected && !!connectionId && !running;

  const totalMs = useMemo(() => rows.reduce((acc, r) => acc + r.ms, 0), [rows]);

  async function runBench() {
    if (!connectionId) return;
    setRunning(true);
    setRows([]);
    setError(null);

    const next: BenchRow[] = [];
    const t0 = performance.now();
    const step = async <T,>(name: string, fn: () => Promise<T>, meta?: (value: T) => string) => {
      const s = performance.now();
      const value = await fn();
      const e = performance.now();
      next.push({ name, ms: e - s, meta: meta?.(value) });
      setRows([...next]);
      return value;
    };

    try {
      const schemas = await step("List schemas", () => dbListSchemas(connectionId), (v) => `${v.length} schemas`);
      const hasSchema = schemas.some((s) => s.name === tableSchema);

      await step(
        `List tables (${tableSchema})`,
        () => dbListTables(tableSchema, connectionId),
        (v) => `${v.length} objects`
      );

      await step(
        hasSchema ? `Execute SQL (${tableSchema})` : "Execute SQL",
        () => dbExecuteQuery(sql, connectionId),
        (v) => `${v.rows.length} rows × ${v.columns.length} cols`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      const t1 = performance.now();
      next.push({ name: "Total (approx)", ms: t1 - t0 });
      setRows([...next]);
      setRunning(false);
    }
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent">
      <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-foreground">Benchmarks</h1>
            <p className="text-xs text-muted-foreground">
              Quick timing harness for schema + query workflows (use the same DB/queries when comparing tools).
            </p>
          </div>
          <Button onClick={runBench} disabled={!canRun}>
            {running ? "Running…" : "Run benchmark"}
          </Button>
        </div>

        {!isConnected ? (
          <Card className="p-5 text-sm text-muted-foreground">
            Connect to a database first, then come back to run benchmarks.
          </Card>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[1fr_360px]">
            <Card className="min-h-0 p-4">
              <div className="mb-3 space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Schema for table listing</label>
                <Input value={tableSchema} onChange={(e) => setTableSchema(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">SQL to execute</label>
                <Input value={sql} onChange={(e) => setSql(e.target.value)} className="h-9 font-mono text-xs" />
                <p className="text-[11px] text-muted-foreground/70">
                  Tip: use a “big result” query to test time-to-first-row and UI responsiveness.
                </p>
              </div>
            </Card>

            <Card className="min-h-0 p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Results</p>
                <p className="text-[11px] text-muted-foreground/70">{rows.length ? `Σ ${fmt(totalMs)}` : ""}</p>
              </div>

              {error && (
                <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[11px] text-destructive">
                  {error}
                </div>
              )}

              <ScrollArea className={cn("mt-3 h-[420px] rounded-md border border-border/30", !rows.length && "opacity-70")}>
                <div className="divide-y divide-border/20">
                  {rows.length ? (
                    rows.map((r) => (
                      <div key={r.name} className="flex items-start justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-medium text-foreground/90">{r.name}</p>
                          {r.meta ? (
                            <p className="truncate text-[11px] text-muted-foreground/60">{r.meta}</p>
                          ) : null}
                        </div>
                        <p className="shrink-0 font-mono text-[11px] text-muted-foreground/80">{fmt(r.ms)}</p>
                      </div>
                    ))
                  ) : (
                    <div className="px-3 py-6 text-[12px] text-muted-foreground">
                      Run a benchmark to see timings.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

