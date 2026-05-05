// @ts-nocheck
import { invoke } from '@tauri-apps/api/core';
import { EventBus } from './event-bus';
import { StateCache } from './state-cache';
import { Indicators } from './indicators';
import { MarketStateEngine } from './market-state';
import { LiquidityEngine } from './liquidity';
import { ScalpEngine } from './scalp-engine';
import { ConfluenceEngine } from './confluence';
import { VolumeProfile } from './volume-profile';

export class MasterAnalysisEngine {
    constructor() {
        this.isInitialized = false;
        this.lastSignal = null;
        this.isProcessing = false;
        this.lastAnalysisPrice = 0;  // v3.0: Price-triggered optimization
    }

    init() {
        if (this.isInitialized) return;

        console.log('[MAESTRO v2] Initializing Institutional Pipeline...');

        // v3.0: Optimized trigger system (Price Movement based)
        EventBus.on('TICK_UPDATE', (data) => {
            this.analyze(data);
        });

        EventBus.on('CANDLE_CLOSE', (data) => {
            this.analyze(data, true); // Force on candle close
        });

        this.isInitialized = true;
    }

    async analyze(marketData, force = false) {
        if (!marketData || !marketData.candles1m) return null;

        const candles = marketData.candles1m;
        const currentPrice = marketData.price || 
                           (candles.length > 0 ? candles[candles.length - 1].close : 0);

        // --- CPU OPTIMIZATION GATING ---
        if (!force && this.lastAnalysisPrice > 0) {
            const move = Math.abs(currentPrice - this.lastAnalysisPrice) / this.lastAnalysisPrice;
            if (move < 0.0005) return null; // 0.05% change threshold
        }
        this.lastAnalysisPrice = currentPrice;

        try {

            // 1. Run Engines
            const mse = MarketStateEngine.analyze(candles);
            const ill = LiquidityEngine.analyze(candles);
            const vpe = VolumeProfile.getSummary ? VolumeProfile.getSummary() : null;
            
            // 2. Calculate Indicators
            const indicators = {
                rsi: Indicators.RSI(candles.map(c => c.close)),
                macd: Indicators.MACD(candles.map(c => c.close)),
                bb: Indicators.BollingerBands(candles.map(c => c.close)),
                fvg: Indicators.FairValueGap(candles),
                atr: Indicators.ATR(candles),
                vwap: Indicators.VWAP(candles)
            };

            // 3. Confluence Scoring
            const confluenceResult = ConfluenceEngine.calculate(
                indicators, 
                {}, // patterns
                { rsi: true, macd: true, fvg: true, liquidity: true, structure: true }, // toggles
                { marketState: mse, liquidity: ill, volumeProfile: vpe }
            );

            const probability = confluenceResult.confidence / 100;
            const direction = this._resolveDirection(mse, ill, confluenceResult);

            // 4. Build Signal
            const finalSignal = {
                timestamp: Date.now(),
                direction: direction.bias,
                probability: confluenceResult.confidence / 100,
                score: confluenceResult.score,
                source: direction.source,
                classification: confluenceResult.classification?.label || 'Neutral',
                breakdown: confluenceResult.breakdown,
                mse: { 
                    regime: mse.regime?.current, 
                    strength: mse.regime?.confidence 
                },
                ill: { 
                    sweeps: ill.sweeps?.length || 0,
                    confirmed: ill.sweeps?.filter(s => s.confirmed).length || 0
                }
            };

            console.log(`🎯 [Analysis] Signal: ${finalSignal.direction.toUpperCase()} (${(finalSignal.probability * 100).toFixed(0)}%) | Source: ${finalSignal.source}`);
            if (confluenceResult.score !== 0) {
                console.log(`📊 [Confluence] Score: ${confluenceResult.score} | Confidence: ${confluenceResult.confidence}%`);
            }

            EventBus.emit('ANALYSIS_SIGNAL', finalSignal);

            // 5. Execution Gate: Leverage-Adaptive Thresholds (v4.0)
            const regime = mse.regime?.current || 'range';
            const volScore = ScalpEngine._state?.lastVolatilityScore || 50;
            const operatingMode = ScalpEngine._state?.currentMode || 'swing_scalp';
            
            // Mode-aware threshold: micro_scalp is more aggressive
            let executionThreshold = 0.65; // swing_scalp default
            if (operatingMode === 'micro_scalp') executionThreshold = 0.50;
            else if (operatingMode === 'hybrid') executionThreshold = 0.55;

            // Market condition modifiers (still apply on top)
            if (volScore > 70) executionThreshold += 0.10; // Pre-news / High noise filter
            if (regime === 'range' && operatingMode === 'swing_scalp') executionThreshold -= 0.10;

            // Co-pilot: when threshold reached, EMIT setup (no execution).
            // Frontend SetupCard renders it; user decides whether to trade on MEXC.
            if (probability >= executionThreshold && direction.bias !== 'neutral' && !this.isProcessing) {
                console.log(`📡 [SETUP] Threshold reached (${(probability*100).toFixed(0)}% >= ${(executionThreshold*100).toFixed(0)}%) mode=${operatingMode} — emitting recommendation`);
                this._emitSetup(direction.bias, probability, currentPrice);
            }

            return finalSignal;
        } catch (error) {
            console.error('[MAESTRO] Analysis error:', error);
            return null;
        }
    }

