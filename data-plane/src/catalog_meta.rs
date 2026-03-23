//! List databases and schema objects (functions, types) — web parity with Tauri `queries.rs`.

use crate::types::{
    EventTriggerInfo, FunctionInfo, TypeDefinitionDetail, TypeInfo,
};
use deadpool_postgres::Pool;
use std::sync::Arc;

fn quote_ident_enum(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn escape_enum_literal(s: &str) -> String {
    s.replace('\'', "''")
}

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

pub async fn list_functions(
    pool: &Arc<Pool>,
    schema: &str,
    pg_version: u32,
) -> Result<Vec<FunctionInfo>, String> {
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let rows = if pg_version >= 110000 {
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

    Ok(rows
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
        .collect())
}

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

    Ok(rows
        .iter()
        .map(|row| TypeInfo {
            name: row.get(0),
            kind: row.get(1),
        })
        .collect())
}

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

    Ok(rows
        .iter()
        .map(|row| EventTriggerInfo {
            name: row.get(0),
            event: row.get(1),
            enabled: row.get(2),
            function_name: row.get(3),
        })
        .collect())
}

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

pub async fn get_type_definition(
    pool: &Arc<Pool>,
    schema: &str,
    name: &str,
) -> Result<Option<TypeDefinitionDetail>, String> {
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

fn sanitize_identifier(name: &str) -> String {
    name.replace('"', "\"\"")
        .replace('\'', "")
        .replace(';', "")
        .replace("--", "")
}

/// Build and execute CREATE TABLE; returns generated SQL (parity with Tauri `queries::create_table`).
pub async fn create_table(
    pool: &Arc<Pool>,
    schema: &str,
    table: &str,
    columns: &[crate::types::CreateColumnDef],
    if_not_exists: bool,
) -> Result<String, String> {
    if columns.is_empty() {
        return Err("A table must have at least one column.".to_string());
    }

    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;

    let safe_schema = sanitize_identifier(schema);
    let safe_table = sanitize_identifier(table);

    let pk_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| format!("\"{}\"", sanitize_identifier(&c.name)))
        .collect();

    let mut col_defs: Vec<String> = Vec::new();
    let mut table_constraints: Vec<String> = Vec::new();

    for col in columns {
        let safe_name = sanitize_identifier(&col.name);

        let safe_type: String = col
            .data_type
            .chars()
            .filter(|c| c.is_alphanumeric() || " ()[]_,.'".contains(*c))
            .collect();

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

        let pk_inline = if pk_cols.len() == 1 && col.is_primary_key {
            " PRIMARY KEY"
        } else {
            ""
        };

        col_defs.push(format!(
            "  \"{}\" {}{}{}{}",
            safe_name, type_str, null_clause, default_clause, pk_inline
        ));

        if col.is_unique && !(pk_cols.len() == 1 && col.is_primary_key) {
            table_constraints.push(format!("  UNIQUE (\"{}\")", safe_name));
        }

        if let Some(ref chk) = col.check_constraint {
            let trimmed = chk.trim();
            if !trimmed.is_empty() {
                table_constraints.push(format!("  CHECK ({})", trimmed));
            }
        }
    }

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

pub async fn create_database(pool: &Arc<Pool>, name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 63 {
        return Err("Database name must be between 1 and 63 characters".to_string());
    }
    let client = pool.get().await.map_err(|e| format!("Pool error: {}", e))?;
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
