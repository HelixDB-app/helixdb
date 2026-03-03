/**
 * Schema Designer AI Engine — Gemini API Integration
 *
 * Reuses the core Gemini utilities from ai-chat-engine.ts for:
 * - Schema generation from app description
 * - Schema optimization suggestions
 * - Performance/scalability reports
 * - Index recommendations
 */

import { callGeminiStream, callGeminiSync, type GeminiModelId } from "./ai-chat-engine";
export { GEMINI_MODELS } from "./ai-chat-engine";
export type { GeminiModelId } from "./ai-chat-engine";
import type { SchemaDesignerTable, SchemaDesignerColumn, AISchemaReport } from "./types";
import { useSettingsStore } from "@/stores/settings-store";
import { withGeminiLogging } from "@/lib/gemini-logger";

// ── System Prompts ──────────────────────────────────────────────────────────

const SCHEMA_GENERATION_PROMPT = `You are an expert PostgreSQL database architect. Generate a complete, production-ready PostgreSQL schema based on the user's application description.

CRITICAL: Output the ENTIRE JSON in one complete response. Do NOT truncate. Include every table and every column to the end. The response must be valid, parseable JSON.

RULES:
1. Output ONLY valid JSON — no markdown, no code fences, no explanations.
2. JSON format: { "tables": [ ... ] } with every table fully listed.
3. Each table: { "name": "snake_case_name", "columns": [ ... ] } with every column fully listed.
4. Each column: { "name": "col_name", "data_type": "PG_TYPE", "nullable": BOOL, "default_value": "DEFAULT_OR_NULL", "is_primary_key": BOOL, "foreign_key": FK_OR_NULL }
5. Foreign key format: { "target_table": "table_name", "target_column": "col_name" }
6. Always include: id (UUID PK), created_at, updated_at timestamps.
7. Use proper PostgreSQL types: UUID, TEXT, VARCHAR(n), INTEGER, BIGINT, NUMERIC(p,s), BOOLEAN, TIMESTAMPTZ, JSONB, etc.
8. Add appropriate foreign keys for all relationships.
9. Design for scalability and normalization (3NF minimum).
10. Include junction tables for many-to-many relationships.`;

const SCHEMA_OPTIMIZATION_PROMPT = `You are an expert PostgreSQL performance architect. Analyze the given schema and provide optimization suggestions.

OUTPUT ONLY valid JSON: { "suggestions": [ { "type": "index|constraint|type_change|normalization|denormalization", "table": "table_name", "description": "what to change and why", "priority": "high|medium|low", "sql": "optional SQL to implement" } ] }`;

const SCHEMA_REPORT_PROMPT = `You are an expert PostgreSQL architect and performance analyst. Analyze the given schema and generate a comprehensive report.

OUTPUT ONLY valid JSON:
{
  "performance_score": 0-100,
  "scalability_rating": "Excellent|Good|Fair|Needs Improvement",
  "bottlenecks": ["potential bottleneck descriptions"],
  "index_suggestions": ["CREATE INDEX suggestions with rationale"],
  "architecture_notes": ["architecture improvement notes"],
  "estimated_load": "description of estimated load capacity",
  "summary": "2-3 sentence executive summary"
}`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getApiKeyAndModel(): { apiKey: string; model: GeminiModelId } {
    const settings = useSettingsStore.getState();
    return {
        apiKey: settings.geminiApiKey,
        model: settings.defaultAiModel as GeminiModelId,
    };
}

function tablesToContext(tables: SchemaDesignerTable[]): string {
    if (tables.length === 0) return "No tables defined yet.";
    return tables.map(t => {
        const cols = t.columns.map(c => {
            let desc = `  ${c.name} ${c.data_type}`;
            if (c.is_primary_key) desc += " PK";
            if (!c.nullable) desc += " NOT NULL";
            if (c.default_value) desc += ` DEFAULT ${c.default_value}`;
            if (c.foreign_key) desc += ` FK→${c.foreign_key.target_table_id}.${c.foreign_key.target_column_id}`;
            return desc;
        }).join("\n");
        return `TABLE ${t.name}:\n${cols}`;
    }).join("\n\n");
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface GeneratedSchema {
    tables: {
        name: string;
        columns: {
            name: string;
            data_type: string;
            nullable: boolean;
            default_value: string | null;
            is_primary_key: boolean;
            foreign_key: { target_table: string; target_column: string } | null;
        }[];
    }[];
}

export interface OptimizationSuggestion {
    type: string;
    table: string;
    description: string;
    priority: string;
    sql?: string;
}

/**
 * Try to repair truncated JSON: remove incomplete trailing key/value and close open brackets.
 */
function repairTruncatedSchemaJson(raw: string): string {
    let s = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    // Remove trailing incomplete field (e.g. , "name": "  or  , "data_type":  )
    s = s.replace(/,?\s*"[a-z_]+"\s*:\s*("[^"]*)?\s*$/, "").trim();
    if (s.endsWith(",")) s = s.slice(0, -1);
    // Find last complete column object and truncate there, then close structure
    const lastColEnd = s.lastIndexOf('}');
    if (lastColEnd > 0 && (s.slice(lastColEnd).match(/}/g)?.length ?? 0) === 1) {
        const after = s.slice(lastColEnd + 1).trim();
        if (after === "" || after === "," || after.startsWith("]")) {
            s = s.slice(0, lastColEnd + 1);
            if (s.endsWith(",")) s = s.slice(0, -1);
            if (!s.endsWith("}]")) s += "]"; // columns
            if (!s.endsWith("}]}")) s += "}"; // table
            if (!s.endsWith("}]}}")) s += "]}"; // tables + root
            if (!s.endsWith("}")) s += "}";
        }
    }
    return s;
}

