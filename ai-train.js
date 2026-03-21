/**
 * PgStudio AI Tab Completion Worker
 * Cloudflare Worker — PostgreSQL-optimized next-line prediction
 *
 * Design principles:
 *  - Static system prompt (never sent by client, zero payload overhead)
 *  - Schema-aware, prefix-keyed LRU cache with aggressive TTL tuning
 *  - Completion-only response contract (no metadata bloat on hot path)
 *  - Single-purpose: SQL completions. No general chat, no multi-turn.
 */

// ============================================================================
// STATIC SYSTEM PROMPT — baked in, never travels over the wire
// ============================================================================

const SYSTEM_PROMPT = `You are PgStudio Copilot, an expert PostgreSQL autocompletion engine embedded in a native SQL editor.

Your ONLY job is to predict and complete the next logical fragment of a PostgreSQL query.

## Output Rules (STRICT)
- Return ONLY the raw SQL completion text — no explanation, no markdown, no code fences, no preamble
- Complete exactly ONE logical unit: one clause, one expression, one column list, or one keyword sequence
- Do NOT repeat any part of the input SQL that was already written
- Do NOT add a trailing semicolon unless the input clearly ends a complete statement
- If the input is already complete and nothing meaningful can be added, return an empty string

## Completion Behavior
- After SELECT → suggest column list using schema context if provided, else use *
- After FROM → suggest the most contextually relevant table name
- After WHERE / AND / OR → suggest a predicate using indexed columns when possible
- After INSERT INTO <table> → suggest (column_list) VALUES (placeholders)
- After UPDATE <table> SET → suggest column = $1 assignments
- After CREATE TABLE → suggest a well-formed column definition block
- After JOIN → suggest ON <table>.<fk> = <table>.<pk> using schema context
- After ORDER BY → suggest the most relevant sort column with direction
- After GROUP BY → suggest grouping columns matching the SELECT clause
- Prefer $1, $2 … parameterized placeholders over literal values
- Use lowercase SQL keywords (select, from, where, join, …) to match the editor style
- Respect transaction context: inside BEGIN…END, bias toward DML completions
- Respect CTE context: inside WITH…AS, complete the inner query appropriately

## Schema Context
When a \`schema\` object is provided in the request, use it to suggest real table and column names.
Prioritize: primary keys, foreign keys, indexed columns, NOT NULL columns.
Never invent table or column names that are not in the provided schema.

## Style Preferences
- Align multi-line continuations with 2-space indentation
- For column lists longer than 3 items, suggest one column per line
- Do not add comments to the completion output`;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  'Content-Type': 'application/json',
};

const CFG = {
  // Use the fastest available model. Swap to a quantized 7B for lower latency
  // if response quality is acceptable for your use case.
  model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',

  // Max tokens for a completion fragment. Keep tight — completions should be short.
  maxTokens: 228,

  // Low temperature = deterministic, consistent SQL completions
  temperature: 0.1,

  cache: {
    maxItems: 500,       // completion cache is cheap — store more
    ttlSeconds: 1800,    // 30 min; SQL patterns repeat heavily within a session
    schemaHashTtl: 300,  // schema hash recomputed every 5 min max
  },

  // Strip leading/trailing whitespace and normalize internal whitespace
  // before hashing to maximise cache hits across equivalent queries
  normalizeInput: true,
};

// ============================================================================
// CACHE  — LRU with TTL, keyed by (schema_hash + normalized_sql_prefix)
// ============================================================================

class CompletionCache {
  constructor() {
    if (!globalThis._pgCache) {
      globalThis._pgCache = {
        items: new Map(),
        order: [],
        stats: { hits: 0, misses: 0, evictions: 0, purges: 0 },
        created: Date.now(),
      };
    }
    this._c = globalThis._pgCache;
  }

