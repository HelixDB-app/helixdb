import type { QueryResult } from "@/lib/types";
import {
    dbSandboxBegin,
    dbSandboxExecute,
    dbSandboxRollback,
    type SandboxExecuteResult,
} from "@/lib/tauri";

export type SqlTestPrimitive = string | number | boolean | null;

export interface SqlTestExpected {
    rowCount?: number;
    columnValues?: Record<string, SqlTestPrimitive[]>;
    errorIncludes?: string;
}

export interface SqlTestCase {
    id: string;
    name: string;
    sql: string;
    expected: SqlTestExpected;
    createdAt: number;
}

export type SqlAssertionKind = "row_count" | "column_values" | "error" | "execution";

export interface SqlAssertionResult {
    kind: SqlAssertionKind;
    passed: boolean;
    message: string;
    column?: string;
    expected?: unknown;
    actual?: unknown;
}

export interface SqlTestResult {
    id: string;
    name: string;
    sql: string;
    passed: boolean;
    assertions: SqlAssertionResult[];
    durationMs: number;
    executedAt: number;
    queryType: string | null;
    errorMessage: string | null;
    fixSuggestion: string | null;
}

export interface SqlTestSuiteRunOptions {
    connectionId: string;
    signal?: AbortSignal;
    onProgress?: (result: SqlTestResult, completed: number, total: number) => void;
}

export interface SqlTestReport {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    totalDurationMs: number;
    averageDurationMs: number;
    statusChartData: Array<{
        name: "Passed" | "Failed";
        value: number;
        fill: string;
    }>;
    durationChartData: Array<{
        name: string;
        durationMs: number;
        status: "Passed" | "Failed";
        fill: string;
    }>;
}

export interface SqlTestSourceParseResult {
    testCases: SqlTestCase[];
    warnings: string[];
    error: string | null;
    errorLine?: number;
    errorColumn?: number;
}

export interface SqlAutoTableTarget {
    schema: string;
    name: string;
    rowCount?: number | null;
}

export interface SqlAutoTableGenerationOptions {
    includeMetadataCheck?: boolean;
    includeReadSmoke?: boolean;
}

function extractErrorLocation(error: unknown): { line?: number; column?: number } {
    if (!(error instanceof Error) || !error.stack) return {};

    const bySourceUrl = error.stack.match(/sql-unit-tests\.dsl\.js:(\d+):(\d+)/);
    if (bySourceUrl) {
        const line = Number(bySourceUrl[1]);
        const column = Number(bySourceUrl[2]);
        return {
            line: Number.isFinite(line) ? line : undefined,
            column: Number.isFinite(column) ? column : undefined,
        };
    }

    const generic = error.stack.match(/<anonymous>:(\d+):(\d+)/);
    if (generic) {
        const line = Number(generic[1]);
        const column = Number(generic[2]);
        return {
            line: Number.isFinite(line) ? line : undefined,
            column: Number.isFinite(column) ? column : undefined,
        };
    }

    return {};
}

const PASS_COLOR = "#22c55e";
const FAIL_COLOR = "#ef4444";

let testCounter = 0;

function nowMs(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
    }
    return Date.now();
}

function cleanErrorMessage(message: string): string {
    const trimmed = message.trim();
    return trimmed.startsWith("db error: ") ? trimmed.slice(10).trim() : trimmed;
}

function toPrimitive(value: unknown): SqlTestPrimitive {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    return String(value);
}

