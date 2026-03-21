//! Session monitor, schema topology, and rich table metadata (parity with Tauri `queries.rs`).

use crate::types::{
    ColumnInfo, PgSession, TableConstraint, TableDetails, TableIndex, TableTriggerInfo,
    TopologyColumn, TopologyData, TopologyEdge, TopologyNode,
};
use deadpool_postgres::Pool;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tokio_postgres::Row;
use tracing::warn;

pub async fn get_sessions(pool: &Pool) -> Result<Vec<PgSession>, String> {
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

            PgSession {
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

pub async fn terminate_backend(pool: &Pool, pid: i32) -> Result<bool, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let row = client
        .query_one("SELECT pg_terminate_backend($1::int)", &[&pid])
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.get::<_, bool>(0))
}

pub async fn cancel_backend(pool: &Pool, pid: i32) -> Result<bool, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let row = client
        .query_one("SELECT pg_cancel_backend($1::int)", &[&pid])
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.get::<_, bool>(0))
}

pub async fn get_schema_topology(pool: &Pool, schema: &str) -> Result<TopologyData, String> {
    const TIMEOUT: Duration = Duration::from_secs(15);
    let started_at = Instant::now();

    let result = tokio::time::timeout(TIMEOUT, async {
        let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

        let (table_rows, col_rows, pk_rows, fk_rows) = tokio::try_join!(
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

        let mut pk_set: HashSet<(String, String)> = HashSet::new();
        for row in &pk_rows {
            let t: String = row.get(0);
            let c: String = row.get(1);
            pk_set.insert((t, c));
        }

        let mut columns_by_table: HashMap<(String, String), Vec<TopologyColumn>> = HashMap::new();
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
        Ok(Ok(data)) => Ok(data),
        Ok(Err(err)) => {
            warn!(
                target: "topology",
                schema = %schema,
                elapsed_ms = started_at.elapsed().as_millis(),
                error = %err,
                "schema_topology error"
            );
            Err(err)
        }
        Err(_) => {
            warn!(
                target: "topology",
                schema = %schema,
                elapsed_ms = started_at.elapsed().as_millis(),
                "schema_topology timeout"
            );
            Err(
                "Topology query timed out after 15 seconds. The database may be slow or unreachable."
                    .to_string(),
            )
        }
    }
}

pub async fn get_columns(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
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

    Ok(rows
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
        .collect())
}

fn map_constraint_rows(con_rows: &[Row]) -> Vec<TableConstraint> {
    con_rows
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
        .collect()
}

pub async fn get_table_details(
    pool: &Pool,
    schema: &str,
    table: &str,
) -> Result<TableDetails, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

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

    let constraints = map_constraint_rows(&con_rows);

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
