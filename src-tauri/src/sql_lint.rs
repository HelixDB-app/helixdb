use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlLintSchemaContext {
    pub tables: Vec<String>,
    pub columns: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlLintQuickFix {
    pub id: String,
    pub label: String,
    pub start_line_number: usize,
    pub start_column: usize,
    pub end_line_number: usize,
    pub end_column: usize,
    pub replacement: String,
    pub is_preferred: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlLintDiagnostic {
    pub id: String,
    pub rule_id: String,
    pub severity: String,
    pub message: String,
    pub source: String,
    pub start_line_number: usize,
    pub start_column: usize,
    pub end_line_number: usize,
    pub end_column: usize,
    pub quick_fixes: Vec<SqlLintQuickFix>,
}

#[derive(Debug, Clone)]
struct SqlStatement {
    start_offset: usize,
    end_offset: usize,
}

#[derive(Debug, Clone)]
struct LineIndex {
    line_starts: Vec<usize>,
}

impl LineIndex {
    fn new(sql: &str) -> Self {
        let mut starts = Vec::with_capacity(128);
        starts.push(0);
        for (idx, b) in sql.bytes().enumerate() {
            if b == b'\n' {
                starts.push(idx + 1);
            }
        }
        Self { line_starts: starts }
    }

    fn line_col(&self, sql: &str, offset: usize) -> (usize, usize) {
        let clamped = offset.min(sql.len());
        let line_index = match self.line_starts.binary_search(&clamped) {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        };
        let line_start = self.line_starts[line_index];
        let column = sql[line_start..clamped].chars().count() + 1;
        (line_index + 1, column)
    }
}

static SELECT_PROJECTION_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)\bselect\b(?P<projection>.+?)\bfrom\b").expect("valid SELECT projection regex")
});

static FROM_CLAUSE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?is)\bfrom\b(?P<from>.+?)(?:\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\boffset\b|\bunion\b|$)",
    )
    .expect("valid FROM clause regex")
});

static LEFT_JOIN_ALIAS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?is)\bleft\s+(?:outer\s+)?join\s+(?P<table>(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)(?:\s+(?:as\s+)?(?P<alias>[a-z_][a-z0-9_$]*))?\s+on\b"#,
    )
    .expect("valid LEFT JOIN regex")
});

static TABLE_ALIAS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?is)\b(?:from|join)\s+(?P<table>(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)(?:\s+(?:as\s+)?(?P<alias>[a-z_][a-z0-9_$]*))?"#,
    )
    .expect("valid table alias regex")
});

static BARE_IDENTIFIER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b[a-z_][a-z0-9_]*\b").expect("valid identifier regex"));

static STAR_IN_SELECT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(^|,)\s*(?:[a-z_][a-z0-9_]*\.)?\*").expect("valid SELECT * regex")
});

static IMPLICIT_CAST_RIGHT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\b[a-z_][a-z0-9_$.]*\s*(?:=|<>|!=|<=|>=|<|>)\s*(?P<quoted>'(?P<literal>\d+(?:\.\d+)?)')"#,
    )
    .expect("valid implicit cast regex")
});

static IMPLICIT_CAST_LEFT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?P<quoted>'(?P<literal>\d+(?:\.\d+)?)')\s*(?:=|<>|!=|<=|>=|<|>)\s*[a-z_][a-z0-9_$.]*"#,
    )
    .expect("valid implicit cast reverse regex")
});

static CORRELATED_SUBQUERY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?is)\(\s*select\b[\s\S]*?\bwhere\b[\s\S]*?\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*",
    )
    .expect("valid N+1 regex")
});

static WHERE_WORD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bwhere\b").expect("valid WHERE regex"));

static WITH_RESOLVE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(select|insert|update|delete|merge|drop|truncate|alter|create)\b")
        .expect("valid WITH resolver regex")
});

