use dashmap::DashMap;
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio_postgres::types::Type;
use tokio_postgres::{Client, NoTls, Row};

// ─── Public types ─────────────────────────────────────────────────────────────

/// One row of the before/after diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxDiffRow {
    /// Column values before the DML (None = row was inserted)
    pub before: Option<Vec<Option<String>>>,
    /// Column values after the DML (None = row was deleted)
    pub after: Option<Vec<Option<String>>>,
}

/// Full result from executing a DML statement inside the sandbox transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxResult {
    pub rows_affected: i64,
    pub diff_rows: Vec<SandboxDiffRow>,
    /// Column names that apply to both before and after
    pub columns: Vec<String>,
    pub query_type: String,
    pub warnings: Vec<String>,
    pub missing_where: bool,
    /// For SELECT queries only
    pub select_columns: Vec<String>,
    pub select_rows: Vec<Vec<Option<String>>>,
}

// ─── Session ──────────────────────────────────────────────────────────────────

struct SandboxSession {
    client: Client,
}

// ─── Manager ──────────────────────────────────────────────────────────────────

pub struct SandboxManager {
    sessions: DashMap<String, Arc<Mutex<SandboxSession>>>,
    started_at: DashMap<String, Instant>,
}

impl SandboxManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            started_at: DashMap::new(),
        }
    }

    /// Open a dedicated connection, send BEGIN, and store the session.
    pub async fn begin(&self, sandbox_id: &str, conn_str: &str) -> Result<(), String> {
        let client = connect_client(conn_str).await?;
        client
            .execute("BEGIN", &[])
            .await
            .map_err(|e| format!("BEGIN failed: {e}"))?;

        self.sessions.insert(
            sandbox_id.to_string(),
            Arc::new(Mutex::new(SandboxSession { client })),
        );
        self.started_at
            .insert(sandbox_id.to_string(), Instant::now());
        Ok(())
    }

    /// Execute SQL inside the open transaction and return the diff.
    pub async fn execute(&self, sandbox_id: &str, sql: &str) -> Result<SandboxResult, String> {
        let arc = self
            .sessions
            .get(sandbox_id)
            .map(|e| e.value().clone())
            .ok_or_else(|| "Sandbox session not found. Start sandbox mode first.".to_string())?;

        let mut session = arc.lock().await;
        execute_in_sandbox(&mut session.client, sql).await
    }

    /// COMMIT the transaction and drop the session.
    pub async fn commit(&self, sandbox_id: &str) -> Result<(), String> {
        let arc = self
            .sessions
            .remove(sandbox_id)
            .map(|(_, v)| v)
            .ok_or_else(|| "Sandbox session not found".to_string())?;
        self.started_at.remove(sandbox_id);
        let session = arc.lock().await;
        session
            .client
            .execute("COMMIT", &[])
            .await
            .map_err(|e| format!("COMMIT failed: {e}"))?;
        Ok(())
    }

    /// ROLLBACK the transaction and drop the session.
    pub async fn rollback(&self, sandbox_id: &str) -> Result<(), String> {
        let arc = self
            .sessions
            .remove(sandbox_id)
            .map(|(_, v)| v)
            .ok_or_else(|| "Sandbox session not found".to_string())?;
        self.started_at.remove(sandbox_id);
        let session = arc.lock().await;
        let _ = session.client.execute("ROLLBACK", &[]).await;
        Ok(())
    }

    pub fn has_session(&self, sandbox_id: &str) -> bool {
        self.sessions.contains_key(sandbox_id)
    }

    /// Seconds elapsed since the sandbox was opened.
    pub fn elapsed_secs(&self, sandbox_id: &str) -> u64 {
        self.started_at
            .get(sandbox_id)
            .map(|e| e.value().elapsed().as_secs())
            .unwrap_or(0)
    }
}

// ─── Connection helpers ───────────────────────────────────────────────────────

async fn connect_client(conn_str: &str) -> Result<Client, String> {
    // Try TLS first, fall back to plaintext
    let tls_result: Result<Client, String> = async {
        let tls = TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;
        let connector = MakeTlsConnector::new(tls);
        let (client, conn) = tokio_postgres::connect(conn_str, connector)
            .await
            .map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(client)
    }
    .await;

    match tls_result {
        Ok(c) => Ok(c),
        Err(_) => {
            let (client, conn) = tokio_postgres::connect(conn_str, NoTls)
                .await
                .map_err(|e| format!("Sandbox connection failed: {e}"))?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            Ok(client)
        }
    }
}

// ─── Core execution logic ─────────────────────────────────────────────────────

