// ═══════════════════════════════════════════════════════════════════════════════
// NEXUS V2 — MEXC Trading Co-Pilot
// Core Library — Tauri Entry Point
// ═══════════════════════════════════════════════════════════════════════════════

pub mod core;
pub mod market_data;
pub mod execution;
pub mod risk;
pub mod strategy;
pub mod engine;

use std::sync::Arc;
use tokio::sync::Mutex;
use tauri_plugin_fs::FsExt;
use tauri::Manager;

use core::database::Database;
use core::event_bus::EventBus;
use execution::engine::ExecutionEngine;
use engine::state_manager::{StateManager, SystemState};
use market_data::websocket::MexcStream;
use market_data::scanner::UniverseScanner;
use market_data::mexc_private::{MexcPrivateClient, AccountAsset, OpenPosition, try_build_from_env};
use risk::manager::RiskManager;

// ─── Phase 4 Commands ────────────────────────────────────────────────────────

#[tauri::command]
fn set_active_analysis_symbol(symbol: String, symbol_tx: tauri::State<'_, tokio::sync::watch::Sender<String>>) -> Result<(), String> {
    log::info!("[TAURI CMD] Changing active analysis symbol to {}", symbol);
    symbol_tx.send(symbol).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── TAURI STATE ────────────────────────────────────────────────────────────
// These are wrapped in Arc for thread-safe sharing across Tauri commands

struct AppState {
    db: Arc<Database>,
    event_bus: Arc<EventBus>,
    execution: Arc<ExecutionEngine>,
    state_manager: Arc<StateManager>,
    risk_manager: Arc<Mutex<RiskManager>>,
    /// MEXC private API client. None if API keys not set in .env — Tauri commands
    /// then return informative errors instead of crashing.
    mexc_private: Option<Arc<MexcPrivateClient>>,
}

// ─── IPC COMMANDS (Replace Electron ipcMain.handle) ─────────────────────────

/// Get a config value from SQLite
#[tauri::command]
async fn get_config(state: tauri::State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    Ok(state.db.get_config(&key).await)
}

/// Save a config value to SQLite
#[tauri::command]
async fn save_config(state: tauri::State<'_, AppState>, key: String, value: String) -> Result<bool, String> {
    state.db.set_config(&key, &value).await.map_err(|e| e.to_string())?;
    Ok(true)
}

// ─── REMOVED in F5 (Oracle permanent) ──────────────────────────────────────
// `toggle_live_trading` and `toggle_oracle_mode` were deleted because Nexus V2
// is co-pilot only. Execution is permanently disabled at the engine level
// (see ExecutionEngine in src/execution/engine.rs). Re-enabling autonomous
// execution must be done as a deliberate, audited code change — not a runtime
// toggle. This eliminates the chance that a UI bug or compromised state ever
// flips the system into live-trading mode.

/// Get current system state
#[tauri::command]
async fn get_system_state(state: tauri::State<'_, AppState>) -> Result<SystemState, String> {
    Ok(state.state_manager.get())
}

/// Set leverage
#[tauri::command]
async fn set_leverage(state: tauri::State<'_, AppState>, leverage: u32) -> Result<(), String> {
    state.state_manager.set_leverage(leverage);
    Ok(())
}

/// Get recent trade history
#[tauri::command]
async fn get_trade_history(state: tauri::State<'_, AppState>, limit: u32) -> Result<Vec<core::database::TradeRecord>, String> {
    Ok(state.db.get_recent_trades(limit).await)
}

/// Get win rate for a setup type
#[tauri::command]
async fn get_win_rate(state: tauri::State<'_, AppState>, reason: String) -> Result<(u32, u32, f64), String> {
    Ok(state.db.get_win_rate(&reason).await)
}

/// Execute an auto order (from AI analysis)
#[tauri::command]
async fn execute_auto_order(
    state: tauri::State<'_, AppState>,
    signal: core::event_bus::TradeSignal,
) -> Result<core::event_bus::OrderResult, String> {
    // Risk check
    {
        let rm = state.risk_manager.lock().await;
        rm.can_trade().map_err(|e| e)?;
    }

    let result = state.execution.execute_with_protection(&signal).await;

    if result.success {
        state.state_manager.set_position_open(true);
    }

    Ok(result)
}

/// Get active position
#[tauri::command]
async fn get_active_position(state: tauri::State<'_, AppState>) -> Result<Option<execution::types::Position>, String> {
    Ok(state.execution.get_active_position().await)
}

/// Record trade outcome (updates risk manager)
#[tauri::command]
async fn record_trade_outcome(state: tauri::State<'_, AppState>, outcome: core::event_bus::TradeOutcome) -> Result<(), String> {
    let mut rm = state.risk_manager.lock().await;
    rm.record_outcome(outcome.pnl_pct);
    state.event_bus.emit(core::event_bus::SystemEvent::TradeClosed(outcome));
    Ok(())
}

/// Get current risk manager state
#[tauri::command]
async fn get_risk_state(state: tauri::State<'_, AppState>) -> Result<risk::manager::RiskState, String> {
    let rm = state.risk_manager.lock().await;
    Ok(rm.get_state())
}

#[tauri::command]
async fn fetch_historical_candles(
    _state: tauri::State<'_, AppState>,
    symbol: String,
    interval: String,
    limit: u32,
) -> Result<Vec<market_data::types::Kline>, String> {
    market_data::history::fetch_mexc_klines(&symbol, &interval, limit).await
}

#[tauri::command]
fn set_vol_trigger(state: tauri::State<AppState>, allow: bool) {
    state.state_manager.set_vol_trigger(allow);
    log::info!("⚡ [CONFIG] Volatility Trigger: {}", if allow { "ENABLED" } else { "DISABLED" });
}

// ─── MEXC Private API (read-only) — F6 ─────────────────────────────────────

/// Get MEXC futures USDT equity (available + frozen + unrealized).
/// Returns Err with explanation if .env doesn't have MEXC_API_KEY/SECRET.
#[tauri::command]
async fn get_mexc_balance(state: tauri::State<'_, AppState>) -> Result<f64, String> {
    let client = state
        .mexc_private
        .as_ref()
        .ok_or("MEXC API keys not set. Add MEXC_API_KEY and MEXC_API_SECRET to .env (read-only key).")?;
    client.fetch_usdt_equity().await
}

/// Get all account assets (more detail than just balance).
#[tauri::command]
async fn get_mexc_account(state: tauri::State<'_, AppState>) -> Result<Vec<AccountAsset>, String> {
    let client = state
        .mexc_private
        .as_ref()
        .ok_or("MEXC API keys not set in .env")?;
    client.fetch_account_assets().await
}

/// Get all open positions on MEXC futures.
#[tauri::command]
async fn get_mexc_positions(state: tauri::State<'_, AppState>) -> Result<Vec<OpenPosition>, String> {
    let client = state
        .mexc_private
        .as_ref()
        .ok_or("MEXC API keys not set in .env")?;
    client.fetch_open_positions().await
}

/// Quick check: are MEXC API keys configured? Used by frontend to show/hide
/// the "configure API key" prompt.
#[tauri::command]
fn mexc_keys_configured(state: tauri::State<AppState>) -> bool {
    state.mexc_private.is_some()
}

// ─── Setup outcomes persistence + weekly report (F8) ───────────────────────

/// Persist a marked outcome with full metadata (symbol, leverage, classification, etc).
/// Replaces the older minimalistic `record_trade_outcome` for the F8 reporting flow.
#[tauri::command]
async fn record_setup_outcome(
    state: tauri::State<'_, AppState>,
    outcome: core::database::SetupOutcome,
) -> Result<i64, String> {
    // Also feed RiskManager so daily PnL / consecutive-loss lockout updates.
    {
        let mut rm = state.risk_manager.lock().await;
        rm.record_outcome(outcome.pnl_pct / 100.0); // store keeps fraction
    }
    state.db.record_setup_outcome(&outcome).await.map_err(|e| e.to_string())
}

/// Query outcomes within a [start_ms, end_ms) range. Used by the weekly report.
#[tauri::command]
async fn query_setup_outcomes(
    state: tauri::State<'_, AppState>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<core::database::SetupOutcome>, String> {
    Ok(state.db.query_setup_outcomes(start_ms, end_ms).await)
}

/// Write a markdown report to a host file path. Used to drop weekly reports
/// into the user's Obsidian vault (or any path they choose).
#[tauri::command]
fn write_report_to_vault(app: tauri::AppHandle, path: String, content: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);

    // Utilize Tauri's fs scope API to restrict write access and prevent Path Traversal
    let scope = app.fs_scope();
    if !scope.is_allowed(&p) {
        return Err(format!("Path access denied by fs scope: {}", path));
    }

    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir {:?}: {}", parent, e))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("Failed to write {}: {}", path, e))?;
    Ok(path)
}

