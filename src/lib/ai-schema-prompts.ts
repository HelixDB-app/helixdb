export type QualityMode = 'full' | 'fast' | 'tables_only'

export interface SchemaDesignRequest {
  userIntent: string
  detectedDomain: string
  scaleTier: 'startup' | 'growth' | 'enterprise'
  isMultiTenant: 'true' | 'false' | 'unknown'
  auditRequired: 'true' | 'false' | 'unknown'
  existingSchemaSummary?: string
  conversationHistoryCompressed?: string
  imageBase64Array?: string
  pgVersion: string
  forbiddenExtensions?: string
  namingConvention?: string
  qualityMode: QualityMode
}

const SYSTEM_PROMPT_BASE = `You are SchemaForge, the AI-powered database architect embedded inside pgStudio — a professional native macOS PostgreSQL client.
You are not a general assistant. You are a precision PostgreSQL systems architect.

You produce COMPLETE, PRODUCTION-GRADE PostgreSQL schema architectures from natural language or image inputs.

OUTPUT CONTRACT:
- Return a single JSON envelope with keys: schema_meta, sql_blocks, react_flow_graph, schema_doc
- No markdown fences around outer JSON
- No prose outside JSON
- Omit empty sql_blocks keys entirely
- Never return placeholder SQL comments
- Use PostgreSQL 15+ features when appropriate

JSON envelope shape:
{
  "schema_meta": { ... },
  "sql_blocks": {
    "extensions": "-- SQL string",
    "tables": "-- SQL string",
    "indexes": "-- SQL string",
    "triggers": "-- SQL string",
    "functions": "-- SQL string",
    "rls": "-- SQL string",
    "cron_jobs": "-- SQL string",
    "materialized_views": "-- SQL string"
  },
  "react_flow_graph": {
    "nodes": [ ... ],
    "edges": [ ... ]
  },
  "schema_doc": "-- markdown"
}

QUALITY CHECKS:
- Every table has PK
- Every FK column is indexed
- Timestamps use sensible defaults
- updated_at columns have triggers on mutable tables
- M:N relationships use junction tables
- JSONB query columns use GIN
- High growth tables include partition strategy
- Functions include SET search_path = public, pg_catalog
- Extensions use CREATE EXTENSION IF NOT EXISTS
- React flow edges only reference valid node ids
- Each react_flow_graph node with type "tableNode" MUST include data.columns: array of { name, type, constraints[] } (constraints use strings like "PRIMARY KEY", "FOREIGN KEY", "UNIQUE") so the canvas can render full ERD cards without relying on SQL parsing alone`

const FAST_MODE_TAIL = `
FAST MODE:
- Prioritize schema_meta, tables, indexes, react_flow_graph
- Include triggers/functions when clearly needed
- Omit cron_jobs, rls, materialized_views unless strongly implied by request`

const TABLES_ONLY_TAIL = `
TABLES ONLY MODE:
- Return schema_meta plus sql_blocks.tables and sql_blocks.indexes only
- Omit triggers/functions/rls/cron/materialized_views/schema_doc unless absolutely required
- Still include react_flow_graph`

export function buildSystemPrompt(qualityMode: QualityMode, skipDocs = false): string {
  const modeTail =
    qualityMode === 'tables_only'
      ? TABLES_ONLY_TAIL
      : qualityMode === 'fast'
        ? FAST_MODE_TAIL
        : ''
  const docsTail = skipDocs
    ? '\nDOC MODE: Set schema_doc to an empty string and focus tokens on SQL and graph.'
    : ''
  return `${SYSTEM_PROMPT_BASE}\n${modeTail}${docsTail}`.trim()
}

export function buildUserMessage(input: SchemaDesignRequest): string {
  return `## SCHEMA DESIGN REQUEST

### User Intent
${input.userIntent}

### Domain Hints (auto-detected or user-confirmed)
- Domain: ${input.detectedDomain}
- Scale tier: ${input.scaleTier}
- Multi-tenant: ${input.isMultiTenant}
- Audit required: ${input.auditRequired}
- Existing schema context: ${input.existingSchemaSummary?.trim() || 'none'}

### Session Context (last 3 turns)
${input.conversationHistoryCompressed?.trim() || '(none)'}

### Image Attachments
${input.imageBase64Array?.trim() || 'none'}

### Constraints
- Target PostgreSQL version: ${input.pgVersion}
- Forbidden extensions: ${input.forbiddenExtensions?.trim() || 'none'}
- Custom naming convention: ${input.namingConvention?.trim() || 'snake_case (default)'}
- Output token budget: UNLIMITED - produce the complete schema. Do not truncate.

### Quality Mode
${input.qualityMode}`.trim()
}

export function buildSchemaUpdateMessage(baseUserMessage: string, existingSchemaSummary: string): string {
  const schema = existingSchemaSummary.trim()
  if (!schema) return baseUserMessage.trim()
  return `${baseUserMessage.trim()}

### Existing PostgreSQL Schema
Use this schema as the current source of truth. Apply the requested changes without dropping unrelated structures.
\`\`\`sql
${schema}
\`\`\`
`.trim()
}

export function buildRecoveryPrompt(
  originalUserRequest: string,
  brokenOutput: string,
  missingSections: string[]
): string {
  return `A previous attempt to generate a PostgreSQL schema design returned an incomplete or malformed response.

Original user request:
${originalUserRequest}

What was received (partial/broken):
${brokenOutput}

Recovery instructions:
1. Regenerate the COMPLETE schema from scratch based on the original request
2. If the partial output contains valid SQL blocks, preserve them exactly
3. Focus on completing missing sections: ${missingSections.join(', ') || 'all'}
4. Return the full valid JSON envelope as specified in system instructions
5. Do NOT reference the failed attempt in your output

Produce the complete schema now.`
}

export function buildCompressorPrompt(fullConversationHistory: string): string {
  return `You are a conversation summarizer for a PostgreSQL schema design session.

Given the following conversation history, produce a COMPRESSED CONTEXT OBJECT that preserves only information needed for schema evolution continuity.

Output ONLY this JSON, nothing else:

{
  "established_entities": ["users", "orders", "products"],
  "confirmed_decisions": [
    "UUID v7 for all PKs",
    "multi-tenant with RLS",
    "pg_cron for nightly archival"
  ],
  "pending_questions": ["user asked about geospatial support - not yet resolved"],
  "last_schema_hash": "{sha256 of last sql_blocks output}",
  "turn_count": 5
}

Conversation history:
${fullConversationHistory}`.trim()
}