function toComparable(value: SqlTestPrimitive): string | null {
    if (value === null) return null;
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeExpected(expected: unknown): SqlTestExpected {
    if (expected === undefined || expected === null) return {};
    if (!isPlainObject(expected)) {
        throw new Error("Expected assertion payload must be an object.");
    }

    const normalized: SqlTestExpected = {};

    if ("rowCount" in expected && expected.rowCount !== undefined) {
        const rowCount = Number(expected.rowCount);
        if (!Number.isFinite(rowCount) || rowCount < 0) {
            throw new Error("expected.rowCount must be a non-negative number.");
        }
        normalized.rowCount = rowCount;
    }

    if ("errorIncludes" in expected && expected.errorIncludes !== undefined) {
        const token = String(expected.errorIncludes).trim();
        if (token.length === 0) throw new Error("expected.errorIncludes cannot be empty.");
        normalized.errorIncludes = token;
    }

    if ("columnValues" in expected && expected.columnValues !== undefined) {
        if (!isPlainObject(expected.columnValues)) {
            throw new Error("expected.columnValues must be an object: { column: [values...] }.");
        }
        const columnValues: Record<string, SqlTestPrimitive[]> = {};
        for (const [column, values] of Object.entries(expected.columnValues)) {
            const cleanColumn = column.trim();
            if (!cleanColumn) throw new Error("columnValues keys cannot be empty.");
            if (!Array.isArray(values)) throw new Error(`columnValues.${cleanColumn} must be an array.`);
            columnValues[cleanColumn] = values.map((value) => toPrimitive(value));
        }
        normalized.columnValues = columnValues;
    }

    return normalized;
}

function newTestId(): string {
    testCounter += 1;
    return `sql-test-${testCounter}-${Date.now()}`;
}

function normalizeTestCase(testCase: SqlTestCase): SqlTestCase {
    return {
        id: testCase.id.trim(),
        name: testCase.name.trim(),
        sql: testCase.sql.trim(),
        expected: normalizeExpected(testCase.expected),
        createdAt: testCase.createdAt,
    };
}

function coerceTestCase(raw: unknown, label = "test case"): SqlTestCase {
    if (!isPlainObject(raw)) {
        throw new Error(`${label} must be an object.`);
    }

    const name = String(raw.name ?? "").trim();
    const sql = String(raw.sql ?? "").trim();
    const expected = normalizeExpected(raw.expected);
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : newTestId();
    const createdAt = Number(raw.createdAt);

    if (!name) throw new Error(`${label} is missing a valid name.`);
    if (!sql) throw new Error(`${label} is missing SQL content.`);

    return normalizeTestCase({
        id,
        name,
        sql,
        expected,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    });
}

export function createTestCase(
    name: string,
    sql: string,
    expected: SqlTestExpected = {}
): SqlTestCase {
    const cleanName = name.trim();
    const cleanSql = sql.trim();

    if (!cleanName) {
        throw new Error("Test case name cannot be empty.");
    }
    if (!cleanSql) {
        throw new Error(`SQL cannot be empty for test "${cleanName}".`);
    }

    return normalizeTestCase({
        id: newTestId(),
        name: cleanName,
        sql: cleanSql,
        expected,
        createdAt: Date.now(),
    });
}

export function assertRowCount(sql: string, expected: number, name?: string): SqlTestCase {
    const title = name?.trim() || `Assert row count = ${expected}`;
    return createTestCase(title, sql, { rowCount: expected });
}

export function assertColumnValues(
    sql: string,
    column: string,
    expected: SqlTestPrimitive[],
    name?: string
): SqlTestCase {
    const cleanColumn = column.trim();
    if (!cleanColumn) throw new Error("Column name is required for assertColumnValues.");
    const title = name?.trim() || `Assert column values: ${cleanColumn}`;
    return createTestCase(title, sql, { columnValues: { [cleanColumn]: expected } });
}

function resultCellToPrimitive(cell: QueryResult["rows"][number][number] | undefined): SqlTestPrimitive {
    if (!cell || cell.type === "Null") return null;
    const value = cell.value;
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    return JSON.stringify(value);
}

export function generateTestFromResult(queryResult: QueryResult, name = "Generated from current result"): SqlTestCase {
    const querySql = queryResult.query?.trim();
    if (!querySql) {
        throw new Error("Cannot generate test: query text is missing.");
    }

    if (queryResult.is_error) {
        return createTestCase(name, querySql, {
            errorIncludes: queryResult.error_message?.slice(0, 120) || "error",
        });
    }

    const expected: SqlTestExpected = {
        rowCount: queryResult.row_count,
    };

    if (queryResult.columns.length > 0 && queryResult.rows.length > 0) {
        const firstColumn = queryResult.columns[0].name;
        expected.columnValues = {
            [firstColumn]: queryResult.rows
                .slice(0, 10)
                .map((row) => resultCellToPrimitive(row[0])),
        };
    }

    return createTestCase(name, querySql, expected);
}

function getActualRowCount(result: SandboxExecuteResult): number {
    const queryType = (result.query_type || "").toUpperCase();
    if (queryType === "SELECT") return result.select_rows.length;
    return Number(result.rows_affected ?? 0);
}

function evaluateRowCountAssertion(
    testCase: SqlTestCase,
    executionResult: SandboxExecuteResult
): SqlAssertionResult | null {
    if (testCase.expected.rowCount === undefined) return null;

    const actual = getActualRowCount(executionResult);
    const expected = testCase.expected.rowCount;
    const passed = actual === expected;

    return {
        kind: "row_count",
        passed,
        message: passed
            ? `Row count matched (${actual}).`
            : `Row count mismatch. Expected ${expected}, got ${actual}.`,
        expected,
        actual,
    };
}

function evaluateColumnAssertions(
    testCase: SqlTestCase,
    executionResult: SandboxExecuteResult
): SqlAssertionResult[] {
    const entries = Object.entries(testCase.expected.columnValues ?? {});
    if (entries.length === 0) return [];

    const queryType = (executionResult.query_type || "").toUpperCase();
    if (queryType !== "SELECT") {
        return entries.map(([column]) => ({
            kind: "column_values",
            passed: false,
            column,
            message: `Column assertion requires SELECT output, but query type was ${executionResult.query_type}.`,
            expected: testCase.expected.columnValues?.[column] ?? [],
            actual: [],
        }));
    }

    return entries.map(([column, expectedValues]) => {
        const targetColumn = column.toLowerCase();
        const columnIndex = executionResult.select_columns.findIndex(
            (candidate) => candidate.toLowerCase() === targetColumn
        );

        if (columnIndex === -1) {
            return {
                kind: "column_values",
                passed: false,
                column,
                message: `Column "${column}" was not present in query output.`,
                expected: expectedValues,
                actual: executionResult.select_columns,
            };
        }

        const actualValues = executionResult.select_rows.map((row) => {
            const value = row[columnIndex];
            return value === undefined ? null : value;
        });
        const comparableExpected = expectedValues.map((value) => toComparable(toPrimitive(value)));
        const comparableActual = actualValues.map((value) =>
            value === null || value === undefined ? null : String(value)
        );

        if (comparableActual.length !== comparableExpected.length) {
            return {
                kind: "column_values",
                passed: false,
                column,
                message: `Column "${column}" length mismatch. Expected ${comparableExpected.length}, got ${comparableActual.length}.`,
                expected: comparableExpected,
                actual: comparableActual,
            };
        }

        for (let idx = 0; idx < comparableExpected.length; idx += 1) {
            if (comparableExpected[idx] !== comparableActual[idx]) {
                return {
                    kind: "column_values",
                    passed: false,
                    column,
                    message: `Column "${column}" mismatch at row ${idx + 1}. Expected "${String(comparableExpected[idx])}", got "${String(comparableActual[idx])}".`,
                    expected: comparableExpected,
                    actual: comparableActual,
                };
            }
        }

        return {
            kind: "column_values",
            passed: true,
            column,
            message: `Column "${column}" matched expected values.`,
            expected: comparableExpected,
            actual: comparableActual,
        };
    });
}

function buildFixSuggestion(assertions: SqlAssertionResult[], errorMessage: string | null): string | null {
    if (errorMessage) {
        return "Fix SQL syntax/runtime issue first, then re-run. If this failure is expected, set expected.errorIncludes.";
    }
    const firstFailure = assertions.find((assertion) => !assertion.passed);
    if (!firstFailure) return null;

    if (firstFailure.kind === "row_count") {
        return "Review fixture data and WHERE clause, then align expected.rowCount with deterministic data.";
    }
    if (firstFailure.kind === "column_values") {
        return "Ensure deterministic ordering (ORDER BY) and verify expected column alias/value list.";
    }
    if (firstFailure.kind === "error") {
        return "Update expected.errorIncludes to match the exact failure message or fix the SQL if the error is not intended.";
    }
    return "Inspect assertion details and adjust SQL or expected output.";
}

function ensureNotAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return;
    const abortError = new Error("Test run cancelled.");
    abortError.name = "AbortError";
    throw abortError;
}

