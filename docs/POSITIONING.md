# pgStudio positioning (v1)

## One-liner

`pgStudio` is a **performance-first PostgreSQL studio** for developers who need **fast answers** on **big schemas** and **large result sets**—without the weight and latency of traditional database IDEs.

## 30-second pitch

Most Postgres GUIs are either **feature-heavy and slow** or **fast but shallow**. `pgStudio` is built to be the tool you keep open all day: **instant schema navigation**, a **serious query editor**, and **performance-first workflows** (sessions, indexes, topology, query history) that keep you in flow.

## Ideal customer profile (beachhead)

- **Primary**: individual developers and small teams (1–20) running Postgres-backed products
- **Context**: large-ish databases (lots of tables, lots of rows), frequent debugging, production-read workflows

## Core promise

- **Time-to-answer**: get from “question” → “verified result” faster
- **Performance at scale**: big tables and complex schemas stay responsive
- **Safety rails**: reduce “oops” moments (dangerous writes, long locks, unreviewed changes)

## The wedge (what we must win on)

### Wedge statement

**The fastest Postgres studio for real-world databases.**

### Proof points (measurable)

- Faster time-to-first-row for large queries
- Faster schema introspection on large databases
- Responsive UI while queries are running
- Lower memory footprint than heavy desktop IDEs

## Differentiation pillars

1. **Performance-native UX**
   - virtualized result rendering
   - streaming/pagination-first data access
   - background, incremental metadata refresh
2. **Performance troubleshooting loop**
   - explain + plan visualization
   - sessions/locks visibility
   - index building and impact exploration
3. **Safety-first workflows**
   - preflight checks, sandbox/dry-run where possible
   - clearer environment/criticality signals

## “Why switch?” bullets (homepage-ready)

- **Fast on big tables**: browse and filter large datasets without locking up your UI.
- **Fast on big schemas**: schema navigation stays snappy even on complex databases.
- **Performance workflows built in**: sessions, indexes, topology, and explain tools live next to your editor.
- **Developer-focused**: shortcuts, command palette, query history, and sharable artifacts.

## Objections and counters

- **“My current tool already works.”**
  - If your DB is small, it probably does. `pgStudio` is for when scale and responsiveness matter every day.
- **“Can I trust it?”**
  - We prioritize correctness, clear warnings, and safe execution modes; reliability is non-negotiable for database tools.
- **“Is my data private?”**
  - Connections are direct to your DB. Diagnostics can be made optional; never send credentials.

## Pricing hypothesis (solo/small teams)

- **Starter**: free (core connection + querying)
- **Pro**: \$8–\$20/month (advanced performance workflows + replay/share artifacts)
- **Team** (later): collaboration, governance, shared replay bundles, review gates

## Positioning do’s / don’ts

- **Do**: lead with “fastest time-to-answer on real databases.”
- **Do**: show benchmarks and real workflows (videos > text).
- **Don’t**: claim “no telemetry” if diagnostics are enabled/configured.
- **Don’t**: compete on “everything for everyone” (feature breadth trap).

