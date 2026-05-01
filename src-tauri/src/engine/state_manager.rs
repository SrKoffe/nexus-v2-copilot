use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use log::info;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::core::event_bus::{SystemEvent, TradeSignal};
use crate::engine::intent_engine::{IntentEngine, IntentResult};
use crate::strategy::probability::ProbabilityEngine;

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
    pub async fn analyze(&self, current_price: f64, app_handle: &tauri::AppHandle) -> Option<TradeSignal> {
        // 1. Single-Shot Sniper Lock
        if self.has_open_position.load(Ordering::SeqCst) || self.is_processing.load(Ordering::SeqCst) {
            return None; // Blind until trade resolves
        }

        let prev = *self.prev_price.read().unwrap();
        if prev == 0.0 {
            *self.prev_price.write().unwrap() = current_price;
            return None;
        }

        let price_delta = (current_price - prev).abs();
        
        // HFT Trigger: Evaluate deeply only if volatility spikes > 0.01% bridging tick latency
        let is_volatile = price_delta > current_price * 0.0001; 
        
        if is_volatile {
            if !self.allow_vol_trigger.load(Ordering::SeqCst) {
                *self.prev_price.write().unwrap() = current_price;
                return None;
            }
            
            self.is_processing.store(true, Ordering::SeqCst);

            let _ = app_handle.emit("analysis-signal", serde_json::json!({
                "message": format!("📝 Volatility spike detected (Δ {:.1} pts). Fetching last 25 candles...", price_delta),
                "level": "sys"
            }));
            
            // 2. Fetch last 25 closed candles for VSA (Volume Spread Analysis) & Structure
            let url = "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=26";
            
            let mut struct_high = current_price;
            let mut struct_low = current_price;
            let mut latest_vol = 0.0;
            let mut prev_vol = 0.0;
            let mut vol_delta = 0.0;
            
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
                                else if i >= 2 && i == closed_klines.len() - 2 { prev_vol = v; }
                            }
                        }
                    }
                    if !closed_klines.is_empty() {
                        let avg_vol = total_vol / closed_klines.len() as f64;
                        vol_delta = latest_vol - avg_vol;
                    }
                }
            }

            let volatility = if struct_low > 0.0 { (struct_high - struct_low) / struct_low * 100.0 } else { 0.0 };
            let sweep_direction = if current_price > prev { Some("bullish") } else { Some("bearish") };
            let liquidity_swept = current_price >= struct_high || current_price <= struct_low;
            
            let intent = IntentEngine::detect(
                current_price, latest_vol, prev_vol, struct_high, struct_low, vol_delta, volatility, liquidity_swept, sweep_direction
            );
            
            if intent.confidence > 0.4 {
                let _ = app_handle.emit("analysis-signal", serde_json::json!({
                    "message": format!("Intent Context: {} | Bias: {} | Score: {}%", intent.intent_type.to_uppercase(), intent.direction.to_uppercase(), (intent.confidence * 100.0).round()),
                    "level": "info"
                }));
                
                // 3. Probability & Confluence Model
                let prob_engine = ProbabilityEngine::new();
                let prob = prob_engine.calculate(intent.confidence + 0.15, 0.80);
                
                if prob.probability >= 0.65 {
                    self.analysis_count.fetch_add(1, Ordering::SeqCst);
                    let count = self.analysis_count.load(Ordering::SeqCst);
                    
                    let _ = app_handle.emit("analysis-signal", serde_json::json!({
                        "message": format!("🎯 CONFLUENCE HIT: {}% Win Probability! Engaging execution router...", (prob.probability * 100.0).round()),
                        "level": "warn"
                    }));
                    
                    // 4. Trade Execution Gate 
                    let risk_distance = current_price * 0.005; // 0.5% SL
                    let (sl, tp) = if intent.direction == "long" {
                        (current_price - risk_distance, current_price + (risk_distance * 2.0))
                    } else {
                        (current_price + risk_distance, current_price - (risk_distance * 2.0))
                    };

                    let signal = TradeSignal {
                        id: format!("trade_{}", count),
                        symbol: "BTC-PERP".to_string(),
                        direction: intent.direction.clone(),
                        entry_price: current_price,
                        quantity: 0.1, // Sized by risk manager
                        take_profit: Some(tp),
                        stop_loss: Some(sl),
                        leverage: Some(self.leverage.load(Ordering::SeqCst)),
                        reason: format!("{} | {}%", intent.intent_type, (prob.probability * 100.0).round()),
                        score: prob.probability,
                        is_bracket: true,
                    };

                    // Broadcast bracket orders to UI
                    let _ = app_handle.emit("analysis-signal", serde_json::json!({
                        "message": format!("ROUTING {}: Entry: ${:.1} | SL: ${:.1} | TP: ${:.1}", intent.direction.to_uppercase(), current_price, sl, tp),
                        "level": if intent.direction == "long" { "buy" } else { "sell" }
                    }));

                    // Lock the sniper!
                    self.has_open_position.store(true, Ordering::SeqCst);
                    self.is_processing.store(false, Ordering::SeqCst);

                    *self.prev_price.write().unwrap() = current_price;
                    return Some(signal);
                } else {
                     let _ = app_handle.emit("analysis-signal", serde_json::json!({
                        "message": format!("Aborting setup. Model probability too low: {}%", (prob.probability * 100.0).round()),
                        "level": "sys"
                    }));
                }
            }
        }
        
        self.is_processing.store(false, Ordering::SeqCst);
        *self.prev_price.write().unwrap() = current_price;
        None
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
