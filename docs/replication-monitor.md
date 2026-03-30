# Replication Monitor

The Replication Monitor is a desktop-only view in pgStudio (`/replication`) that polls PostgreSQL replication statistics and optionally a Patroni REST endpoint.

## What it queries

On each poll, the Tauri command `replication_snapshot` runs:

1. **`SELECT pg_is_in_recovery()`** — whether the connected instance is a standby.
2. **`SELECT pg_current_wal_lsn()`** — current WAL position (shown as “primary LSN” in the UI).
3. **`pg_stat_replication`** — one row per WAL sender to a streaming replica (PID, application name, client address, LSN positions, `write_lag` / `flush_lag` / `replay_lag`, `sync_state`, etc.).
4. **`pg_replication_slots`** — logical and physical slots, including **`pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)`** as retained WAL per slot when supported.

## Permissions

Reading `pg_stat_replication` and `pg_replication_slots` typically requires the **`pg_monitor`** role (or a superuser). If access is denied, the app returns an empty replica/slot list and sets **`fetchWarning`** with an explanation instead of failing the whole snapshot.

## WAL retention and slot alerts

When `pg_wal_lsn_diff` is available (PostgreSQL 10+), each slot gets an estimated **`walRetainedBytes`**. The UI compares that to a configurable threshold (default **1 GiB**) and shows an amber banner for slots over the limit. Inactive slots are called out in the banner.

If `pg_wal_lsn_diff` cannot be used (very old server or error), the app falls back to a query without per-slot bytes and records a warning; **`walRetainedBytes`** is then `null` for slots.

## Rolling history and charts

The client keeps the last **60** snapshots. Each replica card includes a small **replay lag** sparkline built from **`replayLagMs`** over that history.

## Failover readiness (UI heuristic)

The badge is derived only from PostgreSQL stats (not Patroni):

- **NO REPLICAS** — no rows in `pg_stat_replication`.
- **READY** — at least one replica with `state = streaming` and **`replayLagMs` &lt; 10 seconds**.
- **LAGGING** — otherwise.

## Patroni integration (optional)

Settings include a **Patroni REST base URL** (no trailing slash required). The command `replication_patroni` performs:

`GET {base}/cluster`

with a **5 second** timeout. The JSON is expected to include **`scope`** and a **`members`** array. Each member may expose:

- **`lag_in_mb`** — converted to bytes for display (`× 1024 × 1024`).
- **`lag`** — used as a fallback (numeric JSON value; interpretation depends on your Patroni version).

**`failoverPossible`** in the Patroni panel is `true` when any member has `role = replica`, `state = running`, and lag **&lt; 1 MiB** (bytes &lt; 1_000_000). Network errors, non-200 responses, and parse failures are shown as a Patroni error string in the UI and do not crash the app.

## Polling and persistence

- Default poll interval: **5s**; presets **5s / 10s / 30s** in the header.
- **Pause** stops the interval and clears the internal handle on navigation away.
- Persisted locally (Zustand `persist`): poll interval, WAL threshold, Patroni URL.

## Replica setup assistant

Open **Replica setup** on the Replication Monitor page.

### Logical publication (primary only)

- Creates `CREATE PUBLICATION … FOR ALL TABLES` on PostgreSQL 10+, or **`FOR TABLES IN SCHEMA`** on **PostgreSQL 15+** when you pick schemas.
- Identifier names are restricted to ASCII letters, numbers, and underscores.
- Lists existing publications from `pg_publication` when your role allows it.
- Includes a **subscriber** `CREATE SUBSCRIPTION` template (run on the other database).

### Physical standby snippets

- Builds `primary_conninfo` and a sample **`pg_basebackup -R -C -S …`** command from your saved connection string.
- **Passwords are never included** — replace `CHANGE_ME` with a replication-capable role.

## Developer utilities

- **Copy primary LSN** / per-replica summary to the clipboard.
- **Export JSON** — downloads the latest snapshot for debugging or ticketing.

## Troubleshooting

| Symptom | Likely cause |
|--------|----------------|
| Empty replicas, permission warning | Role lacks `pg_monitor` / superuser. |
| Empty replicas, no warning, standby | Normal on a replica (`pg_stat_replication` is empty). |
| No per-slot WAL sizes | PostgreSQL &lt; 10 or `pg_wal_lsn_diff` error; check diagnostics. |
| Patroni errors | Wrong URL, TLS, firewall, or Patroni API shape; verify `GET /cluster` with `curl`. |
