/**
 * PgStudio AI Tab Completion Worker — v4
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT'S NEW IN V4
 * ─────────────────────────────────────────────────────────────────────────
 * FEATURE — Dual SQL dialect support
 *   type=psql  → PostgreSQL-specific completions (default)
 *               bigserial, jsonb, inet, uuid, text[], RLS policies,
 *               CONCURRENTLY indexes, gen_random_uuid(), etc.
 *
 *   type=normal → ANSI / generic SQL completions
 *               INT, VARCHAR, DATETIME, standard constraints,
 *               works with MySQL, SQLite, SQL Server, MariaDB, etc.
 *
 * HOW TO SELECT THE DIALECT
 *   Via URL query param (takes priority):
 *     POST /complete?type=psql
 *     POST /complete?type=normal
 *
 *   Via request body (fallback):
 *     { "sql": "...", "type": "normal" }
 *
 *   Default when omitted: psql
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CARRIED OVER FROM V3
 * ─────────────────────────────────────────────────────────────────────────
 * BUG 1 — Multi-statement SQL isolation (StatementSplitter)
 * BUG 2 — Cache keyed on active-statement + phase, not full blob
 * BUG 3 — Partial keyword engine for "CREATE IN", "SELEC", etc.
 * ─────────────────────────────────────────────────────────────────────────
 */

// ============================================================================
// SYSTEM PROMPTS — one per dialect
// ============================================================================

const SYSTEM_PROMPT_PSQL = `You are PgStudio Copilot — an expert PostgreSQL autocompletion engine.

## HARD OUTPUT CONTRACT
- Return ONLY raw SQL text. No markdown, no fences, no explanation.
- NEVER repeat SQL that is already written before the cursor.
- Complete exactly ONE logical unit: one keyword, one clause, one column def, or one expression.
- If nothing useful remains → return a single space " ". Never return empty.
- No trailing semicolon unless the statement is definitively complete.
- Match the keyword casing already used (lowercase preferred).

## DIALECT: PostgreSQL (psql)
Use PostgreSQL-specific syntax, types and functions:
  bigserial, smallserial, serial
  jsonb, json, inet, cidr, macaddr
  text[], varchar[], integer[]
  timestamp with time zone, timestamptz
  uuid default gen_random_uuid()
  CREATE INDEX CONCURRENTLY
  CREATE POLICY … USING (…)
  ON CONFLICT DO UPDATE / DO NOTHING
  RETURNING clause
  $1, $2 … parameter placeholders
  now(), current_setting(), current_user

## CRITICAL RULE — MULTI-STATEMENT FILES
The SQL you receive is the LAST INCOMPLETE STATEMENT only.
Previous complete statements have already been stripped.

## Column name → type lookup table (PostgreSQL)
id                  → bigserial primary key
*_id                → bigint not null references {table}(id)
*_at, *_on          → timestamp with time zone not null default now()
deleted_at          → timestamp with time zone
is_*, has_*, can_*  → boolean not null default false
email               → varchar(255) not null unique
phone, mobile       → varchar(30)
name, *_name        → varchar(255) not null
slug                → varchar(255) not null unique
status, *_status    → varchar(30) not null default 'active'
type, *_type        → varchar(50) not null
description, *_desc → text
content, body       → text
metadata, config    → jsonb
settings, data      → jsonb
tags, labels        → text[] not null default '{}'
price, amount, cost → numeric(10, 2) not null default 0
age, score, rank    → integer not null
quantity, count     → integer not null default 0
ip, ip_address      → inet
uuid, *_uuid        → uuid not null default gen_random_uuid()
currency            → char(3) not null default 'USD'
lat, latitude       → decimal(10, 8)
lng, longitude      → decimal(11, 8)

## REMINDER
Return raw SQL only. Never repeat what was already written.`;

const SYSTEM_PROMPT_NORMAL = `You are SQL Copilot — an expert ANSI SQL / generic SQL autocompletion engine.

## HARD OUTPUT CONTRACT
- Return ONLY raw SQL text. No markdown, no fences, no explanation.
- NEVER repeat SQL that is already written before the cursor.
- Complete exactly ONE logical unit: one keyword, one clause, one column def, or one expression.
- If nothing useful remains → return a single space " ". Never return empty.
- No trailing semicolon unless the statement is definitively complete.
- Match the keyword casing already used (lowercase preferred).

## DIALECT: Standard SQL / Generic (normal)
Use ANSI-compatible syntax that works across MySQL, SQLite, SQL Server, MariaDB:
  INT, INTEGER, BIGINT, SMALLINT, TINYINT
  VARCHAR(n), CHAR(n), TEXT, LONGTEXT, MEDIUMTEXT
  FLOAT, DOUBLE, DECIMAL(p,s), NUMERIC(p,s)
  DATE, TIME, DATETIME, TIMESTAMP
  BOOLEAN / TINYINT(1)
  JSON (MySQL 5.7+), BLOB
  AUTO_INCREMENT (MySQL) or IDENTITY (SQL Server) or AUTOINCREMENT (SQLite)
  DEFAULT CURRENT_TIMESTAMP
  ?, :param or @param placeholder styles (use ? as default)
  Standard JOIN syntax, LIMIT / TOP, standard aggregates

## CRITICAL RULE — MULTI-STATEMENT FILES
The SQL you receive is the LAST INCOMPLETE STATEMENT only.
Previous complete statements have already been stripped.

## Column name → type lookup table (Standard SQL)
id                  → INT NOT NULL AUTO_INCREMENT PRIMARY KEY
*_id                → INT NOT NULL REFERENCES {table}(id)
*_at, *_on          → DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
deleted_at          → DATETIME
is_*, has_*, can_*  → TINYINT(1) NOT NULL DEFAULT 0
email               → VARCHAR(255) NOT NULL UNIQUE
phone, mobile       → VARCHAR(30)
name, *_name        → VARCHAR(255) NOT NULL
slug                → VARCHAR(255) NOT NULL UNIQUE
status, *_status    → VARCHAR(30) NOT NULL DEFAULT 'active'
type, *_type        → VARCHAR(50) NOT NULL
description, *_desc → TEXT
content, body       → TEXT
metadata, config    → JSON
price, amount, cost → DECIMAL(10, 2) NOT NULL DEFAULT 0
age, score, rank    → INT NOT NULL
quantity, count     → INT NOT NULL DEFAULT 0
currency            → CHAR(3) NOT NULL DEFAULT 'USD'
lat, latitude       → DECIMAL(10, 8)
lng, longitude      → DECIMAL(11, 8)

## REMINDER
Return raw SQL only. Never repeat what was already written.`;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  'Content-Type': 'application/json',
};

