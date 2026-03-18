# Differentiating feature bets (build-ready specs)

This doc captures three “win the category” workflows and the minimal implementation path for each.

## 1) Performance Replay (portable performance incident bundle)

### User story

As a developer, when a query is slow or risky, I want to capture everything needed to reproduce and diagnose it later (or share it), without digging through multiple views.

### MVP scope (v1)

- Export a **Replay Bundle** JSON from a query history entry:
  - query text (optionally redacted)
  - execution timing + row count
  - EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
  - saved notes / AI analysis if present

### Where it lives in the app

- Query History → select an entry → **Export Replay**

### Implementation notes (this repo)

- Bundle builder: `src/lib/performance-replay.ts`
- Export UI: `src/app/query-history/page.tsx` (Local History detail panel)

### v2+ expansions (unique moat)

- Add “session/lock snapshot” and “index candidates” into the bundle.
- Add deterministic “replay runner” against a staging DB to compare before/after (index change, config change).

## 2) Adaptive Result Streaming (big data feels native)

### User story

As a developer, I want results to stay responsive on large tables without waiting for full fetches or freezing the UI.

### MVP scope (v1)

- Detect the simplest “browse table” queries and execute them via **paged table data API** (instead of fetching all rows).

Supported:

- `SELECT * FROM schema.table`
- `SELECT * FROM "schema"."table"`

Not supported (falls back to normal execution):

- WHERE / JOIN / CTE / subqueries
- LIMIT/OFFSET already present

### Implementation notes (this repo)

- Detection + paging route: `src/stores/query-store.ts` (uses `dbGetTableData` with page size 2000)

### v2+ expansions (unique moat)

- “Load more” in query results for paged mode (next page).
- Keyset pagination option for stable scrolling.
- Local “hot slice” cache for repeated navigation.

## 3) Safe Schema Change Concierge (risk scan + rollout plan)

### User story

As a developer, before applying migrations, I want quick, actionable warnings about lock risk and destructive operations, plus a checklist I can follow during rollout.

### MVP scope (v1)

- Heuristic scan of the generated forward migration SQL:
  - destructive drops
  - index creation without concurrently
  - add column with default
  - heavy maintenance commands
- Produce a downloadable **Markdown checklist**.

### Where it lives in the app

- Migration Studio → Execute step → **Concierge checklist**

### Implementation notes (this repo)

- Analyzer + checklist: `src/lib/schema-change-concierge.ts`
- Dialog UI: `src/components/schema-change-concierge-dialog.tsx`
- Hook into Migration Studio: `src/app/migration-studio/page.tsx`

### v2+ expansions (unique moat)

- Use real table stats + estimated lock durations (pg_stat / pg_class) to score risk.
- “Shadow apply” runner to simulate on a clone (when configured).

