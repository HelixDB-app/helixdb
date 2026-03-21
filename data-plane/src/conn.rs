use dashmap::DashMap;
use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use std::sync::Arc;
use tokio_postgres::NoTls;

pub struct ConnectionManager {
    pools: DashMap<String, (Pool, u32)>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            pools: DashMap::new(),
        }
    }

    pub async fn connect(
        &self,
        connection_id: &str,
        connection_string: &str,
        pool_max_size: usize,
        statement_timeout_ms: u64,
    ) -> Result<(), String> {
        let mut config = connection_string
            .parse::<tokio_postgres::Config>()
            .map_err(|e| format!("Invalid connection string: {}", e))?;

        if statement_timeout_ms > 0 {
            let opts = format!(
                "-c statement_timeout={}",
                statement_timeout_ms
            );
            config.options(&opts);
        }

        let mut pool_config = Config::new();
        pool_config.dbname = config.get_dbname().map(|s| s.to_string());
        pool_config.user = config.get_user().map(|s| s.to_string());
        pool_config.password = config
            .get_password()
            .map(|p| String::from_utf8_lossy(p).to_string());

        if let Some(host) = config.get_hosts().first() {
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
        if let Some(port) = config.get_ports().first() {
            pool_config.port = Some(*port);
        }

        pool_config.pool = Some(deadpool_postgres::PoolConfig {
            max_size: pool_max_size,
            ..Default::default()
        });
        pool_config.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });

        let pool = match Self::create_pool_with_tls(&pool_config).await {
            Ok(p) => p,
            Err(_) => pool_config
                .create_pool(Some(Runtime::Tokio1), NoTls)
                .map_err(|e| format!("Failed to create connection pool: {}", e))?,
        };

        let client = pool
            .get()
            .await
            .map_err(|e| format!("Failed to connect to database: {}", e))?;

        client
            .simple_query("SELECT 1")
            .await
            .map_err(|e| format!("Database health check failed: {}", e))?;

        let pg_version = Self::probe_version(&client).await.unwrap_or(90600);

        self.pools
            .insert(connection_id.to_string(), (pool, pg_version));
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

    async fn probe_version(client: &deadpool_postgres::Object) -> Result<u32, String> {
        let row = client
            .query_one("SELECT current_setting('server_version_num')::integer", &[])
            .await
            .map_err(|e| e.to_string())?;
        let v: i32 = row.get(0);
        Ok(v as u32)
    }

    pub fn get_pool(&self, connection_id: &str) -> Result<Arc<Pool>, String> {
        self.pools
            .get(connection_id)
            .map(|entry| Arc::new(entry.value().0.clone()))
            .ok_or_else(|| format!("No connection found with ID: {}", connection_id))
    }

    pub fn get_pg_version(&self, connection_id: &str) -> u32 {
        self.pools
            .get(connection_id)
            .map(|e| e.value().1)
            .unwrap_or(90600)
    }

    pub fn disconnect(&self, connection_id: &str) -> bool {
        self.pools.remove(connection_id).is_some()
    }
}