static SQL_KEYWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "select",
        "from",
        "where",
        "join",
        "left",
        "right",
        "inner",
        "full",
        "outer",
        "cross",
        "on",
        "group",
        "order",
        "having",
        "limit",
        "offset",
        "with",
        "as",
        "and",
        "or",
        "not",
        "in",
        "is",
        "null",
        "like",
        "ilike",
        "between",
        "exists",
        "union",
        "all",
        "except",
        "intersect",
        "insert",
        "update",
        "delete",
        "create",
        "drop",
        "alter",
        "truncate",
        "table",
        "into",
        "values",
        "set",
        "distinct",
        "case",
        "when",
        "then",
        "else",
        "end",
        "true",
        "false",
    ]
    .into_iter()
    .collect()
});

#[tauri::command]
pub fn db_lint_sql(
    sql: String,
    schema_context: Option<SqlLintSchemaContext>,
) -> Result<Vec<SqlLintDiagnostic>, String> {
    Ok(run_sql_lint(&sql, schema_context.as_ref()))
}

fn run_sql_lint(sql: &str, schema_context: Option<&SqlLintSchemaContext>) -> Vec<SqlLintDiagnostic> {
    if sql.trim().is_empty() {
        return Vec::new();
    }

    if let Some(ctx) = schema_context {
        let _ = &ctx.tables;
    }

    let statements = split_statements_with_offsets(sql);
    let line_index = LineIndex::new(sql);
    let mut diagnostics = Vec::<SqlLintDiagnostic>::new();

    lint_delimiter_errors(sql, &line_index, &mut diagnostics);

    for statement in &statements {
        lint_missing_where(sql, statement, &line_index, &mut diagnostics);
        lint_select_star(sql, statement, &line_index, &mut diagnostics);
        lint_implicit_cast(sql, statement, &line_index, &mut diagnostics);
        lint_unused_left_join(sql, statement, &line_index, &mut diagnostics);
        lint_deprecated_comma_join(sql, statement, &line_index, &mut diagnostics);
        lint_n_plus_one(sql, statement, &line_index, &mut diagnostics);
        if let Some(schema_ctx) = schema_context {
            lint_ambiguous_columns(sql, statement, schema_ctx, &line_index, &mut diagnostics);
        }
    }

    diagnostics.sort_by(|a, b| {
        severity_rank(&a.severity)
            .cmp(&severity_rank(&b.severity))
            .then(a.start_line_number.cmp(&b.start_line_number))
            .then(a.start_column.cmp(&b.start_column))
            .then(a.message.cmp(&b.message))
    });

    diagnostics
}

