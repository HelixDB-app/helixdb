//! JSON shapes aligned with `helixDB/src/lib/types.ts` and `src-tauri/src/db/types.rs`.

use serde::{Deserialize, Serialize};

/// Column definition for CREATE TABLE (JSON camelCase from the Helix UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateColumnDef {
    pub name: String,
    pub data_type: String,
    pub length: Option<String>,
    pub is_nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_unique: bool,
    pub check_constraint: Option<String>,
}

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
    DateTime(String),
    Date(String),
    Time(String),
    Uuid(String),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
    pub table_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub schema: String,
    pub row_count: i64,
    pub table_type: String,
    pub table_comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumn {
    pub name: String,
    pub data_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_labels: Option<Vec<String>>,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionResponse {
    pub connection_id: String,
    pub database_name: String,
    pub server_version: String,
    pub pg_version_num: u32,
}

#[derive(Debug, Deserialize)]
pub struct ConnectRequest {
    pub connection_string: String,
    #[serde(default)]
    pub connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExecuteQueryBody {
    pub sql: String,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub guard_reason: Option<String>,
}

/// Multi-condition filter (aligned with Helix `FilterCondition` / Tauri search).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCondition {
    pub column: String,
    pub operator: String,
    pub value: Option<String>,
    pub logical_op: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSearchBody {
    pub conditions: Vec<FilterCondition>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub sort_column: Option<String>,
    #[serde(default)]
    pub sort_direction: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub redis: String,
}

#[derive(Debug, Serialize)]
pub struct CapabilitiesResponse {
    pub version: String,
    pub ssh_tunnel: bool,
    pub local_postgres: bool,
}

// ── Session monitor (`pg_stat_activity`) ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgSession {
    pub pid: i32,
    pub usename: Option<String>,
    pub application_name: Option<String>,
    pub datname: Option<String>,
    pub client_addr: Option<String>,
    pub client_port: Option<i32>,
    pub backend_start: Option<String>,
    pub xact_start: Option<String>,
    pub query_start: Option<String>,
    pub state_change: Option<String>,
    pub wait_event_type: Option<String>,
    pub wait_event: Option<String>,
    pub state: Option<String>,
    pub query: Option<String>,
    pub backend_type: Option<String>,
    pub blocking_pids: Vec<i32>,
    pub query_duration_secs: Option<f64>,
    pub xact_duration_secs: Option<f64>,
    pub backend_duration_secs: Option<f64>,
}

// ── Schema topology ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyColumn {
    pub name: String,
    pub data_type: String,
    pub is_primary_key: bool,
    pub is_nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyNode {
    pub schema: String,
    pub table_name: String,
    pub row_count: i64,
    pub columns: Vec<TopologyColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyEdge {
    pub constraint_name: String,
    pub from_schema: String,
    pub from_table: String,
    pub from_column: String,
    pub to_schema: String,
    pub to_table: String,
    pub to_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyData {
    pub nodes: Vec<TopologyNode>,
    pub edges: Vec<TopologyEdge>,
}

// ── Table columns / details (AI + table manager parity) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub ordinal_position: i32,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    #[serde(default)]
    pub is_generated: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableConstraint {
    pub name: String,
    pub constraint_type: String,
    pub columns: Vec<String>,
    pub foreign_table: Option<String>,
    pub foreign_columns: Option<Vec<String>>,
    pub check_clause: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableIndex {
    pub name: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub index_type: String,
    pub columns: Vec<String>,
    pub definition: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableTriggerInfo {
    pub name: String,
    pub timing: String,
    pub events: Vec<String>,
    pub function_name: String,
    pub enabled: bool,
}

/// Function or procedure in a schema (aligned with `helixDB/src/lib/types.ts` `FunctionInfo`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    pub arguments: String,
    pub return_type: String,
    pub kind: String,
    pub is_trigger_function: bool,
    pub language: String,
    pub security_definer: bool,
    pub is_strict: bool,
}

/// User-defined type in a schema (aligned with `TypeInfo` in the Helix TS types).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeInfo {
    pub name: String,
    pub kind: String,
}

/// Rich type metadata for preview (aligned with `TypeDefinitionDetail` in Helix TS).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeDefinitionDetail {
    pub schema: String,
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composite_attrs: Option<Vec<(String, String)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_base_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_check: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_subtype: Option<String>,
}

/// Cluster/database-level event trigger (PG 9.3+).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventTriggerInfo {
    pub name: String,
    pub event: String,
    pub enabled: String,
    pub function_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDetails {
    pub schema: String,
    pub name: String,
    pub table_type: String,
    pub columns: Vec<ColumnInfo>,
    pub constraints: Vec<TableConstraint>,
    pub indexes: Vec<TableIndex>,
    pub triggers: Vec<TableTriggerInfo>,
    pub row_count: i64,
    pub total_size: String,
    pub table_size: String,
    pub indexes_size: String,
    pub comment: Option<String>,
}