const CFG = {
  primaryModel:  '@cf/meta/llama-3.1-8b-instruct',
  fallbackModel: '@cf/mistral/mistral-7b-instruct-v0.1',
  maxTokens:     160,
  temperature:   0.05,

  /** Supported SQL dialect types */
  validTypes: ['psql', 'normal'],
  defaultType: 'psql',

  cache: {
    enabled:    true,
    maxItems:   400,
    ttlSeconds: 900,
    minLength:  2,
    contextTag: true,
  },

  normalizeInput: true,
};

// ============================================================================
// DIALECT RESOLVERS
// ============================================================================

/**
 * Resolve the SQL dialect type from:
 *   1. URL query param  ?type=psql   (highest priority)
 *   2. Request body     { type: "normal" }
 *   3. Default          "psql"
 */
function resolveType(url, body) {
  const qp = new URL(url).searchParams.get('type');
  if (qp && CFG.validTypes.includes(qp.toLowerCase())) return qp.toLowerCase();
  if (body?.type && CFG.validTypes.includes(body.type?.toLowerCase())) return body.type.toLowerCase();
  return CFG.defaultType;
}

function getSystemPrompt(type) {
  return type === 'normal' ? SYSTEM_PROMPT_NORMAL : SYSTEM_PROMPT_PSQL;
}

// ============================================================================
// STATEMENT SPLITTER
// ============================================================================

