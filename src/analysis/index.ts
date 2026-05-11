// @ts-nocheck
import { listen } from '@tauri-apps/api/event';
import { EventBus } from './event-bus';
import { candleManager } from './candle-manager';
import { maestro } from './engine';
import { ScalpEngine } from './scalp-engine';
import { FastPathEngine } from './fast-path-engine';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ANALYSIS PIPELINE — ENTRY POINT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module connects the Tauri Rust backend events to the TypeScript analysis
 * engines. It handles the real-time data flow from the Binance WebSocket 
 * through the institutional intelligence pipeline.
 */

export async function initAnalysisPipeline() {
    console.log('🚀 [Analysis] Starting Institutional Pipeline...');

    // 1. Initialize Engines
    maestro.init();
    ScalpEngine.init();
    FastPathEngine.subscribe();

    // 1.5 Fetch History to Bootstrap Indicators/Engines
    try {
        console.log('⏳ [Analysis] Fetching historical data (200m)...');
        const history = await invoke('fetch_historical_candles', { 
            symbol: 'BTCUSDT', 
            interval: '1m', 
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

    // 4. Cascading Pipeline Listeners
    const unlistenLevel1 = await listen('LEVEL_1_PASSED', (event) => {
        const payload = event.payload;
        EventBus.emit('LEVEL_1_PASSED', payload);
        // Let L2 engine process it
        if (maestro.processLevel1Signal) {
            maestro.processLevel1Signal(payload);
        }
    });

    console.log('✅ [Analysis] Pipeline Online & Listening to Tauri events.');

    // Return cleanup functions
    return () => {
        unlistenMarketTick();
        unlistenOrderFilled();
        unlistenTradeClosed();
        unlistenLevel1();
    };
}
