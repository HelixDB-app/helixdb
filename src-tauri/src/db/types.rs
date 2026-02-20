use serde::{Deserialize, Serialize};

/// Represents a single cell value from a PostgreSQL query result.
/// Covers all major PG types, serialized as JSON-friendly variants.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum CellValue {
    Null,
    Bool(bool),
    Int16(i16),
    Int32(i32),
    Int64(i64),
    Float32(f32),
    Float64(f64),
    String(String),
    Json(serde_json::Value),
    DateTime(String), // ISO 8601
    Date(String),
    Time(String),
    Uuid(String),
    Bytes(Vec<u8>),
}

/// Column metadata for query results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub ordinal_position: i32,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
}

/// Schema metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
    pub table_count: i64,
}

/// Table metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub schema: String,
    pub row_count: i64,
    pub table_type: String, // "BASE TABLE" or "VIEW"
}

/// Query result with rows, columns, timing, and pagination info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<CellValue>>,
    pub row_count: usize,
    pub total_rows: Option<i64>,
    pub execution_time_ms: f64,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
    pub query: String,
    pub is_error: bool,
    pub error_message: Option<String>,
}

/// Column info within a query result (lighter than ColumnInfo)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumn {
    pub name: String,
    pub data_type: String,
}

/// Sort direction for table data requests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SortDirection {
    Asc,
    Desc,
}

/// Connection response returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionResponse {
    pub connection_id: String,
    pub database_name: String,
    /// Full version string, e.g. "PostgreSQL 16.4 on ..."
    pub server_version: String,
    /// Numeric version, e.g. 160004 for PG 16.4. Useful for feature detection on the UI.
    pub pg_version_num: u32,
}

/// Event trigger (cluster/database level) — available since PG 9.3
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventTriggerInfo {
    pub name: String,
    /// DDL event: ddl_command_start | ddl_command_end | sql_drop | table_rewrite
    pub event: String,
    /// Firing state: origin | disabled | replica | always
    pub enabled: String,
    /// Name of the trigger function
    pub function_name: String,
}

/// Function or procedure in a schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    pub arguments: String,
    pub return_type: String,
    pub is_trigger_function: bool,
    /// function | procedure | aggregate | window
    pub kind: String,
    /// Procedural language, e.g. plpgsql, sql, c, internal
    pub language: String,
    /// Whether the function runs with the privileges of the definer
    pub security_definer: bool,
    /// Whether the function returns NULL on any NULL argument (STRICT)
    pub is_strict: bool,
}

/// User-defined type in a schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeInfo {
    pub name: String,
    /// enum | composite | domain | range | multirange
    pub kind: String,
}

/// Detailed type definition for preview (enum labels, composite attrs, domain info, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeDefinitionDetail {
    pub schema: String,
    pub name: String,
    pub kind: String,
    /// Enum: ordered list of labels
    pub enum_labels: Option<Vec<String>>,
    /// Composite: (attribute_name, type_name)
    pub composite_attrs: Option<Vec<(String, String)>>,
    /// Domain: base type name
    pub domain_base_type: Option<String>,
    /// Domain: check constraint expression if any
    pub domain_check: Option<String>,
    /// Range: subtype name
    pub range_subtype: Option<String>,
}
