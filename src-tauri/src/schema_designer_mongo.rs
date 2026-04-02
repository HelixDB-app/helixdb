//! Optional MongoDB persistence for AI Schema Designer projects.

use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::TryStreamExt;
use mongodb::bson::doc;
use mongodb::options::{FindOptions, IndexOptions, ReplaceOptions};
use mongodb::{Client, Collection, IndexModel};

use crate::schema_designer_storage::SchemaProject;

const COLLECTION_NAME: &str = "schema_projects";

static INDEXES_ENSURED: AtomicBool = AtomicBool::new(false);

pub fn mongo_connection_uri() -> Option<String> {
    if let Ok(s) = std::env::var("SCHEMA_DESIGNER_MONGO_URI") {
        let t = s.trim().to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    std::env::var("MONGODB_URI")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn mongo_db_name() -> String {
    std::env::var("SCHEMA_DESIGNER_MONGO_DB").unwrap_or_else(|_| "pgstudio".to_string())
}

async fn open_collection() -> Result<Collection<SchemaProject>, String> {
    let uri = mongo_connection_uri().ok_or_else(|| "MongoDB URI not configured".to_string())?;
    let client = Client::with_uri_str(&uri)
        .await
        .map_err(|e| format!("MongoDB connect: {e}"))?;
    let db = client.database(&mongo_db_name());
    Ok(db.collection(COLLECTION_NAME))
}

async fn ensure_indexes(col: &Collection<SchemaProject>) -> Result<(), String> {
    if INDEXES_ENSURED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let id_idx = IndexModel::builder()
        .keys(doc! { "id": 1 })
        .options(
            IndexOptions::builder()
                .name("schema_project_id_unique".to_string())
                .unique(true)
                .build(),
        )
        .build();
    let updated_idx = IndexModel::builder()
        .keys(doc! { "updated_at": -1 })
        .options(
            IndexOptions::builder()
                .name("schema_project_updated_at".to_string())
                .build(),
        )
        .build();
    let text_idx = IndexModel::builder()
        .keys(doc! {
            "name": "text",
            "description": "text",
        })
        .options(
            IndexOptions::builder()
                .name("schema_project_text_search".to_string())
                .build(),
        )
        .build();
    if let Err(e) = col.create_indexes(vec![id_idx, updated_idx, text_idx]).await {
        INDEXES_ENSURED.store(false, Ordering::SeqCst);
        return Err(format!("MongoDB create_indexes: {e}"));
    }
    Ok(())
}

pub async fn load_all() -> Result<Vec<SchemaProject>, String> {
    let col = open_collection().await?;
    ensure_indexes(&col).await?;
    let find_opts = FindOptions::builder()
        .sort(doc! { "updated_at": -1 })
        .build();
    let mut cur = col
        .find(doc! {})
        .with_options(find_opts)
        .await
        .map_err(|e| format!("MongoDB find: {e}"))?;
    let mut out = Vec::new();
    while let Some(doc) = cur
        .try_next()
        .await
        .map_err(|e| format!("MongoDB cursor: {e}"))?
    {
        out.push(doc);
    }
    Ok(out)
}

pub async fn get_project(id: &str) -> Result<Option<SchemaProject>, String> {
    let col = open_collection().await?;
    ensure_indexes(&col).await?;
    col.find_one(doc! { "id": id })
        .await
        .map_err(|e| format!("MongoDB find_one: {e}"))
}

pub async fn save_project(project: SchemaProject) -> Result<Vec<SchemaProject>, String> {
    let col = open_collection().await?;
    ensure_indexes(&col).await?;
    let filter = doc! { "id": &project.id };
    let opts = ReplaceOptions::builder().upsert(true).build();
    col.replace_one(filter, project)
        .with_options(opts)
        .await
        .map_err(|e| format!("MongoDB replace_one: {e}"))?;
    load_all().await
}

pub async fn delete_project(id: &str) -> Result<Vec<SchemaProject>, String> {
    let col = open_collection().await?;
    ensure_indexes(&col).await?;
    col.delete_one(doc! { "id": id })
        .await
        .map_err(|e| format!("MongoDB delete: {e}"))?;
    load_all().await
}
