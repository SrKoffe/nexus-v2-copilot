use serde::{Deserialize, Serialize};

/// Output of the Probability Engine
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbabilityResult {
    pub probability: f64,       // 0.0 to 1.0
    pub order_flow_score: f64,  // 0.0 to 1.0
    pub structure_score: f64,   // 0.0 to 1.0
}

pub struct ProbabilityEngine {
    weight_order_flow: f64,
    weight_structure: f64,
}

impl ProbabilityEngine {
    pub fn new() -> Self {
        Self {
            weight_order_flow: 0.50,
            weight_structure: 0.50,
        }
    }

    /// Calculate probability using institutional 2-axis model (Order Flow & Structure).
    pub fn calculate(&self, order_flow_score: f64, structure_score: f64) -> ProbabilityResult {
        let base_prob = (order_flow_score * self.weight_order_flow) +
                        (structure_score * self.weight_structure);
        
        // Confluence bonus: if both axes agree strongly (> 0.7), boost
        let mut final_prob = base_prob;
        if order_flow_score > 0.7 && structure_score > 0.7 {
            final_prob += 0.10; // Rare alignment bonus
        }
        
        ProbabilityResult {
            probability: final_prob.clamp(0.0, 1.0),
            order_flow_score,
            structure_score,
        }
    }

    /// Dynamic weight update from Learning Engine feedback.
    pub fn update_weights(&mut self, weight_of: f64, weight_struct: f64) {
        self.weight_order_flow = weight_of;
        self.weight_structure = weight_struct;
    }
}
