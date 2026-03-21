//! Authentication for `/v1/*`: optional API key, HS256 JWT, or RS256 via JWKS (cached).

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
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
    /// When true, protected routes require a valid credential even if no verifier is configured.
    pub require_auth: bool,
}

impl AuthState {
    pub fn any_verifier_configured(&self) -> bool {
        self.api_key.is_some()
            || self.jwt_hs256_secret.is_some()
            || self.jwks.is_some()
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
                .expect("jwks reqwest client"),
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

    pub async fn verify_token(&self, token: &str, validation: &Validation) -> Result<(), String> {
        let header = decode_header(token).map_err(|e| e.to_string())?;
        let kid = header.kid.as_deref().ok_or_else(|| "JWT header missing kid".to_string())?;
        let set = self.jwk_set().await?;
        let jwk = set
            .find(kid)
            .ok_or_else(|| format!("JWK kid not found: {kid}"))?;
        let key = DecodingKey::from_jwk(jwk).map_err(|e| e.to_string())?;

        #[derive(Debug, Deserialize)]
        struct Claims {
            #[allow(dead_code)]
            sub: String,
        }
        decode::<Claims>(token, &key, validation).map_err(|e| e.to_string())?;
        Ok(())
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

fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<&str> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    auth.strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
}

#[derive(Debug, Deserialize)]
struct Hs256Claims {
    #[allow(dead_code)]
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

fn verify_hs256(
    token: &str,
    secret: &str,
    iss: &Option<String>,
    aud: &Option<String>,
) -> bool {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let v = jwt_validation_hs256(iss, aud);
    decode::<Hs256Claims>(token, &key, &v).is_ok()
}

pub async fn auth_middleware_inner(
    auth: Arc<AuthState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let public = path == "/health" || path == "/v1/capabilities";
    if public {
        return next.run(req).await;
    }

    let configured = auth.any_verifier_configured();
    if !configured && !auth.require_auth {
        return next.run(req).await;
    }

    let headers = req.headers();
    let bearer = extract_bearer(headers).map(str::trim).filter(|s| !s.is_empty());

    let Some(bearer) = bearer else {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };

    if let Some(ref expected) = auth.api_key {
        if bearer_matches_api_key(expected, bearer) {
            return next.run(req).await;
        }
    }

    if let Some(ref secret) = auth.jwt_hs256_secret {
        if verify_hs256(bearer, secret, &auth.jwt_issuer, &auth.jwt_audience) {
            return next.run(req).await;
        }
    }

    if let Some(ref jwks) = auth.jwks {
        let v = jwt_validation_rs256(&auth.jwt_issuer, &auth.jwt_audience);
        if jwks.verify_token(bearer, &v).await.is_ok() {
            return next.run(req).await;
        }
    }

    (StatusCode::UNAUTHORIZED, "Unauthorized").into_response()
}
