use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde_json::{json, Value};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::broadcast;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tauri::Emitter;

use crate::core::event_bus::{SystemEvent, UniverseTicker};

/// MEXC Futures Universe Scanner
/// Monitors ALL USDT perpetual futures efficiently using `sub.tickers`
pub struct UniverseScanner {
    is_connected: Arc<AtomicBool>,
}

impl UniverseScanner {
    pub fn new() -> Self {
        UniverseScanner {
            is_connected: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self, event_sender: broadcast::Sender<SystemEvent>, app_handle: tauri::AppHandle) {
        let is_connected = self.is_connected.clone();

        tauri::async_runtime::spawn(async move {
            loop {
                match Self::connect_and_stream(&event_sender, &app_handle, &is_connected).await {
                    Ok(_) => {
                        warn!("[UNIVERSE SCANNER] Connection closed cleanly. Reconnecting in 5s...");
                    }
                    Err(e) => {
                        error!("[UNIVERSE SCANNER] Connection error: {}. Reconnecting in 5s...", e);
                    }
                }
                is_connected.store(false, Ordering::SeqCst);
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        });
    }

    async fn connect_and_stream(
        event_sender: &broadcast::Sender<SystemEvent>,
        app_handle: &tauri::AppHandle,
        is_connected: &Arc<AtomicBool>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let url = "wss://contract.mexc.com/edge";
        info!("[UNIVERSE SCANNER] Connecting to {}", url);

        let (ws_stream, _response) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();

        // Subscribe to ALL tickers
        let sub_msg = json!({
            "method": "sub.tickers",
            "param": {}
        });
        write.send(Message::Text(sub_msg.to_string())).await?;
        info!("[UNIVERSE SCANNER] Subscribed to all tickers");

        is_connected.store(true, Ordering::SeqCst);

        // Ping task (30s)
        let ping_handle = tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
                let ping_msg = json!({ "method": "ping" }).to_string();
                if write.send(Message::Text(ping_msg)).await.is_err() {
                    break;
                }
            }
        });

        // Throttle updates to 1Hz
        let mut last_frontend_update = std::time::Instant::now();

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let parsed: Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    let channel = parsed.get("channel").and_then(|c| c.as_str()).unwrap_or("");
                    if channel != "push.tickers" && channel != "push.ticker" {
                        continue;
                    }

                    let data = parsed.get("data");
                    if data.is_none() || !data.unwrap().is_array() {
                        continue;
                    }

                    let arr = data.unwrap().as_array().unwrap();
                    let mut tickers = Vec::with_capacity(arr.len());

                    let timestamp = parsed.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);

                    for item in arr {
                        let symbol = item.get("symbol").and_then(|s| s.as_str()).unwrap_or("");
                        if !symbol.ends_with("_USDT") {
                            continue; // Only care about USDT pairs
                        }

                        let last_price = item.get("lastPrice").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let volume_24h = item.get("volume24").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let amount_24h = item.get("amount24").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let rise_fall_rate = item.get("riseFallRate").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let high_24h = item.get("high24Price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let low_24h = item.get("lower24Price").and_then(|v| v.as_f64()).unwrap_or(0.0);

                        let volatility = if last_price > 0.0 && high_24h > low_24h {
                            (high_24h - low_24h) / last_price
                        } else {
                            0.0
                        };

                        let regime = if volatility > 0.15 {
                            "CHAOTIC"
                        } else if rise_fall_rate > 0.05 {
                            "TREND_UP"
                        } else if rise_fall_rate < -0.05 {
                            "TREND_DOWN"
                        } else {
                            "RANGE"
                        };

                        // Score = Momentum + Volatility + log(Turnover)
                        let liquidity_score = if amount_24h > 1.0 { amount_24h.log10() } else { 0.0 };
                        let momentum_score = rise_fall_rate.abs() * 50.0;
                        let vol_score = volatility * 100.0;
                        let opportunity_score = momentum_score + vol_score + (liquidity_score * 2.0);

                        tickers.push(UniverseTicker {
                            symbol: symbol.to_string(),
                            last_price,
                            volume_24h,
                            amount_24h,
                            rise_fall_rate,
                            high_24h,
                            low_24h,
                            volatility,
                            regime: regime.to_string(),
                            opportunity_score,
                            timestamp,
                        });
                    }

                    // Phase 2: Sort candidates by opportunity score descending
                    tickers.sort_by(|a, b| b.opportunity_score.partial_cmp(&a.opportunity_score).unwrap_or(std::cmp::Ordering::Equal));

                    // Send to EventBus
                    let _ = event_sender.send(SystemEvent::UniverseScanUpdate(tickers.clone()));

                    // Throttle to frontend (1Hz)
                    let now = std::time::Instant::now();
                    if now.duration_since(last_frontend_update).as_millis() >= 1000 {
                        let _ = app_handle.emit("universe-scan-update", &tickers);
                        last_frontend_update = now;
                    }
                }
                Ok(Message::Close(_)) => {
                    break;
                }
                Err(e) => {
                    error!("[UNIVERSE SCANNER] Read error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        ping_handle.abort();
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.is_connected.load(Ordering::SeqCst)
    }
}