class StatementSplitter {
  static split(sql) {
    const statements = [];
    let current = '';
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let i = 0;

    while (i < sql.length) {
      const ch = sql[i];
      const next = sql[i + 1] ?? '';

      if (!inString && (ch === "'" || ch === '"' || ch === '`')) {
        inString = true;
        stringChar = ch;
        current += ch;
        i++;
        continue;
      }
      if (inString) {
        if (ch === stringChar && next === stringChar) {
          current += ch + next;
          i += 2;
          continue;
        }
        if (ch === stringChar) inString = false;
        current += ch;
        i++;
        continue;
      }

      if (ch === '-' && next === '-') {
        while (i < sql.length && sql[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < sql.length - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i += 2;
        continue;
      }

      if (ch === '(') depth++;
      else if (ch === ')') depth--;

      if (ch === ';' && depth === 0) {
        const stmt = current.trim();
        if (stmt) statements.push(stmt);
        current = '';
        i++;
        continue;
      }

      current += ch;
      i++;
    }

    return {
      completed: statements,
      active: current.trim(),
      parenDepth: depth,
    };
  }
}

// ============================================================================
// PARTIAL KEYWORD ENGINE
// ============================================================================

class PartialKeywordEngine {
  static RULES = [
    // CREATE sub-commands
    [/^CREATE\s+IN$/i,          'INDEX',          'CREATE_INDEX'],
    [/^CREATE\s+IND$/i,         'EX',             'CREATE_INDEX'],
    [/^CREATE\s+INDE$/i,        'X',              'CREATE_INDEX'],
    [/^CREATE\s+INDEX$/i,       null,             null],
    [/^CREATE\s+TA$/i,          'BLE',            'CREATE_TABLE'],
    [/^CREATE\s+TAB$/i,         'LE',             'CREATE_TABLE'],
    [/^CREATE\s+TABL$/i,        'E',              'CREATE_TABLE'],
    [/^CREATE\s+TABLE$/i,       null,             null],
    [/^CREATE\s+UN$/i,          'IQUE INDEX',     'CREATE_UNIQUE_INDEX'],
    [/^CREATE\s+UNI$/i,         'QUE INDEX',      'CREATE_UNIQUE_INDEX'],
    [/^CREATE\s+UNIQ$/i,        'UE INDEX',       'CREATE_UNIQUE_INDEX'],
    [/^CREATE\s+UNIQU$/i,       'E INDEX',        'CREATE_UNIQUE_INDEX'],
    [/^CREATE\s+UNIQUE$/i,      ' INDEX',         'CREATE_UNIQUE_INDEX'],
    [/^CREATE\s+PO$/i,          'LICY',           'CREATE_POLICY'],
    [/^CREATE\s+POL$/i,         'ICY',            'CREATE_POLICY'],
    [/^CREATE\s+POLI$/i,        'CY',             'CREATE_POLICY'],
    [/^CREATE\s+POLIC$/i,       'Y',              'CREATE_POLICY'],
    [/^CREATE\s+POLICY$/i,      null,             null],
    [/^CREATE\s+SE$/i,          'QUENCE',         'CREATE_SEQUENCE'],
    [/^CREATE\s+VI$/i,          'EW',             'CREATE_VIEW'],
    [/^CREATE\s+OR$/i,          ' REPLACE VIEW',  'CREATE_OR_REPLACE_VIEW'],
    [/^CREATE\s+TY$/i,          'PE',             'CREATE_TYPE'],
    [/^CREATE\s+FU$/i,          'NCTION',         'CREATE_FUNCTION'],
    [/^CREATE\s+TR$/i,          'IGGER',          'CREATE_TRIGGER'],
    [/^CREATE\s+EX$/i,          'TENSION',        'EXTENSION'],
    [/^CREATE$/i,               ' ',              'CREATE_START'],

    // DML
    [/^INSE$/i,                 'RT INTO',        'INSERT'],
    [/^INSER$/i,                'T INTO',         'INSERT'],
    [/^INSERT$/i,               ' INTO',          'INSERT'],
    [/^INSERT\s+IN$/i,          'TO',             'INSERT'],
    [/^INSERT\s+INT$/i,         'O',              'INSERT'],
    [/^SELE$/i,                 'CT',             'SELECT'],
    [/^SELEC$/i,                'T',              'SELECT'],
    [/^UPDA$/i,                 'TE',             'UPDATE'],
    [/^UPDAT$/i,                'E',              'UPDATE'],
    [/^DELE$/i,                 'TE FROM',        'DELETE'],
    [/^DELET$/i,                'E FROM',         'DELETE'],
    [/^DELETE$/i,               ' FROM',          'DELETE'],
    [/^ALTE$/i,                 'R TABLE',        'ALTER'],
    [/^ALTER$/i,                ' TABLE',         'ALTER'],
    [/^ALTER\s+TA$/i,           'BLE',            'ALTER_TABLE'],
    [/^ALTER\s+TAB$/i,          'LE',             'ALTER_TABLE'],
    [/^TRUN$/i,                 'CATE TABLE',     'TRUNCATE'],
    [/^TRUNC$/i,                'ATE TABLE',      'TRUNCATE'],
    [/^DROP\s+TA$/i,            'BLE',            'DROP_TABLE'],
    [/^DROP\s+TAB$/i,           'LE',             'DROP_TABLE'],
    [/^DROP\s+IN$/i,            'DEX',            'DROP_INDEX'],
    [/^WITH$/i,                 ' ',              'CTE_START'],
    [/^EXPLA$/i,                'IN',             'EXPLAIN'],
    [/^EXPLAI$/i,               'N',              'EXPLAIN'],
    [/^EXPLAIN$/i,              ' ANALYZE',       'EXPLAIN_ANALYZE'],
    [/^BEGIN$/i,                ';',              'BEGIN'],
    [/^COMMIT$/i,               ';',              'COMMIT'],
    [/^ROLLBAC$/i,              'K;',             'ROLLBACK'],
  ];

  static match(activeStatement) {
    const s = activeStatement.trim();
    for (const [regex, completion, phase] of this.RULES) {
      if (regex.test(s)) {
        if (completion === null) return null;
        return { completion, phase };
      }
    }
    return null;
  }
}

// ============================================================================
// SQL CONTEXT ANALYZER
// ============================================================================

class SQLContextAnalyzer {
  static analyze(activeStatement, allSql) {
    const trimmed = activeStatement.trimEnd();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const lastToken = tokens[tokens.length - 1] ?? '';

    const ctx = {
      raw: trimmed,
      fullSql: allSql,
      statementType: null,
      phase: null,
      lastToken,
      lastTokenUpper: lastToken.toUpperCase(),
      tableName: null,
      columnDefName: null,
      isAfterComma: /,\s*$/.test(trimmed),
      parenDepth: 0,
    };

    if (!trimmed) return ctx;

    let depth = 0, inStr = false, strCh = '';
    for (const ch of trimmed) {
      if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strCh = ch; continue; }
      if (inStr) { if (ch === strCh) inStr = false; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    ctx.parenDepth = depth;

    const firstKw = tokens.find(t => /^[A-Za-z]/.test(t))?.toUpperCase();
    ctx.statementType = firstKw ?? null;

    if (ctx.statementType === 'CREATE') {
      const subKw = tokens[1]?.toUpperCase();

      if (subKw === 'TABLE' || subKw === 'TABL' || subKw === 'TAB') {
        const match = trimmed.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/is);
        if (match && depth > 0) {
          ctx.tableName = match[1];
          ctx.phase = 'CREATE_TABLE_BODY';

          const bodyStart = trimmed.indexOf('(') + 1;
          const body = trimmed.slice(bodyStart);
          const segments = this._splitByTopLevelComma(body);
          const lastSeg = (segments[segments.length - 1] ?? '').trim();
          const segTokens = lastSeg.split(/\s+/).filter(Boolean);

          const SQL_TYPES = new Set([
            'NOT','NULL','DEFAULT','UNIQUE','PRIMARY','KEY','CHECK','REFERENCES',
            'SERIAL','BIGSERIAL','SMALLSERIAL','INTEGER','INT','BIGINT','SMALLINT',
            'TEXT','VARCHAR','CHAR','CHARACTER','VARYING','BOOLEAN','BOOL',
            'NUMERIC','DECIMAL','REAL','DOUBLE','PRECISION','FLOAT','DATE','TIME',
            'TIMESTAMP','INTERVAL','JSON','JSONB','UUID','BYTEA','INET','CIDR',
            'MACADDR','MONEY','OID','ARRAY','WITH','ZONE','WITHOUT','ON','DELETE',
            'CASCADE','SET','RESTRICT','NO','ACTION','AUTO_INCREMENT','IDENTITY',
            'TINYINT','MEDIUMTEXT','LONGTEXT','DATETIME','BLOB',
          ]);

          if (
            segTokens.length === 1 &&
            !SQL_TYPES.has(segTokens[0].toUpperCase()) &&
            /^[a-zA-Z_]\w*$/.test(segTokens[0])
          ) {
            ctx.phase = 'CREATE_TABLE_COLUMN_TYPE';
            ctx.columnDefName = segTokens[0].toLowerCase();
          } else if (segTokens.length === 0 || ctx.isAfterComma) {
            ctx.phase = 'CREATE_TABLE_NEXT_COLUMN';
          } else {
            ctx.phase = 'CREATE_TABLE_COLUMN_DEFINITION';
          }
        } else if (match && depth === 0) {
          ctx.phase = 'CREATE_TABLE_DONE';
        } else {
          ctx.phase = 'CREATE_TABLE_START';
        }
      } else if (subKw === 'INDEX' || subKw === 'UNIQUE') {
        ctx.phase = 'CREATE_INDEX';
      } else if (subKw === 'POLICY') {
        ctx.phase = 'CREATE_POLICY';
      } else if (subKw === 'VIEW' || (subKw === 'OR' && tokens[2]?.toUpperCase() === 'REPLACE')) {
        ctx.phase = 'CREATE_VIEW';
      } else if (subKw === 'SEQUENCE') {
        ctx.phase = 'CREATE_SEQUENCE';
      } else if (subKw === 'FUNCTION' || subKw === 'PROCEDURE') {
        ctx.phase = 'CREATE_FUNCTION';
      } else if (subKw === 'TYPE') {
        ctx.phase = 'CREATE_TYPE';
      } else if (subKw === 'EXTENSION') {
        ctx.phase = 'CREATE_EXTENSION';
      }
    }

    if (ctx.statementType === 'SELECT' || ctx.statementType === 'WITH') {
      if (/\b(WHERE|AND|OR)\s*$/i.test(trimmed))               ctx.phase = 'SELECT_WHERE';
      else if (/\bORDER\s+BY\s*$/i.test(trimmed))              ctx.phase = 'SELECT_ORDER';
      else if (/\bGROUP\s+BY\s*$/i.test(trimmed))              ctx.phase = 'SELECT_GROUP';
      else if (/\bHAVING\s*$/i.test(trimmed))                  ctx.phase = 'SELECT_HAVING';
      else if (/\bJOIN\s+\S+\s*(ON|USING)?\s*$/i.test(trimmed)) ctx.phase = 'SELECT_JOIN_ON';
      else if (/\bFROM\s*$/i.test(trimmed))                    ctx.phase = 'SELECT_FROM';
      else if (/\bSELECT\s*$/i.test(trimmed))                  ctx.phase = 'SELECT_COLUMNS';
      else if (/\bLIMIT\s*$/i.test(trimmed))                   ctx.phase = 'SELECT_LIMIT';
      else if (/\bOFFSET\s*$/i.test(trimmed))                  ctx.phase = 'SELECT_OFFSET';
    }

    if (ctx.statementType === 'INSERT') {
      const m = trimmed.match(/INSERT\s+(?:INTO\s+)?(\w+)\s*$/i);
      if (m) { ctx.tableName = m[1]; ctx.phase = 'INSERT_COLUMNS'; }
      else if (/\bVALUES\s*$/i.test(trimmed)) ctx.phase = 'INSERT_VALUES';
      else if (/\bON\s+CONFLICT\s*$/i.test(trimmed)) ctx.phase = 'INSERT_ON_CONFLICT';
      else if (/\bRETURNING\s*$/i.test(trimmed)) ctx.phase = 'INSERT_RETURNING';
    }

    if (ctx.statementType === 'UPDATE') {
      if (/\bSET\s*$/i.test(trimmed))          ctx.phase = 'UPDATE_SET';
      else if (/\bWHERE\s*$/i.test(trimmed))   ctx.phase = 'UPDATE_WHERE';
      else if (/\bRETURNING\s*$/i.test(trimmed)) ctx.phase = 'UPDATE_RETURNING';
    }

    if (ctx.statementType === 'DELETE') {
      if (/\bWHERE\s*$/i.test(trimmed)) ctx.phase = 'DELETE_WHERE';
    }

    if (ctx.statementType === 'ALTER') {
      if (/\bALTER\s+TABLE\s+\w+\s*$/i.test(trimmed)) ctx.phase = 'ALTER_TABLE';
      else if (/\bADD\s+COLUMN\s*$/i.test(trimmed))    ctx.phase = 'ALTER_ADD_COLUMN';
    }

    return ctx;
  }

  static _splitByTopLevelComma(str) {
    const segments = [];
    let cur = '', d = 0;
    for (const ch of str) {
      if (ch === '(') d++;
      else if (ch === ')') d--;
      if (ch === ',' && d === 0) { segments.push(cur); cur = ''; }
      else cur += ch;
    }
    segments.push(cur);
    return segments;
  }
}

// ============================================================================
// SCHEMA INFERENCE ENGINE — dialect-aware
// ============================================================================

class SchemaInferenceEngine {
  /**
   * @param {string} colName
   * @param {string} tableName
   * @param {'psql'|'normal'} type
   */
  static inferColumnType(colName, tableName = '', type = 'psql') {
    const n = colName.toLowerCase();
    return type === 'normal'
      ? this._inferNormal(n, tableName)
      : this._inferPsql(n, tableName);
  }

  // ── PostgreSQL dialect ────────────────────────────────────────────────────
  static _inferPsql(n, tableName) {
    const exact = {
      id: 'bigserial primary key',
      email: 'varchar(255) not null unique',
      phone: 'varchar(30)',
      mobile: 'varchar(30)',
      status: "varchar(30) not null default 'active'",
      slug: 'varchar(255) not null unique',
      content: 'text', body: 'text', description: 'text',
      notes: 'text', remarks: 'text', comment: 'text',
      metadata: 'jsonb', config: 'jsonb', settings: 'jsonb',
      data: 'jsonb', extra: 'jsonb', properties: 'jsonb',
      tags: "text[] not null default '{}'",
      labels: "text[] not null default '{}'",
      age: 'integer not null check (age >= 0)',
      score: 'integer not null default 0',
      rating: 'numeric(3, 2)',
      rank: 'integer not null default 0',
      priority: 'integer not null default 0',
      position: 'integer not null default 0',
      sort_order: 'integer not null default 0',
      weight: 'numeric(10, 4) not null default 0',
      quantity: 'integer not null default 0',
      count: 'integer not null default 0',
      price: 'numeric(10, 2) not null default 0',
      amount: 'numeric(10, 2) not null default 0',
      total: 'numeric(10, 2) not null default 0',
      balance: 'numeric(10, 2) not null default 0',
      cost: 'numeric(10, 2) not null default 0',
      salary: 'numeric(10, 2)',
      lat: 'decimal(10, 8)', latitude: 'decimal(10, 8)',
      lng: 'decimal(11, 8)', longitude: 'decimal(11, 8)',
      currency: "char(3) not null default 'USD'",
      ip: 'inet', ip_address: 'inet',
      uuid: 'uuid not null default gen_random_uuid()',
      token: 'text', password: 'text not null',
      width: 'integer', height: 'integer', size: 'integer',
      url: 'text', avatar: 'text', image: 'text', thumbnail: 'text',
      payload: 'text',
    };

    if (exact[n]) return exact[n];
    if (n === 'id' || n.endsWith('_id')) {
      const ref = n.endsWith('_id') ? n.slice(0, -3) : null;
      return ref ? `bigint not null references ${ref}(id)` : 'bigint not null';
    }
    if (n.endsWith('_at') || n.endsWith('_on') || n.endsWith('_date') || n.endsWith('_time'))
      return (n.startsWith('deleted') || n.startsWith('archived'))
        ? 'timestamp with time zone'
        : 'timestamp with time zone not null default now()';
    if (n.startsWith('is_') || n.startsWith('has_') || n.startsWith('can_') || n.endsWith('_flag') || n.endsWith('_enabled'))
      return 'boolean not null default false';
    if (n.endsWith('_name') || n.endsWith('_title') || n.endsWith('_label')) return 'varchar(255) not null';
    if (n.endsWith('_desc') || n.endsWith('_description') || n.endsWith('_note') || n.endsWith('_notes')) return 'text';
    if (n.endsWith('_url') || n.endsWith('_link') || n.endsWith('_href')) return 'text';
    if (n.endsWith('_status')) return "varchar(30) not null default 'active'";
    if (n.endsWith('_type') || n.endsWith('_kind') || n.endsWith('_category')) return 'varchar(50) not null';
    if (n.endsWith('_code')) return 'varchar(50) not null';
    if (n.endsWith('_token') || n.endsWith('_hash') || n.endsWith('_secret')) return 'text';
    if (n.endsWith('_count') || n.endsWith('_total') || n.endsWith('_num')) return 'integer not null default 0';
    if (n.endsWith('_amount') || n.endsWith('_price') || n.endsWith('_cost') || n.endsWith('_fee')) return 'numeric(10, 2) not null default 0';
    if (n.endsWith('_json') || n.endsWith('_data') || n.endsWith('_meta') || n.endsWith('_config') || n.endsWith('_settings')) return 'jsonb';
    if (n.endsWith('_uuid')) return 'uuid not null default gen_random_uuid()';
    if (n.startsWith('num_') || n.startsWith('count_') || n.startsWith('total_')) return 'integer not null default 0';
    return 'varchar(255)';
  }

  // ── Normal / Standard SQL dialect ─────────────────────────────────────────
  static _inferNormal(n, tableName) {
    const exact = {
      id: 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY',
      email: 'VARCHAR(255) NOT NULL UNIQUE',
      phone: 'VARCHAR(30)',
      mobile: 'VARCHAR(30)',
      status: "VARCHAR(30) NOT NULL DEFAULT 'active'",
      slug: 'VARCHAR(255) NOT NULL UNIQUE',
      content: 'TEXT', body: 'TEXT', description: 'TEXT',
      notes: 'TEXT', remarks: 'TEXT', comment: 'TEXT',
      metadata: 'JSON', config: 'JSON', settings: 'JSON',
      data: 'JSON', extra: 'JSON', properties: 'JSON',
      tags: 'TEXT',
      labels: 'TEXT',
      age: 'INT NOT NULL CHECK (age >= 0)',
      score: 'INT NOT NULL DEFAULT 0',
      rating: 'DECIMAL(3, 2)',
      rank: 'INT NOT NULL DEFAULT 0',
      priority: 'INT NOT NULL DEFAULT 0',
      position: 'INT NOT NULL DEFAULT 0',
      sort_order: 'INT NOT NULL DEFAULT 0',
      weight: 'DECIMAL(10, 4) NOT NULL DEFAULT 0',
      quantity: 'INT NOT NULL DEFAULT 0',
      count: 'INT NOT NULL DEFAULT 0',
      price: 'DECIMAL(10, 2) NOT NULL DEFAULT 0',
      amount: 'DECIMAL(10, 2) NOT NULL DEFAULT 0',
      total: 'DECIMAL(10, 2) NOT NULL DEFAULT 0',
      balance: 'DECIMAL(10, 2) NOT NULL DEFAULT 0',
      cost: 'DECIMAL(10, 2) NOT NULL DEFAULT 0',
      salary: 'DECIMAL(10, 2)',
      lat: 'DECIMAL(10, 8)', latitude: 'DECIMAL(10, 8)',
      lng: 'DECIMAL(11, 8)', longitude: 'DECIMAL(11, 8)',
      currency: "CHAR(3) NOT NULL DEFAULT 'USD'",
      ip: 'VARCHAR(45)', ip_address: 'VARCHAR(45)',
      token: 'TEXT', password: 'TEXT NOT NULL',
      width: 'INT', height: 'INT', size: 'INT',
      url: 'TEXT', avatar: 'TEXT', image: 'TEXT', thumbnail: 'TEXT',
      payload: 'TEXT',
    };

    if (exact[n]) return exact[n];
    if (n === 'id' || n.endsWith('_id')) {
      const ref = n.endsWith('_id') ? n.slice(0, -3) : null;
      return ref ? `INT NOT NULL REFERENCES ${ref}(id)` : 'INT NOT NULL';
    }
    if (n.endsWith('_at') || n.endsWith('_on'))
      return (n.startsWith('deleted') || n.startsWith('archived'))
        ? 'DATETIME'
        : 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';
    if (n.endsWith('_date')) return 'DATE';
    if (n.endsWith('_time')) return 'TIME';
    if (n.startsWith('is_') || n.startsWith('has_') || n.startsWith('can_') || n.endsWith('_flag') || n.endsWith('_enabled'))
      return 'TINYINT(1) NOT NULL DEFAULT 0';
    if (n.endsWith('_name') || n.endsWith('_title') || n.endsWith('_label')) return 'VARCHAR(255) NOT NULL';
    if (n.endsWith('_desc') || n.endsWith('_description') || n.endsWith('_note') || n.endsWith('_notes')) return 'TEXT';
    if (n.endsWith('_url') || n.endsWith('_link') || n.endsWith('_href')) return 'TEXT';
    if (n.endsWith('_status')) return "VARCHAR(30) NOT NULL DEFAULT 'active'";
    if (n.endsWith('_type') || n.endsWith('_kind') || n.endsWith('_category')) return 'VARCHAR(50) NOT NULL';
    if (n.endsWith('_code')) return 'VARCHAR(50) NOT NULL';
    if (n.endsWith('_token') || n.endsWith('_hash') || n.endsWith('_secret')) return 'TEXT';
    if (n.endsWith('_count') || n.endsWith('_total') || n.endsWith('_num')) return 'INT NOT NULL DEFAULT 0';
    if (n.endsWith('_amount') || n.endsWith('_price') || n.endsWith('_cost') || n.endsWith('_fee')) return 'DECIMAL(10, 2) NOT NULL DEFAULT 0';
    if (n.endsWith('_json') || n.endsWith('_data') || n.endsWith('_meta') || n.endsWith('_config') || n.endsWith('_settings')) return 'JSON';
    if (n.startsWith('num_') || n.startsWith('count_') || n.startsWith('total_')) return 'INT NOT NULL DEFAULT 0';
    return 'VARCHAR(255)';
  }
}

// ============================================================================
// PATTERN ENGINE  — dialect-aware zero-latency completions
// ============================================================================

class PatternEngine {
  /**
   * @param {object} ctx
   * @param {object|null} schema
   * @param {'psql'|'normal'} type
   */
  static complete(ctx, schema, type = 'psql') {
    const { phase, columnDefName, raw, tableName } = ctx;

    if (phase === 'CREATE_TABLE_COLUMN_TYPE' && columnDefName) {
      const inferred = SchemaInferenceEngine.inferColumnType(columnDefName, tableName, type);
      return `${inferred},`;
    }

    if (phase === 'CREATE_TABLE_NEXT_COLUMN') return null;

    if (phase === 'SELECT_COLUMNS' && schema) {
      const tables = Object.keys(schema);
      if (tables.length === 1) {
        const cols = schema[tables[0]];
        return Array.isArray(cols) && cols.length ? cols.slice(0, 6).join(', ') : '*';
      }
      return '*';
    }

    if (phase === 'SELECT_FROM' && schema) {
      return Object.keys(schema)[0] ?? null;
    }

    if ((phase === 'SELECT_WHERE' || phase === 'UPDATE_WHERE' || phase === 'DELETE_WHERE') && schema) {
      const tables = Object.keys(schema);
      if (tables.length > 0) {
        const cols = schema[tables[0]];
        if (Array.isArray(cols)) {
          if (cols.includes('status')) return "status = 'active'";
          if (cols.includes('deleted_at')) return type === 'psql' ? 'deleted_at is null' : 'deleted_at IS NULL';
          const idCol = cols.find(c => c === 'id');
          if (idCol) return type === 'psql' ? 'id = $1' : 'id = ?';
        }
      }
    }

    if (phase === 'INSERT_COLUMNS' && schema && tableName) {
      const tbl = tableName.toLowerCase();
      const cols = schema[tbl] ?? schema[Object.keys(schema)[0]];
      if (Array.isArray(cols)) {
        const insertCols = cols.filter(c => c !== 'id' && c !== 'created_at' && c !== 'updated_at');
        const placeholders = type === 'psql'
          ? insertCols.map((_, i) => `$${i + 1}`)
          : insertCols.map(() => '?');
        const tail = type === 'psql' ? ' returning id;' : ';';
        return `(${insertCols.join(', ')}) values (${placeholders.join(', ')})${tail}`;
      }
    }

    if (phase === 'UPDATE_SET' && schema) {
      const m = raw.match(/update\s+(\w+)\s+set\s*$/i);
      if (m) {
        const tbl = m[1].toLowerCase();
        const cols = schema[tbl] ?? schema[Object.keys(schema)[0]];
        if (Array.isArray(cols)) {
          const upd = cols.filter(c => c !== 'id' && c !== 'created_at').slice(0, 3);
          let i = 1;
          const asgn = upd.map(c =>
            c === 'updated_at'
              ? (type === 'psql' ? 'updated_at = now()' : 'updated_at = CURRENT_TIMESTAMP')
              : (type === 'psql' ? `${c} = $${i++}` : `${c} = ?`)
          );
          const whereParam = type === 'psql' ? `$${i}` : '?';
          return asgn.join(', ') + ` where id = ${whereParam}`;
        }
      }
    }

    return null;
  }
}

// ============================================================================
// RESPONSE VALIDATOR
// ============================================================================

class ResponseValidator {
  static SUSPICIOUS_PATTERNS = [
    /^(complete:|answer:|sql:|output:|completion:|here is|i would|the next)/i,
    /^```/,
    /^\s*--/,
  ];

  static isContextuallyValid(completion, ctx) {
    const colDefPattern = /\b(NOT NULL|VARCHAR|BIGINT|INTEGER|TEXT|JSONB|BOOLEAN|TIMESTAMP|NUMERIC|BIGSERIAL|DATETIME|TINYINT)\b/i;
    const isColDef = colDefPattern.test(completion);
    const isCreateTableCtx = ctx?.phase?.startsWith('CREATE_TABLE');
    if (isColDef && !isCreateTableCtx) return false;
    return true;
  }

  static isValid(completion, inputSql, ctx) {
    if (!completion || completion.trim().length === 0) return false;
    const tail = inputSql.slice(-30).trim().toLowerCase();
    if (tail.length > 4 && completion.toLowerCase().startsWith(tail)) return false;
    for (const p of this.SUSPICIOUS_PATTERNS) {
      if (p.test(completion.trim())) return false;
    }
    if (!this.isContextuallyValid(completion, ctx)) return false;
    return true;
  }

  static clean(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .replace(/^```(?:sql|pgsql|postgresql|mysql|sqlite)?\s*/im, '')
      .replace(/\s*```\s*$/im, '')
      .replace(/^(Complete:|Answer:|SQL:|Output:|Completion:)\s*/im, '')
      .replace(/^["']|["']$/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }
}

// ============================================================================
// CACHE  — now keyed on (type + phase + active_statement_hash)
// ============================================================================

class CompletionCache {
  constructor() {
    if (!globalThis.__pgCacheV4) {
      globalThis.__pgCacheV4 = {
        items: new Map(),
        order: [],
        stats: { hits: 0, misses: 0, evictions: 0, purges: 0, refused: 0 },
        created: Date.now(),
      };
    }
    this._c = globalThis.__pgCacheV4;
  }

  static _hash(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36);
  }

  static buildKey(activeStatement, schema, phase, type) {
    const normalized = CFG.normalizeInput
      ? activeStatement.trim().replace(/\s+/g, ' ').toLowerCase()
      : activeStatement;
    const schemaFp = schema
      ? CompletionCache._hash(
          Object.entries(schema)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([t, c]) => `${t}:${[...c].sort().join(',')}`)
            .join('|')
        )
      : 'ns';
    return `v4:${type}:${phase ?? 'unknown'}:${schemaFp}:${CompletionCache._hash(normalized)}`;
  }

  static isCacheable(completion, ctx) {
    if (!completion || completion.trim().length < CFG.cache.minLength) return false;
    if (!ResponseValidator.isContextuallyValid(completion, ctx)) return false;
    return true;
  }

  get(key) {
    const e = this._c.items.get(key);
    if (!e) { this._c.stats.misses++; return null; }
    if (Date.now() > e.exp) { this._c.items.delete(key); this._c.stats.misses++; return null; }
    this._touch(key);
    this._c.stats.hits++;
    return e.value;
  }

  set(key, value, ctx) {
    if (!CompletionCache.isCacheable(value, ctx)) { this._c.stats.refused++; return; }
    if (this._c.items.size >= CFG.cache.maxItems) this._evict();
    this._c.items.set(key, { value, exp: Date.now() + CFG.cache.ttlSeconds * 1000 });
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
    const { hits, misses, evictions, purges, refused } = this._c.stats;
    const total = hits + misses;
    return {
      version: 4,
      size: this._c.items.size,
      maxItems: CFG.cache.maxItems,
      hitRate: total > 0 ? ((hits / total) * 100).toFixed(1) + '%' : '—',
      hits, misses, evictions, purges, refused,
      ageSeconds: Math.round((Date.now() - this._c.created) / 1000),
    };
  }

  clear() { this._c.items.clear(); this._c.order = []; }
}

// ============================================================================
// VALIDATION
// ============================================================================

function validateRequest(body, type) {
  if (!body || typeof body !== 'object')
    throw Object.assign(new Error('Request body must be a JSON object'), { status: 400 });
  if (typeof body.sql !== 'string' || body.sql.trim().length === 0)
    throw Object.assign(new Error('"sql" is required and must be a non-empty string'), { status: 400 });
  if (body.sql.length > 50_000)
    throw Object.assign(new Error('"sql" must be ≤ 50 000 characters'), { status: 400 });
  if (body.schema !== undefined && (typeof body.schema !== 'object' || Array.isArray(body.schema)))
    throw Object.assign(new Error('"schema" must be { tableName: ["col", …] }'), { status: 400 });
  return {
    sql:       body.sql,
    schema:    body.schema ?? null,
    skipCache: Boolean(body.skipCache),
    mode:      ['inline', 'suggest', 'predict'].includes(body.mode) ? body.mode : 'inline',
    type,
  };
}

// ============================================================================
// PROMPT BUILDER
// ============================================================================

function serializeSchema(schema) {
  if (!schema) return null;
  const lines = Object.entries(schema).slice(0, 20).map(([t, cols]) => {
    const c = Array.isArray(cols) ? cols.slice(0, 20).join(', ') : String(cols);
    return `${t}(${c})`;
  });
  return lines.length ? 'Tables: ' + lines.join('; ') : null;
}

const PHASE_HINTS = {
  CREATE_TABLE_COLUMN_TYPE:       (ctx) => `Context: INSIDE create table "${ctx.tableName}". Column "${ctx.columnDefName}" has no type yet. Emit ONLY its type + constraints + trailing comma.`,
  CREATE_TABLE_COLUMN_DEFINITION: (ctx) => `Context: INSIDE create table "${ctx.tableName}" body. Emit the next complete column definition.`,
  CREATE_TABLE_NEXT_COLUMN:       (ctx) => `Context: After a completed column in create table "${ctx.tableName}". Emit the next column name + type.`,
  CREATE_TABLE_START:             ()    => `Context: After CREATE TABLE. Emit the table name and opening column definitions.`,
  CREATE_INDEX:                   ()    => `Context: CREATE INDEX statement. Emit the index name, table, and column.`,
  CREATE_POLICY:                  ()    => `Context: CREATE POLICY statement. Emit the policy name, table, FOR clause, and USING expression.`,
  SELECT_COLUMNS:                 ()    => `Context: After SELECT. Emit column list.`,
  SELECT_FROM:                    ()    => `Context: After FROM. Emit table name.`,
  SELECT_WHERE:                   ()    => `Context: After WHERE/AND/OR. Emit a predicate expression.`,
  SELECT_JOIN_ON:                 ()    => `Context: After JOIN … ON. Emit the join predicate.`,
  SELECT_ORDER:                   ()    => `Context: After ORDER BY. Emit column + direction.`,
  SELECT_GROUP:                   ()    => `Context: After GROUP BY. Emit grouping columns.`,
  INSERT_COLUMNS:                 (ctx) => `Context: After INSERT INTO ${ctx.tableName ?? ''}. Emit (columns) values (placeholders).`,
  INSERT_VALUES:                  ()    => `Context: After VALUES. Emit a tuple of placeholders.`,
  UPDATE_SET:                     ()    => `Context: After UPDATE … SET. Emit col = placeholder assignments + WHERE.`,
  UPDATE_WHERE:                   ()    => `Context: After UPDATE … WHERE. Emit predicate.`,
  DELETE_WHERE:                   ()    => `Context: After DELETE FROM … WHERE. Emit predicate.`,
  ALTER_TABLE:                    ()    => `Context: After ALTER TABLE name. Emit ADD COLUMN / DROP COLUMN / etc.`,
};

function buildUserMessage(activeStatement, schema, ctx, mode, type) {
  const parts = [];
  const schemaPart = serializeSchema(schema);
  if (schemaPart) parts.push(schemaPart);
  parts.push(`Dialect: ${type === 'normal' ? 'Standard SQL (MySQL/SQLite/SQL Server compatible)' : 'PostgreSQL'}`);
  const hintFn = PHASE_HINTS[ctx.phase];
  if (hintFn) parts.push(hintFn(ctx));
  if (mode === 'predict') parts.push('Mode: PREDICT — emit the complete most-probable full statement.');
  else if (mode === 'suggest') parts.push('Mode: SUGGEST — emit the next logical block (multi-line ok).');
  parts.push(`SQL (last incomplete statement only):\n${activeStatement}`);
  parts.push('Complete:');
  return parts.join('\n\n');
}

// ============================================================================
// AI LAYER
// ============================================================================

async function runAI(env, model, userMessage, type) {
  return env.AI.run(model, {
    messages: [
      { role: 'system', content: getSystemPrompt(type) },
      { role: 'user',   content: userMessage },
    ],
    temperature: CFG.temperature,
    max_tokens:  CFG.maxTokens,
  });
}

function extractText(r) {
  if (typeof r === 'string') return r;
  return r?.response ?? r?.content ?? r?.text ?? '';
}

async function getAICompletion(env, userMessage, activeStatement, ctx, type) {
  let raw = '';
  try {
    const res = await runAI(env, CFG.primaryModel, userMessage, type);
    raw = ResponseValidator.clean(extractText(res));
  } catch (_) {}

  if (ResponseValidator.isValid(raw, activeStatement, ctx))
    return { completion: raw, model: CFG.primaryModel };

  try {
    const res = await runAI(env, CFG.fallbackModel, userMessage, type);
    raw = ResponseValidator.clean(extractText(res));
  } catch (_) {}

  if (ResponseValidator.isValid(raw, activeStatement, ctx))
    return { completion: raw, model: CFG.fallbackModel };

  return { completion: null, model: null };
}

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });

const err = (message, status = 500) => json({ error: message }, status);

// ============================================================================
// WORKER ENTRY POINT
// ============================================================================

const _cache = new CompletionCache();

export default {
  async fetch(request, env) {
    const t0 = performance.now();
    if (Math.random() < 0.01) _cache.purgeExpired();

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    const { pathname } = new URL(request.url);

    if (request.method === 'GET'    && pathname.endsWith('/health'))
      return json({ ok: true, version: 4, cache: _cache.stats(), dialects: CFG.validTypes, default: CFG.defaultType });
    if (request.method === 'GET'    && pathname.endsWith('/cache/stats'))
      return json(_cache.stats());
    if (request.method === 'DELETE' && pathname.endsWith('/cache'))
      { _cache.clear(); return json({ cleared: true }); }
    if (request.method === 'POST'   && pathname.endsWith('/complete'))
      return handleCompletion(request, env, t0);

    return err('Not found', 404);
  },
};

// ============================================================================
// COMPLETION HANDLER
// ============================================================================

async function handleCompletion(request, env, t0) {
  let body;
  try { body = await request.json(); }
  catch { return err('Invalid JSON body', 400); }

  // Resolve dialect type: URL param > body field > default
  const type = resolveType(request.url, body);

  let params;
  try { params = validateRequest(body, type); }
  catch (e) { return err(e.message, e.status ?? 400); }

  const { sql, schema, skipCache, mode } = params;

  // ── Multi-statement isolation ────────────────────────────────────────────
  const { active: activeStatement, completed } = StatementSplitter.split(sql);

  // ── Partial keyword engine ───────────────────────────────────────────────
  const partialKw = PartialKeywordEngine.match(activeStatement);
  if (partialKw) {
    return json({
      completion:       partialKw.completion,
      source:           'keyword',
      model:            null,
      cached:           false,
      context:          partialKw.phase,
      type,
      active_statement: activeStatement,
      latency_ms:       Math.round(performance.now() - t0),
    });
  }

  // ── Context analysis ─────────────────────────────────────────────────────
  const ctx = SQLContextAnalyzer.analyze(activeStatement, sql);

  // ── Cache lookup — key includes dialect type ─────────────────────────────
  const cacheKey = CompletionCache.buildKey(activeStatement, schema, ctx.phase, type);

  if (!skipCache) {
    const hit = _cache.get(cacheKey);
    if (hit !== null) {
      return json({
        completion:       hit,
        source:           'cache',
        cached:           true,
        context:          ctx.phase,
        type,
        active_statement: activeStatement,
        latency_ms:       Math.round(performance.now() - t0),
      });
    }
  }

  // ── Pattern engine ───────────────────────────────────────────────────────
  const patternResult = PatternEngine.complete(ctx, schema, type);

  if (patternResult && mode === 'inline') {
    _cache.set(cacheKey, patternResult, ctx);
    return json({
      completion:       patternResult,
      source:           'pattern',
      model:            null,
      cached:           false,
      context:          ctx.phase,
      type,
      active_statement: activeStatement,
      latency_ms:       Math.round(performance.now() - t0),
    });
  }

  // ── AI completion ────────────────────────────────────────────────────────
  const userMessage = buildUserMessage(activeStatement, schema, ctx, mode, type);
  const { completion: aiCompletion, model } = await getAICompletion(env, userMessage, activeStatement, ctx, type);

  let finalCompletion = aiCompletion;
  let source = 'ai';

  if (!finalCompletion && patternResult) { finalCompletion = patternResult; source = 'pattern_fallback'; }
  if (!finalCompletion)                  { finalCompletion = '';            source = 'none'; }

  if (!skipCache && finalCompletion.length > 0)
    _cache.set(cacheKey, finalCompletion, ctx);

  return json({
    completion:       finalCompletion,
    source,
    model:            model ?? null,
    cached:           false,
    context:          ctx.phase ?? null,
    type,
    active_statement: activeStatement,
    completed_count:  completed.length,
    latency_ms:       Math.round(performance.now() - t0),
  });
}