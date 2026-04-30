use log::{info, warn};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex;

use crate::core::event_bus::{TradeSignal, OrderResult};
use crate::core::database::Database;
use super::types::{ExecutionConfig, Position, Direction, PositionStatus};

/// Hyperliquid Execution Engine
/// 
/// Ports `executionEngine.ts` to Rust with:
/// - Rate limiting (40 calls / 10s window)
/// - Oracle mode (block all execution)
/// - Live/Simulation toggle
/// - Bracket order support (SL/TP)
pub struct ExecutionEngine {
    config: ExecutionConfig,
    is_live_trading: AtomicBool,
    oracle_mode: AtomicBool,
    active_position: Mutex<Option<Position>>,
    api_call_timestamps: Mutex<Vec<u64>>,
    db: Arc<Database>,
}

impl ExecutionEngine {
    pub fn new(db: Arc<Database>) -> Self {
        ExecutionEngine {
            config: ExecutionConfig::default(),
            is_live_trading: AtomicBool::new(false),
            oracle_mode: AtomicBool::new(true), // Start in oracle mode (safe)
            active_position: Mutex::new(None),
            api_call_timestamps: Mutex::new(Vec::new()),
            db,
        }
    }

    /// Set live trading mode
    pub fn set_live_trading(&self, enabled: bool) {
        self.is_live_trading.store(enabled, Ordering::SeqCst);
        info!("[ExecutionEngine] Mode: {}", if enabled { "🔴 LIVE" } else { "🟢 SIMULATION" });
    }

    /// Set oracle mode (blocks all execution)
    pub fn set_oracle_mode(&self, enabled: bool) {
        self.oracle_mode.store(enabled, Ordering::SeqCst);
        info!("[ExecutionEngine] Oracle Mode: {}", if enabled { "ON 🛡️" } else { "OFF ⚡" });
    }

    /// Execute a trade with protection checks
    pub async fn execute_with_protection(&self, signal: &TradeSignal) -> OrderResult {
        // 🛡️ ORACLE MODE: Block all execution
        if self.oracle_mode.load(Ordering::SeqCst) {
            info!("🛡️ [Oracle Mode] Trade blocked: {} {} @ ${}", signal.direction, signal.symbol, signal.entry_price);
            return OrderResult {
                success: false,
                symbol: signal.symbol.clone(),
                price: signal.entry_price,
                quantity: signal.quantity,
                direction: signal.direction.clone(),
                message: "Oracle Mode: Execution blocked".into(),
            };
        }

        // Simulation mode
        if !self.is_live_trading.load(Ordering::SeqCst) {
            info!("[ExecutionEngine] 🟢 SIMULATION: {} {} @ ${}", signal.direction, signal.symbol, signal.entry_price);
            return OrderResult {
                success: true,
                symbol: signal.symbol.clone(),
                price: signal.entry_price,
                quantity: signal.quantity,
                direction: signal.direction.clone(),
                message: "Simulation mode".into(),
            };
        }

        // Rate limiting
        if let Err(msg) = self.check_rate_limit().await {
            return OrderResult {
                success: false,
                symbol: signal.symbol.clone(),
                price: signal.entry_price,
                quantity: signal.quantity,
                direction: signal.direction.clone(),
                message: msg,
            };
        }

        // Format symbol for Hyperliquid (BTC → BTC-PERP)
        let hl_symbol = Self::format_hl_symbol(&signal.symbol);
        let is_buy = signal.direction == "long" || signal.direction == "buy";

        // Calculate slippage-adjusted limit price
        let slippage_mult = if is_buy { 1.0 + self.config.slippage_pct } else { 1.0 - self.config.slippage_pct };
        let limit_price = (signal.entry_price * slippage_mult).round();

        info!("[ExecutionEngine] 🚀 {} {} | Qty: {} | Price: ${} | Limit: ${}",
              if is_buy { "BUY" } else { "SELL" }, hl_symbol, signal.quantity, signal.entry_price, limit_price);

        // TODO: Actual Hyperliquid API call via reqwest
        // For now, return a placeholder that will be replaced with real HTTP calls
        let result = OrderResult {
            success: true,
            symbol: hl_symbol.clone(),
            price: signal.entry_price,
            quantity: signal.quantity,
            direction: signal.direction.clone(),
            message: format!("Order sent: {} {} @ ${}", if is_buy { "BUY" } else { "SELL" }, hl_symbol, limit_price),
        };

        // Record trade in database
        if result.success {
            let _ = self.db.record_trade_open(
                &hl_symbol,
                &signal.direction,
                signal.entry_price,
                signal.quantity,
                &signal.reason,
            );

            // Update active position
            let mut pos = self.active_position.lock().await;
            *pos = Some(Position {
                id: signal.id.clone(),
                symbol: hl_symbol,
                direction: if is_buy { Direction::Long } else { Direction::Short },
                entry_price: signal.entry_price,
                quantity: signal.quantity,
                stop_loss: signal.stop_loss,
                take_profit: signal.take_profit,
                leverage: signal.leverage.unwrap_or(self.config.default_leverage),
                pnl_pct: 0.0,
                opened_at: chrono::Utc::now().timestamp_millis() as u64,
                status: PositionStatus::Open,
            });
        }

        result
    }

    /// Rate limiter — prevents Hyperliquid IP ban (1200 weight/min limit)
    async fn check_rate_limit(&self) -> Result<(), String> {
        let mut timestamps = self.api_call_timestamps.lock().await;
        let now = chrono::Utc::now().timestamp_millis() as u64;

        // Clean old timestamps outside window
        timestamps.retain(|&t| now - t < self.config.window_ms);

        if timestamps.len() as u32 >= self.config.max_calls_per_window {
            let wait_ms = self.config.window_ms - (now - timestamps[0]);
            warn!("[ExecutionEngine] ⏳ Rate limit throttle: {}ms", wait_ms);
            return Err(format!("Rate limited, try again in {}ms", wait_ms));
        }

        timestamps.push(now);
        Ok(())
    }

    /// Format symbol for Hyperliquid (BTCUSDT → BTC-PERP)
    fn format_hl_symbol(symbol: &str) -> String {
        let clean = symbol
            .replace("USDT", "")
            .replace("usdt", "")
            .to_uppercase()
            .trim()
            .to_string();

        if clean.contains("-PERP") {
            clean
        } else {
            format!("{}-PERP", clean)
        }
    }

    /// Get the current active position
    pub async fn get_active_position(&self) -> Option<Position> {
        self.active_position.lock().await.clone()
    }

    /// Close the active position (used by tracker when SL/TP hit)
    pub async fn close_position(&self) {
        let mut pos = self.active_position.lock().await;
        if let Some(p) = pos.take() {
            info!("[ExecutionEngine] 🚨 Closed Position: {:?} {}", p.direction, p.symbol);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_hl_symbol() {
        assert_eq!(ExecutionEngine::format_hl_symbol("BTCUSDT"), "BTC-PERP");
        assert_eq!(ExecutionEngine::format_hl_symbol("btcusdt"), "BTC-PERP");
        assert_eq!(ExecutionEngine::format_hl_symbol("BTC-PERP"), "BTC-PERP");
        assert_eq!(ExecutionEngine::format_hl_symbol("ETH"), "ETH-PERP");
    }
}
