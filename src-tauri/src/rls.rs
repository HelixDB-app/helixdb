//! Row-level security matrix data and safe role impersonation probes (BEGIN / SET LOCAL / ROLLBACK).

use deadpool::managed::{PoolError, TimeoutType};
use deadpool_postgres::Pool;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::types::Type;
use tokio_postgres::{Error as PgError, Row};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRow {
    pub schemaname: String,
    pub tablename: String,
    pub policyname: String,
    pub roles: Vec<String>,
    pub cmd: String,
    pub permissive: String,
    pub qual: Option<String>,
    pub with_check: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRow {
    pub rolname: String,
    pub rolsuper: bool,
    pub rolinherit: bool,
    pub rolcanlogin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RlsMatrixData {
    pub policies: Vec<PolicyRow>,
    pub roles: Vec<RoleRow>,
    pub rls_enabled_tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImpersonationResult {
    pub success: bool,
    pub row_count: i64,
    pub rows: Vec<Value>,
    pub error: Option<String>,
    pub role_used: String,
    pub sql_executed: String,
}

/// Allow only unquoted PostgreSQL identifiers `[a-zA-Z0-9_]+` (non-empty).
pub fn validate_pg_identifier(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("Identifier must not be empty".to_string());
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(format!(
            "Invalid PostgreSQL identifier (use only letters, digits, underscore): {}",
            s
        ));
    }
    Ok(())
}

/// Rich Postgres error text (avoids useless `db error` from `Display` alone).
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
    let top = e.to_string();
    if top.is_empty() || top == "db error" {
        if let Some(src) = std::error::Error::source(e) {
            return format!("{}\n\nUnderlying: {}", top, src);
        }
    }
    top
}

fn format_pool_err(e: PoolError<PgError>) -> String {
    match e {
        PoolError::Backend(pg) => format_pg_error(&pg),
        PoolError::Timeout(TimeoutType::Wait) => {
            "Timed out waiting for a free database connection from the pool.".to_string()
        }
        PoolError::Timeout(TimeoutType::Create) => {
            "Timed out while opening a new database connection.".to_string()
        }
        PoolError::Timeout(TimeoutType::Recycle) => {
            "Timed out while recycling a pooled database connection.".to_string()
        }
        PoolError::Closed => "The database connection pool has been closed.".to_string(),
        PoolError::NoRuntimeSpecified => {
            "Database pool misconfiguration: no async runtime.".to_string()
        }
        PoolError::PostCreateHook(he) => format!("Connection hook failed: {}", he),
    }
}

/// Custom probe SQL must be a single read-only statement (SELECT / WITH).
fn validate_readonly_probe_sql(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("SQL must not be empty".to_string());
    }
    let single = trimmed.trim_end_matches(';').trim();
    if single.contains(';') {
        return Err("Only a single SQL statement is allowed (no semicolons in the middle)"
            .to_string());
    }
    let lower = single.to_ascii_lowercase();
    if !(lower.starts_with("select") || lower.starts_with("with")) {
        return Err("Custom probe SQL must start with SELECT or WITH".to_string());
    }
    Ok(single.to_string())
}

fn cell_to_json(row: &Row, idx: usize, pg_type: &Type) -> Value {
    match pg_type {
        &Type::BOOL => match row.try_get::<_, Option<bool>>(idx) {
            Ok(Some(v)) => json!(v),
            _ => Value::Null,
        },
        &Type::INT2 => match row.try_get::<_, Option<i16>>(idx) {
            Ok(Some(v)) => json!(v),
            _ => Value::Null,
        },
        &Type::INT4 => match row.try_get::<_, Option<i32>>(idx) {
            Ok(Some(v)) => json!(v),
            _ => Value::Null,
        },
        &Type::INT8 => match row.try_get::<_, Option<i64>>(idx) {
            Ok(Some(v)) => json!(v),
            _ => Value::Null,
        },
        &Type::FLOAT4 => match row.try_get::<_, Option<f32>>(idx) {
            Ok(Some(v)) => serde_json::Number::from_f64(v as f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => Value::Null,
        },
        &Type::FLOAT8 => match row.try_get::<_, Option<f64>>(idx) {
            Ok(Some(v)) => serde_json::Number::from_f64(v)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => Value::Null,
        },
        &Type::NUMERIC => match row.try_get::<_, Option<Decimal>>(idx) {
            Ok(Some(d)) => Value::String(d.to_string()),
            _ => Value::Null,
        },
        &Type::TEXT | &Type::VARCHAR | &Type::BPCHAR | &Type::NAME => {
            match row.try_get::<_, Option<String>>(idx) {
                Ok(Some(v)) => Value::String(v),
                _ => Value::Null,
            }
        }
        &Type::UUID => match row.try_get::<_, Option<uuid::Uuid>>(idx) {
            Ok(Some(v)) => Value::String(v.to_string()),
            _ => Value::Null,
        },
        &Type::JSON | &Type::JSONB => match row.try_get::<_, Option<Value>>(idx) {
            Ok(Some(v)) => v,
            _ => Value::Null,
        },
        &Type::TIMESTAMP => match row.try_get::<_, Option<chrono::NaiveDateTime>>(idx) {
            Ok(Some(v)) => Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
            _ => Value::Null,
        },
        &Type::TIMESTAMPTZ => match row.try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(idx) {
            Ok(Some(v)) => Value::String(v.to_rfc3339()),
            _ => Value::Null,
        },
        &Type::DATE => match row.try_get::<_, Option<chrono::NaiveDate>>(idx) {
            Ok(Some(v)) => Value::String(v.format("%Y-%m-%d").to_string()),
            _ => Value::Null,
        },
        &Type::TIME => match row.try_get::<_, Option<chrono::NaiveTime>>(idx) {
            Ok(Some(v)) => Value::String(v.format("%H:%M:%S%.f").to_string()),
            _ => Value::Null,
        },
        &Type::BYTEA => match row.try_get::<_, Option<Vec<u8>>>(idx) {
            Ok(Some(v)) => Value::String(format!(
                "\\x{}",
                v.iter().map(|b| format!("{:02x}", b)).collect::<String>()
            )),
            _ => Value::Null,
        },
        &Type::OID => match row.try_get::<_, Option<u32>>(idx) {
            Ok(Some(v)) => json!(v),
            _ => Value::Null,
        },
        _ => match row.try_get::<_, Option<String>>(idx) {
            Ok(Some(v)) => Value::String(v),
            _ => Value::Null,
        },
    }
}

fn pg_row_to_json_object(row: &Row) -> Value {
    let mut map = Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        let name = col.name().to_string();
        let v = cell_to_json(row, i, col.type_());
        map.insert(name, v);
    }
    Value::Object(map)
}

