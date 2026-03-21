import { dbExplainQuery } from "@/lib/tauri";
import type { QueryHistorySummary, QueryHistoryDetail } from "@/lib/types";
import { APP_NAME, APP_VERSION } from "@/lib/app-config";

export type PerformanceReplayBundle = {
  format: "pgstudio.performance-replay.v1";
  createdAtMs: number;
  app: {
    name: string;
    version: string;
  };
  query: {
    id?: string;
    executedAtMs?: number;
    environment?: string | null;
    queryType?: string | null;
    totalMs?: number | null;
    rowsReturned?: number | null;
    sql: string;
    sqlRedacted: boolean;
  };
  explain: {
    format: "json";
    raw: string | null;
  };
  notes?: {
    userNote?: string | null;
    aiAnalysis?: unknown | null;
  };
  detail?: QueryHistoryDetail;
};

function redactSqlLiterals(sql: string): string {
  // Minimal, best-effort redaction:
  // - replace single-quoted strings with '?'
  // - replace numbers with 0 (outside identifiers)
  return sql
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\b\d+(\.\d+)?\b/g, "0");
}

export async function buildPerformanceReplayBundle(args: {
  connectionId: string;
  summary: QueryHistorySummary;
  detail?: QueryHistoryDetail;
  redact: boolean;
}): Promise<PerformanceReplayBundle> {
  const sql = args.summary.query_text ?? "";
  const sqlOut = args.redact ? redactSqlLiterals(sql) : sql;

  let explainRaw: string | null = null;
  try {
    explainRaw = await dbExplainQuery(args.connectionId, sql);
  } catch {
    explainRaw = null;
  }

  return {
    format: "pgstudio.performance-replay.v1",
    createdAtMs: Date.now(),
    app: { name: APP_NAME, version: APP_VERSION },
    query: {
      id: String(args.summary.id),
      executedAtMs: args.summary.executed_at ?? undefined,
      environment: args.summary.environment ?? null,
      queryType: args.summary.query_type ?? null,
      totalMs: args.summary.total_ms ?? null,
      rowsReturned: args.summary.rows_returned ?? null,
      sql: sqlOut,
      sqlRedacted: args.redact,
    },
    explain: {
      format: "json",
      raw: explainRaw,
    },
    notes: {
      userNote: args.detail?.item.note ?? args.summary.note ?? null,
      aiAnalysis: args.detail?.ai_analysis ?? null,
    },
    detail: args.detail,
  };
}

export function downloadReplayBundle(bundle: PerformanceReplayBundle, filename: string) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

