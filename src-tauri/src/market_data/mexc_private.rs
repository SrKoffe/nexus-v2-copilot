use hmac::{Hmac, Mac};
use log::{debug, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const REST_BASE: &str = "https://contract.mexc.com";
const RECV_WINDOW: u64 = 60_000;

/// MEXC private API client — READ-ONLY operations for the co-pilot.
///
/// API key MUST be created with read permissions only. See `.env.example` for setup.
/// Authentication: HMAC SHA256 over `apiKey + reqTime + queryString` per MEXC contract docs.
pub struct MexcPrivateClient {
    api_key: String,
    api_secret: String,
    http: Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountAsset {
    pub currency: String,
    pub available_balance: f64,
    pub frozen_balance: f64,
    pub equity: f64,
    pub unrealized_pnl: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenPosition {
    pub symbol: String,
    pub position_id: i64,
    /// "long" | "short"
    pub side: String,
    pub leverage: u32,
    pub size: f64,
    pub entry_price: f64,
    pub mark_price: f64,
    pub liquidation_price: f64,
    pub unrealized_pnl: f64,
    pub margin: f64,
}

impl MexcPrivateClient {
    /// Build a client from explicit credentials. Use `from_env` in production.
    pub fn new(api_key: String, api_secret: String) -> Self {
        Self {
            api_key,
            api_secret,
            http: Client::new(),
        }
    }

    /// Load API credentials from environment (`MEXC_API_KEY`, `MEXC_API_SECRET`).
    /// Returns None if either is missing or empty — Roberto can run without
    /// keys and the UI just won't show real balance.
    pub async fn from_env_or_db(db: &crate::core::database::Database) -> Option<Self> {
        let _ = dotenvy::dotenv();
        let key = std::env::var("MEXC_API_KEY").ok().or_else(|| {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    db.get_config("MEXC_API_KEY").await
                })
            })
        })?;
        let secret = std::env::var("MEXC_API_SECRET").ok().or_else(|| {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    db.get_config("MEXC_API_SECRET").await
                })
            })
        })?;

        if key.trim().is_empty() || secret.trim().is_empty() {
            return None;
        }
        Some(Self::new(key, secret))
    }

    pub fn from_env() -> Option<Self> {
        // Try .env in current dir first; ignore errors if missing.
        let _ = dotenvy::dotenv();
        let key = std::env::var("MEXC_API_KEY").ok()?;
        let secret = std::env::var("MEXC_API_SECRET").ok()?;
        if key.trim().is_empty() || secret.trim().is_empty() {
            return None;
        }
        Some(Self::new(key, secret))
    }

    /// HMAC SHA256 signature: `sign(apiKey + reqTime + queryString)`
    fn sign(&self, req_time: u64, query_string: &str) -> String {
        let payload = format!("{}{}{}", self.api_key, req_time, query_string);
        let mut mac = HmacSha256::new_from_slice(self.api_secret.as_bytes())
            .expect("HMAC accepts any key length");
        mac.update(payload.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// Common GET request with auth headers. `path` like "/api/v1/private/account/assets".
    async fn signed_get(&self, path: &str, query: &str) -> Result<Value, String> {
        let req_time = chrono::Utc::now().timestamp_millis() as u64;
        let signature = self.sign(req_time, query);

        let url = if query.is_empty() {
            format!("{}{}", REST_BASE, path)
        } else {
            format!("{}{}?{}", REST_BASE, path, query)
        };

        debug!("[MexcPrivate] GET {}", url);

        let resp = self
            .http
            .get(&url)
            .header("ApiKey", &self.api_key)
            .header("Request-Time", req_time.to_string())
            .header("Signature", signature)
            .header("Recv-Window", RECV_WINDOW.to_string())
            .send()
            .await
            .map_err(|e| format!("MEXC request failed: {}", e))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("MEXC parse failed: {}", e))?;

        if !status.is_success() || body.get("success").and_then(|v| v.as_bool()) != Some(true) {
            return Err(format!(
                "MEXC API error: status={}, code={:?}, message={:?}",
                status,
                body.get("code"),
                body.get("message")
            ));
        }

        Ok(body)
    }

    /// Fetch all account assets. Roberto can pluck out USDT for futures balance.
    pub async fn fetch_account_assets(&self) -> Result<Vec<AccountAsset>, String> {
        let body = self.signed_get("/api/v1/private/account/assets", "").await?;

        let data = body.get("data").ok_or("missing `data` in response")?;
        let arr = data.as_array().ok_or("`data` is not an array")?;

        let assets: Vec<AccountAsset> = arr
            .iter()
            .filter_map(|item| {
                Some(AccountAsset {
                    currency: item.get("currency")?.as_str()?.to_string(),
                    available_balance: item.get("availableBalance").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    frozen_balance: item.get("frozenBalance").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    equity: item.get("equity").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    unrealized_pnl: item.get("unrealized").and_then(|v| v.as_f64()).unwrap_or(0.0),
                })
            })
            .collect();

        Ok(assets)
    }

    /// Helper: USDT equity (= available + frozen + unrealized PnL). Returns 0 if no USDT row.
    pub async fn fetch_usdt_equity(&self) -> Result<f64, String> {
        let assets = self.fetch_account_assets().await?;
        Ok(assets
            .iter()
            .find(|a| a.currency.eq_ignore_ascii_case("USDT"))
            .map(|a| a.equity)
            .unwrap_or(0.0))
    }

    /// Fetch all currently open positions (futures).
    pub async fn fetch_open_positions(&self) -> Result<Vec<OpenPosition>, String> {
        let body = self.signed_get("/api/v1/private/position/open_positions", "").await?;

        let data = body.get("data").ok_or("missing `data` in response")?;
        let arr = data.as_array().ok_or("`data` is not an array")?;

        let positions: Vec<OpenPosition> = arr
            .iter()
            .filter_map(|item| {
                // MEXC: positionType 1 = long, 2 = short
                let pos_type = item.get("positionType").and_then(|v| v.as_u64()).unwrap_or(0);
                let side = match pos_type {
                    1 => "long",
                    2 => "short",
                    _ => return None,
                };

                Some(OpenPosition {
                    symbol: item.get("symbol")?.as_str()?.to_string(),
                    position_id: item.get("positionId").and_then(|v| v.as_i64()).unwrap_or(0),
                    side: side.to_string(),
                    leverage: item.get("leverage").and_then(|v| v.as_u64()).unwrap_or(1) as u32,
                    size: item.get("holdVol").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    entry_price: item.get("holdAvgPrice").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    mark_price: item.get("markPrice").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    liquidation_price: item.get("liquidatePrice").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    unrealized_pnl: item.get("realised").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    margin: item.get("im").and_then(|v| v.as_f64()).unwrap_or(0.0),
                })
            })
            .collect();

        Ok(positions)
    }
}

/// Helper: log a warning if the client can't be built (missing env keys).
/// Returns None gracefully so the rest of the app keeps running.
pub async fn try_build_from_env_or_db(db: &crate::core::database::Database) -> Option<MexcPrivateClient> {
    match MexcPrivateClient::from_env_or_db(db).await {
        Some(c) => Some(c),
        None => {
            log::warn!(
                "[MexcPrivate] MEXC_API_KEY / MEXC_API_SECRET not set in .env or DB —                  balance and positions will fall back to defaults. Create a                  READ-ONLY API key on MEXC and add to enable."
            );
            None
        }
    }
}

pub fn try_build_from_env() -> Option<MexcPrivateClient> {
    match MexcPrivateClient::from_env() {
        Some(c) => Some(c),
        None => {
            log::warn!("[MexcPrivate] MEXC_API_KEY / MEXC_API_SECRET not set in .env.");
            None
        }
    }
}
