# pgStudio idea validation kit (interviews + synthesis)

This kit is designed to validate the **performance-first Postgres studio** wedge with **15–20** target users (solo devs + small teams) and convert qualitative interviews into a clear decision.

## What you’re testing (hypotheses)

1. **Pain**: Existing Postgres tools feel slow or high-friction on large schemas/results.
2. **Frequency**: The pain happens often enough (weekly+) to justify switching.
3. **Switching**: Users will try a new tool if it’s measurably faster for their workflows.
4. **Willingness-to-pay**: Users will pay \$8–\$20/month for performance workflows they use weekly.

## Screener (5 minutes)

Only schedule if they match 2+ of these:

- Uses Postgres at least **3 days/week**
- Has 20+ tables **or** routinely queries tables with 1M+ rows
- Has used a Postgres GUI/IDE for 6+ months (DBeaver, DataGrip, TablePlus, Postico, pgAdmin, etc.)
- Has experienced at least one of:
  - “UI freezes / slow results rendering”
  - “schema introspection takes forever”
  - “hard to diagnose slow queries, locks, or bad plans”

## Interview script (30–40 minutes)

### 1) Context (5 min)

- Tell me about your app/team and how Postgres fits in.
- What tools do you use for Postgres today? Why that one?
- How often do you switch between tools (CLI, psql, GUI, cloud console)?

### 2) Recent pain (10 min)

Ask for the last *real* incident:

- Think of the last time you were frustrated with your Postgres tool. What happened?
- What were you trying to do? What did the tool do that slowed you down?
- How long did it take? What did you do instead?

Capture:

- Task type (schema browse / query / export / explain / sessions / indexes / migrations)
- Where time was lost (waiting vs confusion vs unsafe execution)
- Stakes (prod incident? debugging? routine analytics?)

### 3) Current workflow (10 min)

- Walk me through how you do each of these today:
  - Explore schema
  - Write and iterate on a query
  - Diagnose slow query (EXPLAIN, indexes)
  - Investigate locks/sessions
  - Make schema changes safely
- What’s the “happy path” and what’s the “annoying path”?

### 4) Value test (10 min)

Present 2–3 wedge scenarios (pick ones that match their pain):

- **Big results**: “What if results feel instant even on huge tables (streaming + virtualization)?”
- **Big schemas**: “What if schema navigation is always snappy and refresh happens in the background?”
- **Performance incident**: “What if you could capture a slow-query incident into a shareable ‘replay bundle’?”

For each:

- How valuable is this (1–10)?
- When would you use it (weekly/monthly/rare)?
- Would it replace your current tool for that workflow?

### 5) Switching + pricing (5 min)

- What would make you switch tools?
- What would block you from switching?
- If this saved you ~30 minutes/week, would you pay **\$10/month**? If not, what would you pay?
- If it saved ~2 hours/week, would you pay **\$20/month**?

## Note-taking template (copy/paste)

**Participant**:  
**Role / company size**:  
**Current tool**:  
**DB size proxy** (tables / row counts):  
**Frequency**:  

### Top pains (ranked)
1.  
2.  
3.  

### Last incident story (verbatim)

### Wedge scenarios (score 1–10)
- Big results streaming: __ /10
- Big schema navigation: __ /10
- Performance Replay: __ /10

### Switching triggers / blockers
- Triggers:  
- Blockers:  

### Willingness-to-pay
- At \$10/mo: yes/no + why  
- At \$20/mo: yes/no + why  

### Most promising “first feature”

## Synthesis rubric (turn interviews into a decision)

After 15–20 interviews, you should be able to answer:

### A) Pain intensity and frequency

- **Green**: 60%+ report weekly friction where tooling is the bottleneck
- **Yellow**: pain exists but infrequent or avoidable
- **Red**: pain is rare; performance isn’t a buying driver

### B) Displacement (will they switch?)

- **Green**: 40%+ say they would switch for a proven performance improvement
- **Yellow**: would trial but won’t replace main tool
- **Red**: locked into incumbents (team standardization) or “good enough”

### C) Monetization signal

- **Green**: 25%+ accept \$10/mo *in interview* for performance workflows
- **Yellow**: will pay only for team features
- **Red**: strong resistance to paying anything

### Decision guideline

Proceed aggressively if at least **2 of 3** (A/B/C) are **Green** and the qualitative stories converge on the same 1–2 pain points.

