import {
    normalizeConnectionEnvironment,
} from "./connection-metadata.ts";
import type { ConnectionEnvironment } from "./types";

export const STRICT_PRODUCTION_CONFIRMATION = "RUN IN PROD";

const RISKY_SQL_TYPES = [
    "UPDATE",
    "DELETE",
    "ALTER",
    "DROP",
    "TRUNCATE",
] as const;

export type RiskySqlType = (typeof RISKY_SQL_TYPES)[number];

export interface SqlRiskClassification {
    statementTypes: string[];
    riskyStatements: RiskySqlType[];
    isRisky: boolean;
}

export interface ProductionGuardDecision {
    required: boolean;
    classification: SqlRiskClassification;
}

interface SqlStatement {
    text: string;
}

function splitStatements(sql: string): SqlStatement[] {
    const statements: SqlStatement[] = [];
    let start = 0;
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let dollarTag: string | null = null;

    const pushStatement = (endExclusive: number) => {
        const fragment = sql.slice(start, endExclusive);
        if (fragment.trim().length > 0) {
            statements.push({ text: fragment });
        }
        start = endExclusive;
    };

    while (i < sql.length) {
        const ch = sql[i];
        const next = i + 1 < sql.length ? sql[i + 1] : "";

        if (inLineComment) {
            if (ch === "\n") inLineComment = false;
            i += 1;
            continue;
        }

        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if (dollarTag) {
            if (sql.startsWith(dollarTag, i)) {
                i += dollarTag.length;
                dollarTag = null;
                continue;
            }
            i += 1;
            continue;
        }

        if (inSingle) {
            if (ch === "'" && next === "'") {
                i += 2;
                continue;
            }
            if (ch === "'") inSingle = false;
            i += 1;
            continue;
        }

        if (inDouble) {
            if (ch === '"' && next === '"') {
                i += 2;
                continue;
            }
            if (ch === '"') inDouble = false;
            i += 1;
            continue;
        }

        if (ch === "-" && next === "-") {
            inLineComment = true;
            i += 2;
            continue;
        }

        if (ch === "/" && next === "*") {
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (ch === "'") {
            inSingle = true;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inDouble = true;
            i += 1;
            continue;
        }

        if (ch === "$") {
            const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
            if (match) {
                dollarTag = match[0];
                i += match[0].length;
                continue;
            }
        }

        if (ch === ";") {
            pushStatement(i + 1);
            i += 1;
            continue;
        }

        i += 1;
    }

    if (start < sql.length) {
        pushStatement(sql.length);
    }

    return statements;
}

function firstKeyword(statement: string): string {
    const cleaned = statement.trim().replace(/^;+/, "").trim();
    if (!cleaned) return "UNKNOWN";

    const first = cleaned.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? "UNKNOWN";
    if (first !== "WITH") return first;

    const cteResolved = cleaned.match(
        /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE)\b/i
    )?.[1];

    return cteResolved ? cteResolved.toUpperCase() : "WITH";
}

function uniqueRiskyTypes(types: string[]): RiskySqlType[] {
    const out: RiskySqlType[] = [];
    const seen = new Set<string>();

    for (const type of types) {
        const candidate = type.toUpperCase();
        if (!RISKY_SQL_TYPES.includes(candidate as RiskySqlType)) continue;
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        out.push(candidate as RiskySqlType);
    }

    return out;
}

export function classifySqlRisk(sql: string): SqlRiskClassification {
    const statementTypes = splitStatements(sql)
        .map((statement) => firstKeyword(statement.text))
        .filter((keyword) => keyword !== "UNKNOWN");

    const riskyStatements = uniqueRiskyTypes(statementTypes);

    return {
        statementTypes,
        riskyStatements,
        isRisky: riskyStatements.length > 0,
    };
}

/** NL search may only run read-only SQL (SELECT / WITH … SELECT). */
export function validateNlGeneratedSql(sql: string): { ok: true } | { ok: false; error: string } {
    const trimmed = sql.trim();
    if (!trimmed) {
        return { ok: false, error: "Empty SQL." };
    }

    const risk = classifySqlRisk(trimmed);
    if (risk.isRisky) {
        return {
            ok: false,
            error: `Generated SQL is not read-only (disallowed: ${risk.riskyStatements.join(", ")}).`,
        };
    }

    const statements = splitStatements(trimmed);
    if (statements.length === 0) {
        return { ok: false, error: "No executable SQL found." };
    }

    for (const statement of statements) {
        const kw = firstKeyword(statement.text);
        if (kw !== "SELECT" && kw !== "WITH") {
            return {
                ok: false,
                error: `Natural language search only allows SELECT queries (got “${kw}”).`,
            };
        }
    }

    return { ok: true };
}

export function shouldRequireProductionGuard(options: {
    strictProductionGuard: boolean;
    environment?: ConnectionEnvironment | string | null;
    sql: string;
}): ProductionGuardDecision {
    const classification = classifySqlRisk(options.sql);
    const environment = normalizeConnectionEnvironment(options.environment);

    return {
        required:
            options.strictProductionGuard &&
            environment === "prod" &&
            classification.isRisky,
        classification,
    };
}
