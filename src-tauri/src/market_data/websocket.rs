use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::broadcast;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tauri::Emitter;

use crate::core::event_bus::{SystemEvent, Tick};
use super::types::AggTrade;

/// Binance WebSocket stream for real-time aggTrade data.
/// 
/// Ports `binanceWebSocket.ts` to async Rust with:
/// - Auto-reconnect on disconnect (5s backoff)
/// - Zero-copy tick parsing via serde
/// - Broadcasts via tokio broadcast channel
pub struct BinanceStream {
    symbol: String,
    is_connected: Arc<AtomicBool>,
}

impl BinanceStream {
    pub fn new(symbol: &str) -> Self {
        BinanceStream {
            symbol: symbol.to_lowercase(),
            is_connected: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Start the WebSocket connection loop.
    /// This spawns a background tokio task that runs indefinitely.
    pub fn start(&self, event_sender: broadcast::Sender<SystemEvent>, app_handle: tauri::AppHandle) {
        let symbol = self.symbol.clone();
        let is_connected = self.is_connected.clone();

        tauri::async_runtime::spawn(async move {
            loop {
                match Self::connect_and_stream(&symbol, &event_sender, &app_handle, &is_connected).await {
                    Ok(_) => {
                        warn!("[Binance WS] Connection closed cleanly. Reconnecting in 5s...");
                    }
                    Err(e) => {
                        error!("[Binance WS] Connection error: {}. Reconnecting in 5s...", e);
                    }
                }
                is_connected.store(false, Ordering::SeqCst);
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        });
    }

    /// Connect to Binance and stream aggTrade data
    async fn connect_and_stream(
        symbol: &str,
        event_sender: &broadcast::Sender<SystemEvent>,
        app_handle: &tauri::AppHandle,
        is_connected: &Arc<AtomicBool>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let url = format!("wss://stream.binance.com:9443/ws/{}@aggTrade", symbol);
        info!("[Binance WS] Connecting to {}", url);

        let (ws_stream, _response) = connect_async(&url).await?;
        let (mut write, mut read) = ws_stream.split();

        is_connected.store(true, Ordering::SeqCst);
        info!("[Binance WS] Connected to {} 🟢", symbol.to_uppercase());

        // Ping every 3 minutes to keep alive
        let ping_handle = tauri::async_runtime::spawn({
            let mut write = write;
            async move {
                loop {
                    tokio::time::sleep(tokio::time::Duration::from_secs(180)).await;
                    if write.send(Message::Ping(vec![])).await.is_err() {
                        break;
                    }
                }
                write
            }
        });

        // Throttle frontend updates to every 150ms (matching Electron behavior)
        let mut last_frontend_update = std::time::Instant::now();

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    // Parse the JSON into our AggTrade struct
                    if let Ok(agg_trade) = serde_json::from_str::<AggTrade>(&text) {
                        let price: f64 = agg_trade.price.parse().unwrap_or(0.0);
                        let quantity: f64 = agg_trade.quantity.parse().unwrap_or(0.0);

                        if price <= 0.0 { continue; }

                        let tick = Tick {
                            symbol: symbol.to_uppercase(),
                            price,
                            quantity,
                            is_buyer_maker: agg_trade.is_buyer_maker,
                            timestamp: agg_trade.trade_time,
                        };

                        // Broadcast tick to internal event bus (all Rust consumers)
                        let _ = event_sender.send(SystemEvent::MarketTick(tick.clone()));

                        // Throttled emit to React frontend via Tauri events
                        let now = std::time::Instant::now();
                        if now.duration_since(last_frontend_update).as_millis() > 150 {
                            let _ = app_handle.emit("market-tick", &tick);
                            last_frontend_update = now;
                        }
                    }
                }
                Ok(Message::Pong(_)) => {
                    // Pong received, connection alive
                }
                Ok(Message::Close(_)) => {
                    info!("[Binance WS] Server sent close frame");
                    break;
                }
                Err(e) => {
                    error!("[Binance WS] Read error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        // Cancel ping task
        ping_handle.abort();

        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.is_connected.load(Ordering::SeqCst)
    }
}