function evaluateTestResult(
    testCase: SqlTestCase,
    executionResult: SandboxExecuteResult | null,
    executionError: string | null,
    durationMs: number
): SqlTestResult {
    const assertions: SqlAssertionResult[] = [];

    if (executionError) {
        if (testCase.expected.errorIncludes) {
            const expectedToken = testCase.expected.errorIncludes.toLowerCase();
            const passed = executionError.toLowerCase().includes(expectedToken);
            assertions.push({
                kind: "error",
                passed,
                message: passed
                    ? `Expected error matched token "${testCase.expected.errorIncludes}".`
                    : `Expected error to include "${testCase.expected.errorIncludes}", but received "${executionError}".`,
                expected: testCase.expected.errorIncludes,
                actual: executionError,
            });
        } else {
            assertions.push({
                kind: "execution",
                passed: false,
                message: `Execution failed: ${executionError}`,
                actual: executionError,
            });
        }
    } else if (executionResult) {
        if (testCase.expected.errorIncludes) {
            assertions.push({
                kind: "error",
                passed: false,
                message: `Expected an error containing "${testCase.expected.errorIncludes}", but query succeeded.`,
                expected: testCase.expected.errorIncludes,
                actual: null,
            });
        } else {
            const rowCountAssertion = evaluateRowCountAssertion(testCase, executionResult);
            if (rowCountAssertion) assertions.push(rowCountAssertion);
            assertions.push(...evaluateColumnAssertions(testCase, executionResult));

            if (assertions.length === 0) {
                assertions.push({
                    kind: "execution",
                    passed: true,
                    message: "Query executed successfully.",
                });
            }
        }
    } else {
        assertions.push({
            kind: "execution",
            passed: false,
            message: "No execution result returned.",
        });
    }

    const passed = assertions.every((assertion) => assertion.passed);
    return {
        id: testCase.id,
        name: testCase.name,
        sql: testCase.sql,
        passed,
        assertions,
        durationMs,
        executedAt: Date.now(),
        queryType: executionResult?.query_type ?? null,
        errorMessage: executionError,
        fixSuggestion: buildFixSuggestion(assertions, executionError),
    };
}

