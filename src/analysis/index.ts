// @ts-nocheck
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { EventBus } from './event-bus';
import { candleManager } from './candle-manager';
import { maestro } from './engine';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ANALYSIS PIPELINE — ENTRY POINT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Connects the Tauri Rust backend events to the TypeScript analysis engines.
 * Real-time data flow from MEXC futures WebSocket → ConfluenceEngine 2.0
 * (8-dimension institutional pipeline) → frontend signals.
 */

export async function initAnalysisPipeline() {
    console.log('🚀 [Analysis] Starting Institutional Pipeline...');

    // 1. Initialize Engines
    maestro.init();

    // 1.5 Fetch History to Bootstrap Indicators/Engines
    try {
        console.log('⏳ [Analysis] Fetching historical data (200m from MEXC)...');
        const history = await invoke('fetch_historical_candles', {
            symbol: 'BTC_USDT',   // MEXC contract format (underscore)
            interval: 'Min1',     // MEXC interval label
            limit: 200
        });
        
        if (history && history.length > 0) {
            candleManager.setHistory(history);
            // Trigger an initial analysis with the full historical set
            maestro.analyze({
                candles1m: candleManager.candles1m,
                candles5m: candleManager.candles5m
            });
        }
    } catch (err) {
        console.error('❌ [Analysis] Failed to fetch history:', err);
    }

    // 2. Listen for Tauri Backend Events
    const unlistenMarketTick = await listen('market-tick', (event) => {
        const tick = event.payload;
        
        // Feed the CandleManager to build OHLC data
        candleManager.addTick(tick);
        
        // Also emit to internal EventBus for any real-time listeners
        EventBus.emit('MARKET_TICK', tick);
    });

    // 3. Listen for Order Events (to unlock sniper/update state)
    const unlistenOrderFilled = await listen('order-filled', (event) => {
        console.log('🎯 [Analysis] Order Filled:', event.payload);
        EventBus.emit('ORDER_FILLED', event.payload);
    });

    const unlistenTradeClosed = await listen('trade-closed', (event) => {
        console.log('🔓 [Analysis] Trade Closed, unlocking sniper.', event.payload);
        EventBus.emit('TRADE_CLOSED', event.payload);
    });

    console.log('✅ [Analysis] Pipeline Online & Listening to Tauri events.');

    // Return cleanup functions
    return () => {
        unlistenMarketTick();
        unlistenOrderFilled();
        unlistenTradeClosed();
    };
}
