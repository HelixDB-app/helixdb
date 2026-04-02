//! PostgreSQL pool with TLS (managed providers e.g. Aiven).

use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::NoTls;

pub async fn create_pool(connection_string: &str, max_size: usize) -> Result<Pool, String> {
    let pg: tokio_postgres::Config = connection_string
        .parse()
        .map_err(|e| format!("Invalid SCHEMA_SYNC_DATABASE_URL: {e}"))?;

    let mut cfg = Config::new();
    cfg.dbname = pg.get_dbname().map(|s| s.to_string());
    cfg.user = pg.get_user().map(|s| s.to_string());
    cfg.password = pg
        .get_password()
        .map(|p| String::from_utf8_lossy(p).to_string());

    if let Some(host) = pg.get_hosts().first() {
        match host {
            tokio_postgres::config::Host::Tcp(h) => {
                cfg.host = Some(h.clone());
            }
            #[cfg(unix)]
            tokio_postgres::config::Host::Unix(p) => {
                cfg.host = Some(p.to_string_lossy().to_string());
            }
        }
    }
    if let Some(port) = pg.get_ports().first() {
        cfg.port = Some(*port);
    }

    cfg.pool = Some(deadpool_postgres::PoolConfig {
        max_size,
        ..Default::default()
    });
    cfg.manager = Some(ManagerConfig {
        recycling_method: RecyclingMethod::Fast,
    });

    match try_tls_pool(&cfg).await {
        Ok(p) => Ok(p),
        Err(e) => {
            tracing::warn!("TLS pool failed ({e}), retrying without TLS");
            cfg.create_pool(Some(Runtime::Tokio1), NoTls)
                .map_err(|e2| format!("create_pool: {e2}"))
        }
    }
}

async fn try_tls_pool(cfg: &Config) -> Result<Pool, String> {
    let tls_connector = TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("TLS: {e}"))?;
    let connector = MakeTlsConnector::new(tls_connector);
    cfg.create_pool(Some(Runtime::Tokio1), connector)
        .map_err(|e| e.to_string())
}

pub const MIGRATION_SQL: &str = include_str!("../migrations/001_init.sql");
