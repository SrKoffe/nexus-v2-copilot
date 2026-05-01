use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfluenceResult {
    pub score: i64,
    pub signal: String, // "buy" | "sell" | "hold"
    pub confidence: i64,
    pub suppressed: bool,
    pub regime: String,
    pub mode: String,   // "institutional"
    // Other fields omitted for brevity, but exist in memory
}

#[derive(Debug, Clone, Default)]
pub struct DimensionScore {
    pub score: f64,
    pub confidence: f64,
    pub contributors: usize,
    pub active: bool,
}

pub struct ConfluenceEngine {
    base_weights_trending_up: HashMap<&'static str, f64>,
    base_weights_trending_down: HashMap<&'static str, f64>,
    base_weights_range: HashMap<&'static str, f64>,
    base_weights_transition: HashMap<&'static str, f64>,
    base_weights_unknown: HashMap<&'static str, f64>,
    default_weights: HashMap<&'static str, f64>,
}

impl ConfluenceEngine {
    pub fn new() -> Self {
        let mut tu = HashMap::new();
        tu.insert("structure", 0.28); tu.insert("liquidity", 0.22);
        tu.insert("volume", 0.12); tu.insert("timeContext", 0.08);
        tu.insert("indicators", 0.03); tu.insert("futures", 0.02);
        tu.insert("volatility", 0.00); tu.insert("orderFlow", 0.25);

        let mut td = HashMap::new();
        td.insert("structure", 0.28); td.insert("liquidity", 0.22);
        td.insert("volume", 0.12); td.insert("timeContext", 0.08);
        td.insert("indicators", 0.03); td.insert("futures", 0.02);
        td.insert("volatility", 0.00); td.insert("orderFlow", 0.25);

        let mut rng = HashMap::new();
        rng.insert("structure", 0.15); rng.insert("liquidity", 0.30);
        rng.insert("volume", 0.15); rng.insert("timeContext", 0.10);
        rng.insert("indicators", 0.03); rng.insert("futures", 0.02);
        rng.insert("volatility", 0.00); rng.insert("orderFlow", 0.25);

        let mut tr = HashMap::new();
        tr.insert("structure", 0.22); tr.insert("liquidity", 0.22);
        tr.insert("volume", 0.14); tr.insert("timeContext", 0.08);
        tr.insert("indicators", 0.03); tr.insert("futures", 0.03);
        tr.insert("volatility", 0.00); tr.insert("orderFlow", 0.28);

        let mut unk = HashMap::new();
        unk.insert("structure", 0.25); unk.insert("liquidity", 0.25);
        unk.insert("volume", 0.15); unk.insert("timeContext", 0.10);
        unk.insert("indicators", 0.03); unk.insert("futures", 0.02);
        unk.insert("volatility", 0.00); unk.insert("orderFlow", 0.20);
        
        let mut def = HashMap::new();
        def.insert("structure", 0.25); def.insert("liquidity", 0.25);
        def.insert("volume", 0.15); def.insert("timeContext", 0.10);
        def.insert("indicators", 0.03); def.insert("futures", 0.02);
        def.insert("volatility", 0.00); def.insert("orderFlow", 0.20);

        Self {
            base_weights_trending_up: tu,
            base_weights_trending_down: td,
            base_weights_range: rng,
            base_weights_transition: tr,
            base_weights_unknown: unk,
            default_weights: def,
        }
    }

    /// Calculate the confluence score based purely on pre-computed dimension scores
    /// For the HFT Rust port, we bypass the huge nesting and pass pre-calculated dimensions
    pub fn calculate(
        &self, 
        regime: &str, 
        regime_strength: f64, 
        dimensions: &HashMap<String, DimensionScore>
    ) -> ConfluenceResult {
        
        // 1. Resolve Weights based on Regime
        let resolved_weights = self.resolve_weights(regime, regime_strength);
        
        // 2. Weighted Combination
        let raw_score = self.weighted_combine(dimensions, &resolved_weights);

        // 3. Rare Alignment Boost (mocked for now)
        let boosted_score = raw_score * 1.0; 

        // 4. Signal determination
        let mut signal = "hold".to_string();
        let final_score = boosted_score;
        let confidence = final_score.abs() as i64;
        
        if final_score > 15.0 && confidence >= 25 {
            signal = "buy".to_string();
        } else if final_score < -15.0 && confidence >= 25 {
            signal = "sell".to_string();
        }
        
        ConfluenceResult {
            score: final_score as i64,
            signal,
            confidence: confidence.min(100),
            suppressed: false,
            regime: regime.to_string(),
            mode: "institutional".to_string(),
        }
    }

    fn resolve_weights(&self, regime: &str, strength: f64) -> HashMap<String, f64> {
        let base = match regime {
            "trending_up" => &self.base_weights_trending_up,
            "trending_down" => &self.base_weights_trending_down,
            "range" => &self.base_weights_range,
            "transition" => &self.base_weights_transition,
            _ => &self.base_weights_unknown,
        };
        
        let mut weights = HashMap::new();
        let mut total = 0.0;
        
        for (k, def_val) in &self.default_weights {
            let regime_val = base.get(k).unwrap_or(def_val);
            let blended = (strength * regime_val) + ((1.0 - strength) * def_val);
            weights.insert(k.to_string(), blended);
            total += blended;
        }

        // Normalize
        for val in weights.values_mut() {
            *val = (*val / total * 1000.0).round() / 1000.0;
        }

        weights
    }

    fn weighted_combine(&self, dimensions: &HashMap<String, DimensionScore>, weights: &HashMap<String, f64>) -> f64 {
        let mut score = 0.0;
        for (dim, weight) in weights {
            if let Some(d) = dimensions.get(dim) {
                if d.active {
                    score += d.score * weight;
                }
            }
        }
        score
    }
}
