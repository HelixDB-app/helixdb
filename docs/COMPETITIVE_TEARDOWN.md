# Competitive teardown + benchmark protocol

This document helps you compare `pgStudio` against 3–5 competitor tools using **the same database** and **the same scenarios**, and record results in a way you can publish (benchmarks) and use internally (prioritization).

## Competitors to include (recommended)

Pick at least one from each bucket:

- **Power IDE**: DataGrip
- **Fast paid desktop**: TablePlus or Postico
- **Free + mature**: DBeaver or pgAdmin
- **Cloud console (if relevant)**: Supabase Studio / Neon Console / RDS Query Editor

## Test database (make it realistic)

Use one of:

- A production-like staging snapshot (sanitized) with many tables, indexes, and real row counts
- A seeded “big” dataset (TPC-H-ish) plus a few application tables and migrations

Record:

- DB host/region (latency matters)
- Postgres version
- table count, total rows, largest tables

## Scenarios (run in every tool)

### Scenario A: time-to-connect + time-to-first-schema

- Start tool from cold
- Connect to DB
- Open schema browser / list tables

Record:

- time-to-connected (s)
- time-to-list-schemas (s)
- time-to-list-tables for a schema with 200+ objects (s)

### Scenario B: big results (responsiveness)

Run a query that returns many rows.

Example patterns:

- `SELECT * FROM big_table ORDER BY id DESC LIMIT 200000;`
- `SELECT * FROM big_table WHERE created_at > now() - interval '7 days' LIMIT 200000;`

Record:

- time-to-first-row (ms)
- time-to-1000-rows rendered (ms)
- UI responsiveness while loading (subjective 1–5)
- peak memory (if measurable)

### Scenario C: performance debugging loop

- Run a slow query
- Open EXPLAIN/plan visualization
- Identify an index candidate

Record:

- time-to-answer (minutes)
- friction points (missing info, hard-to-read plans, etc.)

### Scenario D: sessions + locks

Create a lock contention scenario (2 sessions) and see how fast you can find the blocking chain.

Record:

- time-to-identify blocker
- clarity of UI

## How to record results

Use the template below and keep raw notes; publish only the cleaned summary.

### Results template (copy/paste)

**DB**:  
**Postgres**:  
**Latency** (approx):  
**Competitor**:  
**Tool version**:  
**Machine**:  

| Scenario | Metric | Result |
|---|---:|---:|
| A | time-to-connected |  |
| A | time-to-list-schemas |  |
| A | time-to-list-tables |  |
| B | time-to-first-row |  |
| B | time-to-1000-rows rendered |  |
| B | responsiveness (1–5) |  |
| C | time-to-answer |  |
| D | time-to-identify blocker |  |

**Notes**:\n+
- What felt great?\n+- What was painful?\n+- Anything surprising?\n+

## Publishing guidance (benchmarks without drama)

- Publish **your DB shape** and **your query**. People discount benchmarks without context.
- Show **time-to-first-row** and **responsiveness under load**—those map directly to “feels fast.”
- Include 1–2 short screen recordings; they’re more credible than numbers alone.

