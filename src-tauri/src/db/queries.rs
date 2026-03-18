use deadpool_postgres::Pool;
use log::{debug, warn};
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::error::Error as StdError;
use std::io::{self as io, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_postgres::types::Type;
use tokio_postgres::{Error as PgError, Row};

use super::types::*;

/// Extract a user-facing message from a Postgres/connection error (avoids generic "db error").
fn pg_error_message(e: &impl StdError) -> String {
    let msg = e.to_string();
    if msg.is_empty() || msg == "db error" {
        if let Some(src) = e.source() {
            return src.to_string();
        }
    }
    msg
}

/// Format a tokio_postgres::Error for display: message, detail, hint (no raw Debug).
fn format_pg_error(e: &PgError) -> String {
    if let Some(db) = e.as_db_error() {
        let mut s = db.message().to_string();
        if let Some(d) = db.detail() {
            s.push_str("\n\nDetail: ");
            s.push_str(d);
        }
        if let Some(h) = db.hint() {
            s.push_str("\n\nHint: ");
            s.push_str(h);
        }
        return s;
    }
    e.to_string()
}

// ──────────────────────────────────────────────────────────────────────────────
// Row / cell helpers
// ──────────────────────────────────────────────────────────────────────────────

fn row_to_cells(row: &Row) -> Vec<CellValue> {
    let mut cells = Vec::with_capacity(row.len());
    for i in 0..row.len() {
        let col_type = row.columns()[i].type_();
        cells.push(convert_cell(row, i, col_type));
    }
    cells
}

fn convert_cell(row: &Row, idx: usize, pg_type: &Type) -> CellValue {
    match pg_type {
        &Type::BOOL => match row.try_get::<_, Option<bool>>(idx) {
            Ok(Some(v)) => CellValue::Bool(v),
            _ => CellValue::Null,
        },
        &Type::INT2 => match row.try_get::<_, Option<i16>>(idx) {
            Ok(Some(v)) => CellValue::Int16(v),
            _ => CellValue::Null,
        },
        &Type::INT4 => match row.try_get::<_, Option<i32>>(idx) {
            Ok(Some(v)) => CellValue::Int32(v),
            _ => CellValue::Null,
        },
        &Type::INT8 => match row.try_get::<_, Option<i64>>(idx) {
            Ok(Some(v)) => CellValue::Int64(v),
            _ => CellValue::Null,
        },
        &Type::FLOAT4 => match row.try_get::<_, Option<f32>>(idx) {
            Ok(Some(v)) => CellValue::Float32(v),
            _ => CellValue::Null,
        },
        &Type::FLOAT8 => match row.try_get::<_, Option<f64>>(idx) {
            Ok(Some(v)) => CellValue::Float64(v),
            _ => CellValue::Null,
        },
        // NUMERIC/DECIMAL: read via rust_decimal to preserve precision (e.g. 0.0000)
        &Type::NUMERIC => match row.try_get::<_, Option<Decimal>>(idx) {
            Ok(Some(d)) => CellValue::String(d.to_string()),
            _ => CellValue::Null,
        },
        &Type::TEXT | &Type::VARCHAR | &Type::BPCHAR | &Type::NAME => {
            match row.try_get::<_, Option<String>>(idx) {
                Ok(Some(v)) => CellValue::String(v),
                _ => CellValue::Null,
            }
        }
        &Type::UUID => match row.try_get::<_, Option<uuid::Uuid>>(idx) {
            Ok(Some(v)) => CellValue::Uuid(v.to_string()),
            _ => CellValue::Null,
        },
        &Type::TIMESTAMP => match row.try_get::<_, Option<chrono::NaiveDateTime>>(idx) {
            Ok(Some(v)) => CellValue::DateTime(v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
            _ => CellValue::Null,
        },
        &Type::TIMESTAMPTZ => match row.try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(idx) {
            Ok(Some(v)) => CellValue::DateTime(v.to_rfc3339()),
            _ => CellValue::Null,
        },
        &Type::DATE => match row.try_get::<_, Option<chrono::NaiveDate>>(idx) {
            Ok(Some(v)) => CellValue::Date(v.format("%Y-%m-%d").to_string()),
            _ => CellValue::Null,
        },
        &Type::TIME => match row.try_get::<_, Option<chrono::NaiveTime>>(idx) {
            Ok(Some(v)) => CellValue::Time(v.format("%H:%M:%S%.f").to_string()),
            _ => CellValue::Null,
        },
        &Type::JSON | &Type::JSONB => match row.try_get::<_, Option<serde_json::Value>>(idx) {
            Ok(Some(v)) => CellValue::Json(v),
            _ => CellValue::Null,
        },
        &Type::BYTEA => match row.try_get::<_, Option<Vec<u8>>>(idx) {
            Ok(Some(v)) => CellValue::Bytes(v),
            _ => CellValue::Null,
        },
        &Type::OID => match row.try_get::<_, Option<u32>>(idx) {
            Ok(Some(v)) => CellValue::Int64(v as i64),
            _ => CellValue::Null,
        },
        // INTERVAL: no native Rust type in tokio-postgres; read as text.
        &Type::INTERVAL => match row.try_get::<_, Option<String>>(idx) {
            Ok(Some(v)) => CellValue::String(v),
            _ => CellValue::Null,
        },
        // Custom types (e.g. PostgreSQL enums): wire protocol sends as text; read as String
        // so enum and other user-defined types display and edit correctly.
        _ => match row.try_get::<_, Option<String>>(idx) {
            Ok(Some(v)) => CellValue::String(v),
            _ => CellValue::Null,
        },
    }
}

/// Serialize a CellValue to a PostgreSQL literal for use in INSERT VALUES.
fn cell_value_to_sql_literal(c: &CellValue) -> String {
    match c {
        CellValue::Null => "NULL".to_string(),
        CellValue::Bool(b) => (*b).to_string().to_uppercase(),
        CellValue::Int16(v) => v.to_string(),
        CellValue::Int32(v) => v.to_string(),
        CellValue::Int64(v) => v.to_string(),
        CellValue::Float32(v) => v.to_string(),
        CellValue::Float64(v) => v.to_string(),
        CellValue::String(s) => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        CellValue::Json(j) => {
            let escaped = serde_json::to_string(j)
                .unwrap_or_default()
                .replace('\\', "\\\\")
                .replace('\'', "''");
            format!("'{}'", escaped)
        }
        CellValue::DateTime(s) | CellValue::Date(s) | CellValue::Time(s) | CellValue::Uuid(s) => {
            format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
        }
        CellValue::Bytes(b) => format!(
            "'\\\\x{}'",
            b.iter().map(|x| format!("{:02x}", x)).collect::<String>()
        ),
    }
}

fn pg_type_to_string(pg_type: &Type) -> String {
    match pg_type {
        &Type::BOOL => "boolean".to_string(),
        &Type::INT2 => "smallint".to_string(),
        &Type::INT4 => "integer".to_string(),
        &Type::INT8 => "bigint".to_string(),
        &Type::FLOAT4 => "real".to_string(),
        &Type::FLOAT8 => "double precision".to_string(),
        &Type::NUMERIC => "numeric".to_string(),
        &Type::TEXT => "text".to_string(),
        &Type::VARCHAR => "varchar".to_string(),
        &Type::BPCHAR => "char".to_string(),
        &Type::UUID => "uuid".to_string(),
        &Type::TIMESTAMP => "timestamp".to_string(),
        &Type::TIMESTAMPTZ => "timestamptz".to_string(),
        &Type::DATE => "date".to_string(),
        &Type::TIME => "time".to_string(),
        &Type::INTERVAL => "interval".to_string(),
        &Type::JSON => "json".to_string(),
        &Type::JSONB => "jsonb".to_string(),
        &Type::BYTEA => "bytea".to_string(),
        &Type::OID => "oid".to_string(),
        other => other.name().to_string(),
    }
}

fn normalize_type_name(data_type: &str) -> String {
    let lower = data_type.trim().to_lowercase();
    let base = lower.split('(').next().unwrap_or(&lower).trim();
    base.split('.').last().unwrap_or(base).trim().to_string()
}

fn is_geometry_type(data_type: &str) -> bool {
    let lower = data_type.to_lowercase();
    lower.starts_with("geometry") || lower.starts_with("geography")
}

fn is_native_cell_type(base: &str) -> bool {
    matches!(
        base,
        "boolean"
            | "bool"
            | "smallint"
            | "int2"
            | "integer"
            | "int4"
            | "bigint"
            | "int8"
            | "real"
            | "float4"
            | "double precision"
            | "float8"
            | "numeric"
            | "decimal"
            | "text"
            | "varchar"
            | "character varying"
            | "character"
            | "char"
            | "bpchar"
            | "name"
            | "uuid"
            | "timestamp"
            | "timestamp without time zone"
            | "timestamp with time zone"
            | "timestamptz"
            | "date"
            | "time"
            | "time without time zone"
            | "json"
            | "jsonb"
            | "bytea"
            | "oid"
            | "interval"
    )
}

fn should_cast_to_text(data_type: &str, is_enum: bool) -> bool {
    if is_enum {
        return true;
    }
    let lowered = data_type.trim().to_lowercase();
    if lowered.contains('[') && lowered.contains(']') {
        return true;
    }
    let base = normalize_type_name(data_type);
    if base.is_empty() {
        return false;
    }
    if base.ends_with("[]") {
        return true;
    }
    if base.contains("range") {
        return true;
    }
    if matches!(
        base.as_str(),
        "inet" | "cidr" | "macaddr" | "macaddr8" | "point" | "line" | "lseg" | "box" | "path"
            | "polygon"
            | "circle"
    ) {
        return true;
    }
    if base == "interval" {
        return true;
    }
    !is_native_cell_type(&base)
}

fn build_select_list(
    columns: &[ColumnInfo],
    enum_labels_by_column: &HashMap<String, Vec<String>>,
) -> String {
    columns
        .iter()
        .map(|c| {
            let safe_name = sanitize_identifier(&c.name);
            let quoted = format!("\"{}\"", safe_name);
            if is_geometry_type(&c.data_type) {
                format!("ST_AsGeoJSON({})::text AS {}", quoted, quoted)
            } else if should_cast_to_text(&c.data_type, enum_labels_by_column.contains_key(&c.name))
            {
                format!("{}::text AS {}", quoted, quoted)
            } else {
                quoted
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

async fn fetch_enum_labels_by_column(
    client: &tokio_postgres::Client,
    schema: &str,
    table: &str,
) -> HashMap<String, Vec<String>> {
    let rows = match client
        .query(
            "SELECT a.attname, a.atttypid
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid
             WHERE n.nspname = $1 AND c.relname = $2
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await
    {
        Ok(rows) => rows,
        Err(_) => return HashMap::new(),
    };

    let type_oids: Vec<u32> = rows.iter().map(|r| r.get::<_, u32>(1)).collect();
    let name_and_oid: Vec<(String, u32)> = rows
        .iter()
        .map(|r| (r.get::<_, String>(0), r.get::<_, u32>(1)))
        .collect();

    let enum_oids: Vec<u32> = if type_oids.is_empty() {
        vec![]
    } else {
        match client
            .query(
                "SELECT t.oid FROM pg_type t WHERE t.oid = ANY($1) AND t.typtype = 'e'",
                &[&type_oids],
            )
            .await
        {
            Ok(r) => r.iter().map(|row| row.get::<_, u32>(0)).collect(),
            Err(_) => vec![],
        }
    };

    let oid_to_labels: HashMap<u32, Vec<String>> = if enum_oids.is_empty() {
        HashMap::new()
    } else {
        match client
            .query(
                "SELECT e.enumtypid, e.enumlabel FROM pg_enum e
                 WHERE e.enumtypid = ANY($1) ORDER BY e.enumtypid, e.enumsortorder",
                &[&enum_oids],
            )
            .await
        {
            Ok(enum_rows) => {
                let mut map: HashMap<u32, Vec<String>> = HashMap::new();
                for row in &enum_rows {
                    let oid: u32 = row.get(0);
                    let label: String = row.get(1);
                    map.entry(oid).or_default().push(label);
                }
                map
            }
            Err(_) => HashMap::new(),
        }
    };

    name_and_oid
        .into_iter()
        .filter_map(|(name, oid)| {
            oid_to_labels.get(&oid).cloned().map(|labels| (name, labels))
        })
        .collect()
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema / object discovery
// ──────────────────────────────────────────────────────────────────────────────

pub async fn list_schemas(pool: &Arc<Pool>) -> Result<Vec<SchemaInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = client
        .query(
            "SELECT s.schema_name,
                    (SELECT COUNT(*) FROM information_schema.tables t
                     WHERE t.table_schema = s.schema_name
                     AND t.table_type IN ('BASE TABLE', 'VIEW')) AS table_count
             FROM information_schema.schemata s
             WHERE s.schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
             ORDER BY s.schema_name",
            &[],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let schemas = rows
        .iter()
        .map(|row| SchemaInfo {
            name: row.get(0),
            table_count: row.get(1),
        })
        .collect();

    Ok(schemas)
}

/// List event triggers (PG 9.3+).
/// Returns richer metadata: event name, firing state, and trigger function name.
pub async fn list_event_triggers(pool: &Arc<Pool>) -> Result<Vec<EventTriggerInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = client
        .query(
            "SELECT et.evtname,
                    et.evtevent,
                    CASE et.evtenabled
                        WHEN 'O' THEN 'origin'
                        WHEN 'D' THEN 'disabled'
                        WHEN 'R' THEN 'replica'
                        WHEN 'A' THEN 'always'
                        ELSE et.evtenabled::text
                    END,
                    p.proname
             FROM pg_event_trigger et
             JOIN pg_proc p ON p.oid = et.evtfoid
             ORDER BY et.evtname",
            &[],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let list = rows
        .iter()
        .map(|row| EventTriggerInfo {
            name: row.get(0),
            event: row.get(1),
            enabled: row.get(2),
            function_name: row.get(3),
        })
        .collect();

    Ok(list)
}

/// List functions / procedures / aggregates / window functions in a schema.
///
/// Adapts the query to the server version:
/// - PG 11+ uses `prokind` ('f','p','a','w'), which also covers stored procedures.
/// - PG 10 and below use the deprecated `proisagg` / `proiswindow` booleans.
///   Stored procedures did not exist before PG 11, so only functions are returned.
pub async fn list_functions(
    pool: &Arc<Pool>,
    schema: &str,
    pg_version: u32,
) -> Result<Vec<FunctionInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = if pg_version >= 110000 {
        // PG 11+: prokind column exists; includes procedures
        client
            .query(
                "SELECT p.proname,
                        COALESCE(pg_get_function_arguments(p.oid), ''),
                        COALESCE(pg_get_function_result(p.oid), ''),
                        p.prokind::text,
                        EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid),
                        l.lanname,
                        p.prosecdef,
                        p.proisstrict
                 FROM pg_proc p
                 JOIN pg_namespace n ON p.pronamespace = n.oid
                 JOIN pg_language  l ON p.prolang = l.oid
                 WHERE n.nspname = $1
                   AND p.prokind IN ('f', 'p', 'a', 'w')
                 ORDER BY p.proname",
                &[&schema],
            )
            .await
            .map_err(|e| format!("Query error: {}", e))?
    } else {
        // PG 10 and below: no prokind, no procedures
        client
            .query(
                "SELECT p.proname,
                        COALESCE(pg_get_function_arguments(p.oid), ''),
                        COALESCE(pg_get_function_result(p.oid), ''),
                        CASE WHEN p.proisagg    THEN 'a'
                             WHEN p.proiswindow THEN 'w'
                             ELSE 'f'
                        END,
                        EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid),
                        l.lanname,
                        p.prosecdef,
                        p.proisstrict
                 FROM pg_proc p
                 JOIN pg_namespace n ON p.pronamespace = n.oid
                 JOIN pg_language  l ON p.prolang = l.oid
                 WHERE n.nspname = $1
                 ORDER BY p.proname",
                &[&schema],
            )
            .await
            .map_err(|e| format!("Query error: {}", e))?
    };

    let kind_label = |k: &str| -> String {
        match k {
            "f" => "function".to_string(),
            "p" => "procedure".to_string(),
            "a" => "aggregate".to_string(),
            "w" => "window".to_string(),
            other => other.to_string(),
        }
    };

    let list = rows
        .iter()
        .map(|row| {
            let kind_raw: String = row.get(3);
            FunctionInfo {
                name: row.get(0),
                arguments: row.get(1),
                return_type: row.get(2),
                kind: kind_label(&kind_raw),
                is_trigger_function: row.get(4),
                language: row.get(5),
                security_definer: row.get(6),
                is_strict: row.get(7),
            }
        })
        .collect();

    Ok(list)
}

/// List user-defined types in a schema.
///
/// Type coverage by PG version:
/// - All versions : enum (e), composite (c), domain (d)
/// - PG 9.2+     : range (r)  — rows simply won't appear on older servers
/// - PG 14+      : multirange (m) — rows simply won't appear on older servers
///
/// Because the `typtype` column has always existed, a single query works across
/// all supported versions; versions that lack range/multirange will just
/// return no rows for those typtype values.
pub async fn list_types(pool: &Arc<Pool>, schema: &str) -> Result<Vec<TypeInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = client
        .query(
            "SELECT t.typname,
                    CASE t.typtype
                        WHEN 'e' THEN 'enum'
                        WHEN 'c' THEN 'composite'
                        WHEN 'd' THEN 'domain'
                        WHEN 'r' THEN 'range'
                        WHEN 'm' THEN 'multirange'
                        ELSE 'other'
                    END
             FROM pg_type t
             JOIN pg_namespace n ON t.typnamespace = n.oid
             WHERE n.nspname = $1
               AND t.typtype IN ('e', 'c', 'd', 'r', 'm')
             ORDER BY t.typname",
            &[&schema],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let list = rows
        .iter()
        .map(|row| TypeInfo {
            name: row.get(0),
            kind: row.get(1),
        })
        .collect();

    Ok(list)
}

/// Fetch full CREATE FUNCTION/PROCEDURE source for a function by (schema, name, arguments).
pub async fn get_function_definition(
    pool: &Arc<Pool>,
    schema: &str,
    name: &str,
    arguments: &str,
) -> Result<Option<String>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let row = client
        .query_opt(
            "SELECT pg_get_functiondef(p.oid)
             FROM pg_proc p
             JOIN pg_namespace n ON p.pronamespace = n.oid
             WHERE n.nspname = $1 AND p.proname = $2
               AND COALESCE(pg_get_function_arguments(p.oid), '') = COALESCE($3::text, '')",
            &[&schema, &name, &arguments],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;
    Ok(row.and_then(|r| r.get(0)))
}

/// Fetch type definition details (enum labels, composite attrs, domain base, etc.).
pub async fn get_type_definition(
    pool: &Arc<Pool>,
    schema: &str,
    name: &str,
) -> Result<Option<super::types::TypeDefinitionDetail>, String> {
    use super::types::TypeDefinitionDetail;

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let type_row = client
        .query_opt(
            "SELECT t.oid, t.typtype, t.typbasetype, t.typrelid
             FROM pg_type t
             JOIN pg_namespace n ON t.typnamespace = n.oid
             WHERE n.nspname = $1 AND t.typname = $2",
            &[&schema, &name],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let Some(type_row) = type_row else {
        return Ok(None);
    };

    // pg_type.typtype is PostgreSQL "char" (single byte) -> deserialize as i8
    let oid: u32 = type_row.get(0);
    let typtype_i8: i8 = type_row.get(1);
    let typtype = (typtype_i8 as u8 as char).to_string();
    let typbasetype: u32 = type_row.get(2);
    let typrelid: u32 = type_row.get(3);

    let kind = match typtype.as_str() {
        "e" => "enum",
        "c" => "composite",
        "d" => "domain",
        "r" => "range",
        "m" => "multirange",
        _ => "other",
    };

    let mut enum_labels: Option<Vec<String>> = None;
    let mut composite_attrs: Option<Vec<(String, String)>> = None;
    let mut domain_base_type: Option<String> = None;
    let mut domain_check: Option<String> = None;
    let mut range_subtype: Option<String> = None;

    if typtype == "e" {
        let rows = client
            .query(
                "SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = $1 ORDER BY e.enumsortorder",
                &[&oid],
            )
            .await
            .map_err(|e| format!("Query error: {}", e))?;
        enum_labels = Some(rows.iter().map(|r| r.get(0)).collect());
    } else if typtype == "c" && typrelid != 0 {
        let rows = client
            .query(
                "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)
                 FROM pg_attribute a
                 WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum",
                &[&typrelid],
            )
            .await
            .map_err(|e| format!("Query error: {}", e))?;
        composite_attrs = Some(rows.iter().map(|r| (r.get(0), r.get(1))).collect());
    } else if typtype == "d" && typbasetype != 0 {
        let base_row = client
            .query_opt(
                "SELECT bt.typname FROM pg_type bt WHERE bt.oid = $1",
                &[&typbasetype],
            )
            .await
            .map_err(|e| format!("Query error: {}", e))?;
        if let Some(ref r) = base_row {
            domain_base_type = Some(r.get(0));
        }
        let check_row = client
            .query_opt(
                "SELECT pg_get_constraintdef(c.oid)
                 FROM pg_constraint c
                 WHERE c.contypid = $1 AND c.contype = 'c'",
                &[&oid],
            )
            .await
            .map_err(|e| format!("Query error: {}", e))?;
        if let Some(ref r) = check_row {
            domain_check = r.get(0);
        }
    } else if typtype == "r" {
        let sub_row = client
            .query_opt(
                "SELECT st.typname FROM pg_range r JOIN pg_type st ON r.rngsubtype = st.oid WHERE r.rngtypid = $1",
                &[&oid],
            )
            .await
            .map_err(|e| format!("Query error: {}", e))?;
        if let Some(ref r) = sub_row {
            range_subtype = Some(r.get(0));
        }
    }

    Ok(Some(TypeDefinitionDetail {
        schema: schema.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        enum_labels: if typtype == "e" { enum_labels } else { None },
        composite_attrs,
        domain_base_type,
        domain_check,
        range_subtype,
    }))
}

/// Escape schema/type identifier for enum DDL (double any `"`).
fn quote_ident_enum(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Escape enum label for use inside single-quoted literal (double any `'`).
fn escape_enum_literal(s: &str) -> String {
    s.replace('\'', "''")
}

/// Create a new enum type. High-performance: single round-trip.
pub async fn create_enum(
    pool: &Arc<Pool>,
    schema: &str,
    name: &str,
    values: &[String],
) -> Result<(), String> {
    if values.is_empty() {
        return Err("Enum must have at least one value".to_string());
    }
    let quoted_schema = quote_ident_enum(schema);
    let quoted_name = quote_ident_enum(name);
    let literals: Vec<String> = values
        .iter()
        .map(|v| format!("'{}'", escape_enum_literal(v)))
        .collect();
    let sql = format!(
        "CREATE TYPE {}.{} AS ENUM ({})",
        quoted_schema,
        quoted_name,
        literals.join(", ")
    );
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("{}", e))?;
    Ok(())
}

/// Alter enum: renames and additions in one transaction. High-performance single round-trip.
pub async fn alter_enum_values(
    pool: &Arc<Pool>,
    schema: &str,
    name: &str,
    renames: &[(String, String)],
    additions: &[(String, Option<String>)],
) -> Result<(), String> {
    let quoted_schema = quote_ident_enum(schema);
    let quoted_name = quote_ident_enum(name);
    let type_ref = format!("{}.{}", quoted_schema, quoted_name);

    let mut client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format!("Transaction error: {}", e))?;

    for (old_val, new_val) in renames {
        if old_val == new_val {
            continue;
        }
        let sql = format!(
            "ALTER TYPE {} RENAME VALUE '{}' TO '{}'",
            type_ref,
            escape_enum_literal(old_val),
            escape_enum_literal(new_val)
        );
        tx.execute(&sql, &[])
            .await
            .map_err(|e| format!("Rename enum value: {}", e))?;
    }
    for (new_val, after) in additions {
        let sql = match after {
            Some(a) if !a.is_empty() => format!(
                "ALTER TYPE {} ADD VALUE '{}' AFTER '{}'",
                type_ref,
                escape_enum_literal(new_val),
                escape_enum_literal(a)
            ),
            _ => format!(
                "ALTER TYPE {} ADD VALUE '{}'",
                type_ref,
                escape_enum_literal(new_val)
            ),
        };
        tx.execute(&sql, &[])
            .await
            .map_err(|e| format!("Add enum value: {}", e))?;
    }

    tx.commit().await.map_err(|e| format!("Commit: {}", e))?;
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// Table data
// ──────────────────────────────────────────────────────────────────────────────

pub async fn list_tables(pool: &Arc<Pool>, schema: &str) -> Result<Vec<TableInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = client
        .query(
            "SELECT
                c.relname AS table_name,
                n.nspname AS table_schema,
                CASE c.relkind
                    WHEN 'v' THEN 'VIEW'
                    WHEN 'm' THEN 'VIEW'
                    ELSE 'BASE TABLE'
                END AS table_type,
                COALESCE(c.reltuples::bigint, 0) AS estimated_row_count,
                d.description AS table_comment
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
             WHERE n.nspname = $1
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
             ORDER BY c.relname",
            &[&schema],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let tables = rows
        .iter()
        .map(|row| TableInfo {
            name: row.get(0),
            schema: row.get(1),
            table_type: row.get(2),
            row_count: row.get(3),
            table_comment: row.get(4),
        })
        .collect();

    Ok(tables)
}

pub async fn get_columns(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = client
        .query(
            "SELECT
                a.attname,
                pg_catalog.format_type(a.atttypid, a.atttypmod),
                NOT a.attnotnull AS is_nullable,
                a.attnum::int AS ordinal_position,
                pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
                EXISTS (
                    SELECT 1
                    FROM pg_index i
                    WHERE i.indrelid = c.oid
                      AND i.indisprimary
                      AND a.attnum = ANY(i.indkey)
                ) AS is_pk,
                d.description AS column_comment
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid
             LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
             LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
             WHERE n.nspname = $1
               AND c.relname = $2
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND a.attnum > 0
               AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let columns = rows
        .iter()
        .map(|row| ColumnInfo {
            name: row.get(0),
            data_type: row.get(1),
            is_nullable: row.get(2),
            ordinal_position: row.get(3),
            column_default: row.get(4),
            is_primary_key: row.get(5),
            comment: row.get(6),
        })
        .collect();

    Ok(columns)
}

fn is_comment_missing(comment: &Option<String>) -> bool {
    comment
        .as_ref()
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
}

fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Returns complete table/column/index metadata (including existing comments) for AI documentation.
pub async fn get_documentation_context(
    pool: &Arc<Pool>,
    schema_filter: Option<&str>,
) -> Result<DocumentationContext, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let db_row = client
        .query_one("SELECT current_database()", &[])
        .await
        .map_err(|e| format!("Database name query error: {}", e))?;
    let database_name: String = db_row.get(0);

    let table_rows = client
        .query(
            "SELECT
                n.nspname AS schema_name,
                c.relname AS table_name,
                CASE c.relkind
                    WHEN 'v' THEN 'VIEW'
                    WHEN 'm' THEN 'MATERIALIZED VIEW'
                    WHEN 'f' THEN 'FOREIGN TABLE'
                    WHEN 'p' THEN 'PARTITIONED TABLE'
                    ELSE 'BASE TABLE'
                END AS table_type,
                d.description AS table_comment
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
               AND n.nspname NOT LIKE 'pg_temp_%'
               AND n.nspname NOT LIKE 'pg_toast_temp_%'
               AND ($1::text IS NULL OR n.nspname = $1)
             ORDER BY n.nspname, c.relname",
            &[&schema_filter],
        )
        .await
        .map_err(|e| format!("Documentation tables query error: {}", e))?;

    let tables: Vec<DocumentationTable> = table_rows
        .iter()
        .map(|row| DocumentationTable {
            schema: row.get(0),
            table: row.get(1),
            table_type: row.get(2),
            comment: row.get(3),
        })
        .collect();

    let column_rows = client
        .query(
            "SELECT
                n.nspname AS schema_name,
                c.relname AS table_name,
                CASE c.relkind
                    WHEN 'v' THEN 'VIEW'
                    WHEN 'm' THEN 'MATERIALIZED VIEW'
                    WHEN 'f' THEN 'FOREIGN TABLE'
                    WHEN 'p' THEN 'PARTITIONED TABLE'
                    ELSE 'BASE TABLE'
                END AS table_type,
                a.attnum::int AS ordinal_position,
                a.attname AS column_name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                NOT a.attnotnull AS is_nullable,
                pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
                EXISTS (
                    SELECT 1
                    FROM pg_index i
                    WHERE i.indrelid = c.oid
                      AND i.indisprimary
                      AND a.attnum = ANY(i.indkey)
                ) AS is_primary_key,
                fk.ref_target,
                cd.description AS column_comment
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid
             LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
             LEFT JOIN LATERAL (
                 SELECT format('%I.%I(%I)', fn.nspname, fc.relname, fa.attname) AS ref_target
                 FROM pg_constraint con
                 JOIN pg_class fc ON fc.oid = con.confrelid
                 JOIN pg_namespace fn ON fn.oid = fc.relnamespace
                 JOIN unnest(con.conkey) WITH ORDINALITY AS src(attnum, ord) ON src.attnum = a.attnum
                 JOIN unnest(con.confkey) WITH ORDINALITY AS tgt(attnum, ord) ON src.ord = tgt.ord
                 JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = tgt.attnum
                 WHERE con.contype = 'f'
                   AND con.conrelid = c.oid
                 LIMIT 1
             ) fk ON true
             LEFT JOIN pg_description cd ON cd.objoid = c.oid AND cd.objsubid = a.attnum
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
               AND n.nspname NOT LIKE 'pg_temp_%'
               AND n.nspname NOT LIKE 'pg_toast_temp_%'
               AND ($1::text IS NULL OR n.nspname = $1)
               AND a.attnum > 0
               AND NOT a.attisdropped
             ORDER BY n.nspname, c.relname, a.attnum",
            &[&schema_filter],
        )
        .await
        .map_err(|e| format!("Documentation columns query error: {}", e))?;

    let columns: Vec<DocumentationColumn> = column_rows
        .iter()
        .map(|row| DocumentationColumn {
            schema: row.get(0),
            table: row.get(1),
            table_type: row.get(2),
            ordinal_position: row.get(3),
            name: row.get(4),
            data_type: row.get(5),
            is_nullable: row.get(6),
            column_default: row.get(7),
            is_primary_key: row.get(8),
            foreign_key_target: row.get(9),
            comment: row.get(10),
        })
        .collect();

    let index_rows = client
        .query(
            "SELECT
                n.nspname AS schema_name,
                t.relname AS table_name,
                CASE t.relkind
                    WHEN 'm' THEN 'MATERIALIZED VIEW'
                    WHEN 'f' THEN 'FOREIGN TABLE'
                    WHEN 'p' THEN 'PARTITIONED TABLE'
                    ELSE 'BASE TABLE'
                END AS table_type,
                i.relname AS index_name,
                ix.indisunique,
                ix.indisprimary,
                am.amname AS index_type,
                (ARRAY(
                    SELECT a.attname
                    FROM pg_attribute a
                    WHERE a.attrelid = t.oid
                      AND a.attnum = ANY(ix.indkey)
                      AND a.attnum > 0
                    ORDER BY array_position(ix.indkey, a.attnum)
                ))::text[] AS columns,
                pg_get_indexdef(ix.indexrelid) AS definition,
                idesc.description AS index_comment
             FROM pg_index ix
             JOIN pg_class t ON t.oid = ix.indrelid
             JOIN pg_class i ON i.oid = ix.indexrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_am am ON am.oid = i.relam
             LEFT JOIN pg_description idesc ON idesc.objoid = i.oid AND idesc.objsubid = 0
             WHERE t.relkind IN ('r', 'p', 'm', 'f')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
               AND n.nspname NOT LIKE 'pg_temp_%'
               AND n.nspname NOT LIKE 'pg_toast_temp_%'
               AND ($1::text IS NULL OR n.nspname = $1)
             ORDER BY n.nspname, t.relname, i.relname",
            &[&schema_filter],
        )
        .await
        .map_err(|e| format!("Documentation indexes query error: {}", e))?;

    let indexes: Vec<DocumentationIndex> = index_rows
        .iter()
        .map(|row| DocumentationIndex {
            schema: row.get(0),
            table: row.get(1),
            table_type: row.get(2),
            name: row.get(3),
            is_unique: row.get(4),
            is_primary: row.get(5),
            index_type: row.get(6),
            columns: row.try_get::<_, Vec<String>>(7).unwrap_or_default(),
            definition: row.get(8),
            comment: row.get(9),
        })
        .collect();

    let undocumented_tables = tables
        .iter()
        .filter(|t| is_comment_missing(&t.comment))
        .count();
    let undocumented_columns = columns
        .iter()
        .filter(|c| is_comment_missing(&c.comment))
        .count();
    let undocumented_indexes = indexes
        .iter()
        .filter(|i| is_comment_missing(&i.comment))
        .count();

    Ok(DocumentationContext {
        database_name,
        tables,
        columns,
        indexes,
        undocumented_tables,
        undocumented_columns,
        undocumented_indexes,
    })
}

/// Applies COMMENT ON statements in one transaction. Any failure rolls back all comments.
pub async fn apply_documentation_comments(
    pool: &Arc<Pool>,
    patches: &[DocumentationCommentPatch],
) -> Result<u64, String> {
    if patches.is_empty() {
        return Ok(0);
    }

    let mut client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format!("Transaction error: {}", e))?;

    let mut applied_count = 0u64;
    for patch in patches {
        let comment = patch.comment.trim();
        if comment.is_empty() {
            continue;
        }

        let schema_q = quote_ident(&patch.schema);
        let comment_lit = quote_literal(comment);
        let kind = patch.kind.trim().to_ascii_lowercase();

        let sql =
            match kind.as_str() {
                "table" => {
                    let table =
                        patch.table.as_ref().map(|v| v.as_str()).ok_or_else(|| {
                            "Missing table name for table comment patch".to_string()
                        })?;
                    format!(
                        "COMMENT ON TABLE {}.{} IS {}",
                        schema_q,
                        quote_ident(table),
                        comment_lit
                    )
                }
                "column" => {
                    let table =
                        patch.table.as_ref().map(|v| v.as_str()).ok_or_else(|| {
                            "Missing table name for column comment patch".to_string()
                        })?;
                    let column = patch.column.as_ref().map(|v| v.as_str()).ok_or_else(|| {
                        "Missing column name for column comment patch".to_string()
                    })?;
                    format!(
                        "COMMENT ON COLUMN {}.{}.{} IS {}",
                        schema_q,
                        quote_ident(table),
                        quote_ident(column),
                        comment_lit
                    )
                }
                "index" => {
                    let index =
                        patch.index.as_ref().map(|v| v.as_str()).ok_or_else(|| {
                            "Missing index name for index comment patch".to_string()
                        })?;
                    format!(
                        "COMMENT ON INDEX {}.{} IS {}",
                        schema_q,
                        quote_ident(index),
                        comment_lit
                    )
                }
                _ => {
                    return Err(format!(
                        "Unsupported documentation patch kind: {}",
                        patch.kind
                    ))
                }
            };

        tx.execute(&sql, &[])
            .await
            .map_err(|e| format!("Failed to apply {} comment: {}", kind, e))?;
        applied_count += 1;
    }

    tx.commit()
        .await
        .map_err(|e| format!("Commit error: {}", e))?;
    Ok(applied_count)
}

pub async fn get_table_data(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    page: u32,
    page_size: u32,
    sort_column: Option<&str>,
    sort_direction: Option<&str>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    // Use pg_class estimate; fall back to exact count for views / empty tables
    let total_rows: i64 = match client
        .query_one(
            &format!(
                "SELECT reltuples::bigint FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = '{}' AND n.nspname = '{}'",
                safe_table, safe_schema
            ),
            &[],
        )
        .await
    {
        Ok(row) => {
            let count: i64 = row.get(0);
            if count < 0 {
                0
            } else {
                count
            }
        }
        Err(_) => {
            let count_result = client
                .query_one(
                    &format!(
                        "SELECT COUNT(*) FROM \"{}\".\"{}\"",
                        safe_schema, safe_table
                    ),
                    &[],
                )
                .await
                .map_err(|e| format!("Count error: {}", e))?;
            count_result.get(0)
        }
    };

    let columns_meta = get_columns(pool, schema, table).await.unwrap_or_default();

    // Fetch enum labels for columns that use custom enum types (one batch of queries).
    let enum_labels_by_column =
        fetch_enum_labels_by_column(&client, schema, table).await;

    let (query, columns): (String, Vec<ResultColumn>) = if !columns_meta.is_empty() {
        let select_list: String = build_select_list(&columns_meta, &enum_labels_by_column);
        let order_clause = if let Some(col) = sort_column {
            let safe_col = sanitize_identifier(col);
            let dir = match sort_direction {
                Some(d) if d.to_uppercase() == "DESC" => "DESC",
                _ => "ASC",
            };
            format!("ORDER BY \"{}\" {} NULLS LAST", safe_col, dir)
        } else {
            columns_meta
                .iter()
                .find(|c| {
                    let lower = c.name.to_lowercase();
                    matches!(
                        lower.as_str(),
                        "created_at"
                            | "createdat"
                            | "create_date"
                            | "creation_date"
                            | "date_created"
                            | "created"
                    )
                })
                .map(|c| {
                    format!(
                        "ORDER BY \"{}\" DESC NULLS LAST",
                        sanitize_identifier(&c.name)
                    )
                })
                .unwrap_or_default()
        };
        let offset = (page.saturating_sub(1)) * page_size;
        let q = format!(
            "SELECT {} FROM \"{}\".\"{}\" {} LIMIT {} OFFSET {}",
            select_list, safe_schema, safe_table, order_clause, page_size, offset
        );
        let cols: Vec<ResultColumn> = columns_meta
            .iter()
            .map(|c| ResultColumn {
                name: c.name.clone(),
                data_type: c.data_type.clone(),
                enum_labels: enum_labels_by_column.get(&c.name).cloned(),
            })
            .collect();
        (q, cols)
    } else {
        let order_clause = if let Some(col) = sort_column {
            let safe_col = sanitize_identifier(col);
            let dir = match sort_direction {
                Some(d) if d.to_uppercase() == "DESC" => "DESC",
                _ => "ASC",
            };
            format!("ORDER BY \"{}\" {} NULLS LAST", safe_col, dir)
        } else {
            String::new()
        };
        let offset = (page.saturating_sub(1)) * page_size;
        let q = format!(
            "SELECT * FROM \"{}\".\"{}\" {} LIMIT {} OFFSET {}",
            safe_schema, safe_table, order_clause, page_size, offset
        );
        (q, Vec::new())
    };

    let rows = client
        .query(&query, &[])
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let (columns, data): (Vec<ResultColumn>, Vec<Vec<CellValue>>) =
        if columns.is_empty() && !rows.is_empty() {
            let cols: Vec<ResultColumn> = rows[0]
                .columns()
                .iter()
                .map(|col| {
                    let name = col.name().to_string();
                    ResultColumn {
                        name: name.clone(),
                        data_type: pg_type_to_string(col.type_()),
                        enum_labels: enum_labels_by_column.get(&name).cloned(),
                    }
                })
                .collect();
            let data = rows.iter().map(|row| row_to_cells(row)).collect();
            (cols, data)
        } else {
            let data = rows.iter().map(|row| row_to_cells(row)).collect();
            (columns, data)
        };

    let row_count = data.len();
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;

    Ok(QueryResult {
        columns,
        rows: data,
        row_count,
        total_rows: Some(total_rows),
        execution_time_ms: elapsed,
        page: Some(page),
        page_size: Some(page_size),
        query,
        is_error: false,
        error_message: None,
    })
}

/// Table data with geometry columns returned as GeoJSON (ST_AsGeoJSON) for map visualization.
/// geometry_column_names: column names to convert; must be actual geometry/geography columns.
pub async fn get_table_data_geojson(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    geometry_column_names: Vec<String>,
    limit: u32,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    let columns = get_columns(pool, schema, table)
        .await
        .map_err(|e| format!("Columns error: {}", e))?;

    let geom_set: std::collections::HashSet<String> = geometry_column_names
        .iter()
        .map(|s| s.to_lowercase())
        .collect();

    let select_parts: Vec<String> = columns
        .iter()
        .map(|c| {
            let safe_name = sanitize_identifier(&c.name);
            let quoted = format!("\"{}\"", safe_name);
            if geom_set.contains(&c.name.to_lowercase()) {
                format!("ST_AsGeoJSON({})::text AS {}", quoted, quoted)
            } else {
                quoted
            }
        })
        .collect();
    let select_list = select_parts.join(", ");

    let order_clause = columns
        .iter()
        .find(|c| {
            let lower = c.name.to_lowercase();
            matches!(
                lower.as_str(),
                "created_at"
                    | "createdat"
                    | "create_date"
                    | "creation_date"
                    | "date_created"
                    | "created"
            )
        })
        .map(|c| {
            format!(
                "ORDER BY \"{}\" DESC NULLS LAST",
                sanitize_identifier(&c.name)
            )
        })
        .unwrap_or_else(String::new);

    let limit = limit.min(10_000);
    let query = format!(
        "SELECT {} FROM \"{}\".\"{}\" {} LIMIT {}",
        select_list, safe_schema, safe_table, order_clause, limit
    );

    let rows = client
        .query(&query, &[])
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let result_columns: Vec<ResultColumn> = columns
        .into_iter()
        .map(|c| ResultColumn {
            name: c.name,
            data_type: c.data_type,
            enum_labels: None,
        })
        .collect();

    let data: Vec<Vec<CellValue>> = rows.iter().map(|row| row_to_cells(row)).collect();
    let row_count = data.len();
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;

    Ok(QueryResult {
        columns: result_columns,
        rows: data,
        row_count,
        total_rows: Some(row_count as i64),
        execution_time_ms: elapsed,
        page: None,
        page_size: None,
        query,
        is_error: false,
        error_message: None,
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// Query execution
// ──────────────────────────────────────────────────────────────────────────────

/// Strip leading whitespace, line comments (-- ...) and block comments (/* ... */).
/// Returns the slice starting at the first significant token, or empty if only comments.
fn strip_leading_comments_and_whitespace(mut sql: &str) -> &str {
    loop {
        sql = sql.trim_start();
        if sql.is_empty() {
            return sql;
        }
        if sql.starts_with("--") {
            if let Some(pos) = sql.find('\n') {
                sql = &sql[pos + 1..];
            } else {
                return "";
            }
            continue;
        }
        if sql.starts_with("/*") {
            if let Some(pos) = sql.find("*/") {
                sql = sql.get(pos + 2..).unwrap_or("");
            } else {
                return "";
            }
            continue;
        }
        return sql;
    }
}

/// Returns the maximum parameter index in SQL (e.g. $1, $2, $5 => 5). 0 if none.
fn max_parameter_index(sql: &str) -> usize {
    let mut max = 0usize;
    let mut i = 0;
    let bytes = sql.as_bytes();
    while i + 1 < bytes.len() {
        if bytes[i] == b'$' && bytes[i + 1].is_ascii_digit() {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if let Ok(n) = std::str::from_utf8(&bytes[start..end])
                .unwrap_or("0")
                .parse::<usize>()
            {
                if n > max {
                    max = n;
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    max
}

/// Split SQL into statements by `;`, ignoring semicolons inside comments,
/// single/double-quoted strings, and dollar-quoted bodies (e.g. function bodies).
fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();

    while i < n {
        let c = chars[i];

        // Line comment: skip until newline
        if c == '-' && i + 1 < n && chars[i + 1] == '-' {
            current.push(c);
            current.push(chars[i + 1]);
            i += 2;
            while i < n && chars[i] != '\n' {
                current.push(chars[i]);
                i += 1;
            }
            if i < n {
                current.push(chars[i]);
                i += 1;
            }
            continue;
        }

        // Block comment: skip until */
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            current.push(c);
            current.push(chars[i + 1]);
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                current.push(chars[i]);
                i += 1;
            }
            if i + 1 < n {
                current.push(chars[i]);
                current.push(chars[i + 1]);
                i += 2;
            }
            continue;
        }

        // Single-quoted string (with '' escape)
        if c == '\'' {
            current.push(c);
            i += 1;
            while i < n {
                let q = chars[i];
                if q == '\'' && i + 1 < n && chars[i + 1] == '\'' {
                    current.push(q);
                    current.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                if q == '\'' {
                    current.push(q);
                    i += 1;
                    break;
                }
                current.push(q);
                i += 1;
            }
            continue;
        }

        // Double-quoted identifier
        if c == '"' {
            current.push(c);
            i += 1;
            while i < n && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < n {
                    current.push(chars[i]);
                    current.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                current.push(chars[i]);
                i += 1;
            }
            if i < n {
                current.push(chars[i]);
                i += 1;
            }
            continue;
        }

        // Dollar-quoted string: $tag$ ... $tag$
        if c == '$' && i + 1 < n {
            i += 1;
            let mut tag = String::new();
            while i < n && chars[i] != '$' {
                tag.push(chars[i]);
                i += 1;
            }
            if i < n {
                i += 1; // closing $
                let tag_len = tag.chars().count();
                let delim_len = tag_len + 2; // $tag$
                current.push('$');
                current.push_str(&tag);
                current.push('$');
                loop {
                    if i + delim_len <= n {
                        let peek: String = chars[i..i + delim_len].iter().collect();
                        let expected = format!("${}$", tag);
                        if peek == expected {
                            current.push_str(&peek);
                            i += delim_len;
                            break;
                        }
                    }
                    if i >= n {
                        break;
                    }
                    current.push(chars[i]);
                    i += 1;
                }
            } else {
                current.push(c);
            }
            continue;
        }

        // Statement terminator
        if c == ';' {
            let stmt = current.trim().to_string();
            if !stmt.is_empty() {
                statements.push(stmt);
            }
            current.clear();
            i += 1;
            continue;
        }

        current.push(c);
        i += 1;
    }

    let stmt = current.trim().to_string();
    if !stmt.is_empty() {
        statements.push(stmt);
    }
    statements
}

pub async fn execute_query(pool: &Arc<Pool>, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let mut client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let trimmed = sql.trim();
    let statements = split_sql_statements(trimmed);

    // Single statement: existing behaviour (prepared statement compatible).
    if statements.len() <= 1 {
        let stmt = if statements.is_empty() {
            trimmed
        } else {
            &statements[0]
        };
        let first_token = strip_leading_comments_and_whitespace(stmt);
        let upper = first_token.to_uppercase();
        let is_select = upper.starts_with("SELECT")
            || upper.starts_with("WITH")
            || upper.starts_with("TABLE")
            || upper.starts_with("VALUES")
            || upper.starts_with("SHOW")
            || upper.starts_with("EXPLAIN");

        let param_count = max_parameter_index(stmt);
        let params: Vec<Option<String>> = (0..param_count).map(|_| None).collect();
        let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
            .iter()
            .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
            .collect();
        let param_slice: &[&(dyn tokio_postgres::types::ToSql + Sync)] = param_refs.as_slice();

        if is_select {
            match client.query(stmt, param_slice).await {
                Ok(rows) => {
                    let columns: Vec<ResultColumn> = if !rows.is_empty() {
                        rows[0]
                            .columns()
                            .iter()
                            .map(|col| ResultColumn {
                                name: col.name().to_string(),
                                data_type: pg_type_to_string(col.type_()),
                                enum_labels: None,
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    let data: Vec<Vec<CellValue>> =
                        rows.iter().map(|row| row_to_cells(row)).collect();
                    let row_count = data.len();
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    return Ok(QueryResult {
                        columns,
                        rows: data,
                        row_count,
                        total_rows: Some(row_count as i64),
                        execution_time_ms: elapsed,
                        page: None,
                        page_size: None,
                        query: trimmed.to_string(),
                        is_error: false,
                        error_message: None,
                    });
                }
                Err(e) => {
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    return Ok(QueryResult {
                        columns: Vec::new(),
                        rows: Vec::new(),
                        row_count: 0,
                        total_rows: None,
                        execution_time_ms: elapsed,
                        page: None,
                        page_size: None,
                        query: trimmed.to_string(),
                        is_error: true,
                        error_message: Some(format_pg_error(&e)),
                    });
                }
            }
        } else {
            match client.execute(stmt, param_slice).await {
                Ok(affected) => {
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    return Ok(QueryResult {
                        columns: vec![ResultColumn {
                            name: "affected_rows".to_string(),
                            data_type: "bigint".to_string(),
                            enum_labels: None,
                        }],
                        rows: vec![vec![CellValue::Int64(affected as i64)]],
                        row_count: 1,
                        total_rows: Some(1),
                        execution_time_ms: elapsed,
                        page: None,
                        page_size: None,
                        query: trimmed.to_string(),
                        is_error: false,
                        error_message: None,
                    });
                }
                Err(e) => {
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    return Ok(QueryResult {
                        columns: Vec::new(),
                        rows: Vec::new(),
                        row_count: 0,
                        total_rows: None,
                        execution_time_ms: elapsed,
                        page: None,
                        page_size: None,
                        query: trimmed.to_string(),
                        is_error: true,
                        error_message: Some(format_pg_error(&e)),
                    });
                }
            }
        }
    }

    // Multiple statements: run in a single transaction so failure rolls back (matches pgAdmin script behavior).
    let n = statements.len();
    let txn = client
        .transaction()
        .await
        .map_err(|e| format!("Transaction begin: {}", format_pg_error(&e)))?;
    let mut last_select_result: Option<QueryResult> = None;
    for (idx, stmt) in statements.iter().enumerate() {
        let stmt_trim = stmt.trim();
        if stmt_trim.is_empty() {
            continue;
        }
        let first_token = strip_leading_comments_and_whitespace(stmt_trim);
        let upper = first_token.to_uppercase();
        let read_only = upper.starts_with("SELECT")
            || upper.starts_with("WITH")
            || upper.starts_with("TABLE")
            || upper.starts_with("VALUES")
            || upper.starts_with("SHOW")
            || upper.starts_with("EXPLAIN");

        if read_only {
            match txn.query(stmt_trim, &[]).await {
                Ok(rows) => {
                    let columns: Vec<ResultColumn> = if !rows.is_empty() {
                        rows[0]
                            .columns()
                            .iter()
                            .map(|col| ResultColumn {
                                name: col.name().to_string(),
                                data_type: pg_type_to_string(col.type_()),
                                enum_labels: None,
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    let data: Vec<Vec<CellValue>> =
                        rows.iter().map(|row| row_to_cells(row)).collect();
                    let row_count = data.len();
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    last_select_result = Some(QueryResult {
                        columns,
                        rows: data,
                        row_count,
                        total_rows: Some(row_count as i64),
                        execution_time_ms: elapsed,
                        page: None,
                        page_size: None,
                        query: trimmed.to_string(),
                        is_error: false,
                        error_message: None,
                    });
                }
                Err(e) => {
                    let _ = txn.rollback().await;
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    return Ok(QueryResult {
                        columns: Vec::new(),
                        rows: Vec::new(),
                        row_count: 0,
                        total_rows: None,
                        execution_time_ms: elapsed,
                        page: None,
                        page_size: None,
                        query: trimmed.to_string(),
                        is_error: true,
                        error_message: Some(format!(
                            "Statement {}: {}",
                            idx + 1,
                            format_pg_error(&e)
                        )),
                    });
                }
            }
        } else {
            if let Err(e) = txn.execute(stmt_trim, &[]).await {
                let _ = txn.rollback().await;
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                return Ok(QueryResult {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    row_count: 0,
                    total_rows: None,
                    execution_time_ms: elapsed,
                    page: None,
                    page_size: None,
                    query: trimmed.to_string(),
                    is_error: true,
                    error_message: Some(format!("Statement {}: {}", idx + 1, format_pg_error(&e))),
                });
            }
        }
    }
    txn.commit()
        .await
        .map_err(|e| format!("Commit: {}", format_pg_error(&e)))?;

    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    if let Some(res) = last_select_result {
        Ok(QueryResult {
            execution_time_ms: elapsed,
            ..res
        })
    } else {
        Ok(QueryResult {
            columns: vec![ResultColumn {
                name: "statements".to_string(),
                data_type: "int8".to_string(),
                enum_labels: None,
            }],
            rows: vec![vec![CellValue::Int64(n as i64)]],
            row_count: 1,
            total_rows: Some(1),
            execution_time_ms: elapsed,
            page: None,
            page_size: None,
            query: trimmed.to_string(),
            is_error: false,
            error_message: None,
        })
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Database / server
// ──────────────────────────────────────────────────────────────────────────────

pub async fn list_databases(pool: &Arc<Pool>) -> Result<Vec<String>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = client
        .query(
            "SELECT datname FROM pg_database \
             WHERE datistemplate = false AND datallowconn = true \
             ORDER BY datname",
            &[],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    Ok(rows.iter().map(|row| row.get::<_, String>(0)).collect())
}

pub async fn create_database(pool: &Arc<Pool>, name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 63 {
        return Err("Database name must be between 1 and 63 characters".to_string());
    }
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    // Escape double-quotes in the identifier
    let quoted = name.replace('"', "\"\"");
    let sql = format!("CREATE DATABASE \"{}\"", quoted);
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("{}", e))?;
    Ok(())
}

pub async fn drop_database(pool: &Arc<Pool>, name: &str) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let quoted = name.replace('"', "\"\"");
    let sql = format!("DROP DATABASE \"{}\"", quoted);
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("{}", e))?;
    Ok(())
}

/// Returns (database_name, full_version_string).
pub async fn get_server_info(pool: &Arc<Pool>) -> Result<(String, String), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let version_row = client
        .query_one("SELECT version()", &[])
        .await
        .map_err(|e| format!("Version query error: {}", e))?;
    let version: String = version_row.get(0);

    let db_row = client
        .query_one("SELECT current_database()", &[])
        .await
        .map_err(|e| format!("DB name query error: {}", e))?;
    let db_name: String = db_row.get(0);

    Ok((db_name, version))
}

pub async fn get_database_access_profile(
    pool: &Arc<Pool>,
) -> Result<DatabaseAccessProfile, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let row = client
        .query_one(
            "SELECT
                current_user::text,
                r.rolsuper,
                r.rolcreatedb,
                r.rolcreaterole,
                has_database_privilege(current_user, current_database(), 'CREATE')
             FROM pg_roles r
             WHERE r.rolname = current_user",
            &[],
        )
        .await
        .map_err(|e| format!("Failed to read access profile: {}", e))?;

    let current_user: String = row.get(0);
    let is_superuser: bool = row.get(1);
    let can_create_db: bool = row.get(2);
    let can_create_role: bool = row.get(3);
    let can_create_in_database: bool = row.get(4);

    Ok(DatabaseAccessProfile {
        current_user,
        is_superuser,
        can_create_db,
        can_create_role,
        can_create_in_database,
        is_admin: is_superuser || can_create_role,
    })
}

fn extension_block_reason(
    profile: &DatabaseAccessProfile,
    installed_version: &Option<String>,
    requires_superuser: bool,
    trusted: bool,
) -> Option<String> {
    if installed_version.is_some() {
        return Some("Extension is already installed.".to_string());
    }
    if profile.is_superuser {
        return None;
    }
    if !profile.can_create_in_database {
        return Some("Current role lacks CREATE privilege on this database.".to_string());
    }
    if requires_superuser && !trusted {
        return Some(
            "Extension requires superuser privileges and is not trusted for non-superusers."
                .to_string(),
        );
    }
    None
}

pub async fn list_database_extensions(
    pool: &Arc<Pool>,
) -> Result<Vec<DatabaseExtensionInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let profile = get_database_access_profile(pool).await?;

    let has_trusted_column: bool = client
        .query_one(
            "SELECT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'pg_catalog'
                  AND table_name = 'pg_available_extension_versions'
                  AND column_name = 'trusted'
            )",
            &[],
        )
        .await
        .map_err(|e| format!("Failed to inspect extension metadata: {}", e))?
        .get(0);

    let rows = if has_trusted_column {
        client
            .query(
                "SELECT
                    e.name,
                    e.default_version,
                    e.installed_version,
                    e.comment,
                    COALESCE(bool_and(v.superuser), true) AS requires_superuser,
                    COALESCE(bool_or(v.trusted), false) AS trusted
                 FROM pg_available_extensions e
                 LEFT JOIN pg_available_extension_versions v
                    ON v.name = e.name
                 GROUP BY e.name, e.default_version, e.installed_version, e.comment
                 ORDER BY e.name",
                &[],
            )
            .await
            .map_err(|e| format!("Failed to list extensions: {}", e))?
    } else {
        client
            .query(
                "SELECT
                    e.name,
                    e.default_version,
                    e.installed_version,
                    e.comment,
                    COALESCE(bool_and(v.superuser), true) AS requires_superuser,
                    false AS trusted
                 FROM pg_available_extensions e
                 LEFT JOIN pg_available_extension_versions v
                    ON v.name = e.name
                 GROUP BY e.name, e.default_version, e.installed_version, e.comment
                 ORDER BY e.name",
                &[],
            )
            .await
            .map_err(|e| format!("Failed to list extensions: {}", e))?
    };

    Ok(rows
        .into_iter()
        .map(|row| {
            let installed_version: Option<String> = row.get(2);
            let requires_superuser: bool = row.get(4);
            let trusted: bool = row.get(5);
            let block_reason =
                extension_block_reason(&profile, &installed_version, requires_superuser, trusted);

            DatabaseExtensionInfo {
                name: row.get(0),
                default_version: row.get(1),
                installed_version,
                comment: row.get(3),
                requires_superuser,
                trusted,
                can_install: block_reason.is_none(),
                install_block_reason: block_reason,
            }
        })
        .collect())
}

fn validate_extension_name(name: &str) -> Result<String, String> {
    let value = name.trim();
    if value.is_empty() || value.len() > 63 {
        return Err("Extension name must be between 1 and 63 characters".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(
            "Extension name must contain only letters, numbers, underscores, or hyphens."
                .to_string(),
        );
    }
    Ok(value.to_string())
}

pub async fn install_database_extension(
    pool: &Arc<Pool>,
    extension_name: &str,
) -> Result<(), String> {
    let extension_name = validate_extension_name(extension_name)?;
    let extension_catalog = list_database_extensions(pool).await?;
    let ext = extension_catalog
        .iter()
        .find(|item| item.name == extension_name)
        .ok_or_else(|| {
            format!(
                "Extension '{}' is not available on this server.",
                extension_name
            )
        })?;

    if let Some(reason) = &ext.install_block_reason {
        return Err(format!("Permission denied: {}", reason));
    }

    if ext.installed_version.is_some() {
        return Ok(());
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let sql = format!(
        "CREATE EXTENSION IF NOT EXISTS {}",
        quote_ident(&extension_name)
    );
    client.execute(&sql, &[]).await.map_err(|e| {
        let raw = e.to_string();
        if raw.contains("permission denied") || raw.contains("must be superuser") {
            format!(
                "Permission denied while installing extension '{}': {}",
                extension_name, raw
            )
        } else {
            format!("Failed to install extension '{}': {}", extension_name, raw)
        }
    })?;

    Ok(())
}

fn validate_extension_version(version: &str) -> Result<String, String> {
    let value = version.trim();
    if value.is_empty() {
        return Err("Extension version cannot be empty.".to_string());
    }
    if value.len() > 64 {
        return Err("Extension version is too long.".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' || ch == '+')
    {
        return Err("Extension version contains unsupported characters.".to_string());
    }
    Ok(value.to_string())
}

fn extension_manage_block_reason(
    profile: &DatabaseAccessProfile,
    installed_version: &Option<String>,
    installed_owner: &Option<String>,
    action_label: &str,
) -> Option<String> {
    if installed_version.is_none() {
        return Some("Extension is not installed.".to_string());
    }
    if profile.is_superuser {
        return None;
    }
    if installed_owner
        .as_ref()
        .is_some_and(|owner| owner == &profile.current_user)
    {
        return None;
    }
    Some(format!(
        "Only superusers or extension owners can {} this extension.",
        action_label
    ))
}

pub async fn get_database_extension_detail(
    pool: &Arc<Pool>,
    extension_name: &str,
) -> Result<DatabaseExtensionDetail, String> {
    let extension_name = validate_extension_name(extension_name)?;
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let profile = get_database_access_profile(pool).await?;

    let has_trusted_column: bool = client
        .query_one(
            "SELECT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'pg_catalog'
                  AND table_name = 'pg_available_extension_versions'
                  AND column_name = 'trusted'
            )",
            &[],
        )
        .await
        .map_err(|e| format!("Failed to inspect extension metadata: {}", e))?
        .get(0);

    let row = if has_trusted_column {
        client
            .query_opt(
                "SELECT
                    e.name,
                    e.default_version,
                    e.installed_version,
                    e.comment,
                    COALESCE(bool_and(v.superuser), true) AS requires_superuser,
                    COALESCE(bool_or(v.trusted), false) AS trusted,
                    ext.extversion,
                    n.nspname AS installed_schema,
                    owner_role.rolname AS installed_owner
                 FROM pg_available_extensions e
                 LEFT JOIN pg_available_extension_versions v
                    ON v.name = e.name
                 LEFT JOIN pg_extension ext
                    ON ext.extname = e.name
                 LEFT JOIN pg_namespace n
                    ON n.oid = ext.extnamespace
                 LEFT JOIN pg_roles owner_role
                    ON owner_role.oid = ext.extowner
                 WHERE e.name = $1
                 GROUP BY
                    e.name,
                    e.default_version,
                    e.installed_version,
                    e.comment,
                    ext.extversion,
                    n.nspname,
                    owner_role.rolname",
                &[&extension_name],
            )
            .await
            .map_err(|e| format!("Failed to load extension detail: {}", e))?
    } else {
        client
            .query_opt(
                "SELECT
                    e.name,
                    e.default_version,
                    e.installed_version,
                    e.comment,
                    COALESCE(bool_and(v.superuser), true) AS requires_superuser,
                    false AS trusted,
                    ext.extversion,
                    n.nspname AS installed_schema,
                    owner_role.rolname AS installed_owner
                 FROM pg_available_extensions e
                 LEFT JOIN pg_available_extension_versions v
                    ON v.name = e.name
                 LEFT JOIN pg_extension ext
                    ON ext.extname = e.name
                 LEFT JOIN pg_namespace n
                    ON n.oid = ext.extnamespace
                 LEFT JOIN pg_roles owner_role
                    ON owner_role.oid = ext.extowner
                 WHERE e.name = $1
                 GROUP BY
                    e.name,
                    e.default_version,
                    e.installed_version,
                    e.comment,
                    ext.extversion,
                    n.nspname,
                    owner_role.rolname",
                &[&extension_name],
            )
            .await
            .map_err(|e| format!("Failed to load extension detail: {}", e))?
    };

    let row = row.ok_or_else(|| {
        format!(
            "Extension '{}' is not available on this server.",
            extension_name
        )
    })?;

    let installed_version: Option<String> = row.get(2);
    let requires_superuser: bool = row.get(4);
    let trusted: bool = row.get(5);
    let installed_schema: Option<String> = row.get(7);
    let installed_owner: Option<String> = row.get(8);

    let available_versions_rows = client
        .query(
            "SELECT version
             FROM pg_available_extension_versions
             WHERE name = $1
             ORDER BY version DESC",
            &[&extension_name],
        )
        .await
        .map_err(|e| format!("Failed to list extension versions: {}", e))?;
    let available_versions: Vec<String> = available_versions_rows
        .into_iter()
        .map(|r| r.get::<_, String>(0))
        .collect();

    let install_block_reason =
        extension_block_reason(&profile, &installed_version, requires_superuser, trusted);
    let uninstall_block_reason =
        extension_manage_block_reason(&profile, &installed_version, &installed_owner, "uninstall");
    let update_block_reason =
        extension_manage_block_reason(&profile, &installed_version, &installed_owner, "update");

    Ok(DatabaseExtensionDetail {
        name: row.get(0),
        default_version: row.get(1),
        installed_version,
        installed_schema,
        installed_owner,
        comment: row.get(3),
        requires_superuser,
        trusted,
        available_versions,
        can_install: install_block_reason.is_none(),
        can_uninstall: uninstall_block_reason.is_none(),
        can_update: update_block_reason.is_none(),
        install_block_reason,
        uninstall_block_reason,
        update_block_reason,
    })
}

pub async fn uninstall_database_extension(
    pool: &Arc<Pool>,
    extension_name: &str,
) -> Result<(), String> {
    let extension_name = validate_extension_name(extension_name)?;
    let detail = get_database_extension_detail(pool, &extension_name).await?;
    if let Some(reason) = detail.uninstall_block_reason {
        return Err(format!("Permission denied: {}", reason));
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let sql = format!("DROP EXTENSION IF EXISTS {}", quote_ident(&extension_name));
    client.execute(&sql, &[]).await.map_err(|e| {
        let raw = e.to_string();
        if raw.contains("cannot drop extension") || raw.contains("depends on extension") {
            format!(
                "Failed to uninstall extension '{}'. Existing objects depend on it: {}",
                extension_name, raw
            )
        } else if raw.contains("permission denied") || raw.contains("must be owner") {
            format!(
                "Permission denied while uninstalling extension '{}': {}",
                extension_name, raw
            )
        } else {
            format!(
                "Failed to uninstall extension '{}': {}",
                extension_name, raw
            )
        }
    })?;
    Ok(())
}

pub async fn update_database_extension(
    pool: &Arc<Pool>,
    extension_name: &str,
    target_version: Option<&str>,
) -> Result<(), String> {
    let extension_name = validate_extension_name(extension_name)?;
    let detail = get_database_extension_detail(pool, &extension_name).await?;
    if let Some(reason) = detail.update_block_reason {
        return Err(format!("Permission denied: {}", reason));
    }

    let requested_version = target_version.map(validate_extension_version).transpose()?;

    if let Some(requested) = &requested_version {
        if !detail.available_versions.iter().any(|v| v == requested) {
            return Err(format!(
                "Version '{}' is not available for extension '{}'.",
                requested, extension_name
            ));
        }
        if detail
            .installed_version
            .as_ref()
            .is_some_and(|installed| installed == requested)
        {
            return Ok(());
        }
    }

    let mut sql = format!("ALTER EXTENSION {} UPDATE", quote_ident(&extension_name));
    if let Some(version) = requested_version {
        let escaped = version.replace('\'', "''");
        sql.push_str(&format!(" TO '{}'", escaped));
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    client.execute(&sql, &[]).await.map_err(|e| {
        let raw = e.to_string();
        if raw.contains("permission denied") || raw.contains("must be owner") {
            format!(
                "Permission denied while updating extension '{}': {}",
                extension_name, raw
            )
        } else {
            format!("Failed to update extension '{}': {}", extension_name, raw)
        }
    })?;
    Ok(())
}

pub async fn list_database_roles(pool: &Arc<Pool>) -> Result<Vec<DatabaseRoleInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let rows = client
        .query(
            "WITH me AS (
                SELECT oid, rolsuper FROM pg_roles WHERE rolname = current_user
            )
            SELECT
                r.rolname,
                r.rolcanlogin,
                r.rolsuper,
                r.rolcreatedb,
                r.rolcreaterole,
                (r.rolname LIKE 'pg\\_%') AS is_system_role,
                CASE
                    WHEN me.rolsuper THEN true
                    WHEN r.rolname = current_user THEN false
                    ELSE EXISTS (
                        SELECT 1
                        FROM pg_auth_members am
                        WHERE am.roleid = r.oid
                          AND am.member = me.oid
                          AND am.admin_option
                    )
                END AS is_assignable
            FROM pg_roles r
            CROSS JOIN me
            ORDER BY r.rolname",
            &[],
        )
        .await
        .map_err(|e| format!("Failed to list roles: {}", e))?;

    Ok(rows
        .into_iter()
        .map(|row| DatabaseRoleInfo {
            name: row.get(0),
            can_login: row.get(1),
            is_superuser: row.get(2),
            can_create_db: row.get(3),
            can_create_role: row.get(4),
            is_system_role: row.get(5),
            is_assignable: row.get(6),
        })
        .collect())
}

pub async fn list_database_users(pool: &Arc<Pool>) -> Result<Vec<DatabaseUserInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let rows = client
        .query(
            "SELECT
                r.rolname,
                r.rolcanlogin,
                r.rolsuper,
                r.rolcreatedb,
                r.rolcreaterole,
                r.rolreplication,
                r.rolbypassrls,
                (r.rolname LIKE 'pg\\_%') AS is_system_role,
                r.rolvaliduntil::text,
                COALESCE(ARRAY(
                    SELECT parent.rolname
                    FROM pg_auth_members am
                    JOIN pg_roles parent ON parent.oid = am.roleid
                    WHERE am.member = r.oid
                    ORDER BY parent.rolname
                ), ARRAY[]::text[]) AS member_of
            FROM pg_roles r
            ORDER BY r.rolname",
            &[],
        )
        .await
        .map_err(|e| format!("Failed to list users: {}", e))?;

    Ok(rows
        .into_iter()
        .map(|row| DatabaseUserInfo {
            username: row.get(0),
            can_login: row.get(1),
            is_superuser: row.get(2),
            can_create_db: row.get(3),
            can_create_role: row.get(4),
            can_replicate: row.get(5),
            can_bypass_rls: row.get(6),
            is_system_role: row.get(7),
            valid_until: row.get(8),
            member_of: row.get(9),
        })
        .collect())
}

fn validate_role_identifier(name: &str, kind: &str) -> Result<String, String> {
    let value = name.trim();
    if value.is_empty() || value.len() > 63 {
        return Err(format!("{} must be between 1 and 63 characters", kind));
    }
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return Err(format!("{} must start with a letter or underscore", kind)),
    }
    if !chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return Err(format!(
            "{} must contain only letters, numbers, and underscores",
            kind
        ));
    }
    Ok(value.to_string())
}

fn normalize_memberships(memberships: &[String]) -> Result<Vec<String>, String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut normalized: Vec<String> = Vec::new();
    for item in memberships {
        let role_name = validate_role_identifier(item, "Role membership")?;
        if seen.insert(role_name.clone()) {
            normalized.push(role_name);
        }
    }
    Ok(normalized)
}

fn validate_custom_role_name(name: &str, kind: &str) -> Result<String, String> {
    let role_name = validate_role_identifier(name, kind)?;
    if role_name.starts_with("pg_") {
        return Err(format!(
            "{} cannot start with 'pg_' because that prefix is reserved.",
            kind
        ));
    }
    Ok(role_name)
}

#[derive(Debug, Clone)]
struct RoleActionTarget {
    name: String,
    is_superuser: bool,
    is_system_role: bool,
    is_assignable: bool,
}

fn role_manage_block_reason(
    profile: &DatabaseAccessProfile,
    is_system_role: bool,
    is_assignable: bool,
) -> Option<String> {
    if is_system_role {
        return Some("System roles cannot be managed from this page.".to_string());
    }
    if !profile.is_admin {
        return Some("Current role is not allowed to manage role memberships.".to_string());
    }
    if !profile.is_superuser && !is_assignable {
        return Some(
            "Current role needs ADMIN OPTION on this role to grant or revoke memberships."
                .to_string(),
        );
    }
    None
}

async fn inspect_role_target(
    pool: &Arc<Pool>,
    role_name: &str,
    label: &str,
) -> Result<RoleActionTarget, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let row = client
        .query_opt(
            "WITH me AS (
                SELECT oid, rolsuper
                FROM pg_roles
                WHERE rolname = current_user
            )
            SELECT
                r.rolname,
                r.rolsuper,
                (r.rolname LIKE 'pg\\_%') AS is_system_role,
                CASE
                    WHEN me.rolsuper THEN true
                    WHEN r.rolname = current_user THEN false
                    ELSE EXISTS (
                        SELECT 1
                        FROM pg_auth_members am
                        WHERE am.roleid = r.oid
                          AND am.member = me.oid
                          AND am.admin_option
                    )
                END AS is_assignable
            FROM pg_roles r
            CROSS JOIN me
            WHERE r.rolname = $1",
            &[&role_name],
        )
        .await
        .map_err(|e| format!("Failed to inspect {} '{}': {}", label, role_name, e))?
        .ok_or_else(|| format!("{} '{}' does not exist.", label, role_name))?;

    Ok(RoleActionTarget {
        name: row.get(0),
        is_superuser: row.get(1),
        is_system_role: row.get(2),
        is_assignable: row.get(3),
    })
}

async fn validate_role_membership_change(
    pool: &Arc<Pool>,
    role_name: &str,
    member_name: &str,
) -> Result<(RoleActionTarget, RoleActionTarget), String> {
    let profile = get_database_access_profile(pool).await?;
    if !profile.is_admin {
        return Err("Current role is not allowed to manage role memberships.".to_string());
    }

    let role = inspect_role_target(pool, role_name, "Role").await?;
    let member = inspect_role_target(pool, member_name, "Member").await?;

    if role.is_system_role {
        return Err("System roles cannot be granted or revoked from this view.".to_string());
    }
    if member.is_system_role {
        return Err("System roles cannot be used as membership members in this view.".to_string());
    }
    if role.name == member.name {
        return Err("A role cannot be granted to itself.".to_string());
    }
    if !profile.is_superuser && !role.is_assignable {
        return Err(format!(
            "Current role is not allowed to grant or revoke membership for '{}'.",
            role.name
        ));
    }
    if member.is_superuser && !profile.is_superuser {
        return Err("Only superusers can manage memberships for superuser roles.".to_string());
    }

    Ok((role, member))
}

pub async fn create_database_user(
    pool: &Arc<Pool>,
    request: &CreateDatabaseUserRequest,
) -> Result<(), String> {
    let profile = get_database_access_profile(pool).await?;
    if !profile.is_admin {
        return Err("Current role is not allowed to create database users.".to_string());
    }

    let username = validate_role_identifier(&request.username, "Username")?;
    if request.password.len() < 8 {
        return Err("Password must be at least 8 characters long.".to_string());
    }

    if !profile.is_superuser && (request.is_superuser || request.replication || request.bypass_rls)
    {
        return Err(
            "Only superusers can set SUPERUSER, REPLICATION, or BYPASSRLS role options."
                .to_string(),
        );
    }

    let memberships = normalize_memberships(&request.role_memberships)?;
    let roles = list_database_roles(pool).await?;
    let all_roles: HashSet<String> = roles.iter().map(|r| r.name.clone()).collect();
    let assignable_roles: HashSet<String> = roles
        .iter()
        .filter(|role| role.is_assignable)
        .map(|role| role.name.clone())
        .collect();

    for role in &memberships {
        if !all_roles.contains(role) {
            return Err(format!("Role '{}' does not exist.", role));
        }
        if !profile.is_superuser && !assignable_roles.contains(role) {
            return Err(format!(
                "Current role is not allowed to grant membership for '{}'.",
                role
            ));
        }
    }

    let mut client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    let mut options: Vec<&str> = vec!["LOGIN"];
    options.push(if request.inherit {
        "INHERIT"
    } else {
        "NOINHERIT"
    });
    options.push(if request.can_create_db {
        "CREATEDB"
    } else {
        "NOCREATEDB"
    });
    options.push(if request.can_create_role {
        "CREATEROLE"
    } else {
        "NOCREATEROLE"
    });
    options.push(if request.is_superuser {
        "SUPERUSER"
    } else {
        "NOSUPERUSER"
    });
    options.push(if request.replication {
        "REPLICATION"
    } else {
        "NOREPLICATION"
    });
    options.push(if request.bypass_rls {
        "BYPASSRLS"
    } else {
        "NOBYPASSRLS"
    });

    let mut create_sql = format!(
        "CREATE ROLE {} WITH {} PASSWORD $1",
        quote_ident(&username),
        options.join(" ")
    );
    if request
        .valid_until
        .as_ref()
        .is_some_and(|v| !v.trim().is_empty())
    {
        create_sql.push_str(" VALID UNTIL $2");
    }

    match request
        .valid_until
        .as_ref()
        .filter(|v| !v.trim().is_empty())
    {
        Some(valid_until) => {
            tx.execute(&create_sql, &[&request.password, valid_until])
                .await
                .map_err(|e| format!("Failed to create role '{}': {}", username, e))?;
        }
        None => {
            tx.execute(&create_sql, &[&request.password])
                .await
                .map_err(|e| format!("Failed to create role '{}': {}", username, e))?;
        }
    }

    for role in memberships {
        let grant_sql = format!("GRANT {} TO {}", quote_ident(&role), quote_ident(&username));
        tx.execute(&grant_sql, &[])
            .await
            .map_err(|e| format!("Failed to grant '{}' to '{}': {}", role, username, e))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("Failed to finalize user creation: {}", e))?;

    Ok(())
}

pub async fn create_database_role(
    pool: &Arc<Pool>,
    request: &CreateDatabaseRoleRequest,
) -> Result<(), String> {
    let profile = get_database_access_profile(pool).await?;
    if !profile.is_admin {
        return Err("Current role is not allowed to create custom RBAC roles.".to_string());
    }

    let role_name = validate_custom_role_name(&request.role_name, "Role name")?;
    let memberships = normalize_memberships(&request.memberships)?;

    if memberships.iter().any(|item| item == &role_name) {
        return Err("A role cannot be a member of itself.".to_string());
    }

    let roles = list_database_roles(pool).await?;
    let all_roles: HashSet<String> = roles.iter().map(|r| r.name.clone()).collect();
    let assignable_roles: HashSet<String> = roles
        .iter()
        .filter(|role| role.is_assignable)
        .map(|role| role.name.clone())
        .collect();
    let system_roles: HashSet<String> = roles
        .iter()
        .filter(|role| role.is_system_role)
        .map(|role| role.name.clone())
        .collect();

    if all_roles.contains(&role_name) {
        return Err(format!("Role '{}' already exists.", role_name));
    }

    for parent_role in &memberships {
        if !all_roles.contains(parent_role) {
            return Err(format!("Role '{}' does not exist.", parent_role));
        }
        if system_roles.contains(parent_role) {
            return Err(format!(
                "System role '{}' cannot be used as a custom RBAC parent role.",
                parent_role
            ));
        }
        if !profile.is_superuser && !assignable_roles.contains(parent_role) {
            return Err(format!(
                "Current role is not allowed to grant membership for '{}'.",
                parent_role
            ));
        }
    }

    let mut client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    let mut options: Vec<&str> = vec!["NOLOGIN"];
    options.push(if request.inherit {
        "INHERIT"
    } else {
        "NOINHERIT"
    });
    options.extend([
        "NOCREATEDB",
        "NOCREATEROLE",
        "NOSUPERUSER",
        "NOREPLICATION",
        "NOBYPASSRLS",
    ]);

    let create_sql = format!(
        "CREATE ROLE {} WITH {}",
        quote_ident(&role_name),
        options.join(" ")
    );
    tx.execute(&create_sql, &[])
        .await
        .map_err(|e| format!("Failed to create role '{}': {}", role_name, e))?;

    for parent_role in memberships {
        let grant_sql = format!(
            "GRANT {} TO {}",
            quote_ident(&parent_role),
            quote_ident(&role_name)
        );
        tx.execute(&grant_sql, &[]).await.map_err(|e| {
            format!(
                "Failed to grant '{}' to '{}': {}",
                parent_role, role_name, e
            )
        })?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("Failed to finalize role creation: {}", e))?;
    Ok(())
}

pub async fn get_database_role_detail(
    pool: &Arc<Pool>,
    role_name: &str,
) -> Result<DatabaseRoleDetail, String> {
    let role_name = validate_role_identifier(role_name, "Role name")?;
    let profile = get_database_access_profile(pool).await?;
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let row = client
        .query_opt(
            "WITH me AS (
                SELECT oid, rolsuper
                FROM pg_roles
                WHERE rolname = current_user
            )
            SELECT
                r.rolname,
                r.rolcanlogin,
                r.rolsuper,
                r.rolcreatedb,
                r.rolcreaterole,
                r.rolreplication,
                r.rolbypassrls,
                r.rolinherit,
                r.rolvaliduntil::text,
                sd.description,
                (r.rolname LIKE 'pg\\_%') AS is_system_role,
                CASE
                    WHEN me.rolsuper THEN true
                    WHEN r.rolname = current_user THEN false
                    ELSE EXISTS (
                        SELECT 1
                        FROM pg_auth_members am
                        WHERE am.roleid = r.oid
                          AND am.member = me.oid
                          AND am.admin_option
                    )
                END AS is_assignable
            FROM pg_roles r
            LEFT JOIN pg_shdescription sd
              ON sd.objoid = r.oid
             AND sd.classoid = 'pg_authid'::regclass::oid
            CROSS JOIN me
            WHERE r.rolname = $1",
            &[&role_name],
        )
        .await
        .map_err(|e| format!("Failed to load role detail '{}': {}", role_name, e))?
        .ok_or_else(|| format!("Role '{}' does not exist.", role_name))?;

    let member_of_rows = client
        .query(
            "SELECT parent.rolname
             FROM pg_auth_members am
             JOIN pg_roles member_role
               ON member_role.oid = am.member
             JOIN pg_roles parent
               ON parent.oid = am.roleid
             WHERE member_role.rolname = $1
             ORDER BY parent.rolname",
            &[&role_name],
        )
        .await
        .map_err(|e| {
            format!(
                "Failed to load parent memberships for '{}': {}",
                role_name, e
            )
        })?;
    let member_of: Vec<String> = member_of_rows
        .into_iter()
        .map(|item| item.get::<_, String>(0))
        .collect();

    let members_rows = client
        .query(
            "SELECT
                member_role.rolname,
                member_role.rolcanlogin,
                member_role.rolsuper,
                (member_role.rolname LIKE 'pg\\_%') AS is_system_role,
                am.admin_option
             FROM pg_auth_members am
             JOIN pg_roles target
               ON target.oid = am.roleid
             JOIN pg_roles member_role
               ON member_role.oid = am.member
             WHERE target.rolname = $1
             ORDER BY member_role.rolname",
            &[&role_name],
        )
        .await
        .map_err(|e| format!("Failed to load role members for '{}': {}", role_name, e))?;
    let members: Vec<DatabaseRoleMemberInfo> = members_rows
        .into_iter()
        .map(|item| DatabaseRoleMemberInfo {
            name: item.get(0),
            can_login: item.get(1),
            is_superuser: item.get(2),
            is_system_role: item.get(3),
            admin_option: item.get(4),
        })
        .collect();

    let is_system_role: bool = row.get(10);
    let is_assignable: bool = row.get(11);
    let manage_block_reason = role_manage_block_reason(&profile, is_system_role, is_assignable);

    Ok(DatabaseRoleDetail {
        name: row.get(0),
        can_login: row.get(1),
        is_superuser: row.get(2),
        can_create_db: row.get(3),
        can_create_role: row.get(4),
        can_replicate: row.get(5),
        can_bypass_rls: row.get(6),
        inherit: row.get(7),
        valid_until: row.get(8),
        comment: row.get(9),
        is_system_role,
        is_assignable,
        can_grant_membership: manage_block_reason.is_none(),
        can_revoke_membership: manage_block_reason.is_none(),
        manage_block_reason,
        member_of,
        members,
    })
}

pub async fn grant_database_role_membership(
    pool: &Arc<Pool>,
    role_name: &str,
    member_name: &str,
    with_admin_option: bool,
) -> Result<(), String> {
    let role_name = validate_role_identifier(role_name, "Role")?;
    let member_name = validate_role_identifier(member_name, "Member")?;
    let (role, member) = validate_role_membership_change(pool, &role_name, &member_name).await?;

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let mut sql = format!(
        "GRANT {} TO {}",
        quote_ident(&role.name),
        quote_ident(&member.name)
    );
    if with_admin_option {
        sql.push_str(" WITH ADMIN OPTION");
    }
    client.execute(&sql, &[]).await.map_err(|e| {
        format!(
            "Failed to grant role '{}' to '{}': {}",
            role.name, member.name, e
        )
    })?;
    Ok(())
}

pub async fn revoke_database_role_membership(
    pool: &Arc<Pool>,
    role_name: &str,
    member_name: &str,
) -> Result<(), String> {
    let role_name = validate_role_identifier(role_name, "Role")?;
    let member_name = validate_role_identifier(member_name, "Member")?;
    let (role, member) = validate_role_membership_change(pool, &role_name, &member_name).await?;

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let sql = format!(
        "REVOKE {} FROM {}",
        quote_ident(&role.name),
        quote_ident(&member.name)
    );
    client.execute(&sql, &[]).await.map_err(|e| {
        format!(
            "Failed to revoke role '{}' from '{}': {}",
            role.name, member.name, e
        )
    })?;
    Ok(())
}

async fn validate_target_user_action(
    pool: &Arc<Pool>,
    username: &str,
    allow_self: bool,
) -> Result<(DatabaseAccessProfile, bool, bool), String> {
    let profile = get_database_access_profile(pool).await?;
    if !profile.is_admin {
        return Err("Current role is not allowed to manage database users.".to_string());
    }

    let username = validate_role_identifier(username, "Username")?;
    if !allow_self && profile.current_user == username {
        return Err("This action cannot be applied to the current connected user.".to_string());
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let role = client
        .query_opt(
            "SELECT rolsuper, (rolname LIKE 'pg\\_%') AS is_system_role
             FROM pg_roles
             WHERE rolname = $1",
            &[&username],
        )
        .await
        .map_err(|e| format!("Failed to inspect user '{}': {}", username, e))?
        .ok_or_else(|| format!("User '{}' does not exist.", username))?;

    let target_superuser: bool = role.get(0);
    let target_system_role: bool = role.get(1);

    if target_system_role {
        return Err("System roles cannot be modified in this view.".to_string());
    }
    if target_superuser && !profile.is_superuser {
        return Err("Only superusers can manage other superuser accounts.".to_string());
    }

    Ok((profile, target_superuser, target_system_role))
}

pub async fn set_database_user_login(
    pool: &Arc<Pool>,
    username: &str,
    can_login: bool,
) -> Result<(), String> {
    let username = validate_role_identifier(username, "Username")?;
    let _ = validate_target_user_action(pool, &username, false).await?;

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let sql = if can_login {
        format!("ALTER ROLE {} LOGIN", quote_ident(&username))
    } else {
        format!("ALTER ROLE {} NOLOGIN", quote_ident(&username))
    };
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Failed to update login state for '{}': {}", username, e))?;
    Ok(())
}

pub async fn set_database_user_password(
    pool: &Arc<Pool>,
    username: &str,
    password: &str,
) -> Result<(), String> {
    if password.len() < 8 {
        return Err("Password must be at least 8 characters long.".to_string());
    }

    let username = validate_role_identifier(username, "Username")?;
    let _ = validate_target_user_action(pool, &username, true).await?;

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let sql = format!("ALTER ROLE {} PASSWORD $1", quote_ident(&username));
    client
        .execute(&sql, &[&password])
        .await
        .map_err(|e| format!("Failed to update password for '{}': {}", username, e))?;
    Ok(())
}

pub async fn delete_database_user(
    pool: &Arc<Pool>,
    username: &str,
    reassign_owned_to: Option<&str>,
) -> Result<(), String> {
    let username = validate_role_identifier(username, "Username")?;
    let _ = validate_target_user_action(pool, &username, false).await?;

    let reassigned_target = reassign_owned_to
        .map(|name| validate_role_identifier(name, "Reassign target role"))
        .transpose()?;

    if reassigned_target
        .as_ref()
        .is_some_and(|target| target == &username)
    {
        return Err("Reassign target cannot be the same as the user being deleted.".to_string());
    }

    if let Some(reassign_to) = &reassigned_target {
        let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
        let exists = client
            .query_opt("SELECT 1 FROM pg_roles WHERE rolname = $1", &[reassign_to])
            .await
            .map_err(|e| {
                format!(
                    "Failed to validate reassign target '{}': {}",
                    reassign_to, e
                )
            })?
            .is_some();
        if !exists {
            return Err(format!(
                "Reassign target role '{}' does not exist.",
                reassign_to
            ));
        }
    }

    let mut client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    if let Some(reassign_to) = &reassigned_target {
        let reassign_sql = format!(
            "REASSIGN OWNED BY {} TO {}",
            quote_ident(&username),
            quote_ident(reassign_to)
        );
        tx.execute(&reassign_sql, &[]).await.map_err(|e| {
            format!(
                "Failed to reassign objects from '{}' to '{}': {}",
                username, reassign_to, e
            )
        })?;
        let drop_owned_sql = format!("DROP OWNED BY {}", quote_ident(&username));
        tx.execute(&drop_owned_sql, &[])
            .await
            .map_err(|e| format!("Failed to drop owned privileges for '{}': {}", username, e))?;
    }

    let drop_role_sql = format!("DROP ROLE {}", quote_ident(&username));
    tx.execute(&drop_role_sql, &[]).await.map_err(|e| {
        let raw = e.to_string();
        if raw.contains("dependent objects") {
            format!(
                "Cannot delete '{}': dependent objects exist. Reassign ownership first and retry.",
                username
            )
        } else {
            format!("Failed to delete user '{}': {}", username, raw)
        }
    })?;

    tx.commit()
        .await
        .map_err(|e| format!("Failed to finalize user deletion: {}", e))?;
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// Table row update / delete (for data grid edit)
// ──────────────────────────────────────────────────────────────────────────────

/// Map pg_catalog.format_type output to a safe PostgreSQL cast type for bind params.
/// Handles types with precision/length e.g. "numeric(10,2)", "character varying(255)".
/// Returns the type name to use after :: in SET/WHERE (e.g. "text", "uuid", "\"public\".\"driver_status\"").
fn pg_cast_type_expr(data_type: &str) -> String {
    let trimmed = data_type.trim();
    let base = trimmed
        .split('(')
        .next()
        .map(|s| s.trim())
        .unwrap_or(trimmed);
    if base.is_empty() {
        return "text".to_string();
    }
    let lower = base.to_lowercase();
    let builtin: Option<&'static str> = match lower.as_str() {
        "smallint" | "int2" => Some("smallint"),
        "integer" | "int4" => Some("integer"),
        "bigint" | "int8" => Some("bigint"),
        "real" | "float4" => Some("real"),
        "double precision" | "float8" => Some("double precision"),
        "numeric" | "decimal" => Some("numeric"),
        "boolean" | "bool" => Some("boolean"),
        "text" | "character varying" | "varchar" | "character" | "char" | "bpchar" => Some("text"),
        "uuid" => Some("uuid"),
        "date" => Some("date"),
        "time without time zone" | "time" => Some("time"),
        "timestamp without time zone" | "timestamp" => Some("timestamp"),
        "timestamp with time zone" | "timestamptz" => Some("timestamptz"),
        "json" | "jsonb" => Some("jsonb"),
        _ => None,
    };
    if let Some(t) = builtin {
        return t.to_string();
    }
    // Custom types (e.g. enums): use the type name with proper quoting so UPDATE/INSERT accept the value.
    // format_type can return "driver_status" or "public.driver_status".
    if base.contains('.') {
        let parts: Vec<String> = base
            .split('.')
            .map(|p| format!("\"{}\"", p.trim().replace('"', "\"\"")))
            .collect();
        parts.join(".")
    } else {
        format!("\"{}\"", base.replace('"', "\"\""))
    }
}

/// Update one table row by primary key. Returns number of rows affected (0 or 1).
pub async fn update_table_row(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    pk_columns: &[String],
    pk_values: &[Option<String>],
    updates: &[(String, Option<String>)],
) -> Result<u64, String> {
    if updates.is_empty() {
        return Ok(0);
    }
    if pk_columns.len() != pk_values.len() {
        return Err("pk_columns and pk_values length mismatch".to_string());
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let columns = get_columns(pool, schema, table)
        .await
        .map_err(|e| format!("Columns: {}", e))?;

    let col_type_map: std::collections::HashMap<String, String> = columns
        .iter()
        .map(|c| (c.name.clone(), c.data_type.clone()))
        .collect();

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    let set_parts: Vec<String> = updates
        .iter()
        .enumerate()
        .map(|(i, (col, _))| {
            let safe_col = sanitize_identifier(col);
            let cast = pg_cast_type_expr(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
            // Force params to be TEXT so we can pass strings, then cast to the target type.
            // This avoids "error serializing parameter" for non-text columns (uuid, jsonb, etc).
            format!("\"{}\" = ${}::text::{}", safe_col, i + 1, cast)
        })
        .collect();
    let set_clause = set_parts.join(", ");

    let where_parts: Vec<String> = pk_columns
        .iter()
        .enumerate()
        .map(|(i, col)| {
            let safe_col = sanitize_identifier(col);
            let param_idx = updates.len() + i + 1;
            let cast = pg_cast_type_expr(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
            format!("\"{}\" = ${}::text::{}", safe_col, param_idx, cast)
        })
        .collect();
    let where_clause = where_parts.join(" AND ");

    let query = format!(
        "UPDATE \"{}\".\"{}\" SET {} WHERE {}",
        safe_schema, safe_table, set_clause, where_clause
    );

    let mut params: Vec<Option<String>> = updates.iter().map(|(_, v)| v.clone()).collect();
    params.extend(pk_values.iter().cloned());

    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
        .iter()
        .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    let count = client
        .execute(&query, &param_refs)
        .await
        .map_err(|e| format!("Update error: {}", e))?;

    Ok(count)
}

/// Insert one table row. `values`: (column, value); None means NULL. Use literal "DEFAULT" to omit column (DB default).
/// Returns number of rows affected (1 on success).
pub async fn insert_table_row(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    values: &[(String, Option<String>)],
) -> Result<u64, String> {
    // Omit columns with value "DEFAULT" so the database uses its default (avoids serialization error).
    let values: Vec<(String, Option<String>)> = values
        .iter()
        .filter(|(_, v)| {
            !v.as_deref()
                .map(|s| s.trim().eq_ignore_ascii_case("DEFAULT"))
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    if values.is_empty() {
        return Err("At least one column required for insert".to_string());
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let columns = get_columns(pool, schema, table)
        .await
        .map_err(|e| format!("Columns: {}", e))?;
    let col_type_map: std::collections::HashMap<String, String> = columns
        .iter()
        .map(|c| (c.name.clone(), c.data_type.clone()))
        .collect();

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    let col_names: Vec<&String> = values.iter().map(|(c, _)| c).collect();
    let safe_cols: Vec<String> = col_names
        .iter()
        .map(|c| format!("\"{}\"", sanitize_identifier(c)))
        .collect();
    let cols_clause = safe_cols.join(", ");
    let placeholders: Vec<String> = values
        .iter()
        .enumerate()
        .map(|(i, (col, _))| {
            let cast = pg_cast_type_expr(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
            format!("${}::text::{}", i + 1, cast)
        })
        .collect();
    let values_clause = placeholders.join(", ");
    let query = format!(
        "INSERT INTO \"{}\".\"{}\" ({}) VALUES ({})",
        safe_schema, safe_table, cols_clause, values_clause
    );

    let params: Vec<Option<String>> = values.iter().map(|(_, v)| v.clone()).collect();
    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
        .iter()
        .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    let count = client
        .execute(&query, &param_refs)
        .await
        .map_err(|e| pg_error_message(&e))?;
    Ok(count)
}

/// Insert multiple table rows in a single transaction. All-or-nothing.
pub async fn insert_table_rows_bulk(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    rows: &[Vec<(String, Option<String>)>],
) -> Result<u64, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let mut client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let txn = client
        .transaction()
        .await
        .map_err(|e| format!("Transaction begin: {}", e))?;
    let columns = get_columns(pool, schema, table)
        .await
        .map_err(|e| format!("Columns: {}", e))?;
    let col_type_map: std::collections::HashMap<String, String> = columns
        .iter()
        .map(|c| (c.name.clone(), c.data_type.clone()))
        .collect();
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let mut total = 0u64;
    for row in rows {
        let values: Vec<(String, Option<String>)> = row
            .iter()
            .filter(|(_, v)| {
                !v.as_deref()
                    .map(|s| s.trim().eq_ignore_ascii_case("DEFAULT"))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if values.is_empty() {
            continue;
        }
        let col_names: Vec<&String> = values.iter().map(|(c, _)| c).collect();
        let safe_cols: Vec<String> = col_names
            .iter()
            .map(|c| format!("\"{}\"", sanitize_identifier(c)))
            .collect();
        let cols_clause = safe_cols.join(", ");
        let placeholders: Vec<String> = values
            .iter()
            .enumerate()
            .map(|(i, (col, _))| {
                let cast =
                    pg_cast_type_expr(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
                // Force params to be text then cast to target type to avoid serialization errors.
                format!("${}::text::{}", i + 1, cast)
            })
            .collect();
        let values_clause = placeholders.join(", ");
        let query = format!(
            "INSERT INTO \"{}\".\"{}\" ({}) VALUES ({})",
            safe_schema, safe_table, cols_clause, values_clause
        );
        let params: Vec<Option<String>> = values.iter().map(|(_, v)| v.clone()).collect();
        let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
            .iter()
            .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
            .collect();
        let n = txn
            .execute(&query, &param_refs)
            .await
            .map_err(|e| pg_error_message(&e))?;
        total += n;
    }
    txn.commit().await.map_err(|e| pg_error_message(&e))?;
    Ok(total)
}

/// Delete table rows by primary key. Each row in `rows_pk_values` is one row's PK values (same order as pk_columns).
pub async fn delete_table_rows(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    pk_columns: &[String],
    rows_pk_values: &[Vec<Option<String>>],
) -> Result<u64, String> {
    if rows_pk_values.is_empty() {
        return Ok(0);
    }
    if pk_columns.is_empty() {
        return Err("Primary key columns required for delete".to_string());
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let columns = get_columns(pool, schema, table)
        .await
        .map_err(|e| format!("Columns: {}", e))?;

    let col_type_map: std::collections::HashMap<String, String> = columns
        .iter()
        .map(|c| (c.name.clone(), c.data_type.clone()))
        .collect();

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    // Build WHERE (pk1, pk2) IN (($1,$2),($3,$4),...)
    let placeholders: Vec<String> = rows_pk_values
        .iter()
        .enumerate()
        .map(|(row_i, _row_vals)| {
            let start = row_i * pk_columns.len();
            let parts: Vec<String> = pk_columns
                .iter()
                .enumerate()
                .map(|(col_i, col)| {
                    let param_idx = start + col_i + 1;
                    let cast =
                        pg_cast_type_expr(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
                    // Force params to be text then cast to target type to avoid serialization errors.
                    format!("${}::text::{}", param_idx, cast)
                })
                .collect();
            format!("({})", parts.join(", "))
        })
        .collect();
    let in_clause = placeholders.join(", ");
    let pk_list = pk_columns
        .iter()
        .map(|c| format!("\"{}\"", sanitize_identifier(c)))
        .collect::<Vec<_>>()
        .join(", ");
    let query = format!(
        "DELETE FROM \"{}\".\"{}\" WHERE ({}) IN ({})",
        safe_schema, safe_table, pk_list, in_clause
    );

    // Trim PK values so whitespace from the UI does not prevent matching
    let params: Vec<Option<String>> = rows_pk_values
        .iter()
        .flat_map(|r| r.iter().map(|v| v.as_ref().map(|s| s.trim().to_string())))
        .collect();
    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
        .iter()
        .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    let count = client
        .execute(&query, &param_refs)
        .await
        .map_err(|e| format!("Delete error: {}", e))?;

    Ok(count)
}

// ──────────────────────────────────────────────────────────────────────────────
// Structured table search (parameterized, operator-whitelisted)
// ──────────────────────────────────────────────────────────────────────────────

/// Execute a structured filter search: SELECT * FROM schema.table WHERE col OP $1 LIMIT limit.
/// The operator is validated against a whitelist; the value is passed as a bind parameter.
pub async fn search_table_data(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    column: &str,
    operator: &str,
    value: Option<&str>,
    limit: u32,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let safe_col = sanitize_identifier(column);

    let columns_meta = get_columns(pool, schema, table).await.unwrap_or_default();
    let enum_labels_by_column =
        fetch_enum_labels_by_column(&client, schema, table).await;
    let select_list = if columns_meta.is_empty() {
        "*".to_string()
    } else {
        build_select_list(&columns_meta, &enum_labels_by_column)
    };

    let safe_op: &str = match operator.to_uppercase().trim() {
        "=" => "=",
        "!=" | "<>" => "!=",
        ">" => ">",
        "<" => "<",
        ">=" => ">=",
        "<=" => "<=",
        "LIKE" => "LIKE",
        "NOT LIKE" => "NOT LIKE",
        "ILIKE" => "ILIKE",
        "NOT ILIKE" => "NOT ILIKE",
        "IS NULL" => "IS NULL",
        "IS NOT NULL" => "IS NOT NULL",
        other => return Err(format!("Invalid operator: {}", other)),
    };

    let null_ops = ["IS NULL", "IS NOT NULL"];
    let is_null_op = null_ops.contains(&safe_op);

    let query = if is_null_op {
        format!(
            "SELECT {} FROM \"{}\".\"{}\" WHERE \"{}\" {} LIMIT {}",
            select_list, safe_schema, safe_table, safe_col, safe_op, limit
        )
    } else {
        format!(
            "SELECT {} FROM \"{}\".\"{}\" WHERE \"{}\" {} $1 LIMIT {}",
            select_list, safe_schema, safe_table, safe_col, safe_op, limit
        )
    };

    let rows = if is_null_op {
        client
            .query(&query, &[])
            .await
            .map_err(|e| format!("Query error: {}", e))?
    } else {
        let val = value.unwrap_or("");
        let val_str = val.to_string();
        client
            .query(&query, &[&val_str])
            .await
            .map_err(|e| format!("Query error: {}", e))?
    };

    let columns: Vec<ResultColumn> = if !columns_meta.is_empty() {
        columns_meta
            .iter()
            .map(|c| ResultColumn {
                name: c.name.clone(),
                data_type: c.data_type.clone(),
                enum_labels: enum_labels_by_column.get(&c.name).cloned(),
            })
            .collect()
    } else if !rows.is_empty() {
        rows[0]
            .columns()
            .iter()
            .map(|col| ResultColumn {
                name: col.name().to_string(),
                data_type: pg_type_to_string(col.type_()),
                enum_labels: None,
            })
            .collect()
    } else {
        Vec::new()
    };

    let data: Vec<Vec<CellValue>> = rows.iter().map(|row| row_to_cells(row)).collect();
    let row_count = data.len();
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;

    Ok(QueryResult {
        columns,
        rows: data,
        row_count,
        total_rows: Some(row_count as i64),
        execution_time_ms: elapsed,
        page: None,
        page_size: None,
        query,
        is_error: false,
        error_message: None,
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// Table details (full schema info for table manager)
// ──────────────────────────────────────────────────────────────────────────────

pub async fn get_table_details(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
) -> Result<TableDetails, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    // Columns
    let col_rows = client
        .query(
            "SELECT
                a.attname,
                pg_catalog.format_type(a.atttypid, a.atttypmod),
                NOT a.attnotnull AS is_nullable,
                a.attnum::int AS ordinal_position,
                pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
                EXISTS (
                    SELECT 1
                    FROM pg_index i
                    WHERE i.indrelid = c.oid
                      AND i.indisprimary
                      AND a.attnum = ANY(i.indkey)
                ) AS is_primary_key,
                d.description AS column_comment
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid
             LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
             LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
             WHERE n.nspname = $1
               AND c.relname = $2
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND a.attnum > 0
               AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("Columns query error: {}", e))?;

    let columns: Vec<ColumnInfo> = col_rows
        .iter()
        .map(|row| ColumnInfo {
            name: row.get(0),
            data_type: row.get(1),
            is_nullable: row.get(2),
            ordinal_position: row.get(3),
            column_default: row.get(4),
            is_primary_key: row.get(5),
            comment: row.get(6),
        })
        .collect();

    // Constraints (cast ARRAY_AGG to text[] for reliable deserialization)
    let con_rows = client
        .query(
            "SELECT tc.constraint_name,
                    tc.constraint_type,
                    (ARRAY_AGG(kcu.column_name ORDER BY kcu.ordinal_position))::text[] AS columns,
                    ccu.table_name AS foreign_table,
                    (ARRAY_AGG(DISTINCT ccu.column_name) FILTER (WHERE ccu.column_name IS NOT NULL))::text[] AS foreign_columns,
                    cc.check_clause
             FROM information_schema.table_constraints tc
             LEFT JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name
                 AND kcu.table_schema = tc.table_schema
                 AND kcu.table_name = tc.table_name
             LEFT JOIN information_schema.referential_constraints rc
                 ON rc.constraint_name = tc.constraint_name
                 AND rc.constraint_schema = tc.constraint_schema
             LEFT JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = rc.unique_constraint_name
                 AND ccu.table_schema = rc.unique_constraint_schema
             LEFT JOIN information_schema.check_constraints cc
                 ON cc.constraint_name = tc.constraint_name
                 AND cc.constraint_schema = tc.constraint_schema
             WHERE tc.table_schema = $1 AND tc.table_name = $2
             GROUP BY tc.constraint_name, tc.constraint_type, ccu.table_name, cc.check_clause
             ORDER BY tc.constraint_type, tc.constraint_name",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("Constraints query error: {}", e))?;

    let constraints: Vec<TableConstraint> = con_rows
        .iter()
        .map(|row| {
            let cols: Vec<String> = row
                .try_get::<_, Option<Vec<String>>>(2)
                .ok()
                .flatten()
                .unwrap_or_default();
            let foreign_cols: Vec<String> = row
                .try_get::<_, Option<Vec<String>>>(4)
                .ok()
                .flatten()
                .unwrap_or_default();
            TableConstraint {
                name: row.get(0),
                constraint_type: row.get(1),
                columns: cols,
                foreign_table: row.get(3),
                foreign_columns: if foreign_cols.is_empty() {
                    None
                } else {
                    Some(foreign_cols)
                },
                check_clause: row.get(5),
            }
        })
        .collect();

    // Indexes (cast array to text[] for reliable deserialization)
    let idx_rows = client
        .query(
            "SELECT i.relname AS index_name,
                    ix.indisunique,
                    ix.indisprimary,
                    am.amname AS index_type,
                    (ARRAY(
                        SELECT a.attname
                        FROM pg_attribute a
                        WHERE a.attrelid = t.oid
                          AND a.attnum = ANY(ix.indkey)
                          AND a.attnum > 0
                        ORDER BY array_position(ix.indkey, a.attnum)
                    ))::text[] AS columns,
                    pg_get_indexdef(ix.indexrelid) AS definition,
                    idesc.description AS index_comment
             FROM pg_index ix
             JOIN pg_class t  ON t.oid = ix.indrelid
             JOIN pg_class i  ON i.oid = ix.indexrelid
             JOIN pg_am    am ON am.oid = i.relam
             JOIN pg_namespace n ON n.oid = t.relnamespace
             LEFT JOIN pg_description idesc ON idesc.objoid = i.oid AND idesc.objsubid = 0
             WHERE n.nspname = $1 AND t.relname = $2
             ORDER BY i.relname",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("Indexes query error: {}", e))?;

    let indexes: Vec<TableIndex> = idx_rows
        .iter()
        .map(|row| TableIndex {
            name: row.get(0),
            is_unique: row.get(1),
            is_primary: row.get(2),
            index_type: row.get(3),
            columns: row.try_get::<_, Vec<String>>(4).unwrap_or_default(),
            definition: row.get(5),
            comment: row.get(6),
        })
        .collect();

    // Triggers
    let trig_rows = client
        .query(
            "SELECT t.tgname,
                    CASE t.tgtype & 66
                        WHEN 2  THEN 'BEFORE'
                        WHEN 64 THEN 'INSTEAD OF'
                        ELSE         'AFTER'
                    END AS timing,
                    (ARRAY_REMOVE(ARRAY[
                        CASE WHEN t.tgtype & 4  = 4  THEN 'INSERT'  END,
                        CASE WHEN t.tgtype & 8  = 8  THEN 'DELETE'  END,
                        CASE WHEN t.tgtype & 16 = 16 THEN 'UPDATE'  END,
                        CASE WHEN t.tgtype & 32 = 32 THEN 'TRUNCATE' END
                    ], NULL))::text[] AS events,
                    p.proname AS function_name,
                    t.tgenabled != 'D' AS enabled
             FROM pg_trigger t
             JOIN pg_class c  ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE n.nspname = $1 AND c.relname = $2
               AND NOT t.tgisinternal
             ORDER BY t.tgname",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("Triggers query error: {}", e))?;

    let triggers: Vec<TableTriggerInfo> = trig_rows
        .iter()
        .map(|row| TableTriggerInfo {
            name: row.get(0),
            timing: row.get(1),
            events: row.try_get::<_, Vec<String>>(2).unwrap_or_default(),
            function_name: row.get(3),
            enabled: row.get::<_, bool>(4),
        })
        .collect();

    // Table stats: row count + sizes
    let stats_row = client
        .query_opt(
            "SELECT
                COALESCE(c.reltuples::bigint, 0),
                pg_size_pretty(pg_total_relation_size(c.oid)),
                pg_size_pretty(pg_relation_size(c.oid)),
                pg_size_pretty(pg_indexes_size(c.oid)),
                d.description,
                c.relkind::text
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("Stats query error: {}", e))?;

    let (row_count, total_size, table_size, indexes_size, comment, rel_kind) =
        if let Some(row) = stats_row {
            (
                row.get::<_, i64>(0),
                row.get::<_, String>(1),
                row.get::<_, String>(2),
                row.get::<_, String>(3),
                row.get::<_, Option<String>>(4),
                row.get::<_, String>(5),
            )
        } else {
            (
                0i64,
                "0 bytes".to_string(),
                "0 bytes".to_string(),
                "0 bytes".to_string(),
                None,
                "r".to_string(),
            )
        };

    let table_type = match rel_kind.as_str() {
        "v" | "m" => "VIEW",
        _ => "BASE TABLE",
    }
    .to_string();

    Ok(TableDetails {
        schema: schema.to_string(),
        name: table.to_string(),
        table_type,
        columns,
        constraints,
        indexes,
        triggers,
        row_count,
        total_size,
        table_size,
        indexes_size,
        comment,
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// SQL Export: DDL generation from TableDetails
// ──────────────────────────────────────────────────────────────────────────────

/// Build CREATE TABLE and CREATE INDEX statements from TableDetails.
/// Uses sanitize_identifier for all identifiers. No user input in DDL.
pub fn build_ddl_from_table_details(details: &TableDetails) -> String {
    let safe_schema = sanitize_identifier(&details.schema);
    let safe_table = sanitize_identifier(&details.name);

    let mut col_defs: Vec<String> = Vec::new();
    let pk_cols: Vec<String> = details
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| format!("\"{}\"", sanitize_identifier(&c.name)))
        .collect();

    for col in &details.columns {
        let safe_name = sanitize_identifier(&col.name);
        let safe_type: String = col
            .data_type
            .chars()
            .filter(|c| c.is_alphanumeric() || " ()[]_,.'".contains(*c))
            .collect();
        let null_clause = if col.is_nullable { "" } else { " NOT NULL" };
        let default_clause = match &col.column_default {
            Some(d) if !d.trim().is_empty() => format!(" DEFAULT {}", d.trim()),
            _ => String::new(),
        };
        let pk_inline = if pk_cols.len() == 1 && col.is_primary_key {
            " PRIMARY KEY"
        } else {
            ""
        };
        col_defs.push(format!(
            "  \"{}\" {}{}{}{}",
            safe_name, safe_type, null_clause, default_clause, pk_inline
        ));
    }

    let mut table_constraints: Vec<String> = Vec::new();
    for tc in &details.constraints {
        let cols: String = tc
            .columns
            .iter()
            .map(|c| format!("\"{}\"", sanitize_identifier(c)))
            .collect::<Vec<_>>()
            .join(", ");
        let safe_name = sanitize_identifier(&tc.name);
        match tc.constraint_type.as_str() {
            "PRIMARY KEY" if pk_cols.len() > 1 => {
                table_constraints.push(format!(
                    "  CONSTRAINT \"{}\" PRIMARY KEY ({})",
                    safe_name, cols
                ));
            }
            "UNIQUE" => {
                table_constraints.push(format!("  CONSTRAINT \"{}\" UNIQUE ({})", safe_name, cols));
            }
            "CHECK" => {
                if let Some(ref chk) = tc.check_clause {
                    if !chk.trim().is_empty() {
                        table_constraints.push(format!(
                            "  CONSTRAINT \"{}\" CHECK ({})",
                            safe_name,
                            chk.trim()
                        ));
                    }
                }
            }
            "FOREIGN KEY" => {
                if let (Some(ref ft), Some(ref fc)) = (&tc.foreign_table, &tc.foreign_columns) {
                    let fc_str = fc
                        .iter()
                        .map(|c| format!("\"{}\"", sanitize_identifier(c)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let safe_ft = sanitize_identifier(ft);
                    table_constraints.push(format!(
                        "  CONSTRAINT \"{}\" FOREIGN KEY ({}) REFERENCES \"{}\".\"{}\" ({})",
                        safe_name, cols, safe_schema, safe_ft, fc_str
                    ));
                }
            }
            _ => {}
        }
    }

    let mut all_defs = col_defs;
    all_defs.extend(table_constraints);
    let create_table = format!(
        "CREATE TABLE \"{}\".\"{}\" (\n{}\n);\n",
        safe_schema,
        safe_table,
        all_defs.join(",\n")
    );

    let mut out = create_table;
    for idx in &details.indexes {
        if idx.is_primary {
            continue;
        }
        if !idx.definition.is_empty() {
            out.push_str(&idx.definition);
            if !idx.definition.ends_with(';') {
                out.push(';');
            }
            out.push('\n');
        } else {
            let idx_cols: String = idx
                .columns
                .iter()
                .map(|c| format!("\"{}\"", sanitize_identifier(c)))
                .collect::<Vec<_>>()
                .join(", ");
            let unique = if idx.is_unique { "UNIQUE " } else { "" };
            let safe_idx_name = sanitize_identifier(&idx.name);
            out.push_str(&format!(
                "CREATE {}INDEX \"{}\" ON \"{}\".\"{}\" ({});\n",
                unique, safe_idx_name, safe_schema, safe_table, idx_cols
            ));
        }
    }
    out
}

const EXPORT_CHUNK_SIZE: u32 = 5000;

enum ExportWriter {
    Plain(std::fs::File),
    Gzip(flate2::write::GzEncoder<std::fs::File>),
}

impl Write for ExportWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            ExportWriter::Plain(f) => f.write(buf),
            ExportWriter::Gzip(g) => g.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            ExportWriter::Plain(f) => f.flush(),
            ExportWriter::Gzip(g) => g.flush(),
        }
    }
}

/// Run full SQL export: validate tables, write DDL and/or data to file, emit progress.
pub async fn run_sql_export<F>(
    pool: &Arc<Pool>,
    request: &ExportRequest,
    mut progress: F,
) -> Result<ExportResult, String>
where
    F: FnMut(ExportProgressPayload),
{
    let schemas = list_schemas(pool).await?;
    let allowed_schemas: HashSet<String> = schemas.iter().map(|s| s.name.clone()).collect();
    let mut allowed_tables: HashSet<(String, String)> = HashSet::new();
    for schema in &request.schemas {
        if !allowed_schemas.contains(schema) {
            continue;
        }
        let tables = list_tables(pool, schema).await?;
        for t in &tables {
            allowed_tables.insert((schema.clone(), t.name.clone()));
        }
    }
    let tables: Vec<&ExportTableRef> = request
        .tables
        .iter()
        .filter(|t| allowed_tables.contains(&(t.schema.clone(), t.table.clone())))
        .collect();
    if tables.is_empty() {
        return Err(
            "No tables to export (none selected or none exist in selected schemas)".to_string(),
        );
    }

    let ext = if request.compress { "sql.gz" } else { "sql" };
    let output_path = request.output_path.clone().unwrap_or_else(|| {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        format!(
            "{}/helixdb_export_{}.{}",
            std::env::temp_dir().display(),
            t.as_secs(),
            ext
        )
    });
    if let Some(ref user_path) = request.output_path {
        if request.compress && !user_path.ends_with(".sql.gz") {
            return Err(
                "Output path must end with .sql.gz when compression is enabled".to_string(),
            );
        }
        if !request.compress && !user_path.ends_with(".sql") {
            return Err("Output path must end with .sql when compression is disabled".to_string());
        }
    }

    let file = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create export file: {}", e))?;
    let mut writer: ExportWriter = if request.compress {
        ExportWriter::Gzip(flate2::write::GzEncoder::new(
            file,
            flate2::Compression::default(),
        ))
    } else {
        ExportWriter::Plain(file)
    };
    let mut bytes_written: u64 = 0;

    let total = tables.len() as u32;
    let include_structure = matches!(
        request.content_type,
        ExportContentType::StructureOnly | ExportContentType::StructureAndData
    );
    let include_data = matches!(
        request.content_type,
        ExportContentType::DataOnly | ExportContentType::StructureAndData
    );

    for (i, table_ref) in tables.iter().enumerate() {
        let schema = &table_ref.schema;
        let table = &table_ref.table;
        let table_key = format!("{}.{}", schema, table);
        progress(ExportProgressPayload {
            phase: "table".to_string(),
            message: format!("Exporting {}.{}", schema, table),
            current: (i + 1) as u32,
            total,
            table: Some(table_key.clone()),
            rows_exported: None,
        });

        let details = get_table_details(pool, schema, table).await?;

        if include_structure {
            let ddl = build_ddl_from_table_details(&details);
            writer
                .write_all(ddl.as_bytes())
                .map_err(|e| format!("Write error: {}", e))?;
            writer
                .write_all(b"\n")
                .map_err(|e| format!("Write error: {}", e))?;
            bytes_written += ddl.len() as u64 + 1;
        }

        if include_data && details.table_type == "BASE TABLE" {
            let columns: Vec<&str> = match &request.columns {
                Some(cols) => {
                    if let Some(names) = cols.get(&table_key) {
                        let allowed: HashSet<&str> =
                            details.columns.iter().map(|c| c.name.as_str()).collect();
                        names
                            .iter()
                            .filter(|n| allowed.contains(n.as_str()))
                            .map(String::as_str)
                            .collect()
                    } else {
                        details.columns.iter().map(|c| c.name.as_str()).collect()
                    }
                }
                None => details.columns.iter().map(|c| c.name.as_str()).collect(),
            };
            if columns.is_empty() {
                continue;
            }

            let safe_schema = sanitize_identifier(schema);
            let safe_table = sanitize_identifier(table);
            let col_list: String = columns
                .iter()
                .map(|c| format!("\"{}\"", sanitize_identifier(c)))
                .collect::<Vec<_>>()
                .join(", ");
            let order_col = sanitize_identifier(columns[0]);
            let select_sql = format!(
                "SELECT {} FROM \"{}\".\"{}\" ORDER BY \"{}\" ASC LIMIT $1 OFFSET $2",
                col_list, safe_schema, safe_table, order_col
            );

            let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
            let mut offset: i64 = 0;
            let mut total_rows: u64 = 0;

            loop {
                let rows = client
                    .query(&select_sql, &[&(EXPORT_CHUNK_SIZE as i32), &offset])
                    .await
                    .map_err(|e| format!("Query error: {}", e))?;
                if rows.is_empty() {
                    break;
                }
                let values: Vec<String> = rows
                    .iter()
                    .map(|row| {
                        let cells = row_to_cells(row);
                        let literals: Vec<String> =
                            cells.iter().map(cell_value_to_sql_literal).collect();
                        format!("({})", literals.join(", "))
                    })
                    .collect();
                let insert_sql = format!(
                    "INSERT INTO \"{}\".\"{}\" ({}) VALUES\n{}\n;\n",
                    safe_schema,
                    safe_table,
                    col_list,
                    values.join(",\n")
                );
                writer
                    .write_all(insert_sql.as_bytes())
                    .map_err(|e| format!("Write error: {}", e))?;
                bytes_written += insert_sql.len() as u64;
                total_rows += rows.len() as u64;
                offset += rows.len() as i64;

                progress(ExportProgressPayload {
                    phase: "rows".to_string(),
                    message: format!("Exported {} rows from {}.{}", total_rows, schema, table),
                    current: (i + 1) as u32,
                    total,
                    table: Some(table_key.clone()),
                    rows_exported: Some(total_rows),
                });
            }
        }
    }

    writer.flush().map_err(|e| format!("Flush error: {}", e))?;
    if let ExportWriter::Gzip(ref mut gz) = writer {
        gz.try_finish()
            .map_err(|e| format!("Gzip finish error: {}", e))?;
    }
    Ok(ExportResult {
        output_path,
        bytes_written,
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// DDL operations (table structure mutations)
// ──────────────────────────────────────────────────────────────────────────────

pub async fn rename_table(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    new_name: &str,
) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let safe_new = sanitize_identifier(new_name);
    let sql = format!(
        "ALTER TABLE \"{}\".\"{}\" RENAME TO \"{}\"",
        safe_schema, safe_table, safe_new
    );
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Rename table error: {}", e))?;
    Ok(())
}

pub async fn rename_column(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    column: &str,
    new_name: &str,
) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let safe_col = sanitize_identifier(column);
    let safe_new = sanitize_identifier(new_name);
    let sql = format!(
        "ALTER TABLE \"{}\".\"{}\" RENAME COLUMN \"{}\" TO \"{}\"",
        safe_schema, safe_table, safe_col, safe_new
    );
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Rename column error: {}", e))?;
    Ok(())
}

/// Alter column: change type, default, or nullability.
/// `new_type` if Some → ALTER COLUMN type; `new_default` if Some("") → DROP DEFAULT, if Some(expr) → SET DEFAULT;
/// `nullable` if Some(true) → DROP NOT NULL, if Some(false) → SET NOT NULL.
pub async fn alter_column(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    column: &str,
    new_type: Option<&str>,
    new_default: Option<&str>,
    nullable: Option<bool>,
) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let safe_col = sanitize_identifier(column);

    let mut parts: Vec<String> = Vec::new();

    if let Some(typ) = new_type {
        if !typ.trim().is_empty() {
            // type name validation: only allow alphanumeric, spaces, parens, commas
            let safe_type: String = typ
                .chars()
                .filter(|c| c.is_alphanumeric() || " ()[]_,.'".contains(*c))
                .collect();
            parts.push(format!(
                "ALTER COLUMN \"{}\" TYPE {} USING \"{}\"::{}",
                safe_col, safe_type, safe_col, safe_type
            ));
        }
    }

    if let Some(def) = new_default {
        if def.trim().is_empty() {
            parts.push(format!("ALTER COLUMN \"{}\" DROP DEFAULT", safe_col));
        } else {
            // default expressions come through as-is (user supplied; risk is bounded to their own DB)
            parts.push(format!("ALTER COLUMN \"{}\" SET DEFAULT {}", safe_col, def));
        }
    }

    if let Some(is_nullable) = nullable {
        if is_nullable {
            parts.push(format!("ALTER COLUMN \"{}\" DROP NOT NULL", safe_col));
        } else {
            parts.push(format!("ALTER COLUMN \"{}\" SET NOT NULL", safe_col));
        }
    }

    if parts.is_empty() {
        return Ok(());
    }

    let sql = format!(
        "ALTER TABLE \"{}\".\"{}\" {}",
        safe_schema,
        safe_table,
        parts.join(", ")
    );
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Alter column error: {}", e))?;
    Ok(())
}

pub async fn add_column(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    column: &str,
    data_type: &str,
    is_nullable: bool,
    default_value: Option<&str>,
) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let safe_col = sanitize_identifier(column);
    let safe_type: String = data_type
        .chars()
        .filter(|c| c.is_alphanumeric() || " ()[]_,.'".contains(*c))
        .collect();

    let null_clause = if is_nullable { "" } else { " NOT NULL" };
    let default_clause = match default_value {
        Some(d) if !d.trim().is_empty() => format!(" DEFAULT {}", d),
        _ => String::new(),
    };

    let sql = format!(
        "ALTER TABLE \"{}\".\"{}\" ADD COLUMN \"{}\" {}{}{}",
        safe_schema, safe_table, safe_col, safe_type, null_clause, default_clause
    );
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Add column error: {}", e))?;
    Ok(())
}

pub async fn drop_column(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let safe_col = sanitize_identifier(column);
    let sql = format!(
        "ALTER TABLE \"{}\".\"{}\" DROP COLUMN IF EXISTS \"{}\" CASCADE",
        safe_schema, safe_table, safe_col
    );
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Drop column error: {}", e))?;
    Ok(())
}

pub async fn truncate_table(pool: &Arc<Pool>, schema: &str, table: &str) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let sql = format!(
        "TRUNCATE TABLE \"{}\".\"{}\" RESTART IDENTITY CASCADE",
        safe_schema, safe_table
    );
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Truncate error: {}", e))?;
    Ok(())
}

pub async fn drop_table(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    cascade: bool,
) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let cascade_clause = if cascade { " CASCADE" } else { "" };
    let sql = format!(
        "DROP TABLE IF EXISTS \"{}\".\"{}\"{}",
        safe_schema, safe_table, cascade_clause
    );
    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Drop table error: {}", e))?;
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// CREATE TABLE
// ──────────────────────────────────────────────────────────────────────────────

/// Build and execute a CREATE TABLE statement.
/// Returns the generated SQL string on success so the caller can echo it to the UI.
pub async fn create_table(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    columns: &[super::types::CreateColumnDef],
    if_not_exists: bool,
) -> Result<String, String> {
    if columns.is_empty() {
        return Err("A table must have at least one column.".to_string());
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    // Collect PK column names (safe)
    let pk_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| format!("\"{}\"", sanitize_identifier(&c.name)))
        .collect();

    let mut col_defs: Vec<String> = Vec::new();
    let mut table_constraints: Vec<String> = Vec::new();

    for col in columns {
        let safe_name = sanitize_identifier(&col.name);

        // Sanitize type: allow alphanumeric, spaces, parens, brackets, underscore, comma, dot
        let safe_type: String = col
            .data_type
            .chars()
            .filter(|c| c.is_alphanumeric() || " ()[]_,.'".contains(*c))
            .collect();

        // Append length/precision when provided (digits and commas only)
        let type_str = match &col.length {
            Some(len) if !len.trim().is_empty() => {
                let safe_len: String = len
                    .chars()
                    .filter(|c| c.is_ascii_digit() || *c == ',')
                    .collect();
                if safe_len.is_empty() {
                    safe_type
                } else {
                    format!("{}({})", safe_type, safe_len)
                }
            }
            _ => safe_type,
        };

        let null_clause = if col.is_nullable { "" } else { " NOT NULL" };

        let default_clause = match &col.default_value {
            Some(d) if !d.trim().is_empty() => format!(" DEFAULT {}", d.trim()),
            _ => String::new(),
        };

        // Inline PRIMARY KEY only when exactly one PK column
        let pk_inline = if pk_cols.len() == 1 && col.is_primary_key {
            " PRIMARY KEY"
        } else {
            ""
        };

        col_defs.push(format!(
            "  \"{}\" {}{}{}{}",
            safe_name, type_str, null_clause, default_clause, pk_inline
        ));

        // Per-column UNIQUE (skip if it is already the sole PK)
        if col.is_unique && !(pk_cols.len() == 1 && col.is_primary_key) {
            table_constraints.push(format!("  UNIQUE (\"{}\")", safe_name));
        }

        // Per-column CHECK
        if let Some(ref chk) = col.check_constraint {
            let trimmed = chk.trim();
            if !trimmed.is_empty() {
                table_constraints.push(format!("  CHECK ({})", trimmed));
            }
        }
    }

    // Composite PRIMARY KEY constraint
    if pk_cols.len() > 1 {
        table_constraints.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    let mut all_defs = col_defs;
    all_defs.extend(table_constraints);

    let exists_clause = if if_not_exists { " IF NOT EXISTS" } else { "" };
    let sql = format!(
        "CREATE TABLE{} \"{}\".\"{}\" (\n{}\n)",
        exists_clause,
        safe_schema,
        safe_table,
        all_defs.join(",\n")
    );

    client
        .execute(&sql, &[])
        .await
        .map_err(|e| format!("Create table error: {}", e))?;

    Ok(sql)
}

// ──────────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────────

/// Sanitize a SQL identifier to prevent injection in format!() queries.
// ──────────────────────────────────────────────────────────────────────────────
// Column statistics
// ──────────────────────────────────────────────────────────────────────────────

pub async fn get_column_stats(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<super::types::ColumnStats, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let safe_col = sanitize_identifier(column);

    // Base aggregates
    let stats_sql = format!(
        r#"SELECT
            COUNT(*) as total_rows,
            COUNT("{col}") as non_null_count,
            COUNT(*) - COUNT("{col}") as null_count,
            COUNT(DISTINCT "{col}") as distinct_count,
            MIN("{col}"::text) as min_val,
            MAX("{col}"::text) as max_val
        FROM "{schema}"."{table}""#,
        col = safe_col,
        schema = safe_schema,
        table = safe_table
    );

    let row = client
        .query_one(&stats_sql, &[])
        .await
        .map_err(|e| format!("Stats query error: {}", e))?;

    let total_rows: i64 = row.get(0);
    let non_null_count: i64 = row.get(1);
    let null_count: i64 = row.get(2);
    let distinct_count: i64 = row.get(3);
    let min_value: Option<String> = row.try_get(4).ok().flatten();
    let max_value: Option<String> = row.try_get(5).ok().flatten();

    let null_pct = if total_rows > 0 {
        (null_count as f64 / total_rows as f64) * 100.0
    } else {
        0.0
    };

    // Avg — silently skip if non-numeric column
    let avg_value: Option<f64> = {
        let avg_sql = format!(
            r#"SELECT AVG("{col}"::numeric) FROM "{schema}"."{table}""#,
            col = safe_col,
            schema = safe_schema,
            table = safe_table
        );
        client
            .query_one(&avg_sql, &[])
            .await
            .ok()
            .and_then(|r| r.try_get::<_, Option<f64>>(0).ok().flatten())
    };

    // Top 5 most frequent values
    let top_sql = format!(
        r#"SELECT "{col}"::text, COUNT(*) as cnt
        FROM "{schema}"."{table}"
        WHERE "{col}" IS NOT NULL
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 5"#,
        col = safe_col,
        schema = safe_schema,
        table = safe_table
    );
    let top_rows = client.query(&top_sql, &[]).await.unwrap_or_default();
    let top_values: Vec<(String, i64)> = top_rows
        .iter()
        .map(|r| {
            let val: String = r.try_get(0).unwrap_or_default();
            let cnt: i64 = r.try_get(1).unwrap_or(0);
            (val, cnt)
        })
        .collect();

    Ok(super::types::ColumnStats {
        column: column.to_string(),
        total_rows,
        null_count,
        non_null_count,
        distinct_count,
        null_pct,
        min_value,
        max_value,
        avg_value,
        top_values,
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// Multi-condition table search (safe inline literals with proper escaping)
// ──────────────────────────────────────────────────────────────────────────────

/// Escape a string value for use as a SQL literal (double single-quotes).
fn escape_sql_literal(s: &str) -> String {
    s.replace('\'', "''")
}

/// Execute a multi-condition WHERE query with pagination and optional sort.
///
/// Values are injected as SQL string literals with single-quote escaping (safe because
/// column names and operators are both independently validated). PostgreSQL performs
/// implicit coercion from string literals to the target column type.
pub async fn search_table_data_multi(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    conditions: &[super::types::FilterCondition],
    limit: u32,
    page: u32,
    sort_column: Option<&str>,
    sort_direction: &str,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    let columns_meta = get_columns(pool, schema, table).await.unwrap_or_default();
    let enum_labels_by_column =
        fetch_enum_labels_by_column(&client, schema, table).await;
    let select_list = if columns_meta.is_empty() {
        "*".to_string()
    } else {
        build_select_list(&columns_meta, &enum_labels_by_column)
    };

    const VALID_OPS: &[&str] = &[
        "=",
        "!=",
        "<>",
        ">",
        "<",
        ">=",
        "<=",
        "LIKE",
        "NOT LIKE",
        "ILIKE",
        "NOT ILIKE",
        "IS NULL",
        "IS NOT NULL",
    ];
    const NULL_OPS: &[&str] = &["IS NULL", "IS NOT NULL"];
    const VALID_LOGICAL: &[&str] = &["AND", "OR"];

    // Build WHERE predicates
    let mut predicates: Vec<String> = Vec::new();
    for (i, cond) in conditions.iter().enumerate() {
        if cond.column.is_empty() || cond.operator.is_empty() {
            continue;
        }
        let safe_col = sanitize_identifier(&cond.column);
        let op_upper = cond.operator.to_uppercase();
        let op_str = op_upper.trim();

        if !VALID_OPS.contains(&op_str) {
            return Err(format!("Invalid operator: '{}'", cond.operator));
        }

        let predicate = if NULL_OPS.contains(&op_str) {
            format!("\"{}\" {}", safe_col, op_str)
        } else {
            let val = cond.value.as_deref().unwrap_or("");
            let escaped = escape_sql_literal(val);
            format!("\"{}\" {} '{}'", safe_col, op_str, escaped)
        };

        if i == 0 || predicates.is_empty() {
            predicates.push(predicate);
        } else {
            let logical = cond.logical_op.to_uppercase();
            let logical_safe = if VALID_LOGICAL.contains(&logical.as_str()) {
                logical
            } else {
                "AND".to_string()
            };
            predicates.push(format!("{} {}", logical_safe, predicate));
        }
    }

    let where_clause = if predicates.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", predicates.join(" "))
    };

    // ORDER BY
    let order_clause = match sort_column {
        Some(col) if !col.is_empty() => {
            let safe_sort_col = sanitize_identifier(col);
            let safe_dir = if sort_direction.to_uppercase() == "DESC" {
                "DESC"
            } else {
                "ASC"
            };
            format!("ORDER BY \"{}\" {} NULLS LAST", safe_sort_col, safe_dir)
        }
        _ => String::new(),
    };

    // COUNT (total matching rows)
    let count_sql = format!(
        "SELECT COUNT(*) FROM \"{}\".\"{}\" {}",
        safe_schema, safe_table, where_clause
    );
    let count_row = client
        .query_one(&count_sql, &[])
        .await
        .map_err(|e| format!("Count query error: {}", e))?;
    let total: i64 = count_row.get(0);

    // DATA
    let offset = (page.saturating_sub(1)) as i64 * limit as i64;
    let data_sql = format!(
        "SELECT {} FROM \"{}\".\"{}\" {} {} LIMIT {} OFFSET {}",
        select_list, safe_schema, safe_table, where_clause, order_clause, limit, offset
    );

    let columns_from_meta: Vec<ResultColumn> = if !columns_meta.is_empty() {
        columns_meta
            .iter()
            .map(|c| ResultColumn {
                name: c.name.clone(),
                data_type: c.data_type.clone(),
                enum_labels: enum_labels_by_column.get(&c.name).cloned(),
            })
            .collect()
    } else {
        Vec::new()
    };

    let rows = client
        .query(&data_sql, &[])
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let columns: Vec<ResultColumn> = if !columns_from_meta.is_empty() {
        columns_from_meta
    } else if !rows.is_empty() {
        rows[0]
            .columns()
            .iter()
            .map(|col| ResultColumn {
                name: col.name().to_string(),
                data_type: pg_type_to_string(col.type_()),
                enum_labels: None,
            })
            .collect()
    } else {
        Vec::new()
    };

    let data: Vec<Vec<CellValue>> = rows.iter().map(|row| row_to_cells(row)).collect();
    let row_count = data.len();
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;

    Ok(QueryResult {
        columns,
        rows: data,
        row_count,
        total_rows: Some(total),
        execution_time_ms: elapsed,
        page: Some(page),
        page_size: Some(limit),
        query: data_sql,
        is_error: false,
        error_message: None,
    })
}

fn sanitize_identifier(name: &str) -> String {
    name.replace('"', "\"\"")
        .replace('\'', "")
        .replace(';', "")
        .replace("--", "")
}

// ─── Session Monitor ──────────────────────────────────────────────────────────

/// Fetch all active sessions from pg_stat_activity (excluding our own connection).
pub async fn get_sessions(pool: &Pool) -> Result<Vec<super::types::PgSession>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let rows = client
        .query(
            "SELECT
                pid,
                usename,
                application_name,
                datname,
                client_addr::text AS client_addr,
                client_port,
                backend_start,
                xact_start,
                query_start,
                state_change,
                wait_event_type,
                wait_event,
                state,
                left(query, 10000) AS query,
                backend_type,
                pg_blocking_pids(pid) AS blocking_pids,
                EXTRACT(EPOCH FROM (now() - query_start))::float8 AS query_duration_secs,
                EXTRACT(EPOCH FROM (now() - xact_start))::float8 AS xact_duration_secs,
                EXTRACT(EPOCH FROM (now() - backend_start))::float8 AS backend_duration_secs
             FROM pg_stat_activity
             WHERE pid != pg_backend_pid()
             ORDER BY
                CASE state
                    WHEN 'active' THEN 1
                    WHEN 'idle in transaction' THEN 2
                    WHEN 'idle in transaction (aborted)' THEN 3
                    ELSE 4
                END,
                query_start DESC NULLS LAST",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;

    let sessions = rows
        .iter()
        .map(|row| {
            let backend_start: Option<chrono::DateTime<chrono::Utc>> =
                row.try_get("backend_start").ok().flatten();
            let xact_start: Option<chrono::DateTime<chrono::Utc>> =
                row.try_get("xact_start").ok().flatten();
            let query_start: Option<chrono::DateTime<chrono::Utc>> =
                row.try_get("query_start").ok().flatten();
            let state_change: Option<chrono::DateTime<chrono::Utc>> =
                row.try_get("state_change").ok().flatten();

            super::types::PgSession {
                pid: row.get("pid"),
                usename: row.try_get("usename").ok().flatten(),
                application_name: row.try_get("application_name").ok().flatten(),
                datname: row.try_get("datname").ok().flatten(),
                client_addr: row.try_get("client_addr").ok().flatten(),
                client_port: row.try_get("client_port").ok().flatten(),
                backend_start: backend_start.map(|t| t.to_rfc3339()),
                xact_start: xact_start.map(|t| t.to_rfc3339()),
                query_start: query_start.map(|t| t.to_rfc3339()),
                state_change: state_change.map(|t| t.to_rfc3339()),
                wait_event_type: row.try_get("wait_event_type").ok().flatten(),
                wait_event: row.try_get("wait_event").ok().flatten(),
                state: row.try_get("state").ok().flatten(),
                query: row.try_get("query").ok().flatten(),
                backend_type: row.try_get("backend_type").ok().flatten(),
                blocking_pids: row
                    .try_get::<_, Vec<i32>>("blocking_pids")
                    .unwrap_or_default(),
                query_duration_secs: row.try_get("query_duration_secs").ok().flatten(),
                xact_duration_secs: row.try_get("xact_duration_secs").ok().flatten(),
                backend_duration_secs: row.try_get("backend_duration_secs").ok().flatten(),
            }
        })
        .collect();

    Ok(sessions)
}

/// Terminate a backend process by PID. Returns true if the signal was sent.
pub async fn terminate_backend(pool: &Pool, pid: i32) -> Result<bool, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let row = client
        .query_one("SELECT pg_terminate_backend($1::int)", &[&pid])
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.get::<_, bool>(0))
}

/// Cancel the current query of a backend by PID (gentler than terminate).
pub async fn cancel_backend(pool: &Pool, pid: i32) -> Result<bool, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let row = client
        .query_one("SELECT pg_cancel_backend($1::int)", &[&pid])
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.get::<_, bool>(0))
}

// ──────────────────────────────────────────────────────────────────────────────
// Visual Index Builder queries
// ──────────────────────────────────────────────────────────────────────────────

/// Inspect whether pg_stat_statements is available for the current connection.
/// Checks:
/// 1) extension installed in current database
/// 2) shared_preload_libraries contains pg_stat_statements
/// 3) relation can actually be queried
pub async fn get_pg_stat_statements_status(
    pool: &Pool,
) -> Result<super::types::PgStatStatementsStatus, String> {
    let client = pool
        .get()
        .await
        .map_err(|e| format!("Connection error: {}", pg_error_message(&e)))?;

    let extension_installed: bool = client
        .query_one(
            "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')",
            &[],
        )
        .await
        .map_err(|e| format_pg_error(&e))?
        .get(0);

    let preload_raw: String = client
        .query_one("SHOW shared_preload_libraries", &[])
        .await
        .map_err(|e| format_pg_error(&e))?
        .get(0);

    let preload_enabled = preload_raw
        .split(',')
        .map(|v| v.trim().to_ascii_lowercase())
        .any(|v| v == "pg_stat_statements");

    let mut can_query = false;
    let mut probe_error: Option<String> = None;
    if extension_installed {
        match client
            .query_opt("SELECT 1 FROM pg_stat_statements LIMIT 1", &[])
            .await
        {
            Ok(_) => can_query = true,
            Err(err) => {
                probe_error = Some(format_pg_error(&err));
            }
        }
    }

    let mut messages: Vec<String> = Vec::new();
    if !extension_installed {
        messages
            .push("pg_stat_statements extension is not installed in this database.".to_string());
    }
    if !preload_enabled {
        messages.push(
            "shared_preload_libraries does not include pg_stat_statements. Add it to postgresql.conf and restart PostgreSQL.".to_string(),
        );
    }
    if extension_installed && preload_enabled && !can_query {
        messages.push(
            probe_error
                .map(|e| {
                    format!(
                        "pg_stat_statements is configured but cannot be queried: {}",
                        e
                    )
                })
                .unwrap_or_else(|| {
                    "pg_stat_statements is configured but cannot be queried.".to_string()
                }),
        );
    }

    Ok(super::types::PgStatStatementsStatus {
        extension_installed,
        preload_enabled,
        can_query,
        shared_preload_libraries: Some(preload_raw),
        message: if messages.is_empty() {
            None
        } else {
            Some(messages.join(" "))
        },
    })
}

/// Run CREATE EXTENSION for pg_stat_statements and return the refreshed status.
pub async fn enable_pg_stat_statements(
    pool: &Pool,
) -> Result<super::types::PgStatStatementsStatus, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;

    if let Err(err) = client
        .execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements", &[])
        .await
    {
        let raw = err.to_string();
        if raw.contains("must be loaded via shared_preload_libraries") {
            return Err(
                "pg_stat_statements requires shared_preload_libraries update and PostgreSQL restart before CREATE EXTENSION can succeed."
                    .to_string(),
            );
        }
        return Err(format!("Failed to enable pg_stat_statements: {}", raw));
    }

    get_pg_stat_statements_status(pool).await
}

fn pg_stat_statements_sort_clause(sort_by: Option<&str>, sort_dir: Option<&str>) -> String {
    let dir = match sort_dir.map(|v| v.to_ascii_uppercase()) {
        Some(v) if v == "ASC" => "ASC",
        _ => "DESC",
    };

    let column = match sort_by.unwrap_or("slowest").to_ascii_lowercase().as_str() {
        "max" => "max_exec_time",
        "total" => "total_exec_time",
        "calls" => "calls",
        "rows" => "rows",
        "disk" => "shared_blks_read",
        "slowest" => "mean_exec_time",
        _ => "mean_exec_time",
    };

    format!("{column} {dir}, calls DESC")
}

/// Paginated list from pg_stat_statements with lightweight search and sort.
/// Uses server-side pagination so the UI can handle very large statement sets.
pub async fn list_pg_stat_statements(
    pool: &Pool,
    filter: &super::types::PgStatStatementsFilter,
) -> Result<super::types::PgStatStatementsPage, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;

    let limit = filter.limit.unwrap_or(100).clamp(1, 500);
    let offset = filter.offset.unwrap_or(0);
    let sort_clause =
        pg_stat_statements_sort_clause(filter.sort_by.as_deref(), filter.sort_dir.as_deref());

    let search_text = filter
        .search_text
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let min_mean_ms = filter.min_mean_ms.filter(|v| v.is_finite() && *v >= 0.0);

    let total_count: i64 = client
        .query_one(
            r#"
            SELECT COUNT(*)
            FROM pg_stat_statements
            WHERE ($1::text IS NULL OR query ILIKE ('%' || $1 || '%'))
              AND ($2::float8 IS NULL OR mean_exec_time >= $2)
            "#,
            &[&search_text, &min_mean_ms],
        )
        .await
        .map_err(|e| {
            let msg = format_pg_error(&e);
            if msg.contains("pg_stat_statements") {
                format!("Unable to read pg_stat_statements: {}", msg)
            } else {
                msg
            }
        })?
        .get(0);

    let sql = format!(
        r#"
        SELECT
            md5(query) AS query_id,
            LEFT(query, 12000) AS query,
            calls::bigint AS calls,
            total_exec_time::float8 AS total_exec_time_ms,
            mean_exec_time::float8 AS mean_exec_time_ms,
            min_exec_time::float8 AS min_exec_time_ms,
            max_exec_time::float8 AS max_exec_time_ms,
            CASE WHEN calls > 1 THEN stddev_exec_time::float8 ELSE NULL END AS stddev_exec_time_ms,
            rows::bigint AS rows,
            shared_blks_hit::bigint AS shared_blks_hit,
            shared_blks_read::bigint AS shared_blks_read,
            temp_blks_written::bigint AS temp_blks_written,
            blk_read_time::float8 AS blk_read_time_ms,
            blk_write_time::float8 AS blk_write_time_ms,
            CASE
                WHEN (shared_blks_hit + shared_blks_read) > 0 THEN
                    (shared_blks_hit::float8 * 100.0 / (shared_blks_hit + shared_blks_read)::float8)
                ELSE 100.0
            END AS hit_percent,
            CASE
                WHEN mean_exec_time >= 1000 THEN calls::bigint
                WHEN max_exec_time >= 3000 THEN GREATEST(1, (calls::float8 * LEAST(1.0, mean_exec_time / max_exec_time))::bigint)
                WHEN max_exec_time >= 1000 THEN GREATEST(1, (calls::float8 * LEAST(1.0, mean_exec_time / 1000.0))::bigint)
                ELSE 0
            END AS slow_call_estimate
        FROM pg_stat_statements
        WHERE ($1::text IS NULL OR query ILIKE ('%' || $1 || '%'))
          AND ($2::float8 IS NULL OR mean_exec_time >= $2)
        ORDER BY {sort_clause}
        LIMIT $3 OFFSET $4
        "#
    );

    let limit_i64 = limit as i64;
    let offset_i64 = offset as i64;
    let rows = client
        .query(&sql, &[&search_text, &min_mean_ms, &limit_i64, &offset_i64])
        .await
        .map_err(|e| {
            let msg = format_pg_error(&e);
            if msg.contains("pg_stat_statements") {
                format!("Unable to read pg_stat_statements rows: {}", msg)
            } else {
                msg
            }
        })?;

    let items = rows
        .iter()
        .map(|row| super::types::PgStatStatementEntry {
            query_id: row.get("query_id"),
            query: row.get("query"),
            calls: row.get("calls"),
            total_exec_time_ms: row.get("total_exec_time_ms"),
            mean_exec_time_ms: row.get("mean_exec_time_ms"),
            min_exec_time_ms: row.get("min_exec_time_ms"),
            max_exec_time_ms: row.get("max_exec_time_ms"),
            stddev_exec_time_ms: row.try_get("stddev_exec_time_ms").ok().flatten(),
            rows: row.get("rows"),
            shared_blks_hit: row.get("shared_blks_hit"),
            shared_blks_read: row.get("shared_blks_read"),
            temp_blks_written: row.get("temp_blks_written"),
            blk_read_time_ms: row.try_get("blk_read_time_ms").ok().flatten(),
            blk_write_time_ms: row.try_get("blk_write_time_ms").ok().flatten(),
            hit_percent: row.get("hit_percent"),
            slow_call_estimate: row.get("slow_call_estimate"),
        })
        .collect::<Vec<_>>();

    let has_more = (offset as i64 + items.len() as i64) < total_count;
    Ok(super::types::PgStatStatementsPage {
        items,
        total_count,
        limit,
        offset,
        has_more,
    })
}

/// Get all indexes for a schema with live usage stats from pg_stat_user_indexes.
pub async fn get_indexes_with_stats(
    pool: &Pool,
    schema: &str,
) -> Result<Vec<super::types::IndexStats>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    // Prevent this query from hanging (e.g. on very large catalogs).
    let _ = client
        .execute("SET LOCAL statement_timeout = '20s'", &[])
        .await;

    // Use COALESCE for days_since_reset and stats_reset to avoid NULL/version issues.
    // Use COALESCE(array_agg(...), ARRAY[]::text[]) so columns is never NULL.
    let rows = client
        .query(
            r#"
            SELECT
                n.nspname                                           AS schema,
                t.relname                                           AS table_name,
                i.relname                                           AS index_name,
                ix.indisunique                                      AS is_unique,
                ix.indisprimary                                     AS is_primary,
                am.amname                                           AS index_type,
                pg_get_indexdef(ix.indexrelid)                      AS definition,
                pg_size_pretty(pg_relation_size(i.oid))             AS size_pretty,
                pg_relation_size(i.oid)                             AS size_bytes,
                COALESCE(s.idx_scan, 0)::bigint                     AS idx_scans,
                1.0                                                 AS days_since_reset,
                (SELECT to_char(stats_reset, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                 FROM pg_stat_database WHERE datname = current_database() LIMIT 1)
                                                                    AS stats_reset,
                COALESCE(
                    array_remove(array_agg(a.attname ORDER BY kp.pos), NULL),
                    ARRAY[]::text[]
                )                                                   AS columns
            FROM pg_index ix
            JOIN pg_class t  ON t.oid  = ix.indrelid
            JOIN pg_class i  ON i.oid  = ix.indexrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN pg_am am    ON am.oid  = i.relam
            LEFT JOIN pg_stat_user_indexes s
                   ON s.indexrelid = ix.indexrelid
            JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS kp(attnum, pos) ON true
            LEFT JOIN pg_attribute a
                   ON a.attrelid = t.oid AND a.attnum = kp.attnum AND kp.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname = $1
              AND t.relkind IN ('r', 'p')
            GROUP BY n.nspname, t.relname, i.relname, ix.indisunique, ix.indisprimary,
                     am.amname, ix.indexrelid, i.oid, s.idx_scan
            ORDER BY t.relname, i.relname
            "#,
            &[&schema],
        )
        .await
        .map_err(|e| e.to_string())?;

    let indexes = rows
        .iter()
        .map(|row| {
            let idx_scans: i64 = row.get("idx_scans");
            let days: f64 = row.get::<_, f64>("days_since_reset").max(1.0);
            let scans_per_day = idx_scans as f64 / days;
            let columns: Vec<String> = match row.try_get::<_, Vec<String>>("columns") {
                Ok(v) => v,
                Err(_) => row
                    .try_get::<_, Vec<Option<String>>>("columns")
                    .unwrap_or_default()
                    .into_iter()
                    .flatten()
                    .collect(),
            };

            super::types::IndexStats {
                schema: row.get("schema"),
                table_name: row.get("table_name"),
                index_name: row.get("index_name"),
                is_unique: row.get("is_unique"),
                is_primary: row.get("is_primary"),
                index_type: row.get("index_type"),
                columns,
                definition: row.get("definition"),
                size_pretty: row.get("size_pretty"),
                size_bytes: row.get("size_bytes"),
                idx_scans,
                scans_per_day,
                is_unused: idx_scans == 0,
                stats_reset: row.try_get("stats_reset").ok().flatten(),
            }
        })
        .collect();

    Ok(indexes)
}

/// Get sample queries from pg_stat_statements that reference the given table (for AI context).
/// Returns empty vec if extension is not installed.
pub async fn get_table_query_samples(
    pool: &Pool,
    schema: &str,
    table: &str,
    limit: i64,
) -> Result<Vec<super::types::QuerySample>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let ext_check = client
        .query_opt(
            "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
    if ext_check.is_none() {
        return Ok(Vec::new());
    }
    let table_pattern = format!("%\"{}\"%", table);
    let schema_table = format!("%{}.{}%", schema, table);
    let rows = client
        .query(
            r#"
            SELECT LEFT(query, 400) AS query, calls, mean_exec_time AS mean_exec_time_ms
            FROM pg_stat_statements
            WHERE (query ILIKE $1 OR query ILIKE $2)
              AND query NOT ILIKE '%pg_stat%'
              AND query NOT ILIKE '%EXPLAIN%'
            ORDER BY total_exec_time DESC
            LIMIT $3
            "#,
            &[&table_pattern, &schema_table, &limit],
        )
        .await
        .map_err(|e| e.to_string())?;
    let samples = rows
        .iter()
        .map(|row| super::types::QuerySample {
            query: row.get("query"),
            calls: row.get("calls"),
            mean_exec_time_ms: row.get("mean_exec_time_ms"),
        })
        .collect();
    Ok(samples)
}

/// Analyze pg_stat_statements for queries that would benefit from the proposed index.
/// Falls back gracefully if pg_stat_statements is not installed.
pub async fn get_index_impact(
    pool: &Pool,
    schema: &str,
    table: &str,
    columns: &[String],
    where_clause: Option<&str>,
) -> Result<Vec<super::types::IndexImpactQuery>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;

    // Check pg_stat_statements availability
    let ext_check = client
        .query_opt(
            "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;

    if ext_check.is_none() {
        return Err("pg_stat_statements extension is not installed".to_string());
    }

    // Build patterns to match queries referencing the table and any of the columns
    let table_pattern = format!("%{}%", table);
    let col_patterns: Vec<String> = columns.iter().map(|c| format!("%{}%", c)).collect();

    // Fetch candidate queries from pg_stat_statements
    let rows = client
        .query(
            r#"
            SELECT
                query,
                calls,
                mean_exec_time    AS mean_exec_time_ms,
                total_exec_time   AS total_exec_time_ms
            FROM pg_stat_statements
            WHERE query ILIKE $1
              AND query NOT ILIKE '%pg_stat%'
              AND query NOT ILIKE '%EXPLAIN%'
              AND mean_exec_time > 1
            ORDER BY total_exec_time DESC
            LIMIT 50
            "#,
            &[&table_pattern],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    for row in &rows {
        let query: String = row.get("query");
        let calls: i64 = row.get("calls");
        let mean_exec_time_ms: f64 = row.get("mean_exec_time_ms");
        let total_exec_time_ms: f64 = row.get("total_exec_time_ms");

        // Check if the query references any of the index columns
        let references_column = col_patterns.iter().any(|pat| {
            let col = pat.trim_matches('%');
            query.to_lowercase().contains(&col.to_lowercase())
        });

        if !references_column {
            continue;
        }

        // Run EXPLAIN to check for sequential scans on the target table
        let explain_sql = format!(
            "EXPLAIN (FORMAT JSON) {}",
            // Truncate to first 500 chars to avoid huge queries; wrap in a safe context
            if query.len() > 500 {
                &query[..500]
            } else {
                &query
            }
        );

        let explain_result = client.query_opt(&explain_sql, &[]).await;
        let has_seq_scan = match explain_result {
            Ok(Some(explain_row)) => {
                let plan_json: serde_json::Value =
                    explain_row.try_get(0).unwrap_or(serde_json::Value::Null);
                let plan_str = plan_json.to_string().to_lowercase();
                plan_str.contains("seq scan") && plan_str.contains(&table.to_lowercase())
            }
            _ => {
                // If EXPLAIN fails (e.g. parameterized query), still include if it references columns
                true
            }
        };

        if !has_seq_scan {
            continue;
        }

        // Estimate speedup: sequential scan cost ≈ full table pages; index cost ≈ log(n) + result rows
        // Conservative estimate: index reduces time to ~5-20% of seq scan time
        let speedup_factor = if mean_exec_time_ms > 100.0 {
            0.05 // Very slow query: estimate 95% reduction
        } else if mean_exec_time_ms > 10.0 {
            0.10 // Moderate: estimate 90% reduction
        } else {
            0.20 // Fast queries: 80% reduction (index overhead matters more)
        };

        let estimated_time_after_ms = (mean_exec_time_ms * speedup_factor).max(0.1);

        let matched_cols: Vec<&str> = columns
            .iter()
            .filter(|c| query.to_lowercase().contains(&c.to_lowercase()))
            .map(|c| c.as_str())
            .collect();

        let benefit_reason = format!(
            "Seq Scan on {}.{} filtering on {}",
            schema,
            table,
            matched_cols.join(", ")
        );

        let _ = where_clause; // partial index predicate noted for context

        results.push(super::types::IndexImpactQuery {
            query: if query.len() > 200 {
                format!("{}…", &query[..200])
            } else {
                query
            },
            calls,
            mean_exec_time_ms,
            total_exec_time_ms,
            estimated_time_after_ms,
            benefit_reason,
        });

        if results.len() >= 10 {
            break;
        }
    }

    Ok(results)
}

/// Build and execute CREATE INDEX CONCURRENTLY. Returns the generated SQL.
/// Note: CONCURRENTLY cannot run inside a transaction, so we use a direct connection.
pub async fn create_index_concurrently(
    pool: &Pool,
    req: &super::types::CreateIndexRequest,
) -> Result<String, String> {
    // Validate index type
    let allowed_types = ["BTREE", "HASH", "GIN", "GIST", "BRIN", "SPGIST"];
    let index_type_upper = req.index_type.to_uppercase();
    if !allowed_types.contains(&index_type_upper.as_str()) {
        return Err(format!("Unsupported index type: {}", req.index_type));
    }

    if req.columns.is_empty() {
        return Err("At least one column is required".to_string());
    }

    // Auto-generate index name if not provided
    let index_name = req.index_name.clone().unwrap_or_else(|| {
        let cols = req.columns.join("_");
        format!("idx_{}_{}", req.table_name, cols)
    });

    // Quote identifiers
    let schema_q = quote_ident(&req.schema);
    let table_q = quote_ident(&req.table_name);
    let index_q = quote_ident(&index_name);
    let cols_q: Vec<String> = req.columns.iter().map(|c| quote_ident(c)).collect();
    let cols_str = cols_q.join(", ");

    let unique_kw = if req.is_unique { "UNIQUE " } else { "" };
    let where_kw = req
        .where_clause
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|w| format!(" WHERE {}", w))
        .unwrap_or_default();

    let sql = format!(
        "CREATE {}INDEX CONCURRENTLY {} ON {}.{} USING {} ({}){}",
        unique_kw, index_q, schema_q, table_q, index_type_upper, cols_str, where_kw
    );

    // CONCURRENTLY cannot run inside a transaction block — use a raw client
    let client = pool.get().await.map_err(|e| e.to_string())?;
    client
        .execute(sql.as_str(), &[])
        .await
        .map_err(|e| format!("Index creation failed: {}", e))?;

    Ok(sql)
}

/// Drop an index (using CONCURRENTLY to avoid locking).
pub async fn drop_index(pool: &Pool, schema: &str, index_name: &str) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let schema_q = quote_ident(schema);
    let index_q = quote_ident(index_name);
    let sql = format!("DROP INDEX CONCURRENTLY {}.{}", schema_q, index_q);
    client
        .execute(sql.as_str(), &[])
        .await
        .map_err(|e| format!("Drop index failed: {}", e))?;
    Ok(())
}

/// Poll pg_stat_progress_create_index for live build progress.
pub async fn get_index_build_progress(
    pool: &Pool,
    index_name: &str,
) -> Result<Option<super::types::IndexBuildProgress>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;

    let row = client
        .query_opt(
            r#"
            SELECT
                p.phase,
                COALESCE(p.blocks_done, 0)    AS blocks_done,
                COALESCE(p.blocks_total, 0)   AS blocks_total,
                COALESCE(p.tuples_done, 0)    AS tuples_done,
                COALESCE(p.tuples_total, 0)   AS tuples_total
            FROM pg_stat_progress_create_index p
            JOIN pg_class c ON c.oid = p.relid
            WHERE c.relname = $1
            LIMIT 1
            "#,
            &[&index_name],
        )
        .await
        .map_err(|e| e.to_string())?;

    match row {
        None => Ok(None),
        Some(r) => {
            let blocks_done: i64 = r.get("blocks_done");
            let blocks_total: i64 = r.get("blocks_total");
            let tuples_done: i64 = r.get("tuples_done");
            let tuples_total: i64 = r.get("tuples_total");
            let phase: String = r.try_get("phase").unwrap_or_default();

            let percent_done = if blocks_total > 0 {
                (blocks_done as f64 / blocks_total as f64 * 100.0).min(99.9)
            } else if tuples_total > 0 {
                (tuples_done as f64 / tuples_total as f64 * 100.0).min(99.9)
            } else {
                0.0
            };

            Ok(Some(super::types::IndexBuildProgress {
                index_name: index_name.to_string(),
                phase,
                blocks_done,
                blocks_total,
                tuples_done,
                tuples_total,
                percent_done,
                is_complete: false,
            }))
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema topology (ER diagram)
// ──────────────────────────────────────────────────────────────────────────────

/// Fetch nodes (tables + row count + columns with types/PK) and edges (FKs) for a schema.
/// Uses a 15-second timeout and runs all 4 queries concurrently for performance.
pub async fn get_schema_topology(pool: &Arc<Pool>, schema: &str) -> Result<TopologyData, String> {
    const TIMEOUT: Duration = Duration::from_secs(15);
    let started_at = Instant::now();

    let result = tokio::time::timeout(TIMEOUT, async {
        let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

        // Run all 4 queries concurrently for faster execution
        let (table_rows, col_rows, pk_rows, fk_rows) = tokio::try_join!(
            // 1) Tables with estimated row count
            async {
                client
                    .query(
                        "SELECT t.table_name, t.table_schema, t.table_type,
                                COALESCE(
                                    (SELECT reltuples::bigint FROM pg_class c
                                     JOIN pg_namespace n ON n.oid = c.relnamespace
                                     WHERE c.relname = t.table_name AND n.nspname = t.table_schema),
                                    0
                                ) AS estimated_row_count
                         FROM information_schema.tables t
                         WHERE t.table_schema = $1
                           AND t.table_type IN ('BASE TABLE', 'VIEW')
                         ORDER BY t.table_name",
                        &[&schema],
                    )
                    .await
                    .map_err(|e| format!("Topology tables query: {}", e))
            },
            // 2) All columns for this schema with data_type and is_nullable
            async {
                client
                    .query(
                        "SELECT table_schema, table_name, column_name, data_type,
                                CASE WHEN is_nullable = 'YES' THEN true ELSE false END AS nullable
                         FROM information_schema.columns
                         WHERE table_schema = $1
                         ORDER BY table_name, ordinal_position",
                        &[&schema],
                    )
                    .await
                    .map_err(|e| format!("Topology columns query: {}", e))
            },
            // 3) Primary key columns for all tables in schema
            async {
                client
                    .query(
                        "SELECT kcu.table_name, kcu.column_name
                         FROM information_schema.table_constraints tc
                         JOIN information_schema.key_column_usage kcu
                           ON tc.constraint_name = kcu.constraint_name
                          AND tc.table_schema    = kcu.table_schema
                         WHERE tc.constraint_type = 'PRIMARY KEY'
                           AND tc.table_schema = $1",
                        &[&schema],
                    )
                    .await
                    .map_err(|e| format!("Topology PKs query: {}", e))
            },
            // 4) Foreign keys
            async {
                client
                    .query(
                        "SELECT tc.constraint_name,
                                kcu.table_schema AS from_schema,
                                kcu.table_name   AS from_table,
                                kcu.column_name   AS from_column,
                                ccu.table_schema  AS to_schema,
                                ccu.table_name    AS to_table,
                                ccu.column_name   AS to_column
                         FROM information_schema.table_constraints tc
                         JOIN information_schema.key_column_usage kcu
                           ON tc.constraint_name = kcu.constraint_name
                          AND tc.table_schema    = kcu.table_schema
                         JOIN information_schema.constraint_column_usage ccu
                           ON tc.constraint_name = ccu.constraint_name
                         WHERE tc.constraint_type = 'FOREIGN KEY'
                           AND kcu.table_schema = $1
                           AND ccu.table_schema = $1
                         ORDER BY tc.constraint_name",
                        &[&schema],
                    )
                    .await
                    .map_err(|e| format!("Topology FKs query: {}", e))
            }
        )?;

        // Build a set of (table_name, column_name) that are primary keys
        let mut pk_set: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        for row in &pk_rows {
            let t: String = row.get(0);
            let c: String = row.get(1);
            pk_set.insert((t, c));
        }

        // Build columns map: (schema, table) -> Vec<TopologyColumn>
        let mut columns_by_table: std::collections::HashMap<(String, String), Vec<TopologyColumn>> =
            std::collections::HashMap::new();
        for row in &col_rows {
            let s: String = row.get(0);
            let t: String = row.get(1);
            let col_name: String = row.get(2);
            let data_type: String = row.get(3);
            let nullable: bool = row.get(4);
            let is_pk = pk_set.contains(&(t.clone(), col_name.clone()));
            columns_by_table
                .entry((s, t))
                .or_default()
                .push(TopologyColumn {
                    name: col_name,
                    data_type,
                    is_primary_key: is_pk,
                    is_nullable: nullable,
                });
        }

        let nodes: Vec<TopologyNode> = table_rows
            .iter()
            .map(|row| {
                let schema_name: String = row.get(1);
                let table_name: String = row.get(0);
                let row_count: i64 = row.get(3);
                let columns = columns_by_table
                    .remove(&(schema_name.clone(), table_name.clone()))
                    .unwrap_or_default();
                TopologyNode {
                    schema: schema_name,
                    table_name,
                    row_count,
                    columns,
                }
            })
            .collect();

        let edges: Vec<TopologyEdge> = fk_rows
            .iter()
            .map(|row| TopologyEdge {
                constraint_name: row.get(0),
                from_schema: row.get(1),
                from_table: row.get(2),
                from_column: row.get(3),
                to_schema: row.get(4),
                to_table: row.get(5),
                to_column: row.get(6),
            })
            .collect();

        Ok(TopologyData { nodes, edges })
    })
    .await;

    match result {
        Ok(Ok(data)) => {
            debug!(
                target: "topology",
                "schema_topology ok schema={} nodes={} edges={} elapsed_ms={}",
                schema,
                data.nodes.len(),
                data.edges.len(),
                started_at.elapsed().as_millis()
            );
            Ok(data)
        }
        Ok(Err(err)) => {
            warn!(
                target: "topology",
                "schema_topology error schema={} elapsed_ms={} error={}",
                schema,
                started_at.elapsed().as_millis(),
                err
            );
            Err(err)
        }
        Err(_) => {
            warn!(
                target: "topology",
                "schema_topology timeout schema={} elapsed_ms={}",
                schema,
                started_at.elapsed().as_millis()
            );
            Err("Topology query timed out after 15 seconds. The database may be slow or unreachable.".to_string())
        }
    }
}

/// Simple identifier quoting for SQL safety
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema import — full DDL extraction
// ──────────────────────────────────────────────────────────────────────────────

use super::types::{
    DbImportResult, ImportedFunction, ImportedIndex, ImportedSequence, ImportedTable,
    ImportedTrigger, ImportedView, SchemaImportResult,
};

/// Build a CREATE TABLE DDL string from column + constraint data.
fn build_create_table_ddl(
    schema: &str,
    table_name: &str,
    col_rows: &[tokio_postgres::Row],
    con_rows: &[tokio_postgres::Row],
) -> String {
    let mut parts: Vec<String> = Vec::new();

    // Column definitions
    for row in col_rows {
        let col_name: String = row.get(0);
        let data_type: String = row.get(1);
        let is_nullable: bool = row.get(2);
        let default_val: Option<String> = row.get(3);

        let mut col_def = format!("    {} {}", quote_ident(&col_name), data_type);
        if !is_nullable {
            col_def.push_str(" NOT NULL");
        }
        if let Some(def) = default_val {
            col_def.push_str(&format!(" DEFAULT {}", def));
        }
        parts.push(col_def);
    }

    // Constraints: pg_get_constraintdef returns the constraint body (e.g. "PRIMARY KEY (id)")
    for row in con_rows {
        let con_name: String = row.get(0);
        let con_def: Option<String> = row.get(2);
        if let Some(def) = con_def {
            parts.push(format!("    CONSTRAINT {} {}", quote_ident(&con_name), def));
        }
    }

    format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        quote_ident(schema),
        quote_ident(table_name),
        parts.join(",\n")
    )
}

/// Import the full schema DDL from a connected database.
/// Runs all object queries in parallel per schema for high performance.
pub async fn import_schema_full(
    pool: &Arc<Pool>,
    database: &str,
    schemas_filter: &[String],
    pg_version: u32,
) -> Result<DbImportResult, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    // 1. Resolve which schemas to import
    let schema_list: Vec<String> = if schemas_filter.is_empty() {
        let rows = client
            .query(
                "SELECT nspname FROM pg_namespace
                 WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
                   AND nspname NOT LIKE 'pg_%'
                 ORDER BY nspname",
                &[],
            )
            .await
            .map_err(|e| format!("Schema list error: {}", e))?;
        rows.iter().map(|r| r.get::<_, String>(0)).collect()
    } else {
        schemas_filter.to_vec()
    };

    drop(client); // release back to pool before per-schema queries

    let mut all_schemas: Vec<SchemaImportResult> = Vec::with_capacity(schema_list.len());
    let mut total_tables = 0usize;
    let mut total_views = 0usize;
    let mut total_functions = 0usize;
    let mut total_indexes = 0usize;
    let mut total_triggers = 0usize;
    let mut total_sequences = 0usize;

    for schema in &schema_list {
        let result = import_single_schema(pool, schema, pg_version).await?;
        total_tables += result.tables.len();
        total_views += result.views.len();
        total_functions += result.functions.len();
        total_indexes += result.indexes.len();
        total_triggers += result.triggers.len();
        total_sequences += result.sequences.len();
        all_schemas.push(result);
    }

    Ok(DbImportResult {
        database: database.to_string(),
        schemas: all_schemas,
        total_tables,
        total_views,
        total_functions,
        total_indexes,
        total_triggers,
        total_sequences,
    })
}

async fn import_single_schema(
    pool: &Arc<Pool>,
    schema: &str,
    pg_version: u32,
) -> Result<SchemaImportResult, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let schema_param: &str = schema;

    // ── Fetch all top-level objects sequentially (single client, no borrow conflicts) ──

    let func_sql = if pg_version >= 110000 {
        "SELECT p.proname, p.prokind::text,
                COALESCE(pg_get_function_arguments(p.oid),''),
                COALESCE(pg_get_function_result(p.oid),''),
                pg_get_functiondef(p.oid)
         FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = $1 AND p.prokind IN ('f','p','a','w')
         ORDER BY p.proname"
    } else {
        "SELECT p.proname, 'f'::text,
                COALESCE(pg_get_function_arguments(p.oid),''),
                COALESCE(pg_get_function_result(p.oid),''),
                pg_get_functiondef(p.oid)
         FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = $1
         ORDER BY p.proname"
    };

    let table_rows = client
        .query(
            "SELECT c.relname, COALESCE(c.reltuples::bigint, 0), d.description
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
             WHERE n.nspname = $1 AND c.relkind IN ('r','p')
             ORDER BY c.relname",
            &[&schema_param],
        )
        .await
        .map_err(|e| format!("Tables query error for '{}': {}", schema, e))?;

    let view_rows = client
        .query(
            "SELECT c.relname, c.relkind = 'm', pg_get_viewdef(c.oid, true)
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind IN ('v','m')
             ORDER BY c.relname",
            &[&schema_param],
        )
        .await
        .map_err(|e| format!("Views query error for '{}': {}", schema, e))?;

    let func_rows = client
        .query(func_sql, &[&schema_param])
        .await
        .map_err(|e| format!("Functions query error for '{}': {}", schema, e))?;

    let idx_rows = client
        .query(
            "SELECT i.relname, c.relname, ix.indisunique, ix.indisprimary,
                    pg_get_indexdef(i.oid)
             FROM pg_index ix
             JOIN pg_class c ON c.oid = ix.indrelid
             JOIN pg_class i ON i.oid = ix.indexrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1
             ORDER BY c.relname, i.relname",
            &[&schema_param],
        )
        .await
        .map_err(|e| format!("Indexes query error for '{}': {}", schema, e))?;

    let trig_rows = client
        .query(
            "SELECT tg.tgname, c.relname, pg_get_triggerdef(tg.oid)
             FROM pg_trigger tg
             JOIN pg_class c ON c.oid = tg.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND NOT tg.tgisinternal
             ORDER BY c.relname, tg.tgname",
            &[&schema_param],
        )
        .await
        .map_err(|e| format!("Triggers query error for '{}': {}", schema, e))?;

    let seq_rows = client
        .query(
            "SELECT s.relname
             FROM pg_class s
             JOIN pg_namespace n ON n.oid = s.relnamespace
             WHERE n.nspname = $1 AND s.relkind = 'S'
             ORDER BY s.relname",
            &[&schema_param],
        )
        .await
        .map_err(|e| format!("Sequences query error for '{}': {}", schema, e))?;

    // ── Tables: build CREATE TABLE DDL for each ────────────────────────────────
    let mut tables: Vec<ImportedTable> = Vec::with_capacity(table_rows.len());
    for row in &table_rows {
        let table_name: String = row.get(0);
        let estimated_rows: i64 = row.get(1);
        let comment: Option<String> = row.get(2);

        let t_name: &str = &table_name;
        let col_rows = client
            .query(
                "SELECT a.attname,
                        pg_catalog.format_type(a.atttypid, a.atttypmod),
                        NOT a.attnotnull AS is_nullable,
                        pg_get_expr(ad.adbin, ad.adrelid),
                        EXISTS (
                            SELECT 1 FROM pg_index i
                            WHERE i.indrelid = c.oid AND i.indisprimary
                              AND a.attnum = ANY(i.indkey)
                        )
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_attribute a ON a.attrelid = c.oid
                 LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
                 WHERE n.nspname = $1 AND c.relname = $2
                   AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum",
                &[&schema_param, &t_name],
            )
            .await
            .map_err(|e| format!("Columns query error for {}.{}: {}", schema, table_name, e))?;

        let con_rows = client
            .query(
                "SELECT con.conname, con.contype, pg_get_constraintdef(con.oid, true)
                 FROM pg_constraint con
                 JOIN pg_class c ON c.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2
                 ORDER BY con.contype, con.conname",
                &[&schema_param, &t_name],
            )
            .await
            .map_err(|e| {
                format!(
                    "Constraints query error for {}.{}: {}",
                    schema, table_name, e
                )
            })?;

        let ddl = build_create_table_ddl(schema, &table_name, &col_rows, &con_rows);
        tables.push(ImportedTable {
            name: table_name,
            estimated_rows,
            comment,
            ddl,
        });
    }

    // ── Views ─────────────────────────────────────────────────────────────────
    let views: Vec<ImportedView> = view_rows
        .iter()
        .map(|row| {
            let name: String = row.get(0);
            let is_materialized: bool = row.get(1);
            let body: Option<String> = row.get(2);
            let kw = if is_materialized {
                "MATERIALIZED VIEW"
            } else {
                "VIEW"
            };
            let ddl = format!(
                "CREATE OR REPLACE {} {}.{} AS\n{}",
                kw,
                quote_ident(schema),
                quote_ident(&name),
                body.unwrap_or_default()
            );
            ImportedView {
                name,
                is_materialized,
                ddl,
            }
        })
        .collect();

    // ── Functions ─────────────────────────────────────────────────────────────
    let kind_label = |k: &str| -> String {
        match k {
            "f" => "function".to_string(),
            "p" => "procedure".to_string(),
            "a" => "aggregate".to_string(),
            "w" => "window".to_string(),
            other => other.to_string(),
        }
    };

    let functions: Vec<ImportedFunction> = func_rows
        .iter()
        .map(|row| {
            let name: String = row.get(0);
            let kind_raw: String = row.get(1);
            let arguments: String = row.get(2);
            let return_type: String = row.get(3);
            let def: Option<String> = row.get(4);
            ImportedFunction {
                name,
                kind: kind_label(&kind_raw).to_string(),
                arguments,
                return_type,
                ddl: def.unwrap_or_default(),
            }
        })
        .collect();

    // ── Indexes ───────────────────────────────────────────────────────────────
    let indexes: Vec<ImportedIndex> = idx_rows
        .iter()
        .map(|row| {
            let name: String = row.get(0);
            let table_name: String = row.get(1);
            let is_unique: bool = row.get(2);
            let is_primary: bool = row.get(3);
            let ddl: Option<String> = row.get(4);
            ImportedIndex {
                name,
                table_name,
                is_unique,
                is_primary,
                ddl: ddl.unwrap_or_default(),
            }
        })
        .collect();

    // ── Triggers ──────────────────────────────────────────────────────────────
    let triggers: Vec<ImportedTrigger> = trig_rows
        .iter()
        .map(|row| {
            let name: String = row.get(0);
            let table_name: String = row.get(1);
            let def: Option<String> = row.get(2);
            ImportedTrigger {
                name,
                table_name,
                ddl: def.map(|d| format!("{};", d)).unwrap_or_default(),
            }
        })
        .collect();

    // ── Sequences ─────────────────────────────────────────────────────────────
    let sequences: Vec<ImportedSequence> = seq_rows
        .iter()
        .map(|row| {
            let name: String = row.get(0);
            let ddl = format!(
                "CREATE SEQUENCE {}.{};",
                quote_ident(schema),
                quote_ident(&name)
            );
            ImportedSequence { name, ddl }
        })
        .collect();

    Ok(SchemaImportResult {
        schema: schema.to_string(),
        tables,
        views,
        indexes,
        functions,
        triggers,
        sequences,
    })
}
