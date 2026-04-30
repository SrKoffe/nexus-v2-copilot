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

use core::database::Database;
use core::event_bus::EventBus;
use execution::engine::ExecutionEngine;
use engine::state_manager::{StateManager, SystemState};
use market_data::websocket::MexcStream;
use risk::manager::RiskManager;

// ─── TAURI STATE ────────────────────────────────────────────────────────────
// These are wrapped in Arc for thread-safe sharing across Tauri commands

struct AppState {
    db: Arc<Database>,
    event_bus: Arc<EventBus>,
    execution: Arc<ExecutionEngine>,
    state_manager: Arc<StateManager>,
    risk_manager: Arc<Mutex<RiskManager>>,
}

// ─── IPC COMMANDS (Replace Electron ipcMain.handle) ─────────────────────────

/// Get a config value from SQLite
#[tauri::command]
async fn get_config(state: tauri::State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    Ok(state.db.get_config(&key))
}

/// Save a config value to SQLite
#[tauri::command]
async fn save_config(state: tauri::State<'_, AppState>, key: String, value: String) -> Result<bool, String> {
    state.db.set_config(&key, &value).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Toggle live trading mode
#[tauri::command]
async fn toggle_live_trading(state: tauri::State<'_, AppState>, is_live: bool) -> Result<(), String> {
    state.execution.set_live_trading(is_live);
    Ok(())
}

/// Toggle oracle mode (blocks all execution)
#[tauri::command]
async fn toggle_oracle_mode(state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.execution.set_oracle_mode(enabled);
    Ok(())
}

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
    Ok(state.db.get_recent_trades(limit))
}

/// Get win rate for a setup type
#[tauri::command]
async fn get_win_rate(state: tauri::State<'_, AppState>, reason: String) -> Result<(u32, u32, f64), String> {
    Ok(state.db.get_win_rate(&reason))
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

// ─── TAURI ENTRY POINT ─────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize database
    let db_path = dirs_next::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("antigravity-v2")
        .join("antigravity.db");

    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let db = Arc::new(
        Database::new(db_path.to_str().unwrap_or("antigravity.db"))
            .expect("Failed to initialize database")
    );

    let event_bus = Arc::new(EventBus::new());
    let execution = Arc::new(ExecutionEngine::new(db.clone()));
    let state_manager = Arc::new(StateManager::new());
    let risk_manager = Arc::new(Mutex::new(RiskManager::new()));

    let app_state = AppState {
        db,
        event_bus: event_bus.clone(),
        execution: execution.clone(),
        state_manager: state_manager.clone(),
        risk_manager,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            toggle_live_trading,
            toggle_oracle_mode,
            get_system_state,
            set_leverage,
            get_trade_history,
            get_win_rate,
            execute_auto_order,
            get_active_position,
            set_vol_trigger,
            record_trade_outcome,
            get_risk_state,
            fetch_historical_candles,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Start MEXC futures WebSocket stream
            // Symbol uses MEXC contract format with underscore: BTC_USDT, ETH_USDT, etc.
            let mexc = MexcStream::new("BTC_USDT");
            let sender = event_bus.sender();
            mexc.start(sender, handle.clone());

            // Start state price updater and Position Tracker — listens to ticks and updates StateManager
            let sm = state_manager.clone();
            let exec_tracker = execution.clone();
            let mut rx = event_bus.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(core::event_bus::SystemEvent::MarketTick(tick)) => {
                            sm.update_price(tick.price);
                            
                            // 📡 Analysis pipeline is now handled by the React frontend
                            // for maximum institutional edge and visual feedback.
                            
                            // 🎯 Position Tracker Logic (Check SL/TP)
                            if let Some(pos) = exec_tracker.get_active_position().await {
                                let mut should_close = false;
                                let is_long = pos.direction == execution::types::Direction::Long;
                                
                                if is_long {
                                    if tick.price >= pos.take_profit.unwrap_or(f64::MAX) || tick.price <= pos.stop_loss.unwrap_or(0.0) {
                                        should_close = true;
                                    }
                                } else {
                                    if tick.price <= pos.take_profit.unwrap_or(0.0) || tick.price >= pos.stop_loss.unwrap_or(f64::MAX) {
                                        should_close = true;
                                    }
                                }

                                if should_close {
                                    exec_tracker.close_position().await;
                                    sm.unlock_sniper();
                                }
                            }
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