  /**
   * FNV-1a 32-bit hash — fast, good distribution for short strings
   */
  static _hash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36);
  }

  /**
   * Build a compact, stable cache key.
   *
   * Key anatomy:  <schema_hash>:<sql_prefix_hash>
   *
   * - schema_hash: hash of sorted table+column names. Same schema across
   *   many requests collapses to the same prefix, maximising re-use.
   * - sql_prefix_hash: hash of the normalized SQL written so far.
   */
  static buildKey(sqlPrefix, schema) {
    const normalizedSql = CFG.normalizeInput
      ? sqlPrefix.trim().replace(/\s+/g, ' ').toLowerCase()
      : sqlPrefix;

    const schemaFingerprint = schema
      ? CompletionCache._hash(
          Object.entries(schema)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([t, cols]) => `${t}:${[...cols].sort().join(',')}`)
            .join('|')
        )
      : 'noschema';

    return `${schemaFingerprint}:${CompletionCache._hash(normalizedSql)}`;
  }

  get(key) {
    const entry = this._c.items.get(key);
    if (!entry) { this._c.stats.misses++; return null; }
    if (Date.now() > entry.exp) {
      this._c.items.delete(key);
      this._c.stats.misses++;
      return null;
    }
    this._touch(key);
    this._c.stats.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this._c.items.size >= CFG.cache.maxItems) this._evict();
    this._c.items.set(key, {
      value,
      exp: Date.now() + CFG.cache.ttlSeconds * 1000,
    });
    this._touch(key);
  }

  _touch(key) {
    const i = this._c.order.indexOf(key);
    if (i > -1) this._c.order.splice(i, 1);
    this._c.order.push(key);
  }

  _evict() {
    const lru = this._c.order.shift();
    if (lru) { this._c.items.delete(lru); this._c.stats.evictions++; }
  }

  purgeExpired() {
    const now = Date.now();
    let n = 0;
    for (const [k, v] of this._c.items) {
      if (now > v.exp) {
        this._c.items.delete(k);
        const i = this._c.order.indexOf(k);
        if (i > -1) this._c.order.splice(i, 1);
        n++;
      }
    }
    this._c.stats.purges += n;
    return n;
  }

  stats() {
    const { hits, misses, evictions, purges } = this._c.stats;
    const total = hits + misses;
    return {
      size: this._c.items.size,
      maxItems: CFG.cache.maxItems,
      hitRate: total > 0 ? ((hits / total) * 100).toFixed(1) + '%' : '—',
      hits, misses, evictions, purges,
      ageSeconds: Math.round((Date.now() - this._c.created) / 1000),
    };
  }

  clear() {
    this._c.items.clear();
    this._c.order = [];
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate and extract the completion request payload.
 *
 * Expected request body:
 * {
 *   "sql":      string,   // REQUIRED — SQL written so far (cursor position = end)
 *   "schema":   object,   // optional — { tableName: ["col1", "col2", ...], ... }
 *   "dialect":  string,   // optional — reserved for future dialect hints (default: "postgresql")
 *   "skipCache": boolean  // optional — bypass cache for this request
 * }
 */
function validateRequest(body) {
  if (!body || typeof body !== 'object') {
    throw Object.assign(new Error('Request body must be a JSON object'), { status: 400 });
  }

  if (typeof body.sql !== 'string' || body.sql.trim().length === 0) {
    throw Object.assign(new Error('"sql" field is required and must be a non-empty string'), { status: 400 });
  }

  if (body.sql.length > 8000) {
    throw Object.assign(new Error('"sql" must be 8000 characters or fewer'), { status: 400 });
  }

  if (body.schema !== undefined && (typeof body.schema !== 'object' || Array.isArray(body.schema))) {
    throw Object.assign(new Error('"schema" must be an object mapping table names to column arrays'), { status: 400 });
  }

  return {
    sql: body.sql,
    schema: body.schema ?? null,
    skipCache: Boolean(body.skipCache),
  };
}

// ============================================================================
// SCHEMA SERIALIZER — convert schema object into a compact prompt snippet
// ============================================================================

/**
 * Produce a terse schema summary injected into the user message.
 * Keeping it short matters: every token costs latency.
 *
 * Output example:
 *   Tables: users(id,name,email,created_at), orders(id,user_id,total,status)
 */
function serializeSchema(schema) {
  if (!schema) return null;

  const lines = Object.entries(schema)
    .slice(0, 20) // guard: never blow up the prompt with a huge schema
    .map(([table, cols]) => {
      const colList = Array.isArray(cols)
        ? cols.slice(0, 15).join(', ')
        : String(cols);
      return `${table}(${colList})`;
    });

  return lines.length > 0 ? `Tables: ${lines.join('; ')}` : null;
}

// ============================================================================
// PROMPT BUILDER — assemble the minimal user message for the completion call
// ============================================================================

/**
 * We send a single user message. The system prompt is static (already attached).
 * The user message carries only what changes per request: the SQL + schema summary.
 *
 * Keeping the message compact is the single highest-impact latency optimization.
 */
function buildUserMessage(sql, schema) {
  const schemaPart = serializeSchema(schema);
  const parts = [];

  if (schemaPart) parts.push(schemaPart);
  parts.push(`SQL:\n${sql}`);
  parts.push('Complete:');

  return parts.join('\n\n');
}

// ============================================================================
// POST-PROCESSING — clean the raw model output
// ============================================================================

/**
 * The model occasionally leaks formatting artifacts.
 * Strip them and return pure SQL text.
 */
function cleanCompletion(raw) {
  if (!raw || typeof raw !== 'string') return '';

  return raw
    .replace(/^```(?:sql)?\n?/i, '')   // opening code fence
    .replace(/\n?```$/i, '')            // closing code fence
    .replace(/^(Complete:|Answer:|SQL:)\s*/i, '') // leaked prompt words
    .trimEnd();
}

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function err(message, status = 500) {
  return json({ error: message }, status);
}

// ============================================================================
// WORKER ENTRY POINT
// ============================================================================

const _cache = new CompletionCache();

export default {
  async fetch(request, env) {
    const t0 = performance.now();

    // ── Periodic maintenance (probabilistic — ~1% of requests) ──────────────
    if (Math.random() < 0.01) {
      _cache.purgeExpired();
    }

    // ── CORS preflight ───────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ── GET /health ──────────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname.endsWith('/health')) {
      return json({ ok: true, model: CFG.model, cache: _cache.stats() });
    }

    // ── GET /cache/stats ─────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname.endsWith('/cache/stats')) {
      return json(_cache.stats());
    }

    // ── DELETE /cache ─────────────────────────────────────────────────────────
    if (request.method === 'DELETE' && url.pathname.endsWith('/cache')) {
      _cache.clear();
      return json({ cleared: true });
    }

    // ── POST /complete ────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname.endsWith('/complete')) {
      return handleCompletion(request, env, t0);
    }

    return err('Not found', 404);
  },
};

