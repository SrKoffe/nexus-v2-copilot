use rusqlite::Connection;
use std::sync::Mutex;

/// SQLite database for persistent configuration storage.
/// Ports the Electron `database.ts` to Rust with thread-safe Mutex wrapper.
pub struct Database {
    conn: std::sync::Arc<Mutex<Connection>>,
}

impl Database {
    /// Initialize database with config table
    pub fn new(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trade_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                direction TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL,
                quantity REAL NOT NULL,
                pnl REAL,
                reason TEXT,
                factors TEXT,
                opened_at TEXT NOT NULL,
                closed_at TEXT,
                status TEXT DEFAULT 'open'
            );
            CREATE TABLE IF NOT EXISTS setup_outcomes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                setup_id TEXT NOT NULL,
                symbol TEXT NOT NULL,
                direction TEXT NOT NULL,
                leverage INTEGER NOT NULL,
                confidence REAL NOT NULL,
                classification TEXT NOT NULL,
                entry_price REAL NOT NULL,
                stop_loss REAL NOT NULL,
                take_profit_1 REAL NOT NULL,
                take_profit_2 REAL NOT NULL,
                outcome_label TEXT NOT NULL,
                pnl_pct REAL NOT NULL,
                detected_at_ms INTEGER NOT NULL,
                closed_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_setup_outcomes_closed ON setup_outcomes(closed_at_ms);"
        )?;

        Ok(Database {
            conn: std::sync::Arc::new(Mutex::new(conn)),
        })
    }

    /// Get a config value by key
    pub async fn get_config(&self, key: &str) -> Option<String> {
        let conn = self.conn.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.query_row(
                "SELECT value FROM config WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            ).ok()
        }).await.unwrap()
    }

    /// Set/update a config value
    pub async fn set_config(&self, key: &str, value: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.clone();
        let key = key.to_string();
        let value = value.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value],
            )?;
            Ok(())
        }).await.unwrap()
    }

    /// Record a new trade entry
    pub async fn record_trade_open(
        &self,
        symbol: &str,
        direction: &str,
        entry_price: f64,
        quantity: f64,
        reason: &str,
    ) -> Result<i64, rusqlite::Error> {
        let conn = self.conn.clone();
        let symbol = symbol.to_string();
        let direction = direction.to_string();
        let reason = reason.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT INTO trade_history (symbol, direction, entry_price, quantity, reason, opened_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
                rusqlite::params![symbol, direction, entry_price, quantity, reason],
            )?;
            Ok(conn.last_insert_rowid())
        }).await.unwrap()
    }

    /// Record a trade closure
    pub async fn record_trade_close(
        &self,
        id: i64,
        exit_price: f64,
        pnl: f64,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "UPDATE trade_history SET exit_price = ?1, pnl = ?2, closed_at = datetime('now'), status = 'closed' WHERE id = ?3",
                rusqlite::params![exit_price, pnl, id],
            )?;
            Ok(())
        }).await.unwrap()
    }

    /// Get recent trade history
    pub async fn get_recent_trades(&self, limit: u32) -> Vec<TradeRecord> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, symbol, direction, entry_price, exit_price, quantity, pnl, reason, opened_at, closed_at, status
                 FROM trade_history ORDER BY id DESC LIMIT ?1"
            ).unwrap();

            stmt.query_map(rusqlite::params![limit], |row| {
                Ok(TradeRecord {
                    id: row.get(0)?,
                    symbol: row.get(1)?,
                    direction: row.get(2)?,
                    entry_price: row.get(3)?,
                    exit_price: row.get(4)?,
                    quantity: row.get(5)?,
                    pnl: row.get(6)?,
                    reason: row.get(7)?,
                    opened_at: row.get(8)?,
                    closed_at: row.get(9)?,
                    status: row.get(10)?,
                })
            }).unwrap().filter_map(|r| r.ok()).collect()
        }).await.unwrap()
    }

    /// Get win rate for a specific strategy/setup type
    pub async fn get_win_rate(&self, reason: &str) -> (u32, u32, f64) {
        let conn = self.conn.clone();
        let escaped_reason = reason.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT COUNT(*) as total,
                        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
                 FROM trade_history WHERE reason LIKE ?1 ESCAPE '\\' AND status = 'closed'"
            ).unwrap();

            let result: (u32, u32) = stmt.query_row(
                rusqlite::params![format!("%{}%", escaped_reason)],
                |row| Ok((row.get(0)?, row.get::<_, Option<u32>>(1)?.unwrap_or(0))),
            ).unwrap_or((0, 0));

            let win_rate = if result.0 > 0 { result.1 as f64 / result.0 as f64 } else { 0.0 };
            (result.0, result.1, win_rate)
        }).await.unwrap()
    }
}

/// Trade record from database
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TradeRecord {
    pub id: i64,
    pub symbol: String,
    pub direction: String,
    pub entry_price: f64,
    pub exit_price: Option<f64>,
    pub quantity: f64,
    pub pnl: Option<f64>,
    pub reason: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub status: String,
}

/// Setup outcome record (F8): full metadata for the weekly report.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SetupOutcome {
    pub id: i64,
    pub setup_id: String,
    pub symbol: String,
    pub direction: String,
    pub leverage: u32,
    pub confidence: f64,
    pub classification: String,
    pub entry_price: f64,
    pub stop_loss: f64,
    pub take_profit_1: f64,
    pub take_profit_2: f64,
    pub outcome_label: String,
    pub pnl_pct: f64,
    pub detected_at_ms: i64,
    pub closed_at_ms: i64,
}

