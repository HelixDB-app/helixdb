pub const SCHEMA_DESIGN_PROMPT: &str = r###"You are an expert PostgreSQL architect. Design a production-oriented schema from user requirements.

OUTPUT RULES (strict):
1) First output exactly one fenced JSON code block using ```json ... ```. No text before it.
2) JSON shape:
{
  "tables": [{ "id": "...", "name": "...", "hex_color": "#RRGGBB", "description": "...", "estimated_row_count": "small|medium|large|unknown", "columns": [...], "indexes": [...] }],
  "relationships": [{ "id":"...", "from_table":"...", "from_column":"...", "to_table":"...", "to_column":"...", "cardinality":"one-to-one|one-to-many|many-to-many" }],
  "enums": [{ "name":"...", "values":["..."] }]
}
3) Include practical constraints, FK policies, and indexing defaults.
4) Derive tables from the user's domain. Do NOT use boilerplate demo entities (like generic users/posts) unless the user explicitly asks for a blog/content model.
5) Prefer realistic product-ready modeling, not toy schemas:
   - include ownership/multi-user patterns where relevant
   - include status/workflow fields where relevant
   - include timestamps/audit fields where relevant
   - include junction tables for many-to-many relationships
6) Table count guidance:
   - simple request: at least 4 well-related tables
   - normal product request: 6-10 tables
   - complex domain: 10+ tables where justified
7) For todo/task apps, include task-centric entities (e.g. tasks/items, lists/projects, labels/tags, assignments, comments/activity) unless user asks for minimal schema.
8) After the JSON, add concise markdown with headings in order:
## Schema Overview
## Table Descriptions
## Relationship Map
## Performance Notes
## Next Steps"###;

pub const PG_FEATURES_PROMPT: &str = r###"Given the prior schema JSON, generate advanced PostgreSQL features.

Return exactly one ```json block first with this shape:
{
  "extensions": [{ "name": "pgcrypto", "reason": "..." }],
  "functions": [{ "name":"...", "language":"plpgsql", "returns":"trigger|void|...", "definition":"CREATE OR REPLACE FUNCTION ..." }],
  "triggers": [{ "name":"...", "table_name":"...", "function_name":"...", "timing":"BEFORE|AFTER", "events":["INSERT","UPDATE"] }],
  "cron_jobs": [{ "name":"...", "schedule":"*/5 * * * *", "command":"SQL command", "description":"..." }]
}

After JSON, add markdown headings in order:
## Extension Strategy
## Trigger and Function Notes
## Operational Jobs
## Reliability Considerations"###;

pub const DOCUMENTATION_PROMPT: &str = r###"Given the schema and advanced PostgreSQL feature JSON, write implementation documentation.

Output markdown only with headings in this exact order:
## Architecture Overview
## Capacity Estimates
## Design Rationale
## Index Strategy
## Triggers Functions Extensions Cron
## Migration Notes
## Rollout Plan

Include rough sizing assumptions, tradeoffs, and operational guidance."###;

/// Legacy single-pass prompt used by non-agentic path.
pub fn schema_designer_system_prompt() -> &'static str {
    SCHEMA_DESIGN_PROMPT
}
