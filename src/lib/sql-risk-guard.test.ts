import assert from "node:assert/strict";
import test from "node:test";
import {
    classifySqlRisk,
    shouldRequireProductionGuard,
} from "./sql-risk-guard.ts";

test("classifySqlRisk marks risky write statements", () => {
    const result = classifySqlRisk("UPDATE users SET active = false WHERE id = 10;");

    assert.equal(result.isRisky, true);
    assert.deepEqual(result.riskyStatements, ["UPDATE"]);
});

test("classifySqlRisk handles multiple statement types and deduplicates risky names", () => {
    const result = classifySqlRisk(`
        DELETE FROM sessions WHERE user_id = 1;
        ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
        DROP TABLE old_sessions;
        DELETE FROM sessions WHERE user_id = 2;
    `);

    assert.deepEqual(result.riskyStatements, ["DELETE", "ALTER", "DROP"]);
});

test("classifySqlRisk ignores risky keywords in comments and strings", () => {
    const result = classifySqlRisk(`
        -- UPDATE users SET role = 'admin';
        SELECT 'DROP TABLE users' AS sample_text;
        SELECT 1;
    `);

    assert.equal(result.isRisky, false);
    assert.deepEqual(result.riskyStatements, []);
});

test("classifySqlRisk resolves risky keyword behind WITH CTE", () => {
    const result = classifySqlRisk(`
        WITH changed AS (
            UPDATE users SET active = true WHERE id = 42 RETURNING id
        )
        SELECT * FROM changed;
    `);

    assert.equal(result.isRisky, true);
    assert.deepEqual(result.riskyStatements, ["UPDATE"]);
});

test("production guard required only in prod + strict mode + risky SQL", () => {
    const prodStrict = shouldRequireProductionGuard({
        strictProductionGuard: true,
        environment: "prod",
        sql: "TRUNCATE TABLE audit_log;",
    });
    const prodRelaxed = shouldRequireProductionGuard({
        strictProductionGuard: false,
        environment: "prod",
        sql: "TRUNCATE TABLE audit_log;",
    });
    const stagingStrict = shouldRequireProductionGuard({
        strictProductionGuard: true,
        environment: "staging",
        sql: "TRUNCATE TABLE audit_log;",
    });
    const prodSelect = shouldRequireProductionGuard({
        strictProductionGuard: true,
        environment: "prod",
        sql: "SELECT * FROM audit_log LIMIT 10;",
    });

    assert.equal(prodStrict.required, true);
    assert.equal(prodRelaxed.required, false);
    assert.equal(stagingStrict.required, false);
    assert.equal(prodSelect.required, false);
});
