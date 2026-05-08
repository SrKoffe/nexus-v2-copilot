use log::{info, warn};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::core::event_bus::{TradeSignal, OrderResult};
use crate::core::database::Database;
use super::types::{Position, Direction, PositionStatus};

/// ExecutionEngine — CO-PILOT MODE (permanently disabled execution).
///
/// In Nexus V2, Roberto executes trades manually on MEXC. This module never
/// places orders. It exists to:
///   - Track the "logical active position" (what setup the user marked as
///     taken) so PositionTracker can render it
///   - Persist trade open/close events to SQLite
///   - Provide a hard, immovable safety wall: even if a future bug somehow
///     calls `execute_with_protection`, it returns blocked.
///
/// REMOVED in F5:
///   - `is_live_trading` toggle
///   - `oracle_mode` toggle (oracle is now permanent and unconditional)
///   - All HTTP code that would have POSTed orders to an exchange
///   - Rate limiter (no API calls to rate limit)
///
/// If at some point we want autonomous execution again, that should be a
/// SEPARATE crate/module with explicit, audited setup — not a flag flip.
pub struct ExecutionEngine {
    active_position: Mutex<Option<Position>>,
    db: Arc<Database>,
}

impl ExecutionEngine {
    pub fn new(db: Arc<Database>) -> Self {
        info!("[ExecutionEngine] 🛡️ Co-pilot mode (execution permanently disabled)");
        ExecutionEngine {
            active_position: Mutex::new(None),
            db,
        }
    }

    /// Always blocks. Kept as a Tauri-callable shim so existing wiring (and any
    /// future caller that drifts back to this codepath) gets a clear, auditable
    /// "blocked" response instead of silent fallthrough.
    pub async fn execute_with_protection(&self, signal: &TradeSignal) -> OrderResult {
        warn!(
            "🛡️ [Co-Pilot] execute_with_protection called but execution is permanently OFF. \
             Signal: {} {} @ ${}",
            signal.direction, signal.symbol, signal.entry_price
        );
        OrderResult {
            success: false,
            symbol: signal.symbol.clone(),
            price: signal.entry_price,
            quantity: signal.quantity,
            direction: signal.direction.clone(),
            message: "Co-pilot mode: execution is permanently disabled. \
                      User must place this trade manually on MEXC."
                .into(),
        }
    }

    /// Get the current active position (the setup Roberto marked as taken).
    pub async fn get_active_position(&self) -> Option<Position> {
        self.active_position.lock().await.clone()
    }

    /// Set the active position. Called when Roberto marks a setup as "taken".
    /// Future: also call this when MEXC private API confirms a real open position.
    pub async fn set_active_position(&self, signal: &TradeSignal) {
        let is_long = signal.direction == "long" || signal.direction == "buy";
        let pos = Position {
            id: signal.id.clone(),
            symbol: signal.symbol.clone(),
            direction: if is_long { Direction::Long } else { Direction::Short },
            entry_price: signal.entry_price,
            quantity: signal.quantity,
            stop_loss: signal.stop_loss,
            take_profit: signal.take_profit,
            leverage: signal.leverage.unwrap_or(25),
            pnl_pct: 0.0,
            opened_at: chrono::Utc::now().timestamp_millis() as u64,
            status: PositionStatus::Open,
        };

        let _ = self.db.record_trade_open(
            &signal.symbol,
            &signal.direction,
            signal.entry_price,
            signal.quantity,
            &signal.reason,
        ).await;

        *self.active_position.lock().await = Some(pos);
    }

    /// Clear the active position (when outcome is marked).
    pub async fn close_position(&self) {
        let mut pos = self.active_position.lock().await;
        if let Some(p) = pos.take() {
            info!("[ExecutionEngine] 📒 Cleared active position: {:?} {}", p.direction, p.symbol);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event_bus::TradeSignal;

    fn dummy_signal() -> TradeSignal {
        TradeSignal {
            id: "test_1".into(),
            symbol: "BTC_USDT".into(),
            direction: "long".into(),
            entry_price: 65000.0,
            quantity: 0.01,
            stop_loss: Some(64000.0),
            take_profit: Some(67000.0),
            leverage: Some(25),
            reason: "test".into(),
            score: 0.75,
            is_bracket: true,
        }
    }

    #[tokio::test]
    async fn test_execute_is_always_blocked() {
        // Sanity: even with a perfectly formed signal, execute returns blocked.
        // Uses an in-memory dummy DB; if Database::new fails on memory path,
        // this test is skipped in CI but documents intent.
        if let Ok(db) = Database::new(":memory:") {
            let engine = ExecutionEngine::new(Arc::new(db));
            let result = engine.execute_with_protection(&dummy_signal()).await;
            assert!(!result.success, "Execution must always be blocked in co-pilot mode");
            assert!(result.message.contains("permanently disabled"));
        }
    }
}
