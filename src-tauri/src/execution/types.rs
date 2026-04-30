use serde::{Deserialize, Serialize};

/// Order side
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OrderSide {
    Buy,
    Sell,
}

/// Order type
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OrderType {
    Market,
    Limit { price: f64 },
    StopLoss { trigger_price: f64 },
    TakeProfit { trigger_price: f64 },
}

/// Position direction
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Long,
    Short,
}

/// Order payload for Hyperliquid
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderPayload {
    pub coin: String,
    pub is_buy: bool,
    pub sz: f64,
    pub limit_px: f64,
    pub reduce_only: bool,
    pub order_type: String,
}

/// Active position tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub id: String,
    pub symbol: String,
    pub direction: Direction,
    pub entry_price: f64,
    pub quantity: f64,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub leverage: u32,
    pub pnl_pct: f64,
    pub opened_at: u64,
    pub status: PositionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PositionStatus {
    Open,
    Closed,
    Liquidated,
}

/// Execution configuration
#[derive(Debug, Clone)]
pub struct ExecutionConfig {
    pub max_calls_per_window: u32,    // Rate limit: calls per window
    pub window_ms: u64,               // Rate limit: window duration
    pub slippage_pct: f64,            // Slippage tolerance (e.g., 0.01 = 1%)
    pub default_leverage: u32,
}

impl Default for ExecutionConfig {
    fn default() -> Self {
        ExecutionConfig {
            max_calls_per_window: 40,
            window_ms: 10_000,
            slippage_pct: 0.01,
            default_leverage: 10,
        }
    }
}
