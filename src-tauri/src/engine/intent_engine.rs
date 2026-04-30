use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentResult {
    pub intent_type: String, // "breakout" | "sweep" | "unknown"
    pub confidence: f64,     // 0.0 to 1.0
    pub direction: String,   // "long" | "short" | "neutral"
}

pub struct IntentEngine;

impl IntentEngine {
    /// Classifies market intent as either a breakout or a liquidity sweep
    /// Used primarily for context and UI logging, not execution triggers.
    pub fn detect(
        last_close: f64,
        last_volume: f64,
        prev_volume: f64,
        struct_high: f64,
        struct_low: f64,
        vol_delta: f64,
        volatility: f64,
        liquidity_swept: bool,
        sweep_direction: Option<&str>,
    ) -> IntentResult {
        let mut breakout_score: f64 = 0.0;
        let mut sweep_score: f64 = 0.0;

        // --- Breakout Detection ---
        let is_bull_breakout = last_close > struct_high && vol_delta > 0.0;
        let is_bear_breakout = last_close < struct_low && vol_delta < 0.0;
        
        if is_bull_breakout || is_bear_breakout {
            breakout_score += 60.0;
            if volatility > 1.5 {
                breakout_score += 20.0;
            }
        }

        // --- Sweep Detection ---
        if liquidity_swept {
            sweep_score += 70.0;
            // Boost if volume confirms the sweep rejection
            if last_volume > prev_volume * 1.5 {
                sweep_score += 15.0;
            }
        }

        let max_score = breakout_score.max(sweep_score);
        
        if max_score > 40.0 {
            let intent_type = if sweep_score > breakout_score {
                "sweep".to_string()
            } else {
                "breakout".to_string()
            };
            
            let direction = if is_bull_breakout || sweep_direction == Some("bullish") {
                "long".to_string()
            } else {
                "short".to_string()
            };

            return IntentResult {
                intent_type,
                confidence: max_score / 100.0,
                direction,
            };
        }

        IntentResult {
            intent_type: "unknown".to_string(),
            confidence: 0.0,
            direction: "neutral".to_string(),
        }
    }
}
