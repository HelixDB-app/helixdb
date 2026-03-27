use dashmap::DashMap;
use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use std::sync::Arc;
use tokio_postgres::NoTls;

/// Manages multiple PostgreSQL connection pools keyed by connection ID.
/// Each entry stores the pool, the server's numeric version, and the original
/// connection string (needed by the watch engine to open a dedicated LISTEN connection).
pub struct ConnectionManager {
    pools: DashMap<String, (Pool, u32, String)>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            pools: DashMap::new(),
        }
    }

    /// Create a connection pool and probe the server version.
    /// Returns the connection ID on success.
    pub async fn connect(
        &self,
        connection_id: &str,
        connection_string: &str,
    ) -> Result<(), String> {
        let config = connection_string
            .parse::<tokio_postgres::Config>()
            .map_err(|e| format!("Invalid connection string: {}", e))?;

        let mut pool_config = Config::new();
        pool_config.dbname = config.get_dbname().map(|s| s.to_string());
        pool_config.user = config.get_user().map(|s| s.to_string());
        pool_config.password = config
            .get_password()
            .map(|p| String::from_utf8_lossy(p).to_string());

        let hosts = config.get_hosts();
        let ports = config.get_ports();
        if let Some(host) = hosts.first() {
            match host {
                tokio_postgres::config::Host::Tcp(h) => {
                    pool_config.host = Some(h.clone());
                }
                #[cfg(unix)]
                tokio_postgres::config::Host::Unix(p) => {
                    pool_config.host = Some(p.to_string_lossy().to_string());
                }
            }
        }
        if let Some(port) = ports.first() {
            pool_config.port = Some(*port);
        }

        pool_config.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });

        // Try TLS first, fall back to plain TCP
        let pool = match Self::create_pool_with_tls(&pool_config).await {
            Ok(p) => p,
            Err(_) => pool_config
                .create_pool(Some(Runtime::Tokio1), NoTls)
                .map_err(|e| format!("Failed to create connection pool: {}", e))?,
        };

        // Health check + version probe in one round-trip
        let client = pool
            .get()
            .await
            .map_err(|e| format!("Failed to connect to database: {}", e))?;

        client
            .simple_query("SELECT 1")
            .await
            .map_err(|e| format!("Database health check failed: {}", e))?;

        let pg_version = Self::probe_version(&client).await.unwrap_or(90600);

        self.pools.insert(
            connection_id.to_string(),
            (pool, pg_version, connection_string.to_string()),
        );
        Ok(())
    }

    async fn create_pool_with_tls(pool_config: &Config) -> Result<Pool, String> {
        let tls_connector = TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| format!("TLS error: {}", e))?;
        let connector = MakeTlsConnector::new(tls_connector);
        pool_config
            .create_pool(Some(Runtime::Tokio1), connector)
            .map_err(|e| format!("Failed to create TLS pool: {}", e))
    }

    /// Read `server_version_num` from the connected server.
    /// Returns the integer form, e.g. 160004 for PostgreSQL 16.4.
    async fn probe_version(client: &deadpool_postgres::Object) -> Result<u32, String> {
        let row = client
            .query_one("SELECT current_setting('server_version_num')::integer", &[])
            .await
            .map_err(|e| e.to_string())?;
        let v: i32 = row.get(0);
        Ok(v as u32)
    }

    /// Get a shared pool handle for a connection.
    pub fn get_pool(&self, connection_id: &str) -> Result<Arc<Pool>, String> {
        self.pools
            .get(connection_id)
            .map(|entry| Arc::new(entry.value().0.clone()))
            .ok_or_else(|| format!("No connection found with ID: {}", connection_id))
    }

    /// Return the numeric PostgreSQL version for a connection (e.g. 160004).
    /// Falls back to 90600 if the connection is unknown.
    pub fn get_pg_version(&self, connection_id: &str) -> u32 {
        self.pools
            .get(connection_id)
            .map(|entry| entry.value().1)
            .unwrap_or(90600)
    }

    /// Return the original connection string for a connection (used by the watch engine).
    pub fn get_connection_string(&self, connection_id: &str) -> Option<String> {
        self.pools
            .get(connection_id)
            .map(|entry| entry.value().2.clone())
    }

    /// List all active connection IDs currently held by the manager.
    pub fn list_connection_ids(&self) -> Vec<String> {
        self.pools
            .iter()
            .map(|entry| entry.key().clone())
            .collect()
    }

    /// Disconnect and drop the pool for a connection.
    pub fn disconnect(&self, connection_id: &str) -> bool {
        self.pools.remove(connection_id).is_some()
    }

    pub fn is_connected(&self, connection_id: &str) -> bool {
        self.pools.contains_key(connection_id)
    }
}
