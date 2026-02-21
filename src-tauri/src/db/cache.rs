use dashmap::DashMap;
use std::time::{Duration, Instant};

use super::types::{ColumnInfo, SchemaInfo, TableInfo};

/// TTL-based cache entry
struct CacheEntry<T> {
    data: T,
    inserted_at: Instant,
    ttl: Duration,
}

impl<T: Clone> CacheEntry<T> {
    fn new(data: T, ttl: Duration) -> Self {
        Self {
            data,
            inserted_at: Instant::now(),
            ttl,
        }
    }

    fn is_expired(&self) -> bool {
        self.inserted_at.elapsed() > self.ttl
    }

    fn get(&self) -> Option<T> {
        if self.is_expired() {
            None
        } else {
            Some(self.data.clone())
        }
    }
}

/// In-memory metadata cache with TTL-based invalidation.
/// Uses DashMap for concurrent, lock-free access.
pub struct MetadataCache {
    /// Schema cache: connection_id -> Vec<SchemaInfo>
    schemas: DashMap<String, CacheEntry<Vec<SchemaInfo>>>,
    /// Table cache: "connection_id::schema" -> Vec<TableInfo>
    tables: DashMap<String, CacheEntry<Vec<TableInfo>>>,
    /// Column cache: "connection_id::schema::table" -> Vec<ColumnInfo>
    columns: DashMap<String, CacheEntry<Vec<ColumnInfo>>>,
    /// TTL for schema cache entries
    schema_ttl: Duration,
    /// TTL for table cache entries
    table_ttl: Duration,
    /// TTL for column cache entries
    column_ttl: Duration,
}

impl MetadataCache {
    pub fn new() -> Self {
        Self {
            schemas: DashMap::new(),
            tables: DashMap::new(),
            columns: DashMap::new(),
            schema_ttl: Duration::from_secs(30),
            table_ttl: Duration::from_secs(60),
            column_ttl: Duration::from_secs(120),
        }
    }

    // ── Schemas ──

    pub fn get_schemas(&self, conn_id: &str) -> Option<Vec<SchemaInfo>> {
        self.schemas.get(conn_id).and_then(|entry| entry.get())
    }

    pub fn set_schemas(&self, conn_id: &str, data: Vec<SchemaInfo>) {
        self.schemas
            .insert(conn_id.to_string(), CacheEntry::new(data, self.schema_ttl));
    }

    // ── Tables ──

    pub fn get_tables(&self, conn_id: &str, schema: &str) -> Option<Vec<TableInfo>> {
        let key = format!("{}::{}", conn_id, schema);
        self.tables.get(&key).and_then(|entry| entry.get())
    }

    pub fn set_tables(&self, conn_id: &str, schema: &str, data: Vec<TableInfo>) {
        let key = format!("{}::{}", conn_id, schema);
        self.tables
            .insert(key, CacheEntry::new(data, self.table_ttl));
    }

    // ── Columns ──

    pub fn get_columns(&self, conn_id: &str, schema: &str, table: &str) -> Option<Vec<ColumnInfo>> {
        let key = format!("{}::{}::{}", conn_id, schema, table);
        self.columns.get(&key).and_then(|entry| entry.get())
    }

    pub fn set_columns(&self, conn_id: &str, schema: &str, table: &str, data: Vec<ColumnInfo>) {
        let key = format!("{}::{}::{}", conn_id, schema, table);
        self.columns
            .insert(key, CacheEntry::new(data, self.column_ttl));
    }

    // ── Invalidation ──

    /// Invalidate all caches for a specific connection
    pub fn invalidate(&self, conn_id: &str) {
        self.schemas.remove(conn_id);
        self.tables.retain(|k, _| !k.starts_with(conn_id));
        self.columns.retain(|k, _| !k.starts_with(conn_id));
    }

    /// Invalidate table list for a schema (after DDL on tables)
    pub fn invalidate_tables(&self, conn_id: &str, schema: &str) {
        let key = format!("{}::{}", conn_id, schema);
        self.tables.remove(&key);
        // Also refresh schema counts
        self.schemas.remove(conn_id);
    }

    /// Invalidate column cache for a specific table
    pub fn invalidate_columns(&self, conn_id: &str, schema: &str, table: &str) {
        let key = format!("{}::{}::{}", conn_id, schema, table);
        self.columns.remove(&key);
    }

    /// Remove all cache entries
    pub fn invalidate_all(&self) {
        self.schemas.clear();
        self.tables.clear();
        self.columns.clear();
    }
}