export async function runTestSuite(
    testCases: SqlTestCase[],
    options: SqlTestSuiteRunOptions
): Promise<SqlTestResult[]> {
    const normalizedCases = testCases.map((testCase, index) =>
        coerceTestCase(testCase, `testCases[${index}]`)
    );

    const results: SqlTestResult[] = [];
    const total = normalizedCases.length;

    for (let index = 0; index < total; index += 1) {
        ensureNotAborted(options.signal);

        const testCase = normalizedCases[index];
        const startedAt = nowMs();
        let sandboxId: string | null = null;
        let executionResult: SandboxExecuteResult | null = null;
        let executionError: string | null = null;

        try {
            sandboxId = await dbSandboxBegin(options.connectionId);
            executionResult = await dbSandboxExecute(sandboxId, testCase.sql);
        } catch (error) {
            executionError = cleanErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
            if (sandboxId) {
                await dbSandboxRollback(sandboxId).catch(() => {});
            }
        }

        const durationMs = nowMs() - startedAt;
        const result = evaluateTestResult(testCase, executionResult, executionError, durationMs);
        results.push(result);
        options.onProgress?.(result, index + 1, total);
    }

    return results;
}

export function renderTestReport(results: SqlTestResult[]): SqlTestReport {
    const total = results.length;
    const passed = results.filter((result) => result.passed).length;
    const failed = total - passed;
    const totalDurationMs = results.reduce((sum, result) => sum + result.durationMs, 0);
    const averageDurationMs = total > 0 ? totalDurationMs / total : 0;

    return {
        total,
        passed,
        failed,
        passRate: total > 0 ? (passed / total) * 100 : 0,
        totalDurationMs,
        averageDurationMs,
        statusChartData: [
            { name: "Passed", value: passed, fill: PASS_COLOR },
            { name: "Failed", value: failed, fill: FAIL_COLOR },
        ],
        durationChartData: results.map((result) => ({
            name: result.name.length > 28 ? `${result.name.slice(0, 28)}…` : result.name,
            durationMs: Number(result.durationMs.toFixed(2)),
            status: result.passed ? "Passed" : "Failed",
            fill: result.passed ? PASS_COLOR : FAIL_COLOR,
        })),
    };
}

