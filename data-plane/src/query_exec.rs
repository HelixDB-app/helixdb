//! Port of `execute_query` semantics from `src-tauri/src/db/queries.rs` (subset + parity focus).

use crate::types::{CellValue, QueryResult, ResultColumn};
use deadpool_postgres::Pool;
use rust_decimal::Decimal;
use std::sync::Arc;
use std::time::Instant;
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::types::Type;
use tokio_postgres::{Error as PgError, Row};

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
        if let Some(w) = db.where_() {
            s.push_str("\n\nCONTEXT:\n");
            s.push_str(w);
        }
        match db.position() {
            Some(ErrorPosition::Original(pos)) => {
                s.push_str("\n\nPosition: character ");
                s.push_str(&pos.to_string());
            }
            Some(ErrorPosition::Internal { position, query }) => {
                s.push_str("\n\nQUERY:\n");
                s.push_str(query);
                s.push_str("\n\nPosition: character ");
                s.push_str(&position.to_string());
            }
            None => {}
        }
        s.push_str("\n\nSQL state: ");
        s.push_str(db.code().code());
        return s;
    }
    e.to_string()
}

pub(crate) fn row_to_cells(row: &Row) -> Vec<CellValue> {
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
        &Type::INTERVAL => match row.try_get::<_, Option<String>>(idx) {
            Ok(Some(v)) => CellValue::String(v),
            _ => CellValue::Null,
        },
        _ => match row.try_get::<_, Option<String>>(idx) {
            Ok(Some(v)) => CellValue::String(v),
            _ => CellValue::Null,
        },
    }
}

pub(crate) fn pg_type_to_string(pg_type: &Type) -> String {
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

fn strip_leading_comments_and_whitespace(mut sql: &str) -> &str {
    loop {
        let s = sql.trim_start();
        if s.starts_with("--") {
            if let Some(idx) = s.find('\n') {
                sql = &s[idx + 1..];
                continue;
            }
            return "";
        }
        if s.starts_with("/*") {
            if let Some(end) = s.find("*/") {
                sql = &s[end + 2..];
                continue;
            }
            return "";
        }
        return s;
    }
}

/// Split SQL into statements by `;`, ignoring semicolons inside comments,
/// quoted strings, and dollar-quoted bodies (aligned with src-tauri).
fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();

    while i < n {
        let c = chars[i];

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

        if c == '$' && i + 1 < n {
            i += 1;
            let mut tag = String::new();
            while i < n && chars[i] != '$' {
                tag.push(chars[i]);
                i += 1;
            }
            if i < n {
                i += 1;
                let tag_len = tag.chars().count();
                let delim_len = tag_len + 2;
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

fn max_parameter_index(sql: &str) -> usize {
    let mut max_n = 0usize;
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'$' && bytes[i + 1].is_ascii_digit() {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if let Ok(n) = sql[start..j].parse::<usize>() {
                max_n = max_n.max(n);
            }
            i = j;
            continue;
        }
        i += 1;
    }
    max_n
}

pub async fn execute_query(pool: &Arc<Pool>, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let mut client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let trimmed = sql.trim();
    let statements = split_sql_statements(trimmed);

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
        let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            params.iter().map(|p| p as _).collect();
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
        } else if let Err(e) = txn.execute(stmt_trim, &[]).await {
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
