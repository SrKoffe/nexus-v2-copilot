use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// Market tick data from Binance aggTrade stream
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tick {
    pub symbol: String,
    pub price: f64,
    pub quantity: f64,
    pub is_buyer_maker: bool,
    pub timestamp: u64,
}

/// Lightweight ticker data from MEXC sub.tickers for Universe Scanner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniverseTicker {
    pub symbol: String,
    pub last_price: f64,
    pub volume_24h: f64,
    pub amount_24h: f64,
    pub rise_fall_rate: f64, // 24h % change
    pub high_24h: f64,
    pub low_24h: f64,
    pub volatility: f64,
    pub regime: String, // "TREND_UP", "TREND_DOWN", "RANGE", "CHAOTIC"
    pub opportunity_score: f64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderResult {
    pub success: bool,
    pub symbol: String,
    pub price: f64,
    pub quantity: f64,
    pub direction: String,
    pub message: String,
}

/// Trade execution signal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeSignal {
    pub id: String,
    pub symbol: String,
    pub direction: String,     // "long" | "short"
    pub entry_price: f64,
    pub quantity: f64,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub leverage: Option<u32>,
    pub reason: String,
    pub score: f64,
    pub is_bracket: bool,
}

/// Trade outcome data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeOutcome {
    pub id: String,
    pub pnl_pct: f64,
    pub exit_price: f64,
    pub timestamp: u64,
}

/// System-wide event types
#[derive(Debug, Clone)]
pub enum SystemEvent {
    MarketTick(Tick),
    UniverseScanUpdate(Vec<UniverseTicker>),
    ExecuteTrade(TradeSignal),
    OrderFilled(OrderResult),
    OrderRejected(OrderResult),
    TradeClosed(TradeOutcome),
    SettingsUpdated { key: String, value: String },
    SetLiveTrading(bool),
}

/// Central event bus using tokio broadcast channels.
/// Replaces Node.js EventEmitter with zero-copy async Rust channels.
/// 
/// Architecture:
///   - Single broadcast sender shared via Arc
///   - Any module can subscribe with bus.subscribe()
///   - 1024-message buffer for high-throughput tick data
pub struct EventBus {
    sender: broadcast::Sender<SystemEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(1024);
        EventBus { sender }
    }

    /// Emit an event to all subscribers
    pub fn emit(&self, event: SystemEvent) {
        // Ignore send errors (no active receivers)
        let _ = self.sender.send(event);
    }

    /// Subscribe to all events
    pub fn subscribe(&self) -> broadcast::Receiver<SystemEvent> {
        self.sender.subscribe()
    }

    /// Get a cloneable sender handle
    pub fn sender(&self) -> broadcast::Sender<SystemEvent> {
        self.sender.clone()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

// The SystemEvent must be Clone for broadcast channel
// We derive Clone above, but broadcast also needs Send
unsafe impl Send for SystemEvent {}
unsafe impl Sync for SystemEvent {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_event_bus_broadcast() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        bus.emit(SystemEvent::SetLiveTrading(true));

        match rx.recv().await.unwrap() {
            SystemEvent::SetLiveTrading(v) => assert!(v),
            _ => panic!("Wrong event type"),
        }
    }

    #[tokio::test]
    async fn test_tick_broadcast() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        let tick = Tick {
            symbol: "BTCUSDT".into(),
            price: 95000.0,
            quantity: 0.5,
            is_buyer_maker: false,
            timestamp: 1234567890,
        };

        bus.emit(SystemEvent::MarketTick(tick.clone()));

        match rx.recv().await.unwrap() {
            SystemEvent::MarketTick(t) => {
                assert_eq!(t.symbol, "BTCUSDT");
                assert_eq!(t.price, 95000.0);
            }
            _ => panic!("Wrong event type"),
        }
    }
}