pub async fn load_rls_matrix(pool: &Arc<Pool>, schema: &str) -> Result<RlsMatrixData, String> {
    validate_pg_identifier(schema)?;

    let client = pool.get().await.map_err(format_pool_err)?;

    let policy_rows = client
        .query(
            r#"
            SELECT p.schemaname, p.tablename, p.policyname,
                   COALESCE(
                       ARRAY(
                           SELECT x::text
                           FROM unnest(COALESCE(p.roles, ARRAY[]::name[])) AS u(x)
                       ),
                       ARRAY[]::text[]
                   ) AS roles,
                   p.cmd::text AS cmd,
                   CASE WHEN p.permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
                   p.qual, p.with_check
            FROM pg_catalog.pg_policies p
            WHERE p.schemaname = $1
            ORDER BY p.tablename, p.policyname
            "#,
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error(&e))?;

    let mut policies = Vec::with_capacity(policy_rows.len());
    for row in policy_rows {
        let roles: Vec<String> = row.try_get(3).unwrap_or_default();
        policies.push(PolicyRow {
            schemaname: row.get(0),
            tablename: row.get(1),
            policyname: row.get(2),
            roles,
            cmd: row.get(4),
            permissive: row.get(5),
            qual: row.get(6),
            with_check: row.get(7),
        });
    }

    let role_rows = client
        .query(
            r#"
            SELECT rolname, rolsuper, rolinherit, rolcanlogin
            FROM pg_catalog.pg_roles
            WHERE rolname NOT LIKE 'pg_%'
              AND rolname NOT IN ('postgres', 'rdsadmin', 'cloudsqlsuperuser')
            ORDER BY rolname
            "#,
            &[],
        )
        .await
        .map_err(|e| format_pg_error(&e))?;

    let mut roles = Vec::with_capacity(role_rows.len());
    for row in role_rows {
        roles.push(RoleRow {
            rolname: row.get(0),
            rolsuper: row.get(1),
            rolinherit: row.get(2),
            rolcanlogin: row.get(3),
        });
    }

    let rls_rows = client
        .query(
            r#"
            SELECT c.relname
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1
              AND c.relkind IN ('r', 'p')
              AND c.relrowsecurity = true
            ORDER BY c.relname
            "#,
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error(&e))?;

    let rls_enabled_tables: Vec<String> = rls_rows.into_iter().map(|r| r.get(0)).collect();

    Ok(RlsMatrixData {
        policies,
        roles,
        rls_enabled_tables,
    })
}

pub async fn run_impersonation_probe(
    pool: &Arc<Pool>,
    role: &str,
    schema: &str,
    table: &str,
    custom_sql: Option<&str>,
) -> Result<ImpersonationResult, String> {
    validate_pg_identifier(role)?;
    validate_pg_identifier(schema)?;
    validate_pg_identifier(table)?;

    let default_sql = format!(
        r#"SELECT * FROM "{}"."{}" LIMIT 20"#,
        schema, table
    );

    let sql_executed = match custom_sql {
        None => default_sql,
        Some(cs) => {
            let t = cs.trim();
            if t.is_empty() {
                default_sql
            } else {
                validate_readonly_probe_sql(t)?
            }
        }
    };

    let role_used = role.to_string();
    let client = pool.get().await.map_err(format_pool_err)?;

    if let Err(e) = client.execute("BEGIN", &[]).await {
        return Ok(ImpersonationResult {
            success: false,
            row_count: 0,
            rows: vec![],
            error: Some(format_pg_error(&e)),
            role_used,
            sql_executed,
        });
    }

    let set_role_stmt = format!(r#"SET LOCAL ROLE "{}""#, role);
    let probe_outcome = async {
        client
            .execute(&set_role_stmt, &[])
            .await
            .map_err(|e| format_pg_error(&e))?;
        client
            .execute("SET LOCAL row_security = on", &[])
            .await
            .map_err(|e| format_pg_error(&e))?;
        let rows = client
            .query(&sql_executed, &[])
            .await
            .map_err(|e| format_pg_error(&e))?;
        Ok::<_, String>(rows)
    }
    .await;

    let _ = client.execute("ROLLBACK", &[]).await;

    match probe_outcome {
        Ok(rows) => {
            let json_rows: Vec<Value> = rows.iter().map(|r| pg_row_to_json_object(r)).collect();
            let row_count = json_rows.len() as i64;
            Ok(ImpersonationResult {
                success: true,
                row_count,
                rows: json_rows,
                error: None,
                role_used,
                sql_executed,
            })
        }
        Err(msg) => Ok(ImpersonationResult {
            success: false,
            row_count: 0,
            rows: vec![],
            error: Some(msg),
            role_used,
            sql_executed,
        }),
    }
}
