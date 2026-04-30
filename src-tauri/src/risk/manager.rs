use log::info;

/// Risk Manager — controls position sizing and loss limits.
/// Ports `riskManager.ts` to Rust.
pub struct RiskManager {
    pub max_risk_pct: f64,             // Max risk per trade (1%)
    pub max_consecutive_losses: u32,    // Lock after N consecutive losses
    pub max_daily_loss_pct: f64,       // Max daily loss before shutdown
    pub consecutive_losses: u32,
    pub daily_pnl: f64,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RiskState {
    pub consecutive_losses: u32,
    pub daily_pnl: f64,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
}

impl RiskManager {
    pub fn new() -> Self {
        RiskManager {
            max_risk_pct: 0.01,
            max_consecutive_losses: 3,
            max_daily_loss_pct: 0.05,
            consecutive_losses: 0,
            daily_pnl: 0.0,
            is_locked: false,
            lock_reason: None,
        }
    }

    /// Calculate position size based on 1% capital risk
    pub fn calculate_position_size(&self, capital: f64, entry: f64, stop_loss: f64) -> f64 {
        let risk_amount = capital * self.max_risk_pct;
        let risk_distance = (entry - stop_loss).abs();
        if risk_distance <= 0.0 { return 0.0; }
        
        let size = risk_amount / risk_distance;
        // Round to 4 decimal places
        (size * 10000.0).floor() / 10000.0
    }

    /// Check if trading is allowed
    pub fn can_trade(&self) -> Result<(), String> {
        if self.is_locked {
            return Err(self.lock_reason.clone().unwrap_or("Risk locked".into()));
        }
        if self.daily_pnl <= -self.max_daily_loss_pct {
            return Err(format!("Daily loss limit reached: {:.2}%", self.daily_pnl * 100.0));
        }
        Ok(())
    }

    /// Record trade outcome
    pub fn record_outcome(&mut self, pnl_pct: f64) {
        self.daily_pnl += pnl_pct;

        if pnl_pct > 0.0 {
            self.consecutive_losses = 0;
            self.is_locked = false;
            self.lock_reason = None;
        } else {
            self.consecutive_losses += 1;
            if self.consecutive_losses >= self.max_consecutive_losses {
                self.is_locked = true;
                self.lock_reason = Some(format!(
                    "{} consecutive losses — cooling down",
                    self.consecutive_losses
                ));
                info!("[RiskManager] 🔒 LOCKED: {}", self.lock_reason.as_ref().unwrap());
            }
        }

        // Daily loss circuit breaker
        if self.daily_pnl <= -self.max_daily_loss_pct {
            self.is_locked = true;
            self.lock_reason = Some("Daily loss limit hit".into());
            info!("[RiskManager] 🛑 DAILY LIMIT HIT: {:.2}%", self.daily_pnl * 100.0);
        }
    }

    /// Reset daily stats
    pub fn reset_daily(&mut self) {
        self.daily_pnl = 0.0;
        self.consecutive_losses = 0;
        self.is_locked = false;
        self.lock_reason = None;
    }

    /// Get summary state for UI
    pub fn get_state(&self) -> RiskState {
        RiskState {
            consecutive_losses: self.consecutive_losses,
            daily_pnl: self.daily_pnl,
            is_locked: self.is_locked,
            lock_reason: self.lock_reason.clone(),
        }
    }
}

impl Default for RiskManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_position_sizing() {
        let rm = RiskManager::new();
        // $10,000 capital, entry $95,000, SL $94,000 (risk = $1,000 per coin)
        // 1% risk = $100, size = 100 / 1000 = 0.1 BTC
        let size = rm.calculate_position_size(10000.0, 95000.0, 94000.0);
        assert!((size - 0.1).abs() < 0.001);
    }

    #[test]
    fn test_consecutive_loss_lockout() {
        let mut rm = RiskManager::new();
        rm.record_outcome(-0.005); // Loss 1
        assert!(!rm.is_locked);
        rm.record_outcome(-0.005); // Loss 2
        assert!(!rm.is_locked);
        rm.record_outcome(-0.005); // Loss 3 → LOCKED
        assert!(rm.is_locked);
        assert!(rm.can_trade().is_err());
    }

    #[test]
    fn test_daily_loss_limit() {
        let mut rm = RiskManager::new();
        rm.record_outcome(-0.03); // -3%
        assert!(!rm.is_locked);
        rm.record_outcome(-0.025); // Total -5.5% → LOCKED
        assert!(rm.is_locked);
    }
}