fn lint_delimiter_errors(sql: &str, line_index: &LineIndex, diagnostics: &mut Vec<SqlLintDiagnostic>) {
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut single_start: Option<usize> = None;
    let mut double_start: Option<usize> = None;
    let mut dollar_tag: Option<String> = None;
    let mut dollar_start: Option<usize> = None;
    let mut paren_stack: Vec<usize> = Vec::new();

    while i < len {
        let ch = bytes[i];
        let next = if i + 1 < len { bytes[i + 1] } else { 0 };

        if in_line_comment {
            if ch == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }

        if in_block_comment {
            if ch == b'*' && next == b'/' {
                in_block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if let Some(tag) = &dollar_tag {
            if bytes[i..].starts_with(tag.as_bytes()) {
                i += tag.len();
                dollar_tag = None;
                dollar_start = None;
                continue;
            }
            i += 1;
            continue;
        }

        if in_single {
            if ch == b'\'' && next == b'\'' {
                i += 2;
                continue;
            }
            if ch == b'\'' {
                in_single = false;
                single_start = None;
            }
            i += 1;
            continue;
        }

        if in_double {
            if ch == b'"' && next == b'"' {
                i += 2;
                continue;
            }
            if ch == b'"' {
                in_double = false;
                double_start = None;
            }
            i += 1;
            continue;
        }

        if ch == b'-' && next == b'-' {
            in_line_comment = true;
            i += 2;
            continue;
        }

        if ch == b'/' && next == b'*' {
            in_block_comment = true;
            i += 2;
            continue;
        }

        if ch == b'\'' {
            in_single = true;
            single_start = Some(i);
            i += 1;
            continue;
        }

        if ch == b'"' {
            in_double = true;
            double_start = Some(i);
            i += 1;
            continue;
        }

        if ch == b'(' {
            paren_stack.push(i);
            i += 1;
            continue;
        }

        if ch == b')' {
            if paren_stack.pop().is_none() {
                push_diagnostic(
                    sql,
                    line_index,
                    diagnostics,
                    "rust.unmatched-right-paren",
                    "syntax.unmatched_right_paren",
                    "error",
                    "Unmatched closing parenthesis.",
                    i,
                    (i + 1).min(sql.len()),
                    Vec::new(),
                );
                return;
            }
            i += 1;
            continue;
        }

        if ch == b'$' {
            if let Some(tag_len) = match_dollar_tag(bytes, i) {
                let tag = sql[i..(i + tag_len)].to_string();
                dollar_tag = Some(tag);
                dollar_start = Some(i);
                i += tag_len;
                continue;
            }
        }

        i += 1;
    }

    if let Some(start) = single_start {
        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.unterminated-single-quote",
            "syntax.unterminated_single_quote",
            "error",
            "Unterminated single-quoted string literal.",
            start,
            (start + 1).min(sql.len()),
            Vec::new(),
        );
        return;
    }

    if let Some(start) = double_start {
        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.unterminated-double-quote",
            "syntax.unterminated_double_quote",
            "error",
            "Unterminated double-quoted identifier.",
            start,
            (start + 1).min(sql.len()),
            Vec::new(),
        );
        return;
    }

    if let Some(start) = dollar_start {
        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.unterminated-dollar-quote",
            "syntax.unterminated_dollar_quote",
            "error",
            "Unterminated dollar-quoted string.",
            start,
            (start + 2).min(sql.len()),
            Vec::new(),
        );
        return;
    }

    if let Some(start) = paren_stack.pop() {
        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.unclosed-paren",
            "syntax.unclosed_paren",
            "error",
            "Unclosed opening parenthesis.",
            start,
            (start + 1).min(sql.len()),
            Vec::new(),
        );
    }
}

fn lint_missing_where(
    sql: &str,
    statement: &SqlStatement,
    line_index: &LineIndex,
    diagnostics: &mut Vec<SqlLintDiagnostic>,
) {
    let text = &sql[statement.start_offset..statement.end_offset];
    let masked = mask_literals_and_comments(text);
    let keyword = first_keyword(text);
    if keyword != "DELETE" && keyword != "UPDATE" {
        return;
    }

    if WHERE_WORD_RE.is_match(&masked) {
        return;
    }

    let lower = masked.to_lowercase();
    let Some(keyword_pos) = lower.find(&keyword.to_lowercase()) else {
        return;
    };
    let start_offset = statement.start_offset + keyword_pos;
    let end_offset = (start_offset + keyword.len()).min(sql.len());

    let trimmed = text.trim_end_matches(|c: char| c.is_whitespace());
    let mut insertion_rel = trimmed.len();
    if trimmed.ends_with(';') {
        insertion_rel = insertion_rel.saturating_sub(1);
    }
    let insertion_offset = statement.start_offset + insertion_rel;
    let quick_fix = build_quick_fix(
        sql,
        line_index,
        "add-where-clause",
        "Add WHERE placeholder",
        insertion_offset,
        insertion_offset,
        " WHERE /* TODO: add filter */",
        true,
    );

    let (rule_id, severity, message) = if keyword == "DELETE" {
        (
            "missing_where_delete",
            "error",
            "DELETE statement has no WHERE clause. This can remove all rows.",
        )
    } else {
        (
            "missing_where_update",
            "warning",
            "UPDATE statement has no WHERE clause. This can update every row.",
        )
    };

    push_diagnostic(
        sql,
        line_index,
        diagnostics,
        &format!("rust.{rule_id}"),
        rule_id,
        severity,
        message,
        start_offset,
        end_offset,
        vec![quick_fix],
    );
}