// ============================================================================
// COMPLETION HANDLER
// ============================================================================

async function handleCompletion(request, env, t0) {
  // 1. Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON', 400);
  }

  // 2. Validate
  let params;
  try {
    params = validateRequest(body);
  } catch (e) {
    return err(e.message, e.status ?? 400);
  }

  // 3. Cache lookup
  const cacheKey = CompletionCache.buildKey(params.sql, params.schema);

  if (!params.skipCache) {
    const hit = _cache.get(cacheKey);
    if (hit !== null) {
      return json({
        completion: hit,
        cached: true,
        latency_ms: Math.round(performance.now() - t0),
      });
    }
  }

  // 4. Build AI payload — static system prompt + minimal user message
  const userMessage = buildUserMessage(params.sql, params.schema);

  const aiPayload = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
    temperature: CFG.temperature,
    max_tokens:  CFG.maxTokens,
  };

  // 5. Call the model
  let aiResponse;
  try {
    aiResponse = await env.AI.run(CFG.model, aiPayload);
  } catch (e) {
    const msg = e?.message ?? '';
    if (msg.includes('AI') || msg.includes('binding') || msg.includes('not found')) {
      return err('AI binding unavailable. Ensure Workers AI is bound as "AI".', 503);
    }
    return err('AI inference failed', 502);
  }

  // 6. Extract and clean the completion text
  //    Workers AI returns either a string or { response: string }
  const raw = typeof aiResponse === 'string'
    ? aiResponse
    : (aiResponse?.response ?? aiResponse?.content ?? '');

  const completion = cleanCompletion(raw);

  // 7. Cache the result
  if (!params.skipCache) {
    _cache.set(cacheKey, completion);
  }

  // 8. Return — keep the response payload minimal for the hot path
  return json({
    completion,
    cached: false,
    latency_ms: Math.round(performance.now() - t0),
  });
}