// ─── TAURI ENTRY POINT ─────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize database — stored under %APPDATA%\nexus-v2-copilot\nexus.db on Windows
    let db_path = dirs_next::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("nexus-v2-copilot")
        .join("nexus.db");

    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let db = Arc::new(
        Database::new(db_path.to_str().unwrap_or("nexus.db"))
            .expect("Failed to initialize database")
    );

    let event_bus = Arc::new(EventBus::new());
    let execution = Arc::new(ExecutionEngine::new(db.clone()));
    let state_manager = Arc::new(StateManager::new());
    let risk_manager = Arc::new(Mutex::new(RiskManager::new()));
    let mexc_private = try_build_from_env().map(Arc::new);

    let app_state = AppState {
        db,
        event_bus: event_bus.clone(),
        execution: execution.clone(),
        state_manager: state_manager.clone(),
        risk_manager,
        mexc_private,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_system_state,
            set_leverage,
            get_trade_history,
            get_win_rate,
            execute_auto_order,    // permanently returns blocked — kept for audit trail
            get_active_position,
            set_vol_trigger,
            record_trade_outcome,
            get_risk_state,
            fetch_historical_candles,
            // F6: MEXC private API (read-only)
            get_mexc_balance,
            get_mexc_account,
            get_mexc_positions,
            mexc_keys_configured,
            // F8: outcome persistence + weekly report
            record_setup_outcome,
            query_setup_outcomes,
            write_report_to_vault,
            set_active_analysis_symbol,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            let (symbol_tx, symbol_rx) = tokio::sync::watch::channel("BTC_USDT".to_string());
            handle.manage(symbol_tx);

            // Start MEXC futures WebSocket stream
            let mexc = MexcStream::new(symbol_rx);
            let sender = event_bus.sender();
            mexc.start(sender.clone(), handle.clone());

            // Phase 1: Start Universe Scanner
            let scanner = UniverseScanner::new();
            scanner.start(sender, handle.clone());

            // Tick listener — only job in co-pilot mode is keeping StateManager's
            // price field current for any future feature that needs the latest tick.
            //
            // Removed in v5.2-fix (zombie path): `sm.analyze(tick.price, &handle)`
            // was reactivated by another agent and was hitting fapi.binance.com
            // hardcoded with symbol BTCUSDT on EVERY tick. This caused:
            //   - 100s of fetches/min to the wrong exchange
            //   - Inconsistent data (Binance prices feeding MEXC pipeline)
            //   - Symbol drift on multi-symbol switching
            // Level-1 gatekeeper logic now lives in the React analysis pipeline
            // which uses MEXC candles loaded via fetch_historical_candles.
            let sm = state_manager.clone();
            let mut rx = event_bus.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(core::event_bus::SystemEvent::MarketTick(tick)) => {
                            sm.update_price(tick.price);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            log::warn!("[StateUpdater] Skipped {} events", n);
                        }
                        _ => {}
                    }
                }
            });

            log::info!("🛸 NEXUS V2 CO-PILOT — All systems online (MEXC futures)");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