fn lint_select_star(
    sql: &str,
    statement: &SqlStatement,
    line_index: &LineIndex,
    diagnostics: &mut Vec<SqlLintDiagnostic>,
) {
    let text = &sql[statement.start_offset..statement.end_offset];
    let masked = mask_literals_and_comments(text);
    let keyword = first_keyword(text);
    if keyword != "SELECT" && keyword != "WITH" {
        return;
    }

    let Some(caps) = SELECT_PROJECTION_RE.captures(&masked) else {
        return;
    };
    let Some(projection) = caps.name("projection") else {
        return;
    };

    for m in STAR_IN_SELECT_RE.find_iter(projection.as_str()) {
        let fragment = &projection.as_str()[m.start()..m.end()];
        let Some(star_rel) = fragment.rfind('*') else {
            continue;
        };
        let start_offset = statement.start_offset + projection.start() + m.start() + star_rel;
        let end_offset = (start_offset + 1).min(sql.len());

        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.select-star",
            "select_star",
            "warning",
            "Avoid SELECT *. Explicit columns improve performance and schema safety.",
            start_offset,
            end_offset,
            Vec::new(),
        );
    }
}

fn lint_implicit_cast(
    sql: &str,
    statement: &SqlStatement,
    line_index: &LineIndex,
    diagnostics: &mut Vec<SqlLintDiagnostic>,
) {
    let text = &sql[statement.start_offset..statement.end_offset];
    let masked = mask_literals_and_comments(text);

    for caps in IMPLICIT_CAST_RIGHT_RE.captures_iter(&masked) {
        let Some(quoted) = caps.name("quoted") else {
            continue;
        };
        let Some(literal) = caps.name("literal") else {
            continue;
        };
        if masked[quoted.end()..].trim_start().starts_with("::") {
            continue;
        }

        let start_offset = statement.start_offset + quoted.start();
        let end_offset = statement.start_offset + quoted.end();
        let quick_fix = build_quick_fix(
            sql,
            line_index,
            "remove-string-cast",
            "Convert to numeric literal",
            start_offset,
            end_offset,
            literal.as_str(),
            true,
        );

        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.implicit-cast-right",
            "implicit_type_cast",
            "warning",
            "Quoted numeric literals can trigger implicit casts and hurt index usage.",
            start_offset,
            end_offset,
            vec![quick_fix],
        );
    }

    for caps in IMPLICIT_CAST_LEFT_RE.captures_iter(&masked) {
        let Some(quoted) = caps.name("quoted") else {
            continue;
        };
        let Some(literal) = caps.name("literal") else {
            continue;
        };
        if masked[quoted.end()..].trim_start().starts_with("::") {
            continue;
        }

        let start_offset = statement.start_offset + quoted.start();
        let end_offset = statement.start_offset + quoted.end();
        let quick_fix = build_quick_fix(
            sql,
            line_index,
            "remove-string-cast",
            "Convert to numeric literal",
            start_offset,
            end_offset,
            literal.as_str(),
            true,
        );

        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.implicit-cast-left",
            "implicit_type_cast",
            "warning",
            "Quoted numeric literals can trigger implicit casts and hurt index usage.",
            start_offset,
            end_offset,
            vec![quick_fix],
        );
    }
}

