# RLS policy matrix

The **RLS matrix** is a developer-focused view of [row-level security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) in the selected schema. It is available from the workspace header (**RLS**) or at route `/rls-matrix` when a database connection is active.

## What data is loaded

| Source | Purpose |
|--------|---------|
| `pg_policies` | Policy name, table, roles, command (`SELECT` / `INSERT` / `UPDATE` / `DELETE` / `ALL`), permissive vs restrictive, `USING` / `WITH CHECK` expressions |
| `pg_roles` | Roles shown as matrix rows (system roles `pg_*` and a few vendor superuser names are filtered out) |
| `pg_class.relrowsecurity` | Tables in the schema with RLS enabled |

Column headers in the matrix are the **union** of:

- every table that appears in `pg_policies` for that schema, and  
- every table in that schema with `relrowsecurity = true`,

so you still see RLS-enabled tables that have **no** policies yet.

## Matrix colors

- **Green** — At least one **permissive** policy matches that role, table, and command (`cmd` or `ALL`). Role matching treats an **empty** `roles` array or the special name **`public`** as “applies to all roles” (same idea as PostgreSQL’s public grant target).
- **Red** — RLS is on for the table, but **no** policy matches that role × command (typical effective deny for that operation).
- **Amber** — Matching policies exist but only **restrictive** ones for that cell. In real engines you still need permissive policies for access; restrictive policies add extra AND conditions.
- **Gray** — RLS is **not** enabled on that table (policies may still exist in the catalog but are inactive until RLS is enabled).
- **Violet ring** — Currently selected cell (opens the impersonation pane).

## Impersonation probe (safe by design)

Probes answer: *“If I am role R, what does this read-only query see under RLS?”*

The Rust backend:

1. Validates `role`, schema, and table as simple identifiers (`[a-zA-Z0-9_]+`) to avoid identifier injection.
2. Checks out one connection from the pool.
3. Runs `BEGIN`.
4. Runs `SET LOCAL ROLE "…"` (quoted identifier).
5. Runs `SET LOCAL row_security = on`.
6. Runs either your **custom** SQL or `SELECT * FROM "schema"."table" LIMIT 20`.
7. **Always** runs `ROLLBACK`, even if the query failed — nothing is committed; `SET LOCAL` is scoped to the transaction.

Custom SQL is restricted to a **single** statement that must start with `SELECT` or `WITH` (read-only). Multiple statements (extra `;`) are rejected.

## AI-assisted policy drafts

From the pane you can **Generate policy with AI** / **Refine with AI**. That starts a new AI chat message with context (schema, table, role, operation, existing policy snippets). If no Gemini API key is configured, the prompt is **copied to the clipboard** instead.

## Requirements

- Active pgStudio connection to a PostgreSQL database.
- Permission to read catalog views (`pg_policies`, `pg_roles`, `pg_class`, `pg_namespace`).
- For impersonation, the **session user** must be allowed to `SET ROLE` to the target role (often a superuser or member of the target role), or the probe will return a PostgreSQL error in the result panel.

### If loading fails

Errors from the server are shown in full (message, detail, hint, SQLSTATE) — not a generic “db error”. Common cases:

- **Permission denied** on `pg_catalog` — connect as a role that can read catalog views (often `superuser` or `pg_read_all_data` on newer versions).
- **Not PostgreSQL** — the matrix requires real PostgreSQL catalogs (e.g. not MySQL or SQLite).
- **Pool timeout** — too many concurrent work; retry or reduce load.

## Developer tools in the UI

- **RLS health check** — Surfaces tables with RLS enabled but **no policies** (effective deny) and tables with **policies but RLS off** (dormant policies).
- **Export digest** — Copies a Markdown summary of all policies in the selected schema (for docs, PRs, or runbooks).

## Related files

- Backend: [`src-tauri/src/rls.rs`](../src-tauri/src/rls.rs), commands `rls_matrix_data` / `rls_impersonate_query` in [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs)
- Frontend store: [`src/stores/rls-store.ts`](../src/stores/rls-store.ts)
- Page: [`src/app/rls-matrix/page.tsx`](../src/app/rls-matrix/page.tsx)
