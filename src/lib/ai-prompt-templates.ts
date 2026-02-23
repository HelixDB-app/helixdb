/**
 * AI Prompt Templates — Curated library of SQL prompt templates for pgStudio
 */

export interface PromptTemplate {
    id: string;
    title: string;
    prompt: string;
    category: string;
    icon: string;
    isCustom?: boolean;
}

export const TEMPLATE_CATEGORIES = [
    { id: "all", label: "All", icon: "✨" },
    { id: "query", label: "Queries", icon: "🔍" },
    { id: "performance", label: "Performance", icon: "⚡" },
    { id: "schema", label: "Schema", icon: "🏗️" },
    { id: "data", label: "Data Quality", icon: "🧹" },
    { id: "security", label: "Security", icon: "🔒" },
    { id: "analytics", label: "Analytics", icon: "📊" },
    { id: "migration", label: "Migration", icon: "🚀" },
    { id: "debug", label: "Debug", icon: "🐛" },
];

export const DEFAULT_TEMPLATES: PromptTemplate[] = [
    // ── Queries ──
    { id: "q1", title: "SELECT with JOIN", prompt: "Write a SELECT query that joins related tables to fetch [describe data needed]", category: "query", icon: "🔗" },
    { id: "q2", title: "Complex aggregation", prompt: "Write a query with GROUP BY and aggregate functions to calculate [describe metric]", category: "query", icon: "📊" },
    { id: "q3", title: "Subquery / CTE", prompt: "Write a query using a CTE (WITH clause) to [describe complex logic]", category: "query", icon: "📝" },
    { id: "q4", title: "Window function", prompt: "Write a query using window functions (ROW_NUMBER, RANK, LAG/LEAD) to [describe analysis]", category: "query", icon: "🪟" },
    { id: "q5", title: "Pivot / Crosstab", prompt: "Write a pivot query to transform rows into columns for [describe data]", category: "query", icon: "🔄" },
    { id: "q6", title: "Recursive query", prompt: "Write a recursive CTE to traverse hierarchical data in [table name]", category: "query", icon: "🌳" },
    { id: "q7", title: "UPSERT statement", prompt: "Write an INSERT ... ON CONFLICT DO UPDATE (upsert) for [table name]", category: "query", icon: "⬆️" },
    { id: "q8", title: "Bulk UPDATE", prompt: "Write an efficient UPDATE query to modify multiple rows based on [condition]", category: "query", icon: "✏️" },

    // ── Performance ──
    { id: "p1", title: "Show slow queries", prompt: "Show me how to find the slowest running queries using pg_stat_statements", category: "performance", icon: "🐌" },
    { id: "p2", title: "Missing indexes", prompt: "Identify tables with sequential scans that could benefit from new indexes", category: "performance", icon: "🔎" },
    { id: "p3", title: "Index usage stats", prompt: "Show index usage statistics — which indexes are used vs unused", category: "performance", icon: "📈" },
    { id: "p4", title: "Table bloat check", prompt: "Check for table bloat and suggest VACUUM or REINDEX operations", category: "performance", icon: "🎈" },
    { id: "p5", title: "Connection stats", prompt: "Show current connection count, active queries, and idle connections", category: "performance", icon: "🔌" },
    { id: "p6", title: "Optimize this query", prompt: "Analyze and optimize this query for better performance:\n\n```sql\n-- paste your query here\n```", category: "performance", icon: "🚀" },
    { id: "p7", title: "EXPLAIN ANALYZE", prompt: "Write an EXPLAIN ANALYZE for this query and explain the execution plan:\n\n```sql\n-- paste your query here\n```", category: "performance", icon: "📋" },

    // ── Schema ──
    { id: "s1", title: "List all tables", prompt: "Show all tables with their row counts, size on disk, and column count", category: "schema", icon: "📊" },
    { id: "s2", title: "FK relationships", prompt: "Map all foreign key relationships between tables as a dependency graph", category: "schema", icon: "🔗" },
    { id: "s3", title: "Create table", prompt: "Create a new table for [describe entity] with proper types, constraints, and indexes", category: "schema", icon: "➕" },
    { id: "s4", title: "Add column", prompt: "Write an ALTER TABLE to add a new column [name] of type [type] to [table]", category: "schema", icon: "📎" },
    { id: "s5", title: "Create index", prompt: "Suggest optimal indexes for the table [table name] based on common query patterns", category: "schema", icon: "⚡" },

    // ── Data Quality ──
    { id: "d1", title: "Find duplicates", prompt: "Find duplicate rows in [table name] based on [columns]", category: "data", icon: "🔍" },
    { id: "d2", title: "NULL analysis", prompt: "Show columns with high NULL percentages across all tables", category: "data", icon: "❓" },
    { id: "d3", title: "Orphaned records", prompt: "Find orphaned records — rows referencing non-existent parents via foreign keys", category: "data", icon: "👻" },
    { id: "d4", title: "Data distribution", prompt: "Show value distribution and cardinality for columns in [table name]", category: "data", icon: "📊" },
    { id: "d5", title: "Validate constraints", prompt: "Check data integrity — find rows that violate expected business rules in [table]", category: "data", icon: "✅" },

    // ── Security ──
    { id: "sec1", title: "User permissions", prompt: "Show all database roles and their permissions on tables/schemas", category: "security", icon: "👤" },
    { id: "sec2", title: "RLS policies", prompt: "Create Row Level Security policies for [table] to restrict access by [criteria]", category: "security", icon: "🛡️" },
    { id: "sec3", title: "Audit log", prompt: "Create an audit trigger to log all INSERT/UPDATE/DELETE operations on [table]", category: "security", icon: "📜" },

    // ── Analytics ──
    { id: "a1", title: "Time series", prompt: "Write a time series query with date_trunc to aggregate [metric] by [day/week/month]", category: "analytics", icon: "📅" },
    { id: "a2", title: "Percentiles", prompt: "Calculate percentiles (p50, p90, p99) for [metric] in [table]", category: "analytics", icon: "📐" },
    { id: "a3", title: "Retention cohort", prompt: "Build a retention/cohort analysis query for [user activity table]", category: "analytics", icon: "📊" },
    { id: "a4", title: "Running totals", prompt: "Calculate running totals and moving averages for [metric] over time", category: "analytics", icon: "📈" },

    // ── Migration ──
    { id: "m1", title: "Backup table", prompt: "Write a safe backup query — CREATE TABLE AS SELECT — for [table] before migration", category: "migration", icon: "💾" },
    { id: "m2", title: "Rename column", prompt: "Safely rename a column in [table] from [old_name] to [new_name] with zero downtime", category: "migration", icon: "✏️" },
    { id: "m3", title: "Data migration", prompt: "Write a data migration script to transform data from [old format] to [new format] in [table]", category: "migration", icon: "🔄" },

    // ── Debug ──
    { id: "bug1", title: "Lock detection", prompt: "Show currently held locks, blocking queries, and deadlock detection", category: "debug", icon: "🔒" },
    { id: "bug2", title: "Long running", prompt: "Find queries running longer than 30 seconds and show their state", category: "debug", icon: "⏱️" },
    { id: "bug3", title: "Dead tuples", prompt: "Show tables with high dead tuple counts that need VACUUM", category: "debug", icon: "💀" },
    { id: "bug4", title: "Explain error", prompt: "Explain this PostgreSQL error and how to fix it:\n\n```\n-- paste error here\n```", category: "debug", icon: "🐛" },
];

/** Get 6 featured templates for the empty state */
export function getFeaturedTemplates(): PromptTemplate[] {
    return [
        DEFAULT_TEMPLATES.find((t) => t.id === "s1")!,
        DEFAULT_TEMPLATES.find((t) => t.id === "s2")!,
        DEFAULT_TEMPLATES.find((t) => t.id === "p2")!,
        DEFAULT_TEMPLATES.find((t) => t.id === "d1")!,
        DEFAULT_TEMPLATES.find((t) => t.id === "p6")!,
        DEFAULT_TEMPLATES.find((t) => t.id === "q1")!,
    ];
}