fn lint_unused_left_join(
    sql: &str,
    statement: &SqlStatement,
    line_index: &LineIndex,
    diagnostics: &mut Vec<SqlLintDiagnostic>,
) {
    let text = &sql[statement.start_offset..statement.end_offset];
    let masked = mask_literals_and_comments(text);
    let lower = masked.to_lowercase();

    for caps in LEFT_JOIN_ALIAS_RE.captures_iter(&lower) {
        let Some(join_match) = caps.get(0) else {
            continue;
        };
        let Some(table_match) = caps.name("table") else {
            continue;
        };

        let alias = caps
            .name("alias")
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| last_identifier_segment(table_match.as_str()));
        if alias.is_empty() {
            continue;
        }

        let alias_ref = format!("{alias}.");
        let alias_count = count_alias_usages(&lower, &alias_ref);
        if alias_count > 1 {
            continue;
        }

        let start_offset = statement.start_offset + join_match.start();
        let end_offset = (start_offset + 4).min(sql.len());
        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.unused-left-join",
            "unused_join",
            "info",
            "LEFT JOIN alias appears unused outside its ON clause.",
            start_offset,
            end_offset,
            Vec::new(),
        );
    }
}

fn lint_deprecated_comma_join(
    sql: &str,
    statement: &SqlStatement,
    line_index: &LineIndex,
    diagnostics: &mut Vec<SqlLintDiagnostic>,
) {
    let text = &sql[statement.start_offset..statement.end_offset];
    let masked = mask_literals_and_comments(text);
    let keyword = first_keyword(text);
    if keyword != "SELECT" && keyword != "WITH" {
        return;
    }

    let Some(caps) = FROM_CLAUSE_RE.captures(&masked) else {
        return;
    };
    let Some(from_part) = caps.name("from") else {
        return;
    };
    let from_text = from_part.as_str().to_lowercase();
    if from_text.contains(" join ") {
        return;
    }
    let Some(comma_pos) = from_text.find(',') else {
        return;
    };

    let start_offset = statement.start_offset + from_part.start() + comma_pos;
    let end_offset = (start_offset + 1).min(sql.len());
    push_diagnostic(
        sql,
        line_index,
        diagnostics,
        "rust.deprecated-comma-join",
        "deprecated_comma_join",
        "warning",
        "Comma joins are deprecated style. Prefer explicit JOIN ... ON syntax.",
        start_offset,
        end_offset,
        Vec::new(),
    );
}

fn lint_n_plus_one(
    sql: &str,
    statement: &SqlStatement,
    line_index: &LineIndex,
    diagnostics: &mut Vec<SqlLintDiagnostic>,
) {
    let text = &sql[statement.start_offset..statement.end_offset];
    let masked = mask_literals_and_comments(text);
    let keyword = first_keyword(text);
    if keyword != "SELECT" && keyword != "WITH" {
        return;
    }

    let Some(found) = CORRELATED_SUBQUERY_RE.find(&masked) else {
        return;
    };

    let inner = &masked[found.start()..found.end()];
    let inner_select_rel = inner.to_lowercase().find("select").unwrap_or(0);
    let start_offset = statement.start_offset + found.start() + inner_select_rel;
    let end_offset = (start_offset + 6).min(sql.len());
    push_diagnostic(
        sql,
        line_index,
        diagnostics,
        "rust.n-plus-one",
        "n_plus_one_subquery",
        "info",
        "Potential N+1 pattern: correlated subquery inside SELECT list.",
        start_offset,
        end_offset,
        Vec::new(),
    );
}