export function parseSqlUnitTestSource(source: string): SqlTestSourceParseResult {
    const warnings: string[] = [];
    const registered: SqlTestCase[] = [];
    let suiteFromRuntime: SqlTestCase[] | null = null;

    const register = (testCase: SqlTestCase): SqlTestCase => {
        registered.push(testCase);
        return testCase;
    };

    const runtimeCreateTestCase = (name: string, sql: string, expected?: SqlTestExpected): SqlTestCase =>
        register(createTestCase(name, sql, expected ?? {}));

    const runtimeAssertRowCount = (sql: string, expected: number, name?: string): SqlTestCase =>
        register(assertRowCount(sql, expected, name));

    const runtimeAssertColumnValues = (
        sql: string,
        column: string,
        expected: SqlTestPrimitive[],
        name?: string
    ): SqlTestCase => register(assertColumnValues(sql, column, expected, name));

    const runtimeGenerateFromResult = (queryResult: QueryResult, name?: string): SqlTestCase =>
        register(generateTestFromResult(queryResult, name));

    const runtimeRunTestSuite = (testCases?: unknown): SqlTestCase[] => {
        if (testCases === undefined) {
            suiteFromRuntime = [...registered];
            return suiteFromRuntime;
        }
        if (!Array.isArray(testCases)) {
            throw new Error("runTestSuite(testCases) expects an array.");
        }
        suiteFromRuntime = testCases.map((item, index) => coerceTestCase(item, `runTestSuite[${index}]`));
        return suiteFromRuntime;
    };

    if (!source.trim()) {
        return {
            testCases: [],
            warnings,
            error: "Test source is empty.",
            errorLine: undefined,
            errorColumn: undefined,
        };
    }

    try {
        const runner = new Function(
            "createTestCase",
            "runTestSuite",
            "assertRowCount",
            "assertColumnValues",
            "generateTestFromResult",
            `"use strict";\n${source}\n//# sourceURL=sql-unit-tests.dsl.js`
        ) as (
            createTestCaseFn: typeof runtimeCreateTestCase,
            runTestSuiteFn: typeof runtimeRunTestSuite,
            assertRowCountFn: typeof runtimeAssertRowCount,
            assertColumnValuesFn: typeof runtimeAssertColumnValues,
            generateTestFromResultFn: typeof runtimeGenerateFromResult
        ) => unknown;

        const maybeReturnedSuite = runner(
            runtimeCreateTestCase,
            runtimeRunTestSuite,
            runtimeAssertRowCount,
            runtimeAssertColumnValues,
            runtimeGenerateFromResult
        );

        if (Array.isArray(maybeReturnedSuite)) {
            suiteFromRuntime = maybeReturnedSuite.map((item, index) =>
                coerceTestCase(item, `returned[${index}]`)
            );
        }
    } catch (error) {
        const location = extractErrorLocation(error);
        return {
            testCases: [],
            warnings,
            error: cleanErrorMessage(error instanceof Error ? error.message : String(error)),
            errorLine: location.line,
            errorColumn: location.column,
        };
    }

    const testCases = suiteFromRuntime ?? registered;
    if (testCases.length === 0) {
        warnings.push("No tests discovered. Define tests with createTestCase/assert helpers.");
    }

    return {
        testCases,
        warnings,
        error: null,
        errorLine: undefined,
        errorColumn: undefined,
    };
}

