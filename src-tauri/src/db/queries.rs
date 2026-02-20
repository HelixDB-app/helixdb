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

    let oid: u32 = type_row.get(0);
    let typtype: String = type_row.get(1);
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
        String::new()
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

    if is_select {
        match client.query(trimmed, &[]).await {
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
                    error_message: Some(e.to_string()),
                })
            }
        }
    } else {
        match client.execute(trimmed, &[]).await {
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
                    error_message: Some(e.to_string()),
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
// Utilities
// ──────────────────────────────────────────────────────────────────────────────

/// Sanitize a SQL identifier to prevent injection in format!() queries.
fn sanitize_identifier(name: &str) -> String {
    name.replace('"', "\"\"")
        .replace('\'', "")
        .replace(';', "")
        .replace("--", "")
}