fn lint_ambiguous_columns(
    sql: &str,
    statement: &SqlStatement,
    schema_context: &SqlLintSchemaContext,
    line_index: &LineIndex,
    diagnostics: &mut Vec<SqlLintDiagnostic>,
) {
    let text = &sql[statement.start_offset..statement.end_offset];
    let masked = mask_literals_and_comments(text);
    let lower = masked.to_lowercase();

    let mut alias_to_table: Vec<(String, String)> = Vec::new();
    for caps in TABLE_ALIAS_RE.captures_iter(&lower) {
        let Some(table_match) = caps.name("table") else {
            continue;
        };
        let table_name = normalize_identifier(table_match.as_str());
        if table_name.is_empty() {
            continue;
        }
        let alias = caps
            .name("alias")
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| last_identifier_segment(table_match.as_str()));
        let alias = alias.to_lowercase();
        if alias.is_empty() {
            continue;
        }
        if alias_to_table.iter().any(|(a, _)| a == &alias) {
            continue;
        }
        alias_to_table.push((alias, table_name));
    }

    if alias_to_table.len() < 2 {
        return;
    }

    let mut column_alias_map: HashMap<String, Vec<String>> = HashMap::new();
    for (alias, table_name) in &alias_to_table {
        let columns = lookup_columns(schema_context, table_name);
        for column in columns {
            let entry = column_alias_map.entry(column).or_default();
            if !entry.iter().any(|existing| existing == alias) {
                entry.push(alias.clone());
            }
        }
    }

    column_alias_map.retain(|_, aliases| aliases.len() > 1);
    if column_alias_map.is_empty() {
        return;
    }

    let Some(caps) = SELECT_PROJECTION_RE.captures(&masked) else {
        return;
    };
    let Some(projection) = caps.name("projection") else {
        return;
    };

    let projection_text = projection.as_str();
    let projection_bytes = projection_text.as_bytes();
    let mut emitted = 0usize;

    for id_match in BARE_IDENTIFIER_RE.find_iter(projection_text) {
        if emitted >= 8 {
            break;
        }
        let token = &projection_text[id_match.start()..id_match.end()];
        let token_lower = token.to_lowercase();

        if SQL_KEYWORDS.contains(token_lower.as_str()) {
            continue;
        }
        if alias_to_table.iter().any(|(alias, _)| alias == &token_lower) {
            continue;
        }
        if !column_alias_map.contains_key(&token_lower) {
            continue;
        }

        if id_match.start() > 0 && projection_bytes[id_match.start() - 1] == b'.' {
            continue;
        }
        if id_match.end() < projection_bytes.len() && projection_bytes[id_match.end()] == b'.' {
            continue;
        }
        if id_match.end() < projection_bytes.len() && projection_bytes[id_match.end()] == b'(' {
            continue;
        }

        let start_offset = statement.start_offset + projection.start() + id_match.start();
        let end_offset = statement.start_offset + projection.start() + id_match.end();
        let preferred_alias = column_alias_map
            .get(&token_lower)
            .and_then(|aliases| aliases.first())
            .cloned()
            .unwrap_or_else(|| alias_to_table[0].0.clone());
        let replacement = format!("{preferred_alias}.{token_lower}");

        let quick_fix = build_quick_fix(
            sql,
            line_index,
            "qualify-column",
            "Qualify with table alias",
            start_offset,
            end_offset,
            &replacement,
            true,
        );

        push_diagnostic(
            sql,
            line_index,
            diagnostics,
            "rust.ambiguous-column",
            "ambiguous_column_reference",
            "warning",
            "Column reference may be ambiguous across joined tables.",
            start_offset,
            end_offset,
            vec![quick_fix],
        );
        emitted += 1;
    }
}

fn push_diagnostic(
    sql: &str,
    line_index: &LineIndex,
    diagnostics: &mut Vec<SqlLintDiagnostic>,
    id: &str,
    rule_id: &str,
    severity: &str,
    message: &str,
    start_offset: usize,
    end_offset: usize,
    quick_fixes: Vec<SqlLintQuickFix>,
) {
    let (start_line, start_col) = line_index.line_col(sql, start_offset);
    let (end_line, end_col) = line_index.line_col(sql, end_offset);

    diagnostics.push(SqlLintDiagnostic {
        id: format!("{id}:{}", diagnostics.len() + 1),
        rule_id: rule_id.to_string(),
        severity: severity.to_string(),
        message: message.to_string(),
        source: "Rust SQL Linter".to_string(),
        start_line_number: start_line,
        start_column: start_col,
        end_line_number: end_line,
        end_column: end_col.max(start_col + usize::from(start_line == end_line)),
        quick_fixes,
    });
}

