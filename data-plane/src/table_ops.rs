use crate::query_exec::row_to_cells;
use crate::types::{QueryResult, ResultColumn, SchemaInfo, TableInfo};
use deadpool_postgres::Pool;
use std::sync::Arc;
use std::time::Instant;

fn sanitize_identifier(name: &str) -> String {
    name.replace('"', "\"\"")
        .replace('\'', "")
        .replace(';', "")
        .replace("--", "")
}

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

    Ok(rows
        .iter()
        .map(|row| SchemaInfo {
            name: row.get(0),
            table_count: row.get(1),
        })
        .collect())
}

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

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row.get(0),
            schema: row.get(1),
            table_type: row.get(2),
            row_count: row.get(3),
            table_comment: row.get(4),
        })
        .collect())
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

    let (columns, data): (Vec<ResultColumn>, Vec<_>) = if !rows.is_empty() {
        let cols: Vec<ResultColumn> = rows[0]
            .columns()
            .iter()
            .map(|col| ResultColumn {
                name: col.name().to_string(),
                data_type: crate::query_exec::pg_type_to_string(col.type_()),
                enum_labels: None,
            })
            .collect();
        let data = rows.iter().map(|row| row_to_cells(row)).collect();
        (cols, data)
    } else {
        (Vec::new(), Vec::new())
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
