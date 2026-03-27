//! Heuristic detection of SQL that should optionally require biometric confirmation.

use once_cell::sync::Lazy;
use regex::Regex;

static DESTRUCTIVE_SQL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)\b(UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b")
        .expect("sql_sensitive DESTRUCTIVE_SQL regex")
});

static LINE_COMMENTS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)--[^\n]*").expect("LINE_COMMENTS regex")
});

static BLOCK_COMMENTS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?s)/\*.*?\*/").expect("BLOCK_COMMENTS regex")
});

/// Rough comment stripping so a keyword in `-- comment` does not trigger a match alone.
pub fn sql_script_requires_biometric_gate(sql: &str) -> bool {
    let max = sql.len().min(80_000);
    let sql = &sql[..max];
    let cleaned = strip_sql_comments(sql);
    DESTRUCTIVE_SQL.is_match(&cleaned)
}

fn strip_sql_comments(sql: &str) -> String {
    let s = BLOCK_COMMENTS.replace_all(sql, " ");
    LINE_COMMENTS.replace_all(&s, " ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_update() {
        assert!(sql_script_requires_biometric_gate("UPDATE t SET a = 1"));
    }

    #[test]
    fn ignores_commented_keyword() {
        assert!(!sql_script_requires_biometric_gate("-- DELETE FROM t\nSELECT 1"));
    }
}