export function formatTestCaseSnippet(testCase: SqlTestCase): string {
    const expected: Record<string, unknown> = {};
    if (testCase.expected.rowCount !== undefined) expected.rowCount = testCase.expected.rowCount;
    if (testCase.expected.columnValues) expected.columnValues = testCase.expected.columnValues;
    if (testCase.expected.errorIncludes) expected.errorIncludes = testCase.expected.errorIncludes;

    const escapedSql = testCase.sql
        .trim()
        .replace(/`/g, "\\`")
        .replace(/\$\{/g, "\\${");
    const expectedJson = JSON.stringify(expected, null, 2) ?? "{}";

    return [
        `createTestCase(${JSON.stringify(testCase.name)},`,
        "    `",
        escapedSql,
        "    `,",
        `    ${expectedJson}`,
        ");",
    ].join("\n");
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, "\"\"")}"`;
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function sanitizeVarToken(value: string): string {
    const token = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    if (!token) return "table_test";
    if (/^\d/.test(token)) return `t_${token}`;
    return token;
}

function tableLabel(target: SqlAutoTableTarget): string {
    return `${target.schema}.${target.name}`;
}

export function generateAutoTableTestCases(
    targets: SqlAutoTableTarget[],
    options?: SqlAutoTableGenerationOptions
): SqlTestCase[] {
    const includeMetadataCheck = options?.includeMetadataCheck ?? true;
    const includeReadSmoke = options?.includeReadSmoke ?? true;
    const out: SqlTestCase[] = [];

    for (const target of targets) {
        const schema = target.schema.trim();
        const name = target.name.trim();
        if (!schema || !name) continue;

        if (includeMetadataCheck) {
            out.push(
                createTestCase(
                    `Table exists: ${tableLabel(target)}`,
                    `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = ${quoteLiteral(schema)}
  AND table_name = ${quoteLiteral(name)};
                    `,
                    { rowCount: 1 }
                )
            );

            out.push(
                createTestCase(
                    `Has columns: ${tableLabel(target)}`,
                    `
SELECT column_name
FROM information_schema.columns
WHERE table_schema = ${quoteLiteral(schema)}
  AND table_name = ${quoteLiteral(name)}
ORDER BY ordinal_position
LIMIT 1;
                    `,
                    { rowCount: 1 }
                )
            );
        }

        if (includeReadSmoke) {
            out.push(
                createTestCase(
                    `Read smoke: ${tableLabel(target)}`,
                    `
SELECT *
FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)}
LIMIT 25;
                    `,
                    {}
                )
            );
        }
    }

    return out;
}

export function generateAutoTableTestSource(
    targets: SqlAutoTableTarget[],
    options?: SqlAutoTableGenerationOptions
): string {
    const cases = generateAutoTableTestCases(targets, options);
    const namesUsed = new Set<string>();
    const vars: string[] = [];
    const lines: string[] = [];

    lines.push("// Auto-generated SQL unit tests by HelixDB");
    lines.push("// Review and adjust expected values before running in production.");
    lines.push("");

    for (const testCase of cases) {
        const base = sanitizeVarToken(testCase.name.toLowerCase());
        let candidate = base;
        let suffix = 2;
        while (namesUsed.has(candidate)) {
            candidate = `${base}_${suffix}`;
            suffix += 1;
        }
        namesUsed.add(candidate);
        vars.push(candidate);

        const snippet = formatTestCaseSnippet(testCase);
        const snippetLines = snippet.split("\n");
        const [first, ...rest] = snippetLines;
        lines.push(`const ${candidate} = ${first}`);
        lines.push(...rest);
        lines.push("");
    }

    lines.push(`runTestSuite([${vars.join(", ")}]);`);
    return lines.join("\n");
}
