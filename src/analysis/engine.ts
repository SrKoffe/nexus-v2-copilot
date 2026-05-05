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

        console.log('[MAESTRO v2] Initializing Institutional Pipeline (Cascading L2)...');

        // Level 2: Listen for Level 1 Gatekeeper approval
        EventBus.on('LEVEL_1_PASSED', (l1Data) => {
            this.analyze(l1Data);
        });

        this.isInitialized = true;
    }

    async analyze(l1Data) {
        // Level 2 expects L1 data + access to candleManager
        const { candles1m } = require('./candle-manager').candleManager;
        if (!candles1m || candles1m.length === 0) return null;

        const candles = candles1m;
        const currentPrice = l1Data.currentPrice;

        this.lastAnalysisPrice = currentPrice;

        const store = require('../store').useNexusStore;
        store.getState().setPipelineStage(2, 'evaluating', l1Data.directionBias, 'Evaluating Confluence...');

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

            // 3. Confluence Scoring (Bidirectional)
            const confluenceResult = ConfluenceEngine.calculate(
                indicators, 
                {}, // patterns
                { rsi: true, macd: true, fvg: true, liquidity: true, structure: true }, // toggles
                { marketState: mse, liquidity: ill, volumeProfile: vpe }
            );

            // Level 2 Bidirectional Validation
            // We evaluate both LONG and SHORT setups.
            let direction = this._resolveDirection(mse, ill, confluenceResult);
            
            // Bias from L1 microstructure
            const l1Bias = l1Data.directionBias;
            if (direction.bias !== 'neutral' && direction.bias !== l1Bias) {
                console.log(`[LEVEL 2] Confluence direction (${direction.bias}) conflicts with L1 microstructure bias (${l1Bias}). Discarding.`);
                store.getState().setPipelineStage(2, 'rejected', l1Bias, `Direction conflict (L1=${l1Bias}, L2=${direction.bias})`);
                return null; // Conflict between L1 microstructure and L2 macro
            }
            
            let confidence = confluenceResult.confidence;
            
            // Correlation Penalty: if multiple order-flow signals align too perfectly, 
            // penalize slightly to prevent artificial confidence inflation.
            // L1 Volatility + L1 Swept + High MACD + RSI
            let correlatedSignals = 0;
            if (l1Data.liquiditySwept) correlatedSignals++;
            if (l1Data.volatility > 0.05) correlatedSignals++;
            if (indicators.rsi && (indicators.rsi > 70 || indicators.rsi < 30)) correlatedSignals++;
            
            if (correlatedSignals >= 3) {
                console.log(`[LEVEL 2] Applying correlation penalty (0.8x) due to ${correlatedSignals} stacked signals.`);
                confidence *= 0.8;
            }

            const probability = confidence / 100;

            // Baseline Level 2 threshold (Level 3 will refine this dynamically based on leverage)
            const baseL2Threshold = 0.50; 
            
            if (probability < baseL2Threshold || direction.bias === 'neutral') {
                store.getState().setPipelineStage(2, 'rejected', l1Bias, `Low Confluence (${Math.round(probability * 100)}%)`);
                return null;
            }

            store.getState().setPipelineStage(2, 'passed', direction.bias, `High Confluence (${Math.round(probability * 100)}%)`);

            // 4. Build Signal (Level 2 Passed)
            const finalSignal = {
                timestamp: Date.now(),
                direction: direction.bias,
                probability: probability,
                score: confluenceResult.score,
                source: direction.source,
                classification: confluenceResult.classification?.label || 'Neutral',
                breakdown: confluenceResult.breakdown,
                l1Data: l1Data, // Pass L1 data down the pipeline
                mse: { 
                    regime: mse.regime?.current, 
                    strength: mse.regime?.confidence 
                }
            };

            console.log(`🎯 [LEVEL 2] Directional Confluence: ${finalSignal.direction.toUpperCase()} (${(finalSignal.probability * 100).toFixed(0)}%)`);

            // EventBus.emit('ANALYSIS_SIGNAL', finalSignal); // Keep for UI logs if needed
            
            if (!this.isProcessing) {
                console.log(`✅ [LEVEL 2] PASSED. Emitting to Level 3 (Profit Gate & Dynamic Leverage)...`);
                
                // Emitting to Level 3
                this.isProcessing = true;
                const naturalSetup = {
                    id: `setup_${Date.now()}`,
                    symbol: 'BTC_USDT',
                    direction: direction.bias,
                    entryPrice: currentPrice,
                    confidence: probability,
                    reason: 'Level 2 Bidirectional Confluence',
                    timestamp: Date.now(),
                    l1Data: l1Data
                };
                
                EventBus.emit('LEVEL_2_PASSED', naturalSetup);
                
                setTimeout(() => { this.isProcessing = false; }, 100);
            }

            return finalSignal;
        } catch (error) {
            console.error('[MAESTRO] L2 Analysis error:', error);
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


}

export const maestro = new MasterAnalysisEngine();
