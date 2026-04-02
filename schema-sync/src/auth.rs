//! Bearer JWT / API key — mirrors helix-data-plane auth patterns.

use axum::http::header;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AuthState {
    pub api_key: Option<String>,
    pub jwt_hs256_secret: Option<String>,
    pub jwt_issuer: Option<String>,
    pub jwt_audience: Option<String>,
    pub jwks: Option<Arc<JwksCache>>,
    pub require_auth: bool,
}

impl AuthState {
    pub fn any_verifier_configured(&self) -> bool {
        self.api_key.is_some() || self.jwt_hs256_secret.is_some() || self.jwks.is_some()
    }
}

pub struct JwksCache {
    url: String,
    ttl: Duration,
    inner: RwLock<Option<(Instant, JwkSet)>>,
    client: reqwest::Client,
}

impl JwksCache {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            ttl: Duration::from_secs(3600),
            inner: RwLock::new(None),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .connect_timeout(Duration::from_secs(5))
                .build()
                .expect("jwks client"),
        }
    }

    async fn jwk_set(&self) -> Result<JwkSet, String> {
        let now = Instant::now();
        {
            let g = self.inner.read().await;
            if let Some((t, set)) = g.as_ref() {
                if now.duration_since(*t) < self.ttl {
                    return Ok(set.clone());
                }
            }
        }
        let text = self
            .client
            .get(&self.url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        let set: JwkSet = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        *self.inner.write().await = Some((now, set.clone()));
        Ok(set)
    }

    pub async fn decode_sub(&self, token: &str, validation: &Validation) -> Result<String, String> {
        let header = decode_header(token).map_err(|e| e.to_string())?;
        let kid = header
            .kid
            .as_deref()
            .ok_or_else(|| "JWT header missing kid".to_string())?;
        let set = self.jwk_set().await?;
        let jwk = set
            .find(kid)
            .ok_or_else(|| format!("JWK kid not found: {kid}"))?;
        let key = DecodingKey::from_jwk(jwk).map_err(|e| e.to_string())?;
        #[derive(Debug, Deserialize)]
        struct Claims {
            sub: String,
        }
        let t = decode::<Claims>(token, &key, validation).map_err(|e| e.to_string())?;
        Ok(t.claims.sub)
    }
}

fn bearer_matches_api_key(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .as_bytes()
        .ct_eq(provided.as_bytes())
        .into()
}

pub fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<&str> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    auth.strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
}

#[derive(Debug, Deserialize)]
struct Hs256Claims {
    sub: String,
}

fn jwt_validation_hs256(iss: &Option<String>, aud: &Option<String>) -> Validation {
    let mut v = Validation::new(Algorithm::HS256);
    v.validate_exp = true;
    if let Some(a) = aud {
        v.set_audience(&[a.as_str()]);
    }
    if let Some(i) = iss {
        v.set_issuer(&[i.as_str()]);
    }
    v
}

fn jwt_validation_rs256(iss: &Option<String>, aud: &Option<String>) -> Validation {
    let mut v = Validation::new(Algorithm::RS256);
    v.validate_exp = true;
    if let Some(a) = aud {
        v.set_audience(&[a.as_str()]);
    }
    if let Some(i) = iss {
        v.set_issuer(&[i.as_str()]);
    }
    v
}

/// Returns OAuth-style `sub` for the authenticated principal.
pub async fn verify_bearer_returns_sub(
    auth: &AuthState,
    bearer: &str,
) -> Result<String, &'static str> {
    let bearer = bearer.trim();
    if bearer.is_empty() {
        return Err("empty token");
    }

    if let Some(ref expected) = auth.api_key {
        if bearer_matches_api_key(expected, bearer) {
            return Ok("api-key".to_string());
        }
    }

    if let Some(ref secret) = auth.jwt_hs256_secret {
        let key = DecodingKey::from_secret(secret.as_bytes());
        let v = jwt_validation_hs256(&auth.jwt_issuer, &auth.jwt_audience);
        if let Ok(t) = decode::<Hs256Claims>(bearer, &key, &v) {
            return Ok(t.claims.sub);
        }
    }

    if let Some(ref jwks) = auth.jwks {
        let v = jwt_validation_rs256(&auth.jwt_issuer, &auth.jwt_audience);
        if let Ok(sub) = jwks.decode_sub(bearer, &v).await {
            return Ok(sub);
        }
    }

    Err("invalid token")
}

pub async fn auth_from_env() -> AuthState {
    let api_key = std::env::var("SCHEMA_SYNC_API_KEY").ok().filter(|s| !s.is_empty());
    let jwt_hs256_secret = std::env::var("SCHEMA_SYNC_JWT_HS256_SECRET")
        .ok()
        .filter(|s| !s.is_empty());
    let jwt_issuer = std::env::var("SCHEMA_SYNC_JWT_ISSUER")
        .ok()
        .filter(|s| !s.is_empty());
    let jwt_audience = std::env::var("SCHEMA_SYNC_JWT_AUDIENCE")
        .ok()
        .filter(|s| !s.is_empty());
    let jwks_url = std::env::var("SCHEMA_SYNC_JWKS_URL")
        .ok()
        .filter(|s| !s.is_empty());
    let jwks = jwks_url.map(|u| Arc::new(JwksCache::new(u)));
    let require_auth = std::env::var("SCHEMA_SYNC_REQUIRE_AUTH")
        .ok()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));

    AuthState {
        api_key,
        jwt_hs256_secret,
        jwt_issuer,
        jwt_audience,
        jwks,
        require_auth,
    }
}