    _resolveDirection(mse, ill, confluence) {
        // 1. Priority: Institutional Sweeps (High conviction liquidity shift)
        if (ill && ill.sweeps && ill.sweeps.length > 0) {
            const sweep = ill.sweeps[ill.sweeps.length - 1];
            if (sweep.confirmed) {
                return { bias: sweep.direction === 'bullish' ? 'long' : 'short', source: 'Liquidity Sweep' };
            }
        }

        // 2. High Confidence Confluence (The 'Collective Intelligence')
        if (confluence && confluence.confidence >= 40) {
            if (confluence.signal === 'buy') return { bias: 'long', source: 'Confluence Buy' };
            if (confluence.signal === 'sell') return { bias: 'short', source: 'Confluence Sell' };
        }

        // 3. Market Structure Shift (Structural trend change)
        if (mse && mse.structure && mse.structure.lastMSS) {
            return { bias: mse.structure.lastMSS.direction === 'bullish' ? 'long' : 'short', source: 'MSS' };
        }

        // 4. Fallback: Neutral
        return { bias: 'neutral', source: 'Neutral' };
    }

    /**
     * Emit a structured setup recommendation to the frontend.
     *
     * Co-pilot mode: NEVER calls invoke('execute_auto_order'). The system only
     * surfaces high-confluence setups to Roberto, who decides and executes
     * manually on MEXC. The setup payload is consumed by <SetupCard /> and
     * (later) the LeverageAdjustedRiskEngine which recomputes SL/TP per leverage.
     */
    _emitSetup(direction, score, price) {
        this.isProcessing = true;
        try {
            const setup = ScalpEngine.calculateSetup(direction);

            const naturalSetup = {
                id: `setup_${Date.now()}`,
                symbol: 'BTC_USDT',     // MEXC contract format
                direction: direction,
                entryPrice: price,
                naturalStopLoss: setup.stopLoss,
                naturalTakeProfit: setup.takeProfit,
                confidence: score,
                reason: 'Institutional Confluence',
                timestamp: Date.now(),
            };

            console.log('[MAESTRO] 📡 Setup detected:', naturalSetup);
            // Co-pilot: emit to frontend so SetupCard renders + LeverageAdjustedRiskEngine
            // can recompute SL/TP based on user-selected leverage.
            EventBus.emit('SETUP_DETECTED', naturalSetup);
        } catch (error) {
            console.error('[MAESTRO] Setup emit error:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /** @deprecated Co-pilot does not auto-execute. Kept as no-op for any stale callers. */
    async _executeTrade(direction, score, price) {
        console.warn('[MAESTRO] _executeTrade is deprecated in co-pilot mode. Routing to _emitSetup.');
        this._emitSetup(direction, score, price);
    }
}

export const maestro = new MasterAnalysisEngine();
