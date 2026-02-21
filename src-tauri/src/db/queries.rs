use deadpool_postgres::Pool;
use std::sync::Arc;
use std::time::Instant;
use tokio_postgres::types::Type;
use tokio_postgres::Row;

use super::types::*;

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
        // NUMERIC: try as f64 first (sufficient for most uses), fall back to text
        &Type::NUMERIC => match row.try_get::<_, Option<f64>>(idx) {
            Ok(Some(v)) => CellValue::Float64(v),
            _ => match row.try_get::<_, Option<String>>(idx) {
                Ok(Some(v)) => CellValue::String(v),
                _ => CellValue::Null,
            },
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
        &Type::TIMESTAMPTZ => {
            match row.try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(idx) {
                Ok(Some(v)) => CellValue::DateTime(v.to_rfc3339()),
                _ => CellValue::Null,
            }
        }
        &Type::DATE => match row.try_get::<_, Option<chrono::NaiveDate>>(idx) {
            Ok(Some(v)) => CellValue::Date(v.format("%Y-%m-%d").to_string()),
            _ => CellValue::Null,
        },
        &Type::TIME => match row.try_get::<_, Option<chrono::NaiveTime>>(idx) {
            Ok(Some(v)) => CellValue::Time(v.format("%H:%M:%S%.f").to_string()),
            _ => CellValue::Null,
        },
        // INTERVAL: tokio-postgres does not expose a native Rust type for this;
        // fall through to the generic String fallback below.
        &Type::JSON | &Type::JSONB => {
            match row.try_get::<_, Option<serde_json::Value>>(idx) {
                Ok(Some(v)) => CellValue::Json(v),
                _ => CellValue::Null,
            }
        }
        &Type::BYTEA => match row.try_get::<_, Option<Vec<u8>>>(idx) {
            Ok(Some(v)) => CellValue::Bytes(v),
            _ => CellValue::Null,
        },
        &Type::OID => match row.try_get::<_, Option<u32>>(idx) {
            Ok(Some(v)) => CellValue::Int64(v as i64),
            _ => CellValue::Null,
        },
        // Generic fallback: try text representation
        _ => match row.try_get::<_, Option<String>>(idx) {
            Ok(Some(v)) => CellValue::String(v),
            _ => CellValue::Null,
        },
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
pub async fn list_event_triggers(
    pool: &Arc<Pool>,
) -> Result<Vec<EventTriggerInfo>, String> {
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
pub async fn list_types(
    pool: &Arc<Pool>,
    schema: &str,
) -> Result<Vec<TypeInfo>, String> {
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

// ──────────────────────────────────────────────────────────────────────────────
// Table data
// ──────────────────────────────────────────────────────────────────────────────

pub async fn list_tables(pool: &Arc<Pool>, schema: &str) -> Result<Vec<TableInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = client
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
        .map_err(|e| format!("Query error: {}", e))?;

    let tables = rows
        .iter()
        .map(|row| TableInfo {
            name: row.get(0),
            schema: row.get(1),
            table_type: row.get(2),
            row_count: row.get(3),
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
            "SELECT c.column_name, c.data_type, c.is_nullable,
                    c.ordinal_position, c.column_default,
                    EXISTS(
                        SELECT 1 FROM information_schema.key_column_usage kcu
                        JOIN information_schema.table_constraints tc
                            ON tc.constraint_name = kcu.constraint_name
                           AND tc.table_schema    = kcu.table_schema
                        WHERE kcu.table_schema = c.table_schema
                          AND kcu.table_name   = c.table_name
                          AND kcu.column_name  = c.column_name
                          AND tc.constraint_type = 'PRIMARY KEY'
                    ) AS is_pk
             FROM information_schema.columns c
             WHERE c.table_schema = $1 AND c.table_name = $2
             ORDER BY c.ordinal_position",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let columns = rows
        .iter()
        .map(|row| {
            let is_nullable: String = row.get(2);
            ColumnInfo {
                name: row.get(0),
                data_type: row.get(1),
                is_nullable: is_nullable == "YES",
                ordinal_position: row.get(3),
                column_default: row.get(4),
                is_primary_key: row.get(5),
            }
        })
        .collect();

    Ok(columns)
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
            if count < 0 { 0 } else { count }
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

    let order_clause = if let Some(col) = sort_column {
        let safe_col = sanitize_identifier(col);
        let dir = match sort_direction {
            Some(d) if d.to_uppercase() == "DESC" => "DESC",
            _ => "ASC",
        };
        format!("ORDER BY \"{}\" {} NULLS LAST", safe_col, dir)
    } else {
        // Default: newest first when a creation-time column exists
        match get_columns(pool, schema, table).await {
            Ok(columns) => columns
                .iter()
                .find(|c| {
                    let lower = c.name.to_lowercase();
                    matches!(
                        lower.as_str(),
                        "created_at" | "createdat" | "create_date" | "creation_date" | "date_created" | "created"
                    )
                })
                .map(|c| format!("ORDER BY \"{}\" DESC NULLS LAST", sanitize_identifier(&c.name)))
                .unwrap_or_default(),
            _ => String::new(),
        }
    };

    let offset = (page.saturating_sub(1)) * page_size;
    let query = format!(
        "SELECT * FROM \"{}\".\"{}\" {} LIMIT {} OFFSET {}",
        safe_schema, safe_table, order_clause, page_size, offset
    );

    let rows = client
        .query(&query, &[])
        .await
        .map_err(|e| format!("Query error: {}", e))?;

    let columns: Vec<ResultColumn> = if !rows.is_empty() {
        rows[0]
            .columns()
            .iter()
            .map(|col| ResultColumn {
                name: col.name().to_string(),
                data_type: pg_type_to_string(col.type_()),
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
        total_rows: Some(total_rows),
        execution_time_ms: elapsed,
        page: Some(page),
        page_size: Some(page_size),
        query,
        is_error: false,
        error_message: None,
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// Query execution
// ──────────────────────────────────────────────────────────────────────────────

/// Format a database error for display. Uses Debug to get full PostgreSQL
/// message, detail, hint, and code when Display only shows a short "db error".
fn format_query_error(e: &(impl std::fmt::Display + std::fmt::Debug)) -> String {
    let display = e.to_string();
    let debug = format!("{:?}", e);
    if display.is_empty() || display == "db error" || display.len() < 20 {
        debug
    } else if debug.len() > display.len() && debug.contains(&display) {
        format!("{}\n\n[Debug]\n{}", display, debug)
    } else {
        display
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
            if let Ok(n) = std::str::from_utf8(&bytes[start..end]).unwrap_or("0").parse::<usize>() {
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

pub async fn execute_query(pool: &Arc<Pool>, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let trimmed = sql.trim();
    let upper = trimmed.to_uppercase();
    let is_select = upper.starts_with("SELECT")
        || upper.starts_with("WITH")
        || upper.starts_with("TABLE")
        || upper.starts_with("VALUES")
        || upper.starts_with("SHOW")
        || upper.starts_with("EXPLAIN");

    // Bind parameters: if SQL contains $1, $2, ... use NULL for each so the query runs.
    let param_count = max_parameter_index(trimmed);
    let params: Vec<Option<String>> = (0..param_count).map(|_| None).collect();
    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
        .iter()
        .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    let param_slice: &[&(dyn tokio_postgres::types::ToSql + Sync)] = param_refs.as_slice();

    if is_select {
        match client.query(trimmed, param_slice).await {
            Ok(rows) => {
                let columns: Vec<ResultColumn> = if !rows.is_empty() {
                    rows[0]
                        .columns()
                        .iter()
                        .map(|col| ResultColumn {
                            name: col.name().to_string(),
                            data_type: pg_type_to_string(col.type_()),
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
                    query: trimmed.to_string(),
                    is_error: false,
                    error_message: None,
                })
            }
            Err(e) => {
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                Ok(QueryResult {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    row_count: 0,
                    total_rows: None,
                    execution_time_ms: elapsed,
                    page: None,
                    page_size: None,
                    query: trimmed.to_string(),
                    is_error: true,
                    error_message: Some(format_query_error(&e)),
                })
            }
        }
    } else {
        match client.execute(trimmed, param_slice).await {
            Ok(affected) => {
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                Ok(QueryResult {
                    columns: vec![ResultColumn {
                        name: "affected_rows".to_string(),
                        data_type: "bigint".to_string(),
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
                })
            }
            Err(e) => {
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                Ok(QueryResult {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    row_count: 0,
                    total_rows: None,
                    execution_time_ms: elapsed,
                    page: None,
                    page_size: None,
                    query: trimmed.to_string(),
                    is_error: true,
                    error_message: Some(format_query_error(&e)),
                })
            }
        }
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

// ──────────────────────────────────────────────────────────────────────────────
// Table row update / delete (for data grid edit)
// ──────────────────────────────────────────────────────────────────────────────

/// Map information_schema data_type to a safe PostgreSQL cast type for bind params.
fn pg_cast_type(data_type: &str) -> &'static str {
    match data_type.to_lowercase().as_str() {
        "smallint" | "int2" => "smallint",
        "integer" | "int4" => "integer",
        "bigint" | "int8" => "bigint",
        "real" | "float4" => "real",
        "double precision" | "float8" => "double precision",
        "numeric" | "decimal" => "numeric",
        "boolean" | "bool" => "boolean",
        "text" | "character varying" | "varchar" | "character" | "char" | "bpchar" => "text",
        "uuid" => "uuid",
        "date" => "date",
        "time without time zone" | "time" => "time",
        "timestamp without time zone" | "timestamp" => "timestamp",
        "timestamp with time zone" | "timestamptz" => "timestamptz",
        "json" | "jsonb" => "jsonb",
        _ => "text",
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
            let cast = pg_cast_type(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
            format!("\"{}\" = ${}::{}", safe_col, i + 1, cast)
        })
        .collect();
    let set_clause = set_parts.join(", ");

    let where_parts: Vec<String> = pk_columns
        .iter()
        .enumerate()
        .map(|(i, col)| {
            let safe_col = sanitize_identifier(col);
            let param_idx = updates.len() + i + 1;
            let cast = pg_cast_type(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
            format!("\"{}\" = ${}::{}", safe_col, param_idx, cast)
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

/// Insert one table row. `values`: (column, value); None means NULL. Columns not in `values` are omitted (DEFAULT).
/// Returns number of rows affected (1 on success).
pub async fn insert_table_row(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    values: &[(String, Option<String>)],
) -> Result<u64, String> {
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
            let cast = pg_cast_type(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
            format!("${}::{}", i + 1, cast)
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
        .map_err(|e| format!("Insert error: {}", e))?;
    Ok(count)
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
                    let cast = pg_cast_type(col_type_map.get(col).map(|s| s.as_str()).unwrap_or("text"));
                    format!("${}::{}", param_idx, cast)
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

    let params: Vec<Option<String>> = rows_pk_values.iter().flat_map(|r| r.iter().cloned()).collect();
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
            "SELECT * FROM \"{}\".\"{}\" WHERE \"{}\" {} LIMIT {}",
            safe_schema, safe_table, safe_col, safe_op, limit
        )
    } else {
        format!(
            "SELECT * FROM \"{}\".\"{}\" WHERE \"{}\" {} $1 LIMIT {}",
            safe_schema, safe_table, safe_col, safe_op, limit
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

    let columns: Vec<ResultColumn> = if !rows.is_empty() {
        rows[0]
            .columns()
            .iter()
            .map(|col| ResultColumn {
                name: col.name().to_string(),
                data_type: pg_type_to_string(col.type_()),
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

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    // Columns
    let col_rows = client
        .query(
            "SELECT c.column_name, c.data_type, c.is_nullable = 'YES', c.ordinal_position::int,
                    c.column_default,
                    EXISTS (
                        SELECT 1 FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage kcu
                            ON kcu.constraint_name = tc.constraint_name
                            AND kcu.table_schema = tc.table_schema
                            AND kcu.table_name = tc.table_name
                        WHERE tc.constraint_type = 'PRIMARY KEY'
                          AND tc.table_schema = c.table_schema
                          AND tc.table_name = c.table_name
                          AND kcu.column_name = c.column_name
                    ) AS is_primary_key
             FROM information_schema.columns c
             WHERE c.table_schema = $1 AND c.table_name = $2
             ORDER BY c.ordinal_position",
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
                foreign_columns: if foreign_cols.is_empty() { None } else { Some(foreign_cols) },
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
                    pg_get_indexdef(ix.indexrelid) AS definition
             FROM pg_index ix
             JOIN pg_class t  ON t.oid = ix.indrelid
             JOIN pg_class i  ON i.oid = ix.indexrelid
             JOIN pg_am    am ON am.oid = i.relam
             JOIN pg_namespace n ON n.oid = t.relnamespace
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
            columns: row
                .try_get::<_, Vec<String>>(4)
                .unwrap_or_default(),
            definition: row.get(5),
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
            (0i64, "0 bytes".to_string(), "0 bytes".to_string(), "0 bytes".to_string(), None, "r".to_string())
        };

    let table_type = match rel_kind.as_str() {
        "v" | "m" => "VIEW",
        _ => "BASE TABLE",
    }.to_string();

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
    client.execute(&sql, &[]).await.map_err(|e| format!("Rename table error: {}", e))?;
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
    client.execute(&sql, &[]).await.map_err(|e| format!("Rename column error: {}", e))?;
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
        safe_schema, safe_table, parts.join(", ")
    );
    client.execute(&sql, &[]).await.map_err(|e| format!("Alter column error: {}", e))?;
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
    client.execute(&sql, &[]).await.map_err(|e| format!("Add column error: {}", e))?;
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
    client.execute(&sql, &[]).await.map_err(|e| format!("Drop column error: {}", e))?;
    Ok(())
}

pub async fn truncate_table(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);
    let sql = format!("TRUNCATE TABLE \"{}\".\"{}\" RESTART IDENTITY CASCADE", safe_schema, safe_table);
    client.execute(&sql, &[]).await.map_err(|e| format!("Truncate error: {}", e))?;
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
    let sql = format!("DROP TABLE IF EXISTS \"{}\".\"{}\"{}",  safe_schema, safe_table, cascade_clause);
    client.execute(&sql, &[]).await.map_err(|e| format!("Drop table error: {}", e))?;
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
                let safe_len: String = len.chars().filter(|c| c.is_ascii_digit() || *c == ',').collect();
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

    const VALID_OPS: &[&str] = &[
        "=", "!=", "<>", ">", "<", ">=", "<=",
        "LIKE", "NOT LIKE", "ILIKE", "NOT ILIKE",
        "IS NULL", "IS NOT NULL",
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
            let safe_dir = if sort_direction.to_uppercase() == "DESC" { "DESC" } else { "ASC" };
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
        "SELECT * FROM \"{}\".\"{}\" {} {} LIMIT {} OFFSET {}",
        safe_schema, safe_table, where_clause, order_clause, limit, offset
    );

    // Use prepare to get column metadata even for empty result sets
    let stmt = client
        .prepare(&data_sql)
        .await
        .map_err(|e| format!("Prepare error: {}", e))?;

    let columns: Vec<ResultColumn> = stmt
        .columns()
        .iter()
        .map(|col| ResultColumn {
            name: col.name().to_string(),
            data_type: pg_type_to_string(col.type_()),
        })
        .collect();

    let rows = client
        .query(&stmt, &[])
        .await
        .map_err(|e| format!("Query error: {}", e))?;

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

/// Get all indexes for a schema with live usage stats from pg_stat_user_indexes.
pub async fn get_indexes_with_stats(
    pool: &Pool,
    schema: &str,
) -> Result<Vec<super::types::IndexStats>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;

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
            if query.len() > 500 { &query[..500] } else { &query }
        );

        let explain_result = client.query_opt(&explain_sql, &[]).await;
        let has_seq_scan = match explain_result {
            Ok(Some(explain_row)) => {
                let plan_json: serde_json::Value = explain_row.try_get(0).unwrap_or(serde_json::Value::Null);
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

/// Simple identifier quoting for SQL safety
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
