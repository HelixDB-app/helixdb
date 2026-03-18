export type ConciergeSeverity = "info" | "warn" | "block";

export type ConciergeItem = {
  id: string;
  severity: ConciergeSeverity;
  title: string;
  detail: string;
  suggestion?: string;
};

function has(pattern: RegExp, sql: string) {
  return pattern.test(sql);
}

export function analyzeMigrationSql(sql: string): ConciergeItem[] {
  const s = sql;
  const items: ConciergeItem[] = [];

  if (!s.trim()) return items;

  if (has(/\bdrop\s+table\b/i, s) || has(/\bdrop\s+column\b/i, s)) {
    items.push({
      id: "destructive_drop",
      severity: "block",
      title: "Destructive DROP detected",
      detail: "Your migration includes DROP operations that can permanently remove data.",
      suggestion: "Verify backups + have rollback SQL + run on staging first.",
    });
  }

  if (has(/\balter\s+table\b/i, s) && has(/\badd\s+column\b/i, s) && has(/\bdefault\b/i, s)) {
    items.push({
      id: "add_column_default",
      severity: "warn",
      title: "ADD COLUMN with DEFAULT",
      detail: "On large tables, adding a column with a DEFAULT can be expensive and may lock the table.",
      suggestion: "Prefer add nullable column → backfill in batches → set NOT NULL/default later (expand/contract).",
    });
  }

  if (has(/\bcreate\s+index\b/i, s) && !has(/\bconcurrently\b/i, s)) {
    items.push({
      id: "create_index_not_concurrently",
      severity: "warn",
      title: "Index build may lock writes",
      detail: "CREATE INDEX without CONCURRENTLY can block writes depending on workload and size.",
      suggestion: "Consider CREATE INDEX CONCURRENTLY for production (and schedule during low traffic).",
    });
  }

  if (has(/\bvacuum\s+full\b/i, s) || has(/\breindex\b/i, s)) {
    items.push({
      id: "maintenance_heavy",
      severity: "warn",
      title: "Heavy maintenance command detected",
      detail: "VACUUM FULL / REINDEX can be disruptive and may require extra disk/locks.",
      suggestion: "Validate maintenance window and impact before running on production.",
    });
  }

  if (has(/\balter\s+type\b/i, s) || has(/\bcreate\s+type\b/i, s)) {
    items.push({
      id: "type_changes",
      severity: "info",
      title: "Type / enum changes",
      detail: "Type changes can have surprising dependencies across functions, columns, and casts.",
      suggestion: "Search for dependent objects and verify application compatibility.",
    });
  }

  if (items.length === 0) {
    items.push({
      id: "no_major_risks",
      severity: "info",
      title: "No obvious high-risk patterns found",
      detail: "This is a heuristic check, not a guarantee. Still dry-run and keep rollback SQL.",
    });
  }

  return items;
}

export function conciergeChecklistMarkdown(items: ConciergeItem[]): string {
  const lines: string[] = [];
  lines.push("# Schema Change Concierge Checklist");
  lines.push("");
  for (const item of items) {
    const tag = item.severity.toUpperCase();
    lines.push(`- [ ] **${tag}**: ${item.title}`);
    lines.push(`  - ${item.detail}`);
    if (item.suggestion) lines.push(`  - Suggestion: ${item.suggestion}`);
  }
  lines.push("");
  return lines.join("\n");
}

