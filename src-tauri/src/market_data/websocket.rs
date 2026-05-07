use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde_json::{json, Value};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::broadcast;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tauri::Emitter;

use crate::core::event_bus::{SystemEvent, Tick};

/// MEXC Futures WebSocket stream for real-time deal (trade) data.
///
/// Endpoint: `wss://contract.mexc.com/edge`
/// Streams: `sub.deal` (trades), `sub.kline` (candles), `sub.depth` (orderbook)
///
/// Features:
/// - Auto-reconnect on disconnect (5s backoff)
/// - Ping every 30s to keep connection alive
/// - Throttled emit to React frontend (150ms)
/// - Broadcasts via tokio broadcast channel
pub struct MexcStream {
    /// Reactive receiver for the currently focused symbol
    symbol_rx: tokio::sync::watch::Receiver<String>,
    is_connected: Arc<AtomicBool>,
}

impl MexcStream {
    /// Create a new MEXC futures stream.
    /// `symbol` should be in MEXC contract format with underscore (e.g. "BTC_USDT", "ETH_USDT").
    pub fn new(symbol_rx: tokio::sync::watch::Receiver<String>) -> Self {
        MexcStream {
            symbol_rx,
            is_connected: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Start the WebSocket connection loop.
    /// This spawns a background tokio task that runs indefinitely.
    pub fn start(&self, event_sender: broadcast::Sender<SystemEvent>, app_handle: tauri::AppHandle) {
        let mut symbol_rx = self.symbol_rx.clone();
        let is_connected = self.is_connected.clone();

        tauri::async_runtime::spawn(async move {
            loop {
                let symbol = symbol_rx.borrow().clone();
                match Self::connect_and_stream(&symbol, &mut symbol_rx, &event_sender, &app_handle, &is_connected).await {
                    Ok(true) => {
                        info!("[MEXC WS] Symbol changed. Reconnecting immediately...");
                        continue;
                    }
                    Ok(false) => {
                        warn!("[MEXC WS] Connection closed cleanly. Reconnecting in 5s...");
                    }
                    Err(e) => {
                        error!("[MEXC WS] Connection error: {}. Reconnecting in 5s...", e);
                    }
                }
                is_connected.store(false, Ordering::SeqCst);
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        });
    }

    /// Connect to MEXC futures and stream deal (trade) data.
    /// Returns Ok(true) if the connection was dropped due to a symbol change.
    async fn connect_and_stream(
        symbol: &str,
        symbol_rx: &mut tokio::sync::watch::Receiver<String>,
        event_sender: &broadcast::Sender<SystemEvent>,
        app_handle: &tauri::AppHandle,
        is_connected: &Arc<AtomicBool>,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let url = "wss://contract.mexc.com/edge";
        info!("[MEXC WS] Connecting to {} for {}", url, symbol);

        let (ws_stream, _response) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();

        // Subscribe to deal stream (trades / time & sales)
        let sub_deal = json!({
            "method": "sub.deal",
            "param": { "symbol": symbol }
        });
        write.send(Message::Text(sub_deal.to_string())).await?;
        info!("[MEXC WS] Subscribed to sub.deal for {}", symbol);

        is_connected.store(true, Ordering::SeqCst);
        info!("[MEXC WS] Connected to {} 🟢", symbol);

        // Spawn ping task — MEXC recommends ping every 30s.
        // Take ownership of `write` for the ping side; reads continue on `read`.
        let ping_handle = tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
                let ping_msg = json!({ "method": "ping" }).to_string();
                if write.send(Message::Text(ping_msg)).await.is_err() {
                    break;
                }
            }
        });

        // Throttle frontend updates to every 150ms
        let mut last_frontend_update = std::time::Instant::now();

        loop {
            tokio::select! {
                // 1) Wait for incoming messages
                msg = read.next() => {
                    let msg = match msg {
                        Some(m) => m,
                        None => break, // Stream closed
                    };

                    match msg {
                        Ok(Message::Text(text)) => {
                            let parsed: Value = match serde_json::from_str(&text) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };

                            // Pong: {"channel":"pong",...} — keep-alive ack
                            if parsed.get("channel").and_then(|c| c.as_str()) == Some("pong") {
                                continue;
                            }

                            // Subscribe ack: {"channel":"rs.sub.deal","data":"success",...}
                            if let Some(ch) = parsed.get("channel").and_then(|c| c.as_str()) {
                                if ch.starts_with("rs.sub.") {
                                    info!("[MEXC WS] Sub ack: {} → {:?}", ch, parsed.get("data"));
                                    continue;
                                }
                            }

                            // Push deal: {"channel":"push.deal","data":{p,v,T,t,...},"symbol":"BTC_USDT","ts":...}
                            let is_deal = parsed.get("channel").and_then(|c| c.as_str()) == Some("push.deal");
                            if !is_deal {
                                continue;
                            }

                            let data = match parsed.get("data") {
                                Some(d) => d,
                                None => continue,
                            };

                            // Price — MEXC returns as number (f64)
                            let price = data.get("p").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            if price <= 0.0 { continue; }

                            // Volume
                            let quantity = data.get("v").and_then(|v| v.as_f64()).unwrap_or(0.0);

                            // Taker direction: T=1 → buy aggressor → is_buyer_maker=false
                            //                  T=2 → sell aggressor → is_buyer_maker=true
                            let taker_dir = data.get("T").and_then(|v| v.as_u64()).unwrap_or(0);
                            let is_buyer_maker = taker_dir == 2;

                            // Timestamp (ms)
                            let timestamp = data.get("t").and_then(|v| v.as_u64())
                                .or_else(|| parsed.get("ts").and_then(|v| v.as_u64()))
                                .unwrap_or(0);

                            let symbol_str = parsed.get("symbol")
                                .and_then(|s| s.as_str())
                                .unwrap_or(symbol)
                                .to_string();

                            let tick = Tick {
                                symbol: symbol_str,
                                price,
                                quantity,
                                is_buyer_maker,
                                timestamp,
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
                        Ok(Message::Pong(_)) => {
                            // Pong frame received
                        }
                        Ok(Message::Close(_)) => {
                            info!("[MEXC WS] Server sent close frame");
                            break;
                        }
                        Err(e) => {
                            error!("[MEXC WS] Read error: {}", e);
                            break;
                        }
                        _ => {}
                    }
                }

                // 2) Listen for symbol changes
                _ = symbol_rx.changed() => {
                    let new_symbol = symbol_rx.borrow().clone();
                    info!("[MEXC WS] Detected symbol change to {}. Terminating current stream.", new_symbol);
                    ping_handle.abort();
                    return Ok(true); // Return true to indicate a symbol change requested reconnect
                }
            }
        }

        // Cancel ping task
        ping_handle.abort();

        Ok(false) // Clean disconnect, no symbol change
    }

    pub fn is_connected(&self) -> bool {
        self.is_connected.load(Ordering::SeqCst)
    }
}

// ─── Backwards-compat alias ────────────────────────────────────────────────
// Kept temporarily so existing callers compile. Remove after migrating lib.rs.
#[deprecated(note = "Use MexcStream instead. BinanceStream alias is for transition only.")]
pub type BinanceStream = MexcStream;
