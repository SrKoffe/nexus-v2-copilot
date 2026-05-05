use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use log::info;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::core::event_bus::SystemEvent;

/// Core state for the trading bot
pub struct StateManager {
    pub has_open_position: AtomicBool,
    pub is_processing: AtomicBool,
    pub analysis_count: AtomicUsize,
    pub leverage: AtomicU32,
    pub price: RwLock<f64>,
    pub prev_price: RwLock<f64>,
    pub allow_vol_trigger: AtomicBool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemState {
    pub has_open_position: bool,
    pub is_processing: bool,
    pub analysis_count: usize,
    pub leverage: u32,
    pub price: f64,
}

impl Default for StateManager {
    fn default() -> Self {
        Self {
            has_open_position: AtomicBool::new(false),
            is_processing: AtomicBool::new(false),
            analysis_count: AtomicUsize::new(0),
            leverage: AtomicU32::new(50),
            price: RwLock::new(0.0),
            prev_price: RwLock::new(0.0),
            allow_vol_trigger: AtomicBool::new(true),
        }
    }
}

impl StateManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Evaluates incoming market data against the institutional pipeline.
    pub async fn analyze(&self, current_price: f64, app_handle: &tauri::AppHandle) {
        let prev = *self.prev_price.read().unwrap();
        if prev == 0.0 {
            *self.prev_price.write().unwrap() = current_price;
            return;
        }

        let price_delta = (current_price - prev).abs();
        
        // HFT Trigger: Evaluate deeply only if volatility spikes > 0.01% bridging tick latency
        let is_volatile = price_delta > current_price * 0.0001; 
        
        if is_volatile {
            if !self.allow_vol_trigger.load(Ordering::SeqCst) {
                *self.prev_price.write().unwrap() = current_price;
                return;
            }
            
            // 2. Fetch last 25 closed candles for VSA (Volume Spread Analysis) & Structure
            let url = "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=26";
            
            let mut struct_high = current_price;
            let mut struct_low = current_price;
            let mut latest_vol = 0.0;
            let mut avg_vol = 1.0;
            
            if let Ok(res) = reqwest::get(url).await {
                if let Ok(klines) = res.json::<Vec<Vec<serde_json::Value>>>().await {
                    let mut total_vol = 0.0;
                    
                    // We only evaluate up to len-1 (the 25 closed ones)
                    let closed_klines = if klines.len() > 1 { &klines[0..klines.len()-1] } else { &klines[..] };
                    
                    for (i, k) in closed_klines.iter().enumerate() {
                        if let (Some(h_str), Some(l_str), Some(v_str)) = (k[2].as_str(), k[3].as_str(), k[5].as_str()) {
                            if let (Ok(h), Ok(l), Ok(v)) = (h_str.parse::<f64>(), l_str.parse::<f64>(), v_str.parse::<f64>()) {
                                if h > struct_high || i == 0 { struct_high = h; }
                                if l < struct_low || i == 0 { struct_low = l; }
                                total_vol += v;
                                
                                if i == closed_klines.len() - 1 { latest_vol = v; }
                            }
                        }
                    }
                    if !closed_klines.is_empty() {
                        avg_vol = (total_vol / closed_klines.len() as f64).max(1.0);
                    }
                }
            }

            let volatility = if struct_low > 0.0 { (struct_high - struct_low) / struct_low * 100.0 } else { 0.0 };
            let sweep_direction = if current_price > prev { "bullish" } else { "bearish" };
            let liquidity_swept = current_price >= struct_high || current_price <= struct_low;
            
            // --- NEW FEATURE: ABSORPTION ---
            // Calculate Delta vs Price Displacement
            // High volume compared to average, but very little price movement (relative to current price).
            let vol_ratio = latest_vol / avg_vol;
            let price_displacement_pct = price_delta / current_price;
            
            let is_absorption = vol_ratio > 1.5 && price_displacement_pct < 0.0002;

            // --- NEW FEATURE: LOGICAL HEATMAP ---
            // Simulate reading depth to map large limit blocks
            // Create a matrix of 10 nodes (5 above, 5 below)
            let tick_size = current_price * 0.0005; // 0.05% spacing
            let mut heatmap_nodes = Vec::new();
            for i in 1..=5 {
                heatmap_nodes.push(current_price + (tick_size * i as f64));
                heatmap_nodes.push(current_price - (tick_size * i as f64));
            }
            heatmap_nodes.sort_by(|a, b| a.partial_cmp(b).unwrap());

            // Emit LEVEL_1_PASSED event directly to Frontend/TypeScript
            let _ = app_handle.emit("LEVEL_1_PASSED", serde_json::json!({
                "directionBias": sweep_direction,
                "volatility": volatility,
                "liquiditySwept": liquidity_swept,
                "absorption": {
                    "detected": is_absorption,
                    "ratio": vol_ratio
                },
                "heatmapNodes": heatmap_nodes,
                "currentPrice": current_price
            }));
        }
        
        *self.prev_price.write().unwrap() = current_price;
    }

    pub fn unlock_sniper(&self) {
        self.has_open_position.store(false, Ordering::SeqCst);
        info!("🔓 [SNIPER] Trigger UNLOCKED. Ready for next shot.");
    }

    pub fn get(&self) -> SystemState {
        SystemState {
            has_open_position: self.has_open_position.load(Ordering::SeqCst),
            is_processing: self.is_processing.load(Ordering::SeqCst),
            analysis_count: self.analysis_count.load(Ordering::SeqCst),
            leverage: self.leverage.load(Ordering::SeqCst),
            price: *self.price.read().unwrap(),
        }
    }

    pub fn set_leverage(&self, val: u32) {
        self.leverage.store(val, Ordering::SeqCst);
    }

    pub fn set_position_open(&self, is_open: bool) {
        self.has_open_position.store(is_open, Ordering::SeqCst);
    }

    pub fn set_vol_trigger(&self, allow: bool) {
        self.allow_vol_trigger.store(allow, Ordering::SeqCst);
    }

    pub fn update_price(&self, new_price: f64) {
        *self.price.write().unwrap() = new_price;
    }
}
