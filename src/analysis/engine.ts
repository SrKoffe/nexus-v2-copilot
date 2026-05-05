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

            // 5. Execution Gate: Dynamic Thresholds
            const regime = mse.regime?.current || 'range';
            const volScore = ScalpEngine._state?.lastVolatilityScore || 50;
            
            // Adapt threshold to market conditions
            let executionThreshold = 0.65; // Standard
            if (volScore > 70) executionThreshold = 0.75; // Pre-news / High noise filter
            if (regime === 'range') executionThreshold = 0.55; // Earlier entry in accumulation

            if (probability >= executionThreshold && direction.bias !== 'neutral' && !this.isProcessing) {
                console.log(`🚀 [EXECUTION] Threshold reached (${(probability*100).toFixed(0)}% >= ${(executionThreshold*100).toFixed(0)}%)`);
                await this._executeTrade(direction.bias, probability, currentPrice);
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

    processLevel1Signal(payload) {
        // Level 2: Confluence & AMT Spatial Validation
        const { useNexusStore } = require('../store');
        const setStatus = useNexusStore.getState().updatePipelineStatus;
        
        setStatus(2, 'evaluating', payload.directionBias, 'Validating AMT...');

        // In a real scenario we use VolumeProfile.getSummary(vpResult)
        // Here we mock the VPE levels around the current price for demonstration if VPE is empty
        const cp = payload.currentPrice;
        const vpe = {
            poc: cp * 0.9995, // mock below
            vah: cp * 1.002,
            val: cp * 0.998
        };

        const l1Direction = payload.directionBias;
        const isAbsorption = payload.absorption?.detected;
        let isApproved = false;
        let reason = '';

        if (l1Direction === 'bullish') {
            if (isAbsorption && cp <= vpe.val) {
                isApproved = true;
                reason = 'Bullish absorption at VAL';
            } else if (cp > vpe.poc) {
                isApproved = true;
                reason = 'Momentum above POC';
            }
        } else {
            if (isAbsorption && cp >= vpe.vah) {
                isApproved = true;
                reason = 'Bearish absorption at VAH';
            } else if (cp < vpe.poc) {
                isApproved = true;
                reason = 'Momentum below POC';
            }
        }

        if (isApproved) {
            setStatus(2, 'passed', l1Direction, reason);
            EventBus.emit('LEVEL_2_PASSED', {
                ...payload,
                amt: vpe,
                l2Reason: reason
            });
        } else {
            setStatus(2, 'rejected', l1Direction, 'AMT Spatial Rejection: No Edge');
        }
    }

    async _executeTrade(direction, score, price) {
        this.isProcessing = true;
        try {
            const setup = ScalpEngine.calculateSetup(direction);
            
            const signal = {
                id: `sig_${Date.now()}`,
                symbol: 'BTCUSDT',
                direction: direction,
                entry_price: price,
                quantity: 0.01, // Placeholder, should be calculated from balance
                stop_loss: setup.stopLoss,
                take_profit: setup.takeProfit,
                reason: 'Institutional Confluence',
                score: score,
                is_bracket: true
            };

            console.log('[MAESTRO] Triggering Trade:', signal);
            await invoke('execute_auto_order', { signal });
            
        } catch (error) {
            console.error('[MAESTRO] Execution error:', error);
        } finally {
            this.isProcessing = false;
        }
    }
}

export const maestro = new MasterAnalysisEngine();