/**
 * Generate a complete schema from an app description.
 * Uses non-streaming request with higher token limit (8192) so the full JSON is returned and not cut off.
 * projectDescription gives the AI full context for better schema design.
 */
export async function generateSchema(
    appType: string,
    features: string,
    scale: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
    projectDescription?: string
): Promise<GeneratedSchema> {
    const { apiKey, model } = getApiKeyAndModel();
    const parts: string[] = [];
    if (appType.trim()) parts.push(`Application Type: ${appType.trim()}`);
    if (features.trim()) parts.push(`Features: ${features.trim()}`);
    parts.push(`Expected Scale: ${scale}`);
    if (projectDescription?.trim()) {
        parts.push("");
        parts.push("Project description (use this for context):");
        parts.push(projectDescription.trim());
    }
    parts.push("");
    parts.push("Generate a complete PostgreSQL schema for this application. Output the full JSON with all tables and columns.");
    const userMessage = parts.join("\n");

    const fullText = await withGeminiLogging(
        () => callGeminiSync(
            model,
            apiKey,
            [{ role: "user", parts: [{ text: userMessage }] }],
            SCHEMA_GENERATION_PROMPT,
            signal,
            { maxOutputTokens: 8192 }
        ),
        { model, featureType: "schema-designer", endpoint: "generateContent" }
    );

    const jsonStr = fullText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    onChunk(fullText);

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        const repaired = repairTruncatedSchemaJson(fullText);
        try {
            parsed = JSON.parse(repaired);
        } catch {
            const match = fullText.match(/\{\s*"tables"\s*:\s*\[[\s\S]*\}/);
            if (match) {
                try {
                    parsed = JSON.parse(repairTruncatedSchemaJson(match[0]));
                } catch {
                    throw new Error("Schema response was truncated or invalid. Try again or describe a smaller schema.");
                }
            } else {
                throw new Error("Failed to parse AI schema response. Try again.");
            }
        }
    }

    const schema = parsed as GeneratedSchema;
    if (!schema?.tables || !Array.isArray(schema.tables)) {
        throw new Error("AI did not return a valid schema with tables.");
    }
    return schema;
}

/**
 * Get optimization suggestions for the current schema.
 */
export async function optimizeSchema(
    tables: SchemaDesignerTable[],
    signal?: AbortSignal
): Promise<OptimizationSuggestion[]> {
    const { apiKey, model } = getApiKeyAndModel();
    const context = tablesToContext(tables);

    const response = await withGeminiLogging(
        () => callGeminiSync(
            model,
            apiKey,
            [{ role: "user", parts: [{ text: `Analyze and optimize this schema:\n\n${context}` }] }],
            SCHEMA_OPTIMIZATION_PROMPT,
            signal
        ),
        { model, featureType: "schema-designer", endpoint: "generateContent" }
    );

    const jsonStr = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    try {
        const parsed = JSON.parse(jsonStr);
        return parsed.suggestions || [];
    } catch {
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            return parsed.suggestions || [];
        }
        return [];
    }
}

/**
 * Generate a comprehensive AI report for the schema.
 */
export async function generateReport(
    tables: SchemaDesignerTable[],
    onChunk: (text: string) => void,
    signal?: AbortSignal
): Promise<AISchemaReport> {
    const { apiKey, model } = getApiKeyAndModel();
    const context = tablesToContext(tables);

    const fullText = await withGeminiLogging(
        () => callGeminiStream(
            model,
            apiKey,
            [{ role: "user", parts: [{ text: `Generate a performance and scalability report for this schema:\n\n${context}` }] }],
            SCHEMA_REPORT_PROMPT,
            onChunk,
            signal
        ),
        { model, featureType: "schema-designer", endpoint: "streamGenerateContent" }
    );

    const jsonStr = fullText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    try {
        return JSON.parse(jsonStr);
    } catch {
        const match = fullText.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        return {
            performance_score: 0,
            scalability_rating: "Unknown",
            bottlenecks: ["Failed to parse AI response"],
            index_suggestions: [],
            architecture_notes: [],
            estimated_load: "Unknown",
            summary: "Report generation failed. Please try again.",
        };
    }
}