fn build_quick_fix(
    sql: &str,
    line_index: &LineIndex,
    id: &str,
    label: &str,
    start_offset: usize,
    end_offset: usize,
    replacement: &str,
    is_preferred: bool,
) -> SqlLintQuickFix {
    let (start_line, start_col) = line_index.line_col(sql, start_offset);
    let (end_line, end_col) = line_index.line_col(sql, end_offset);

    SqlLintQuickFix {
        id: id.to_string(),
        label: label.to_string(),
        start_line_number: start_line,
        start_column: start_col,
        end_line_number: end_line,
        end_column: end_col,
        replacement: replacement.to_string(),
        is_preferred,
    }
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "error" => 0,
        "warning" => 1,
        _ => 2,
    }
}

fn split_statements_with_offsets(sql: &str) -> Vec<SqlStatement> {
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut statements = Vec::<SqlStatement>::new();
    let mut start = 0usize;
    let mut i = 0usize;

    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_tag: Option<String> = None;

    while i < len {
        let ch = bytes[i];
        let next = if i + 1 < len { bytes[i + 1] } else { 0 };

        if in_line_comment {
            if ch == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }

        if in_block_comment {
            if ch == b'*' && next == b'/' {
                in_block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if let Some(tag) = &dollar_tag {
            if bytes[i..].starts_with(tag.as_bytes()) {
                i += tag.len();
                dollar_tag = None;
                continue;
            }
            i += 1;
            continue;
        }

        if in_single {
            if ch == b'\'' && next == b'\'' {
                i += 2;
                continue;
            }
            if ch == b'\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }

        if in_double {
            if ch == b'"' && next == b'"' {
                i += 2;
                continue;
            }
            if ch == b'"' {
                in_double = false;
            }
            i += 1;
            continue;
        }

        if ch == b'-' && next == b'-' {
            in_line_comment = true;
            i += 2;
            continue;
        }

        if ch == b'/' && next == b'*' {
            in_block_comment = true;
            i += 2;
            continue;
        }

        if ch == b'\'' {
            in_single = true;
            i += 1;
            continue;
        }

        if ch == b'"' {
            in_double = true;
            i += 1;
            continue;
        }

        if ch == b'$' {
            if let Some(tag_len) = match_dollar_tag(bytes, i) {
                dollar_tag = Some(sql[i..(i + tag_len)].to_string());
                i += tag_len;
                continue;
            }
        }

        if ch == b';' {
            let end = i + 1;
            if sql[start..end].trim().is_empty() {
                start = end;
                i = end;
                continue;
            }
            statements.push(SqlStatement {
                start_offset: start,
                end_offset: end,
            });
            start = end;
            i = end;
            continue;
        }

        i += 1;
    }

    if start < len && !sql[start..].trim().is_empty() {
        statements.push(SqlStatement {
            start_offset: start,
            end_offset: len,
        });
    }

    statements
}

fn mask_literals_and_comments(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut out = bytes.to_vec();

    let mut i = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_tag: Option<String> = None;

    while i < len {
        let ch = bytes[i];
        let next = if i + 1 < len { bytes[i + 1] } else { 0 };

        if in_line_comment {
            if ch != b'\n' {
                out[i] = b' ';
            } else {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }

        if in_block_comment {
            out[i] = b' ';
            if ch == b'*' && next == b'/' {
                out[i + 1] = b' ';
                in_block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if let Some(tag) = &dollar_tag {
            if bytes[i..].starts_with(tag.as_bytes()) {
                for j in 0..tag.len() {
                    if i + j < out.len() {
                        out[i + j] = b' ';
                    }
                }
                i += tag.len();
                dollar_tag = None;
                continue;
            }
            out[i] = b' ';
            i += 1;
            continue;
        }

        if in_single {
            out[i] = b' ';
            if ch == b'\'' && next == b'\'' {
                if i + 1 < out.len() {
                    out[i + 1] = b' ';
                }
                i += 2;
                continue;
            }
            if ch == b'\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }

        if in_double {
            out[i] = b' ';
            if ch == b'"' && next == b'"' {
                if i + 1 < out.len() {
                    out[i + 1] = b' ';
                }
                i += 2;
                continue;
            }
            if ch == b'"' {
                in_double = false;
            }
            i += 1;
            continue;
        }

        if ch == b'-' && next == b'-' {
            out[i] = b' ';
            if i + 1 < out.len() {
                out[i + 1] = b' ';
            }
            in_line_comment = true;
            i += 2;
            continue;
        }

        if ch == b'/' && next == b'*' {
            out[i] = b' ';
            if i + 1 < out.len() {
                out[i + 1] = b' ';
            }
            in_block_comment = true;
            i += 2;
            continue;
        }

        if ch == b'\'' {
            out[i] = b' ';
            in_single = true;
            i += 1;
            continue;
        }

        if ch == b'"' {
            out[i] = b' ';
            in_double = true;
            i += 1;
            continue;
        }

        if ch == b'$' {
            if let Some(tag_len) = match_dollar_tag(bytes, i) {
                let tag = sql[i..(i + tag_len)].to_string();
                for j in 0..tag_len {
                    if i + j < out.len() {
                        out[i + j] = b' ';
                    }
                }
                dollar_tag = Some(tag);
                i += tag_len;
                continue;
            }
        }

        i += 1;
    }

    String::from_utf8(out).unwrap_or_default()
}

fn match_dollar_tag(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start).copied()? != b'$' {
        return None;
    }

    if bytes.get(start + 1).copied() == Some(b'$') {
        return Some(2);
    }

    let mut i = start + 1;
    let first = *bytes.get(i)?;
    if !is_ident_start(first) {
        return None;
    }
    i += 1;

    while i < bytes.len() && is_ident_continue(bytes[i]) {
        i += 1;
    }

    if bytes.get(i).copied() != Some(b'$') {
        return None;
    }
    Some(i - start + 1)
}

fn is_ident_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_ident_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn first_keyword(statement: &str) -> String {
    let cleaned = statement.trim().trim_start_matches(';').trim();
    if cleaned.is_empty() {
        return "UNKNOWN".to_string();
    }

    let first = cleaned
        .split_whitespace()
        .next()
        .map(|w| w.to_uppercase())
        .unwrap_or_else(|| "UNKNOWN".to_string());

    if first != "WITH" {
        return first;
    }

    WITH_RESOLVE_RE
        .captures(cleaned)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_uppercase()))
        .unwrap_or_else(|| "WITH".to_string())
}

fn normalize_identifier(raw: &str) -> String {
    let stripped = raw.trim().trim_matches('"');
    let without_schema = stripped.rsplit('.').next().unwrap_or(stripped);
    without_schema.trim_matches('"').to_lowercase()
}

fn last_identifier_segment(raw: &str) -> String {
    normalize_identifier(raw)
}

fn count_alias_usages(statement_lower: &str, alias_with_dot: &str) -> usize {
    let mut count = 0usize;
    let mut cursor = 0usize;
    while cursor < statement_lower.len() {
        let Some(pos) = statement_lower[cursor..].find(alias_with_dot) else {
            break;
        };
        let abs = cursor + pos;
        let before_ok = abs == 0 || !is_ident_continue(statement_lower.as_bytes()[abs - 1]);
        if before_ok {
            count += 1;
        }
        cursor = abs + alias_with_dot.len();
    }
    count
}

fn lookup_columns(schema_context: &SqlLintSchemaContext, table_name: &str) -> Vec<String> {
    let target = normalize_identifier(table_name);
    if let Some(cols) = schema_context.columns.get(&target) {
        return cols.iter().map(|c| c.to_lowercase()).collect();
    }

    for (key, cols) in &schema_context.columns {
        if normalize_identifier(key) == target {
            return cols.iter().map(|c| c.to_lowercase()).collect();
        }
    }

    Vec::new()
}
