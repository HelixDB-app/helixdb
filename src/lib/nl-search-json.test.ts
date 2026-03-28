import assert from "node:assert/strict";
import test from "node:test";
import { parseNlSearchModelJson } from "./nl-search-json.ts";

test("parseNlSearchModelJson extracts JSON from fenced block", () => {
    const raw = '```json\n{"sql":"SELECT 1","title":"t","explanation":"e","tablesUsed":[]}\n```';
    const p = parseNlSearchModelJson(raw);
    assert.equal(p?.sql, "SELECT 1");
    assert.equal(p?.title, "t");
    assert.equal(p?.explanation, "e");
    assert.deepEqual(p?.tablesUsed, []);
});

test("parseNlSearchModelJson finds object in prose", () => {
    const raw = 'Here you go:\n{"sql":"SELECT 2","title":"","explanation":"","tablesUsed":["public.a"]}\nThanks';
    const p = parseNlSearchModelJson(raw);
    assert.equal(p?.sql, "SELECT 2");
    assert.deepEqual(p?.tablesUsed, ["public.a"]);
});

test("parseNlSearchModelJson returns null on invalid JSON", () => {
    assert.equal(parseNlSearchModelJson("not json"), null);
    assert.equal(parseNlSearchModelJson("{broken"), null);
});