/**
 * Chat with AI about the schema for iterative refinement.
 */
export async function chatAboutSchema(
    tables: SchemaDesignerTable[],
    userMessage: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal
): Promise<string> {
    const { apiKey, model } = getApiKeyAndModel();
    const context = tablesToContext(tables);

    const systemPrompt = `You are a PostgreSQL schema design assistant. The user is designing a database schema and wants your help.

Current schema:
${context}

Help them refine, add, optimize, or troubleshoot their schema. Be specific, practical, and reference their actual tables and columns. If suggesting changes, include the exact SQL or describe the column changes precisely.`;

    return withGeminiLogging(
        () => callGeminiStream(
            model,
            apiKey,
            [{ role: "user", parts: [{ text: userMessage }] }],
            systemPrompt,
            onChunk,
            signal
        ),
        { model, featureType: "schema-designer", endpoint: "streamGenerateContent" }
    );
}

const SCRIPT_GENERATION_PROMPT = `You are an expert PostgreSQL DBA. Generate only valid PostgreSQL DDL (CREATE TABLE, indexes, constraints). No explanations unless the user asks.

RULES:
1. Output ONLY executable SQL — no markdown code fences, no preamble.
2. Use standard PostgreSQL types: UUID, TEXT, VARCHAR(n), INTEGER, BIGINT, TIMESTAMPTZ, JSONB, etc.
3. Include PRIMARY KEYs, NOT NULL, DEFAULTs (e.g. gen_random_uuid(), NOW()).
4. Add FOREIGN KEY constraints where relationships exist.
5. Use double-quoted identifiers for table/column names if they are reserved or mixed-case.
6. One statement per line or clearly separated; no trailing semicolon required.`;

/**
 * Generate PostgreSQL DDL script from a natural language prompt using Gemini.
 */
export async function generatePostgresScript(
    prompt: string,
    onChunk: (text: string) => void,
    options?: { model?: GeminiModelId; signal?: AbortSignal }
): Promise<string> {
    const { apiKey, model } = getApiKeyAndModel();
    const modelId = options?.model ?? model;
    const fullText = await withGeminiLogging(
        () => callGeminiStream(
            modelId,
            apiKey,
            [{ role: "user", parts: [{ text: prompt }] }],
            SCRIPT_GENERATION_PROMPT,
            onChunk,
            options?.signal
        ),
        { model: modelId, featureType: "schema-designer", endpoint: "streamGenerateContent" }
    );
    return fullText.replace(/^```sql\n?|^```\n?|\n?```$/g, "").trim();
}

/**
 * Generate SQL DDL for the given schema tables.
 * Output is formatted for readability: multi-line FKs with ON DELETE/UPDATE CASCADE.
 */
export function generateSQL(tables: SchemaDesignerTable[]): string {
    const lines: string[] = [];

    for (const table of tables) {
        const colDefs: string[] = [];
        const pks: string[] = [];
        const fkBlocks: string[] = [];

        for (const col of table.columns) {
            let def = `    "${col.name}" ${col.data_type}`;
            if (!col.nullable) def += " NOT NULL";
            if (col.default_value) def += ` DEFAULT ${col.default_value}`;
            if (col.unique) def += " UNIQUE";
            colDefs.push(def);

            if (col.is_primary_key) pks.push(`"${col.name}"`);
            if (col.foreign_key) {
                const targetTable = tables.find(t => t.id === col.foreign_key!.target_table_id);
                const targetCol = targetTable?.columns.find(c => c.id === col.foreign_key!.target_column_id);
                if (targetTable && targetCol) {
                    fkBlocks.push(
                        `    CONSTRAINT "fk_${table.name}_${col.name}"\n        FOREIGN KEY ("${col.name}")\n        REFERENCES "${targetTable.name}" ("${targetCol.name}")\n        ON DELETE CASCADE\n        ON UPDATE CASCADE`
                    );
                }
            }
        }

        if (pks.length > 0) {
            colDefs.push("", `    CONSTRAINT "pk_${table.name}" PRIMARY KEY (${pks.join(", ")})`);
        }
        const allDefs = [...colDefs, ...(fkBlocks.length ? ["", ...fkBlocks] : [])];
        lines.push(`CREATE TABLE "${table.name}" (\n${allDefs.join(",\n")}\n);\n`);
    }

    return lines.join("\n");
}