/// Split SQL by semicolons, ignoring semicolons inside string literals.
fn split_statements(sql: &str) -> Vec<String> {
    let mut stmts = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut prev = '\0';

    for ch in sql.chars() {
        match ch {
            '\'' if !in_double && prev != '\\' => {
                in_single = !in_single;
                current.push(ch);
            }
            '"' if !in_single && prev != '\\' => {
                in_double = !in_double;
                current.push(ch);
            }
            ';' if !in_single && !in_double => {
                let s = current.trim().to_string();
                if !s.is_empty() {
                    stmts.push(s);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
        prev = ch;
    }
    let s = current.trim().to_string();
    if !s.is_empty() {
        stmts.push(s);
    }
    stmts
}

async fn execute_in_sandbox(client: &mut Client, sql: &str) -> Result<SandboxResult, String> {
    let stmts = split_statements(sql);

    if stmts.len() > 1 {
        return execute_multi_statements(client, stmts).await;
    }

    let trimmed = if stmts.is_empty() {
        return Err("Empty SQL — nothing to execute.".to_string());
    } else {
        stmts.into_iter().next().unwrap()
    };

    execute_single_statement(client, &trimmed).await
}

async fn execute_multi_statements(
    client: &mut Client,
    stmts: Vec<String>,
) -> Result<SandboxResult, String> {
    let mut combined_affected: i64 = 0;
    let mut all_diffs: Vec<SandboxDiffRow> = Vec::new();
    let mut last_columns: Vec<String> = Vec::new();
    let mut last_query_type = String::from("OTHER");
    let mut all_warnings: Vec<String> = Vec::new();
    let mut any_missing_where = false;

    for (i, stmt) in stmts.iter().enumerate() {
        let result = execute_single_statement(client, stmt)
            .await
            .map_err(|e| format!("Statement {} failed: {}", i + 1, e))?;
        combined_affected += result.rows_affected;
        all_diffs.extend(result.diff_rows);
        if !result.columns.is_empty() {
            last_columns = result.columns;
        }
        last_query_type = result.query_type;
        all_warnings.extend(result.warnings);
        if result.missing_where {
            any_missing_where = true;
        }
    }

    Ok(SandboxResult {
        rows_affected: combined_affected,
        diff_rows: all_diffs,
        columns: last_columns,
        query_type: last_query_type,
        warnings: all_warnings,
        missing_where: any_missing_where,
        select_columns: vec![],
        select_rows: vec![],
    })
}

async fn execute_single_statement(client: &mut Client, sql: &str) -> Result<SandboxResult, String> {
    let trimmed = sql.trim().trim_end_matches(';');
    let upper = trimmed.to_uppercase();
    let first_word = upper.split_whitespace().next().unwrap_or("");

    match first_word {
        // ── SELECT / read-only ────────────────────────────────────────────────
        "SELECT" | "WITH" | "SHOW" | "EXPLAIN" | "TABLE" => {
            let rows = client
                .query(trimmed, &[])
                .await
                .map_err(|e| e.to_string())?;
            let columns = col_names_from_rows(&rows);
            let select_rows: Vec<Vec<Option<String>>> =
                rows.iter().map(|r| row_to_strings(r)).collect();
            Ok(SandboxResult {
                rows_affected: select_rows.len() as i64,
                diff_rows: vec![],
                columns: columns.clone(),
                query_type: "SELECT".to_string(),
                warnings: vec![],
                missing_where: false,
                select_columns: columns,
                select_rows,
            })
        }

        // ── INSERT ────────────────────────────────────────────────────────────
        "INSERT" => {
            let insert_sql = if upper.contains(" RETURNING ") {
                trimmed.to_string()
            } else {
                format!("{trimmed} RETURNING *")
            };
            let rows = client
                .query(&insert_sql, &[])
                .await
                .map_err(|e| e.to_string())?;
            let columns = col_names_from_rows(&rows);
            let diff_rows: Vec<SandboxDiffRow> = rows
                .iter()
                .map(|r| SandboxDiffRow {
                    before: None,
                    after: Some(row_to_strings(r)),
                })
                .collect();
            let count = diff_rows.len() as i64;
            Ok(SandboxResult {
                rows_affected: count,
                diff_rows,
                columns,
                query_type: "INSERT".to_string(),
                warnings: vec![],
                missing_where: false,
                select_columns: vec![],
                select_rows: vec![],
            })
        }

        // ── UPDATE ────────────────────────────────────────────────────────────
        "UPDATE" => {
            let missing_where = !upper.contains(" WHERE ");
            let mut warnings = vec![];
            if missing_where {
                warnings
                    .push("No WHERE clause — this will affect ALL rows in the table!".to_string());
            }

            // Capture before-state via SELECT
            let (before_cols, before_rows) = match extract_update_select(trimmed) {
                Some(sel) => match client.query(&sel, &[]).await {
                    Ok(rows) => (
                        col_names_from_rows(&rows),
                        rows.iter().map(row_to_strings).collect::<Vec<_>>(),
                    ),
                    Err(_) => (vec![], vec![]),
                },
                None => (vec![], vec![]),
            };

            // Run UPDATE with RETURNING to get after-state
            let update_sql = if upper.contains(" RETURNING ") {
                trimmed.to_string()
            } else {
                format!("{trimmed} RETURNING *")
            };
            let after_rows_raw = client
                .query(&update_sql, &[])
                .await
                .map_err(|e| e.to_string())?;
            let after_cols = col_names_from_rows(&after_rows_raw);
            let after_data: Vec<Vec<Option<String>>> =
                after_rows_raw.iter().map(row_to_strings).collect();

            let columns = if !after_cols.is_empty() {
                after_cols
            } else {
                before_cols
            };
            let max_rows = before_rows.len().max(after_data.len());
            let diff_rows: Vec<SandboxDiffRow> = (0..max_rows)
                .map(|i| SandboxDiffRow {
                    before: before_rows.get(i).cloned(),
                    after: after_data.get(i).cloned(),
                })
                .collect();

            Ok(SandboxResult {
                rows_affected: after_data.len() as i64,
                diff_rows,
                columns,
                query_type: "UPDATE".to_string(),
                warnings,
                missing_where,
                select_columns: vec![],
                select_rows: vec![],
            })
        }

        // ── DELETE ────────────────────────────────────────────────────────────
        "DELETE" => {
            let missing_where = !upper.contains(" WHERE ");
            let mut warnings = vec![];
            if missing_where {
                warnings.push(
                    "No WHERE clause — this will delete ALL rows from the table!".to_string(),
                );
            }

            // Capture rows about to be deleted
            let (before_cols, before_rows) = match extract_delete_select(trimmed) {
                Some(sel) => match client.query(&sel, &[]).await {
                    Ok(rows) => (
                        col_names_from_rows(&rows),
                        rows.iter().map(row_to_strings).collect::<Vec<_>>(),
                    ),
                    Err(_) => (vec![], vec![]),
                },
                None => (vec![], vec![]),
            };

            let rows_affected = client
                .execute(trimmed, &[])
                .await
                .map_err(|e| e.to_string())? as i64;

            let diff_rows: Vec<SandboxDiffRow> = before_rows
                .iter()
                .map(|row| SandboxDiffRow {
                    before: Some(row.clone()),
                    after: None,
                })
                .collect();

            Ok(SandboxResult {
                rows_affected,
                diff_rows,
                columns: before_cols,
                query_type: "DELETE".to_string(),
                warnings,
                missing_where,
                select_columns: vec![],
                select_rows: vec![],
            })
        }

        // ── TRUNCATE ──────────────────────────────────────────────────────────
        "TRUNCATE" => {
            let count_before = get_truncate_count(client, trimmed).await.unwrap_or(0);
            client
                .execute(trimmed, &[])
                .await
                .map_err(|e| e.to_string())?;
            Ok(SandboxResult {
                rows_affected: count_before,
                diff_rows: vec![],
                columns: vec![],
                query_type: "TRUNCATE".to_string(),
                warnings: vec!["TRUNCATE removes ALL rows from the table!".to_string()],
                missing_where: false,
                select_columns: vec![],
                select_rows: vec![],
            })
        }

        // ── DROP ──────────────────────────────────────────────────────────────
        "DROP" => {
            client
                .execute(trimmed, &[])
                .await
                .map_err(|e| e.to_string())?;
            Ok(SandboxResult {
                rows_affected: 0,
                diff_rows: vec![],
                columns: vec![],
                query_type: "DROP".to_string(),
                warnings: vec![
                    "DROP executed inside sandbox — will be rolled back unless committed."
                        .to_string(),
                ],
                missing_where: false,
                select_columns: vec![],
                select_rows: vec![],
            })
        }

        // ── Generic DDL / other ───────────────────────────────────────────────
        _ => {
            let rows_affected = client
                .execute(trimmed, &[])
                .await
                .map_err(|e| e.to_string())? as i64;
            Ok(SandboxResult {
                rows_affected,
                diff_rows: vec![],
                columns: vec![],
                query_type: first_word.to_string(),
                warnings: vec![],
                missing_where: false,
                select_columns: vec![],
                select_rows: vec![],
            })
        }
    }
}

// ─── SQL transformation helpers ───────────────────────────────────────────────

/// Transform `UPDATE table SET ... WHERE ...` into `SELECT * FROM table WHERE ... LIMIT 100`
fn extract_update_select(sql: &str) -> Option<String> {
    let upper = sql.to_uppercase();

    // Find table name between UPDATE and SET
    let update_end = upper.find("UPDATE")? + 6;
    let set_pos = upper[update_end..].find(" SET ")? + update_end;
    let table_name = sql[update_end..set_pos].trim();
    if table_name.is_empty() {
        return None;
    }

    // Find WHERE clause after SET
    if let Some(rel_where) = upper[set_pos..].find(" WHERE ") {
        let where_start = set_pos + rel_where + 7; // skip " WHERE "
        let where_clause = strip_returning_clause(&sql[where_start..]);
        Some(format!(
            "SELECT * FROM {table_name} WHERE {where_clause} LIMIT 100"
        ))
    } else {
        Some(format!("SELECT * FROM {table_name} LIMIT 100"))
    }
}

/// Transform `DELETE FROM table WHERE ...` into `SELECT * FROM table WHERE ... LIMIT 100`
fn extract_delete_select(sql: &str) -> Option<String> {
    let upper = sql.to_uppercase();

    // Find the table name after FROM
    let from_pos = upper.find("FROM")? + 4;
    let after_from = sql[from_pos..].trim_start();
    let table_end = after_from
        .find(char::is_whitespace)
        .unwrap_or(after_from.len());
    let table_name = after_from[..table_end].trim();
    if table_name.is_empty() {
        return None;
    }

    // Find WHERE
    let abs_table_start = from_pos + (sql[from_pos..].len() - after_from.len());
    if let Some(rel_where) = upper[abs_table_start..].find(" WHERE ") {
        let where_start = abs_table_start + rel_where + 7;
        let where_clause = strip_returning_clause(&sql[where_start..]);
        Some(format!(
            "SELECT * FROM {table_name} WHERE {where_clause} LIMIT 100"
        ))
    } else {
        Some(format!("SELECT * FROM {table_name} LIMIT 100"))
    }
}

/// Remove a trailing `RETURNING ...` from a WHERE clause string.
fn strip_returning_clause(s: &str) -> &str {
    let upper = s.to_uppercase();
    if let Some(pos) = upper.find(" RETURNING ") {
        &s[..pos]
    } else {
        s
    }
}

/// Count rows in the target table of a TRUNCATE statement.
async fn get_truncate_count(client: &Client, truncate_sql: &str) -> Option<i64> {
    let upper = truncate_sql.to_uppercase();
    let after = if upper.starts_with("TRUNCATE TABLE ") {
        &truncate_sql[15..]
    } else if upper.starts_with("TRUNCATE ") {
        &truncate_sql[9..]
    } else {
        return None;
    };
    let table = after.split_whitespace().next()?.trim_end_matches(',');
    let row = client
        .query_one(&format!("SELECT COUNT(*) FROM {table}"), &[])
        .await
        .ok()?;
    row.try_get::<_, i64>(0).ok()
}

// ─── Row-to-string helpers ────────────────────────────────────────────────────

fn col_names_from_rows(rows: &[Row]) -> Vec<String> {
    rows.first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default()
}

fn row_to_strings(row: &Row) -> Vec<Option<String>> {
    (0..row.len()).map(|i| cell_to_string(row, i)).collect()
}

fn cell_to_string(row: &Row, idx: usize) -> Option<String> {
    let ty = row.columns()[idx].type_();
    match ty {
        &Type::BOOL => row
            .try_get::<_, Option<bool>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        &Type::INT2 => row
            .try_get::<_, Option<i16>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        &Type::INT4 => row
            .try_get::<_, Option<i32>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        &Type::INT8 => row
            .try_get::<_, Option<i64>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        &Type::FLOAT4 => row
            .try_get::<_, Option<f32>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        &Type::FLOAT8 => row
            .try_get::<_, Option<f64>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        &Type::NUMERIC => row
            .try_get::<_, Option<Decimal>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        &Type::UUID => row
            .try_get::<_, Option<uuid::Uuid>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        &Type::TIMESTAMP => row
            .try_get::<_, Option<chrono::NaiveDateTime>>(idx)
            .ok()
            .flatten()
            .map(|v| v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        &Type::TIMESTAMPTZ => row
            .try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_rfc3339()),
        &Type::DATE => row
            .try_get::<_, Option<chrono::NaiveDate>>(idx)
            .ok()
            .flatten()
            .map(|v| v.format("%Y-%m-%d").to_string()),
        &Type::TIME => row
            .try_get::<_, Option<chrono::NaiveTime>>(idx)
            .ok()
            .flatten()
            .map(|v| v.format("%H:%M:%S%.f").to_string()),
        &Type::JSON | &Type::JSONB => row
            .try_get::<_, Option<serde_json::Value>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        _ => {
            // Try TEXT / VARCHAR / generic string
            if let Ok(v) = row.try_get::<_, Option<String>>(idx) {
                return v;
            }
            // Try &str
            if let Ok(v) = row.try_get::<_, Option<&str>>(idx) {
                return v.map(|s| s.to_string());
            }
            None
        }
    }
}