impl Database {
    /// Persist a marked outcome (F8a). Called from `record_setup_outcome` Tauri cmd.
    pub async fn record_setup_outcome(&self, o: &SetupOutcome) -> Result<i64, rusqlite::Error> {
        let conn = self.conn.clone();
        let o = o.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT INTO setup_outcomes (
                    setup_id, symbol, direction, leverage, confidence, classification,
                    entry_price, stop_loss, take_profit_1, take_profit_2,
                    outcome_label, pnl_pct, detected_at_ms, closed_at_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                rusqlite::params![
                    o.setup_id, o.symbol, o.direction, o.leverage, o.confidence, o.classification,
                    o.entry_price, o.stop_loss, o.take_profit_1, o.take_profit_2,
                    o.outcome_label, o.pnl_pct, o.detected_at_ms, o.closed_at_ms
                ],
            )?;
            Ok(conn.last_insert_rowid())
        }).await.unwrap()
    }

    /// Query outcomes within a [start, end) ms range — used by weekly report.
    pub async fn query_setup_outcomes(&self, start_ms: i64, end_ms: i64) -> Vec<SetupOutcome> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = match conn.prepare(
                "SELECT id, setup_id, symbol, direction, leverage, confidence, classification,
                        entry_price, stop_loss, take_profit_1, take_profit_2,
                        outcome_label, pnl_pct, detected_at_ms, closed_at_ms
                 FROM setup_outcomes
                 WHERE closed_at_ms >= ?1 AND closed_at_ms < ?2
                 ORDER BY closed_at_ms ASC"
            ) {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };

            stmt.query_map(rusqlite::params![start_ms, end_ms], |row| {
                Ok(SetupOutcome {
                    id: row.get(0)?,
                    setup_id: row.get(1)?,
                    symbol: row.get(2)?,
                    direction: row.get(3)?,
                    leverage: row.get(4)?,
                    confidence: row.get(5)?,
                    classification: row.get(6)?,
                    entry_price: row.get(7)?,
                    stop_loss: row.get(8)?,
                    take_profit_1: row.get(9)?,
                    take_profit_2: row.get(10)?,
                    outcome_label: row.get(11)?,
                    pnl_pct: row.get(12)?,
                    detected_at_ms: row.get(13)?,
                    closed_at_ms: row.get(14)?,
                })
            }).map(|iter| iter.filter_map(|r| r.ok()).collect()).unwrap_or_else(|_| Vec::new())
        }).await.unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_config_crud() {
        let db = Database::new(":memory:").unwrap();

        // Set config
        db.set_config("HL_PRIVATE_KEY", "test_key_123").await.unwrap();

        // Get config
        let val = db.get_config("HL_PRIVATE_KEY").await;
        assert_eq!(val, Some("test_key_123".to_string()));

        // Update config
        db.set_config("HL_PRIVATE_KEY", "new_key_456").await.unwrap();
        let val = db.get_config("HL_PRIVATE_KEY").await;
        assert_eq!(val, Some("new_key_456".to_string()));

        // Non-existent key
        let val = db.get_config("NON_EXISTENT").await;
        assert_eq!(val, None);
    }

    #[tokio::test]
    async fn test_trade_history() {
        let db = Database::new(":memory:").unwrap();

        let id = db.record_trade_open("BTC-PERP", "long", 95000.0, 0.1, "Sweep+MSS").await.unwrap();
        assert!(id > 0);

        db.record_trade_close(id, 96000.0, 100.0).await.unwrap();

        let trades = db.get_recent_trades(10).await;
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].symbol, "BTC-PERP");
        assert_eq!(trades[0].pnl, Some(100.0));
        assert_eq!(trades[0].status, "closed");
    }

    #[tokio::test]
    async fn test_win_rate_with_wildcards() {
        let db = Database::new(":memory:").unwrap();

        // One trade with reason containing exactly 100%
        let id = db.record_trade_open("BTC-PERP", "long", 95000.0, 0.1, "100%_profit").await.unwrap();
        db.record_trade_close(id, 96000.0, 100.0).await.unwrap();

        // One trade with similar pattern but not exactly "100%"
        let id = db.record_trade_open("BTC-PERP", "short", 95000.0, 0.1, "1000_profit").await.unwrap();
        db.record_trade_close(id, 96000.0, -50.0).await.unwrap();

        // The search should match only the literal "100%"
        let (total, wins, _) = db.get_win_rate("100%").await;
        assert_eq!(total, 1);
        assert_eq!(wins, 1);
    }

    #[tokio::test]
    async fn test_win_rate() {
        let db = Database::new(":memory:").unwrap();

        // Record 3 wins and 1 loss
        for i in 0..3 {
            let id = db.record_trade_open("BTC-PERP", "long", 95000.0, 0.1, "Sweep+MSS").await.unwrap();
            db.record_trade_close(id, 96000.0, 100.0).await.unwrap();
        }
        let id = db.record_trade_open("BTC-PERP", "short", 95000.0, 0.1, "Sweep+MSS").await.unwrap();
        db.record_trade_close(id, 96000.0, -50.0).await.unwrap();

        let (total, wins, wr) = db.get_win_rate("Sweep").await;
        assert_eq!(total, 4);
        assert_eq!(wins, 3);
        assert!((wr - 0.75).abs() < 0.01);
    }
}
