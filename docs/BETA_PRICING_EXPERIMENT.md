# Private beta: instrumentation + pricing test

This is a minimal plan to test whether `pgStudio` can monetize **advanced performance workflows** for individual devs and small teams.

## What to gate (pricing lever)

Gate features that are:

- clearly valuable weekly
- expensive to build/maintain
- easy to explain in one sentence

Recommended “Pro” candidates:

- Performance Replay bundles (export/share)
- advanced result streaming modes (keyset pagination, local hot-slice cache)
- Safe Schema Change Concierge (risk analysis + checklist export)

## What to instrument (success signals)

Track these events (counts and funnel):

- `db_connect_attempt` / `db_connect_success` / `db_connect_error`
- `query_execute` / `query_execute_error`
- `feature_gate_shown` (which feature)
- `upgrade_click` (which feature)

Constraints:

- never log raw SQL or connection strings
- keep params small and sanitized

## Experiment design

### Phase 1 (1–2 weeks): measure demand without blocking

- show “Pro” labeling and value copy
- do not block usage yet
- success: high “click to learn more” on Pro workflows

### Phase 2 (2–4 weeks): soft gate on advanced workflows

- show a `ProFeatureGate` only when users attempt the advanced workflow
- keep core query/data viewing usable
- success: meaningful conversion from `feature_gate_shown → upgrade_click`

### Phase 3: pricing iteration

Test:

- \$10/mo Pro (individual)
- \$20/mo Pro+ (adds more workflows)

## What “good” looks like (early)

In a private beta with 50–150 users:

- 30%+ run queries on ≥3 different days/week
- 10%+ hit a Pro gate at least once
- 3–8% click “Upgrade” from a gate (pre-conversion proxy)

## Implementation notes (in this repo)

- Events are logged via `src/lib/analytics.ts` (only when Firebase analytics is configured/initialized).
- Gates can be added via `src/components/pro-feature-gate.tsx`.

