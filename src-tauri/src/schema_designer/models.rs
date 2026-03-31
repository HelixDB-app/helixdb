use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationOptions {
    pub temperature: f32,
    pub max_tokens: u32,
    pub database_type: String,
    pub output_format: String,
    pub include_enums: bool,
    pub include_audit_columns: bool,
    pub include_indexes: bool,
    pub include_sample_data: bool,
    pub normalization_level: String,
    pub naming_convention: String,
    pub reasoning_effort: String,
    #[serde(default)]
    pub api_key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyReference {
    pub table: String,
    pub column: String,
    #[serde(default)]
    pub on_delete: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaColumn {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub unique: bool,
    #[serde(default)]
    pub indexed: Option<bool>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub references: Option<ForeignKeyReference>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaIndex {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(rename = "type")]
    pub index_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub columns: Vec<SchemaColumn>,
    #[serde(default)]
    pub indexes: Vec<SchemaIndex>,
    pub color: String,
    #[serde(default)]
    pub position: Option<NodePosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaRelationship {
    pub id: String,
    pub source_table_id: String,
    pub source_column_id: String,
    pub target_table_id: String,
    pub target_column_id: String,
    pub kind: String,
    pub color: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaMetadata {
    pub database_type: String,
    pub version: String,
    pub description: String,
    pub total_tables: usize,
    pub total_relationships: usize,
    #[serde(default)]
    pub generated_by_model: Option<String>,
    #[serde(default)]
    pub generation_time_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaData {
    #[serde(default)]
    pub tables: Vec<TableSchema>,
    #[serde(default)]
    pub enums: Vec<EnumDefinition>,
    #[serde(default)]
    pub relationships: Vec<SchemaRelationship>,
    pub metadata: SchemaMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    #[serde(default)]
    pub token_count: Option<u32>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub schema_snapshot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasState {
    pub viewport: CanvasViewport,
    #[serde(default)]
    pub node_positions: HashMap<String, NodePosition>,
    pub layout_direction: String,
    #[serde(default)]
    pub selected_nodes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaVersionSnapshot {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub schema: SchemaData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDesignerProject {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub description: String,
    pub thumbnail_color: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub schema: Option<SchemaData>,
    pub canvas_state: CanvasState,
    #[serde(default)]
    pub conversation: Vec<ConversationMessage>,
    #[serde(default)]
    pub versions: Vec<SchemaVersionSnapshot>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaProjectSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub thumbnail_color: String,
    pub updated_at: String,
    pub created_at: String,
    pub total_tables: usize,
    pub total_relationships: usize,
    pub model: String,
}

impl From<&SchemaDesignerProject> for SchemaProjectSummary {
    fn from(project: &SchemaDesignerProject) -> Self {
        Self {
            id: project.id.clone(),
            name: project.name.clone(),
            description: project.description.clone(),
            thumbnail_color: project.thumbnail_color.clone(),
            updated_at: project.updated_at.clone(),
            created_at: project.created_at.clone(),
            total_tables: project
                .schema
                .as_ref()
                .map(|schema| schema.tables.len())
                .unwrap_or(0),
            total_relationships: project
                .schema
                .as_ref()
                .map(|schema| schema.relationships.len())
                .unwrap_or(0),
            model: project.model.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyMeta {
    pub id: String,
    pub label: String,
    pub is_default: bool,
    pub created_at: String,
    #[serde(default)]
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRecord {
    pub id: String,
    pub label: String,
    pub masked_value: String,
    pub is_default: bool,
    pub created_at: String,
    #[serde(default)]
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroqStreamPayload {
    pub request_id: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct StoredApiKey {
    pub meta: ApiKeyMeta,
    pub secret: String,
}
