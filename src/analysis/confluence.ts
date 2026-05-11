/**
 * Confluence 2.0 — Adaptive Multi-Dimensional Probabilistic Scoring Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DIMENSIONS (7):
 *   ① Structure    — MSE regime, BOS/MSS
 *   ② Liquidity    — ILL sweeps, OBs, zones
 *   ③ Volume       — VPE POC/VA/HVN/LVN/shape
 *   ④ TimeContext   — ICE session/KZ/bias/weekly
 *   ⑤ Indicators   — RSI/MACD/MA/ADX/Ichimoku
 *   ⑥ Futures      — Funding, OI, squeeze
 *   ⑦ Volatility   — BB/ATR/Keltner
 *
 * KEY FEATURES:
 *   - Adaptive weighting (regime × strength blending)
 *   - Non-linear sigmoid boost for rare alignment (≥4 dimensions)
 */
// @ts-nocheck
import { EventBus } from './event-bus';
import { StateCache } from './state-cache';

export const ConfluenceEngine = {

    // ═══════════════════════════════════════════════════════════════════════
    // ADAPTIVE WEIGHT PROFILES
    // Base weights per regime — blended with regime strength, never used raw
    // ═══════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    // INSTITUTIONAL WEIGHT PROFILES (v3.0)
    // Structure + Liquidity + OrderFlow = 70% of all decisions
    // Retail indicators demoted to noise-filter role (3%)
    // ═══════════════════════════════════════════════════════════════════════
    _baseWeights: {
        trending_up: {
            structure: 0.25, liquidity: 0.20, volume: 0.10,
            timeContext: 0.05, indicators: 0.20, futures: 0.02, volatility: 0.03, orderFlow: 0.15
        },
        trending_down: {
            structure: 0.25, liquidity: 0.20, volume: 0.10,
            timeContext: 0.05, indicators: 0.20, futures: 0.02, volatility: 0.03, orderFlow: 0.15
        },
        range: {
            structure: 0.10, liquidity: 0.25, volume: 0.15,
            timeContext: 0.10, indicators: 0.25, futures: 0.02, volatility: 0.03, orderFlow: 0.10
        },
        transition: {
            structure: 0.15, liquidity: 0.15, volume: 0.10,
            timeContext: 0.10, indicators: 0.30, futures: 0.05, volatility: 0.05, orderFlow: 0.10
        },
        unknown: {
            structure: 0.20, liquidity: 0.20, volume: 0.10,
            timeContext: 0.10, indicators: 0.20, futures: 0.05, volatility: 0.05, orderFlow: 0.10
        }
    },

    _defaultWeights: {
        structure: 0.20, liquidity: 0.20, volume: 0.10,
        timeContext: 0.10, indicators: 0.20, futures: 0.05, volatility: 0.05, orderFlow: 0.10
    },

    // Legacy fallback for when no institutional modules are loaded
    legacyWeights: {
        trend: 0.15, momentum: 0.15, volume: 0.30, volatility: 0.10, structure: 0.30
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ADAPTIVE LEARNING STATE
    // ═══════════════════════════════════════════════════════════════════════

    _learning: {
        history: [],         // Rolling buffer of {dimensions, signal, outcome}
        hitRates: {},        // Per-dimension rolling hit rate
        maxHistory: 50,
        enabled: true
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Calculate full confluence score — Confluence 2.0.
     *
     * @param {object} indicators - All computed indicator results
     * @param {object} patternSummary - Pattern engine summary
     * @param {object} toggles - Which indicators/patterns are enabled
     * @param {object} [institutionalData] - { marketState, liquidity, volumeProfile, context }
     * @returns {object} Backward-compatible + enhanced output
     */
    calculate(indicators, patternSummary, toggles = {}, institutionalData = {}) {
        const { marketState, liquidity, volumeProfile, context, orderFlow } = institutionalData;
        const hasInstitutional = !!(marketState || liquidity || volumeProfile || context);
        const regime = marketState?.regime?.current || 'unknown';
        const regimeStrength = (marketState?.regime?.confidence || 50) / 100;

        // ─── Step 1: Score all 8 dimensions ───
        const dimensions = this._scoreAllDimensions(
            indicators, patternSummary, toggles,
            marketState, liquidity, volumeProfile, context, orderFlow,
            hasInstitutional
        );

        const dimEntries = Object.entries(dimensions);

        // ─── Step 2: Resolve adaptive weights ───
        const weights = hasInstitutional
            ? this._resolveWeights(regime, regimeStrength, context)
            : null;

        // ─── Step 3: Structural alignment gate ───
        const structuralAlignment = hasInstitutional
            ? this._applyStructuralGate(dimEntries, regime, marketState)
            : { penalized: {}, mssOverride: false };

        // ─── Step 4: Noise suppression ───
        const suppressedDims = hasInstitutional
            ? this._applyNoiseSuppression(dimensions, dimEntries, regime, marketState)
            : {};

        // ─── Step 5: Weighted combination ───
        let rawScore;
        if (hasInstitutional && weights) {
            rawScore = this._weightedCombine(dimEntries, weights);
        } else {
            rawScore = this._legacyCombine(dimEntries);
        }

        // ─── Step 6: Non-linear rare alignment boost ───
        const alignment = this._detectRareAlignment(dimEntries);
        const boostedScore = rawScore * alignment.boost;

        // ─── Step 7: Conflict penalty ───
        const conflict = this._assessConflict(dimEntries);

        // ─── Step 8: Context modifier ───
        let contextModifier = { multiplier: 1.0, reason: 'No context' };
        if (context && typeof ContextEngine !== 'undefined') {
            contextModifier = ContextEngine.getModifier(context);
        }

        // ─── Step 8b: Machine Learning Probability ───
        let mlProbability = 0;
        if (typeof ProbabilityEngine !== 'undefined') {
            const factors = {
                structure: (dimensions.structure?.score || 0) / 100,
                liquidity: (dimensions.liquidity?.score || 0) / 100,
                volume: (dimensions.volume?.score || 0) / 100,
                indicators: (dimensions.indicators?.score || 0) / 100,
                mtf: (dimensions.mtf?.score || 0) / 100 // Might be undefined
            };
            mlProbability = ProbabilityEngine.calculate(factors);
        }

        // ─── Step 9: Final score ───
        const modifiedScore = boostedScore * contextModifier.multiplier;
        let finalScore = modifiedScore * (1 - conflict.impact);

        // Boost final score if ML probability is high and aligned
        if (mlProbability > 0.7) {
            finalScore *= 1.1;
        }

        // ─── Step 10: Confidence (0–100) ───
        const baseConfidence = Math.min(100, Math.abs(finalScore));
        const confidence = Math.max(0, Math.round(
            baseConfidence * (1 - conflict.severity * 0.3)
        ));

        // ─── Step 11: Risk modeling ───
        const riskScore = this._computeRisk(
            marketState, liquidity, context, indicators, dimensions
        );

        // ─── Step 12: Signal determination ───
        let signal = 'hold';
        // Reduced thresholds for higher sensitivity in the HUD
        if (finalScore > 10 && confidence >= 20) signal = 'buy';
        else if (finalScore < -10 && confidence >= 20) signal = 'sell';

        // ─── Step 13: Classification ───
        const classification = this._classify(
            confidence, riskScore.composite, alignment, conflict, context
        );

        // ─── Step 14: Reasoning ───
        const reasoning = this._buildReasoning(dimensions, dimEntries, weights, alignment, conflict);

        // ─── Step 15: Adaptive learning feedback ───
        if (this._learning.enabled && hasInstitutional) {
            this._recordPrediction(dimEntries, signal);
        }

        // ─── Build output (backward-compatible + enhanced) ───
        return {
            // Backward-compatible fields
            score: Math.round(finalScore),
            signal,
            confidence,
            dimensions,
            suppressed: conflict.severity > 0.3,
            regime,
            contextModifier,
            suppressedDims,
            structuralAlignment,
            weights: hasInstitutional ? weights : this.legacyWeights,
            mode: hasInstitutional ? 'institutional' : 'legacy',
            breakdown: this._getBreakdown(dimEntries, hasInstitutional ? weights : this.legacyWeights),

            // Enhanced Confluence 2.0 fields
            riskScore,
            classification,
            alignment,
            conflict,
            mlProbability,
            dominantFactors: reasoning.dominant,
            suppressedFactors: reasoning.suppressed,
            reasoning: reasoning.summary
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DIMENSION SCORING
    // ═══════════════════════════════════════════════════════════════════════

    _scoreAllDimensions(indicators, patternSummary, toggles,
        marketState, liquidity, volumeProfile, context, orderFlow,
        hasInstitutional) {
        const dims = {};

        if (hasInstitutional) {
            dims.structure = this._scoreStructure_Inst(marketState);
            dims.liquidity = this._scoreLiquidity_Inst(liquidity);
            dims.volume = this._scoreVolume_Inst(volumeProfile);
            dims.timeContext = this._scoreTimeContext(context);
            dims.orderFlow = this._scoreOrderFlow(orderFlow);
        }

        dims.indicators = this._scoreIndicators(indicators, toggles);
        dims.futures = this._scoreFutures(indicators);
        dims.volatility = this._scoreVolatility(indicators, toggles);

        // Legacy dimensions as fallback
        if (!hasInstitutional) {
            dims.trend = this._scoreTrend(indicators, toggles);
            dims.momentum = this._scoreMomentum(indicators, toggles);
            dims.structure = this._scorePatterns(indicators, patternSummary, toggles);
            dims.volume = this._scoreLegacyVolume(indicators, toggles);
        }

        return dims;
    },

    // --- Structure Dimension (MSE) ---
    _scoreStructure_Inst(marketState) {
        if (!marketState) return { rawScore: 0, confidence: 0, weight: 0, bias: 'neutral', contributors: 0, active: false, score: 0 };

        let score = 0;
        let conf = 50;
        let contributors = 0;

        const regime = marketState.regime?.current;
        const regimeConf = marketState.regime?.confidence || 50;

        // Regime directional score
        if (regime === 'trending_up') { score += 40; contributors++; }
        else if (regime === 'trending_down') { score -= 40; contributors++; }
        else if (regime === 'range') { score += 0; contributors++; }
        else if (regime === 'transition') { score += 0; contributors++; }

        // BOS events
        const lastBOS = marketState.structure?.lastBOS;
        if (lastBOS) {
            score += lastBOS.direction === 'bullish' ? 25 : -25;
            conf += 10;
            contributors++;
        }

        // MSS events (counter-trend reversal signal)
        const lastMSS = marketState.structure?.lastMSS;
        if (lastMSS) {
            const seq = marketState.sequence;
            const recentMSS = seq && seq.length > 0 ? (seq[seq.length - 1].index - lastMSS.index) < 15 : false;
            if (recentMSS) {
                score += lastMSS.direction === 'bullish' ? 35 : -35;
                conf += 15;
                contributors++;
            }
        }

        // Scale by regime confidence
        score = Math.round(score * (regimeConf / 100));
        conf = Math.min(95, Math.round(conf * (regimeConf / 100)));

        return this._makeDimResult(score, conf, contributors);
    },

    // --- Liquidity Dimension (ILL) ---
    _scoreLiquidity_Inst(liquidity) {
        if (!liquidity) return this._emptyDim();

        let score = 0;
        let conf = 40;
        let contributors = 0;

        if (typeof LiquidityEngine === 'undefined') return this._emptyDim();

        const summary = LiquidityEngine.getSummary(liquidity);
        if (!summary.active) return this._emptyDim();

        // Base signal from ILL
        if (summary.signal === 'buy') { score += summary.confidence * 0.4; contributors++; }
        else if (summary.signal === 'sell') { score -= summary.confidence * 0.4; contributors++; }

        // Sweep + MSS linkage (high-impact reversal)
        if (liquidity.sweeps && liquidity.sweeps.length > 0) {
            const recentSweep = liquidity.sweeps[liquidity.sweeps.length - 1];
            if (recentSweep.mssLinked) {
                score += recentSweep.direction === 'bullish' ? 30 : -30;
                conf += 20;
                contributors++;
            } else {
                score += recentSweep.direction === 'bullish' ? 15 : -15;
                contributors++;
            }
        }

        // OB retest
        if (liquidity.orderBlocks) {
            const activeOBs = liquidity.orderBlocks.filter(ob => !ob.mitigated);
            const bullOBs = activeOBs.filter(ob => ob.type === 'bullish').length;
            const bearOBs = activeOBs.filter(ob => ob.type === 'bearish').length;
            if (bullOBs > bearOBs) { score += 10; contributors++; }
            else if (bearOBs > bullOBs) { score -= 10; contributors++; }
        }

        // Premium/Discount zone
        const zone = liquidity.premiumDiscount?.currentZone;
        if (zone === 'discount') { score += 15; conf += 5; contributors++; }
        else if (zone === 'premium') { score -= 15; conf += 5; contributors++; }

        return this._makeDimResult(score, Math.min(90, conf), contributors);
    },

    // --- Volume Dimension (VPE) ---
    _scoreVolume_Inst(volumeProfile) {
        if (!volumeProfile || !volumeProfile.totalVolume) return this._emptyDim();

        if (typeof VolumeProfile === 'undefined') return this._emptyDim();

        const summary = VolumeProfile.getSummary(volumeProfile);
        if (!summary.active) return this._emptyDim();

        let score = 0;
        let conf = 40;
        let contributors = 0;
        const price = volumeProfile.currentPrice || volumeProfile.poc;

        // POC proximity
        if (volumeProfile.poc > 0 && price > 0) {
            const pocDist = (price - volumeProfile.poc) / volumeProfile.poc;
            if (Math.abs(pocDist) > 0.002) {
                score += pocDist < 0 ? 20 : -20;
                contributors++;
            }
        }

        // VA location
        if (volumeProfile.val > 0 && volumeProfile.vah > 0) {
            if (price < volumeProfile.val) { score += 30; conf += 10; contributors++; }
            else if (price > volumeProfile.vah) { score -= 30; conf += 10; contributors++; }
        }

        // Profile shape
        if (volumeProfile.shape === 'P') { score += 15; contributors++; }
        else if (volumeProfile.shape === 'b') { score -= 15; contributors++; }

        // Delta divergence
        if (volumeProfile.deltaDivergence?.detected) {
            const divConf = (volumeProfile.deltaDivergence.confidence || 50) / 100;
            score += (volumeProfile.deltaDivergence.type === 'bullish' ? 25 : -25) * divConf;
            conf += 10;
            contributors++;
        }

        return this._makeDimResult(score, Math.min(85, conf), contributors);
    },

    // --- Time Context Dimension (ICE) ---
    _scoreTimeContext(context) {
        if (!context) return this._emptyDim();

        let score = 0;
        let conf = 40;
        let contributors = 0;

        // Kill zone active → strong time alignment
        if (context.session?.killZone) {
            score += 15; // Positive (indicating favorable timing)
            conf += 15;
            contributors++;
        }

        // Session quality
        if (context.session?.current === 'overlap_london_ny') {
            score += 10;
            conf += 10;
            contributors++;
        } else if (context.session?.current === 'off_hours') {
            score -= 20;
            conf -= 10;
            contributors++;
        }

        // Daily bias alignment
        if (context.dailyBias && context.dailyBias.confidence > 40) {
            if (context.dailyBias.direction === 'BULLISH') { score += 15; contributors++; }
            else if (context.dailyBias.direction === 'BEARISH') { score -= 15; contributors++; }
            conf += 5;
        }

        // Weekly phase
        if (context.weeklyState) {
            if (context.weeklyState.phase === 'EXPANSION') { conf += 10; contributors++; }
            else if (context.weeklyState.phase === 'DISTRIBUTION') { conf -= 5; contributors++; }
        }

        // Volatility ratio
        if (context.volatilityRatio !== null && context.volatilityRatio !== undefined) {
            if (context.volatilityRatio < 0.5) { conf -= 10; } // Quiet = less reliable
            else if (context.volatilityRatio > 1.5) { conf += 5; } // Active = more decisive
        }

        // P3 phase
        if (context.powerOfThree?.phase === 'distribution' && context.powerOfThree.confidence > 50) {
            score += context.powerOfThree.direction === 'bullish' ? 20 : -20;
            conf += 10;
            contributors++;
        }

        return this._makeDimResult(score, Math.max(20, Math.min(85, conf)), contributors);
    },

    // --- Indicators Dimension (combined trend + momentum) ---
    _scoreIndicators(indicators, toggles) {
        const scores = [];

        // Trend signals (Soft scoring)
        if (indicators.ma && toggles.ma !== false) {
            scores.push(indicators.ma.signal === 'buy' ? 80 : indicators.ma.signal === 'sell' ? -80 : 0);
        }
        
        // Momentum signals (Continuous scoring)
        if (indicators.rsi && toggles.rsi !== false) {
            scores.push(indicators.rsi.score || 0);
        }
        if (indicators.macd && toggles.macd !== false) {
            scores.push(indicators.macd.score || 0);
        }
        
        // Volatility/Range signals
        if (indicators.bb && toggles.bb !== false) {
            scores.push(indicators.bb.score || 0);
        }
        
        if (indicators.fvg && toggles.fvg !== false) {
            if (indicators.fvg.signal === 'buy') scores.push(60);
            else if (indicators.fvg.signal === 'sell') scores.push(-60);
        }

        if (scores.length === 0) return this._emptyDim();

        const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
        
        // Confidence based on signal strength
        const strength = scores.reduce((s, v) => s + Math.abs(v), 0) / scores.length;
        const conf = Math.round(Math.max(20, Math.min(90, strength)));

        return this._makeDimResult(avg, conf, scores.length);
    },

    // --- Futures Dimension ---
    _scoreFutures(indicators) {
        if (typeof FuturesMonitor === 'undefined') return this._emptyDim();

        const cache = FuturesMonitor._cache;
        if (!cache) return this._emptyDim();

        let score = 0;
        let conf = 35;
        let contributors = 0;

        // Funding rate
        if (cache.funding !== undefined && cache.funding !== null) {
            if (cache.funding > 0.01) { score -= 15; contributors++; } // High funding = crowded long
            else if (cache.funding < -0.01) { score += 15; contributors++; } // Neg funding = crowded short
        }

        // Open interest changes
        if (cache.oiChange !== undefined) {
            if (cache.oiChange > 5) { conf += 10; contributors++; } // Rising OI = conviction
            else if (cache.oiChange < -5) { conf -= 5; }
        }

        // Squeeze detection
        if (cache.squeeze) {
            score += cache.squeeze.direction === 'long' ? 20 : -20;
            conf += 15;
            contributors++;
        }

        return this._makeDimResult(score, Math.max(20, Math.min(80, conf)), contributors);
    },

    // --- Volatility Dimension ---
    _scoreVolatility(indicators, toggles) {
        const scores = [];

        if (indicators.bb && toggles.bb !== false) {
            if (indicators.bb.signal === 'buy') scores.push(70);
            else if (indicators.bb.signal === 'sell') scores.push(-70);
            else {
                // Squeeze detection from BB width
                if (indicators.bb.percentB !== undefined) {
                    if (indicators.bb.percentB > 1) scores.push(-40); // Overextended
                    else if (indicators.bb.percentB < 0) scores.push(40); // Oversold
                }
            }
        }

        if (indicators.atr && toggles.atr !== false) {
            scores.push(indicators.atr.signal === 'buy' ? 50 : indicators.atr.signal === 'sell' ? -50 : 0);
        }

        if (indicators.keltner && toggles.keltner !== false) {
            scores.push(indicators.keltner.signal === 'buy' ? 55 : indicators.keltner.signal === 'sell' ? -55 : 0);
        }

        if (scores.length === 0) return this._emptyDim();

        const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
        return this._makeDimResult(avg, 50, scores.length);
    },

    // --- Order Flow Dimension (OFDE) ---
    _scoreOrderFlow(orderFlowData) {
        if (!orderFlowData || !orderFlowData.summary?.active) return this._emptyDim();

        const s = orderFlowData.summary;
        const scores = [];
        const contributors = [];

        // Cumulative delta trend
        const cd = orderFlowData.cumulativeDelta;
        if (cd) {
            if (cd.trend === 'bullish') { scores.push(40); contributors.push('delta_bullish'); }
            else if (cd.trend === 'bearish') { scores.push(-40); contributors.push('delta_bearish'); }
        }

        // Delta divergence (high impact reversal)
        const div = orderFlowData.deltaDivergence;
        if (div?.detected) {
            const divScore = div.direction === 'bullish' ? 60 : -60;
            scores.push(divScore);
            contributors.push(`div_${div.direction}`);
        }

        // Absorption
        const abs = orderFlowData.absorption;
        if (abs?.detected && abs.mostRecent) {
            const absScore = abs.mostRecent.direction === 'selling_absorbed' ? 45 : -45;
            scores.push(absScore);
            contributors.push('absorption');
        }

        // Aggressive imbalance
        const imb = orderFlowData.aggressiveImbalance;
        if (imb?.detected) {
            const imbScore = imb.direction === 'buy_aggression' ? 50 : -50;
            scores.push(imbScore);
            contributors.push(`imb_${imb.direction}`);
        }

        // Micro pullback failure
        const pb = orderFlowData.microPullback;
        if (pb?.detected) {
            const pbScore = pb.direction === 'bullish_continuation' ? 55 : -55;
            scores.push(pbScore);
            contributors.push('micro_pullback');
        }

        // Footprint imbalance
        const fp = orderFlowData.footprint;
        if (fp?.detected && fp.consistency >= 2) {
            const fpScore = fp.direction === 'buy_dominant' ? 35 : -35;
            scores.push(fpScore);
            contributors.push('footprint');
        }

        if (scores.length === 0) return this._emptyDim();

        const avg = scores.reduce((a, v) => a + v, 0) / scores.length;
        const conf = Math.min(85, 30 + scores.length * 10);
        const result = this._makeDimResult(avg, conf, scores.length);
        result.contributors = contributors;
        return result;
    },

    // --- Legacy fallback scorers ---
    _scoreTrend(indicators, toggles) {
        const scores = [];
        if (indicators.ma && toggles.ma !== false)
            scores.push(indicators.ma.signal === 'buy' ? 100 : indicators.ma.signal === 'sell' ? -100 : 0);
        if (indicators.ichimoku && toggles.ichimoku !== false)
            scores.push(indicators.ichimoku.signal === 'buy' ? 80 : indicators.ichimoku.signal === 'sell' ? -80 : 0);
        if (indicators.adx && toggles.adx !== false && indicators.adx.value > 25)
            scores.push(indicators.adx.signal === 'buy' ? 60 : indicators.adx.signal === 'sell' ? -60 : 0);
        if (scores.length === 0) return this._emptyDim();
        const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
        return this._makeDimResult(avg, 50, scores.length);
    },

    _scoreMomentum(indicators, toggles) {
        const scores = [];
        if (indicators.rsi && toggles.rsi !== false)
            scores.push(indicators.rsi.signal === 'buy' ? 100 : indicators.rsi.signal === 'sell' ? -100 : 0);
        if (indicators.macd && toggles.macd !== false)
            scores.push(indicators.macd.tradingSignal === 'buy' ? 100 : indicators.macd.tradingSignal === 'sell' ? -100 : 0);
        if (indicators.stochastic && toggles.stochastic !== false)
            scores.push(indicators.stochastic.signal === 'buy' ? 80 : indicators.stochastic.signal === 'sell' ? -80 : 0);
        if (scores.length === 0) return this._emptyDim();
        const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
        return this._makeDimResult(avg, 50, scores.length);
    },

    _scorePatterns(indicators, patternSummary, toggles) {
        const scores = [];
        if (toggles.fvg !== false && indicators.fvg)
            scores.push(indicators.fvg.signal === 'buy' ? 70 : indicators.fvg.signal === 'sell' ? -70 : 0);
        if (toggles.patterns !== false && patternSummary?.signal)
            scores.push(patternSummary.signal === 'buy' ? 80 : patternSummary.signal === 'sell' ? -80 : 0);
        if (scores.length === 0) return this._emptyDim();
        const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
        return this._makeDimResult(avg, 45, scores.length);
    },

    _scoreLegacyVolume(indicators, toggles) {
        const scores = [];
        if (indicators.cvd && toggles.cvd !== false)
            scores.push(indicators.cvd.signal === 'buy' ? 80 : indicators.cvd.signal === 'sell' ? -80 : 0);
        if (indicators.heatmap && toggles.heatmap !== false)
            scores.push(indicators.heatmap.signal === 'buy' ? 60 : indicators.heatmap.signal === 'sell' ? -60 : 0);
        if (indicators.vwap && toggles.vwap !== false)
            scores.push(indicators.vwap.signal === 'buy' ? 70 : indicators.vwap.signal === 'sell' ? -70 : 0);
        if (scores.length === 0) return this._emptyDim();
        const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
        return this._makeDimResult(avg, 45, scores.length);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ADAPTIVE WEIGHT RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════

    _resolveWeights(regime, regimeStrength, context) {
        const base = this._baseWeights[regime] || this._baseWeights.unknown;
        const def = this._defaultWeights;

        // Blend: strong regime → use regime weights; weak → converge to uniform
        const weights = {};
        for (const dim of Object.keys(def)) {
            const regimeW = base[dim] || def[dim];
            weights[dim] = regimeStrength * regimeW + (1 - regimeStrength) * def[dim];
        }

        // Context modulation
        if (context) {
            // Kill zone → boost liquidity + timeContext
            if (context.session?.killZone) {
                weights.liquidity *= 1.15;
                weights.timeContext *= 1.20;
            }
            // Off-hours → reduce indicators, boost volatility awareness
            if (context.session?.current === 'off_hours') {
                weights.indicators *= 0.80;
                weights.volatility *= 1.15;
            }
        }

        // Apply adaptive learning adjustments
        if (this._learning.enabled) {
            for (const dim of Object.keys(weights)) {
                const hitRate = this._learning.hitRates[dim];
                if (hitRate !== undefined && hitRate !== null) {
                    // Bayesian-like: adjust by hit rate relative to 50% baseline
                    // Clamp to 0.5x — 1.5x of base
                    const adjustment = Math.max(0.5, Math.min(1.5, hitRate / 0.5));
                    weights[dim] *= adjustment;
                }
            }
        }

        // Normalize to sum = 1.0
        const total = Object.values(weights).reduce((s, v) => s + v, 0);
        if (total > 0) {
            for (const dim of Object.keys(weights)) {
                weights[dim] = Math.round((weights[dim] / total) * 1000) / 1000;
            }
        }

        return weights;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // STRUCTURAL ALIGNMENT GATE
    // ═══════════════════════════════════════════════════════════════════════

    _applyStructuralGate(dimEntries, regime, marketState) {
        const penalized = {};

        const structDir = regime === 'trending_up' ? 1 : regime === 'trending_down' ? -1 : 0;
        if (structDir === 0) return { penalized, mssOverride: false };

        const lastMSS = marketState?.structure?.lastMSS;
        const seq = marketState?.sequence;
        const mssRecent = lastMSS && seq && seq.length > 0
            ? (seq[seq.length - 1].index - lastMSS.index) < 15 : false;

        const regimeConf = (marketState?.regime?.confidence || 50) / 100;
        const penaltyFactor = regimeConf > 0.70 ? 0.35 : 0.55;

        for (const [dim, data] of dimEntries) {
            if (dim === 'structure' || !data.active) continue;

            const opposes = (structDir > 0 && data.score < -20) || (structDir < 0 && data.score > 20);
            if (!opposes) continue;

            if (mssRecent) {
                penalized[dim] = {
                    original: data.score, factor: 1.25,
                    reason: `${dim} BOOSTED — MSS reversal active`
                };
                data.score = Math.round(data.score * 1.25);
                data.mssBoost = true;
            } else {
                penalized[dim] = {
                    original: data.score, factor: penaltyFactor,
                    reason: `${dim} penalized in ${regime}`
                };
                data.score = Math.round(data.score * penaltyFactor);
                data.structurePenalized = true;
            }
        }

        return { penalized, mssOverride: mssRecent };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // NOISE SUPPRESSION
    // ═══════════════════════════════════════════════════════════════════════

    _applyNoiseSuppression(dimensions, dimEntries, regime, marketState) {
        const suppressed = {};
        const msScore = dimensions.structure?.score || 0;
        const threshold = 25;

        const suppress = (dim, factor, reason) => {
            if (!dimensions[dim]?.active) return;
            suppressed[dim] = { original: dimensions[dim].score, factor, reason };
            dimensions[dim].score = Math.round(dimensions[dim].score * factor);
        };

        if (regime === 'trending_up' && msScore > threshold) {
            if (dimensions.indicators?.active && dimensions.indicators.score < -30)
                suppress('indicators', 0.5, 'Counter-trend indicators suppressed in uptrend');
            if (dimensions.volatility?.active && dimensions.volatility.score < -30)
                suppress('volatility', 0.6, 'Counter-trend volatility suppressed in uptrend');
        } else if (regime === 'trending_down' && msScore < -threshold) {
            if (dimensions.indicators?.active && dimensions.indicators.score > 30)
                suppress('indicators', 0.5, 'Counter-trend indicators suppressed in downtrend');
            if (dimensions.volatility?.active && dimensions.volatility.score > 30)
                suppress('volatility', 0.6, 'Counter-trend volatility suppressed in downtrend');
        } else if (regime === 'transition') {
            for (const [dim, data] of dimEntries) {
                if (dim === 'structure' || dim === 'volatility' || !data.active) continue;
                if (Math.abs(data.score) > 50) {
                    suppress(dim, 0.7, `Aggressive ${dim} dampened in TRANSITION`);
                }
            }
        }

        // Post-structural event: emphasize volatility
        if ((marketState?.structure?.lastBOS || marketState?.structure?.lastMSS) && dimensions.volatility?.active) {
            suppressed.volatilityBoost = {
                original: dimensions.volatility.score,
                factor: 1.2,
                reason: 'Volatility emphasized post-BOS/MSS'
            };
            dimensions.volatility.score = Math.round(dimensions.volatility.score * 1.2);
        }

        return suppressed;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // WEIGHTED COMBINATION
    // ═══════════════════════════════════════════════════════════════════════

    _weightedCombine(dimEntries, weights) {
        let sum = 0, totalW = 0;
        for (const [dim, data] of dimEntries) {
            if (!data.active || weights[dim] === undefined) continue;
            // Score scaled by dimension confidence
            const effectiveScore = data.score * (data.confidence / 100);
            sum += effectiveScore * weights[dim];
            totalW += weights[dim];
        }
        return totalW > 0 ? (sum / totalW) : 0;
    },

    _legacyCombine(dimEntries) {
        let sum = 0, totalW = 0;
        for (const [dim, data] of dimEntries) {
            if (!data.active || this.legacyWeights[dim] === undefined) continue;
            sum += data.score * this.legacyWeights[dim];
            totalW += this.legacyWeights[dim];
        }
        return totalW > 0 ? (sum / totalW) * 100 : 0;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // NON-LINEAR RARE ALIGNMENT BOOST
    // Sigmoid: boost = 1 + 0.5 / (1 + e^(-(alignCount - 3.5)))
    // ═══════════════════════════════════════════════════════════════════════

    _detectRareAlignment(dimEntries) {
        const activeDims = dimEntries.filter(([, d]) => d.active && d.confidence > 50);

        const bullishAligned = activeDims.filter(([, d]) => d.score > 20).length;
        const bearishAligned = activeDims.filter(([, d]) => d.score < -20).length;

        const alignCount = Math.max(bullishAligned, bearishAligned);
        const direction = bullishAligned >= bearishAligned ? 'bullish' : 'bearish';

        // Sigmoid boost: meaningful kick starts at 3 aligned dimensions
        const sigmoid = 1 / (1 + Math.exp(-(alignCount - 2.5)));
        const boost = 1 + 0.5 * sigmoid;

        const isRare = alignCount >= 3;

        return {
            alignCount,
            direction,
            boost: Math.round(boost * 1000) / 1000,
            isRare,
            bullishCount: bullishAligned,
            bearishCount: bearishAligned
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // CONFLICT PENALTY ENGINE
    // severity = min(bull, bear) / max(bull, bear)
    // impact = severity × 0.4
    // ═══════════════════════════════════════════════════════════════════════

    _assessConflict(dimEntries) {
        const active = dimEntries.filter(([, d]) => d.active);

        let bullStrength = 0, bearStrength = 0;
        let bullCount = 0, bearCount = 0;

        for (const [, data] of active) {
            if (data.score > 15) {
                bullStrength += Math.abs(data.score);
                bullCount++;
            } else if (data.score < -15) {
                bearStrength += Math.abs(data.score);
                bearCount++;
            }
        }

        const maxStrength = Math.max(bullStrength, bearStrength);
        const minStrength = Math.min(bullStrength, bearStrength);
        const severity = maxStrength > 0 ? minStrength / maxStrength : 0;
        const impact = severity * 0.4;

        const isConflict = bullCount > 1 && bearCount > 1 &&
            Math.abs(bullCount - bearCount) <= 1;

        return {
            severity: Math.round(severity * 100) / 100,
            impact: Math.round(impact * 100) / 100,
            bullCount,
            bearCount,
            bullStrength: Math.round(bullStrength),
            bearStrength: Math.round(bearStrength),
            isConflict
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // RISK MODELING (4-axis, independent from confidence)
    // ═══════════════════════════════════════════════════════════════════════

    _computeRisk(marketState, liquidity, context, indicators, dimensions) {
        // 1. Structural risk — inverse of regime confidence + MSS recency
        let structuralRisk = 50;
        if (marketState) {
            const regimeConf = marketState.regime?.confidence || 50;
            structuralRisk = 100 - regimeConf;
            // MSS active = structural instability
            if (marketState.structure?.lastMSS) {
                const seq = marketState.sequence;
                const mssRecent = seq && seq.length > 0
                    ? (seq[seq.length - 1].index - marketState.structure.lastMSS.index) < 10 : false;
                if (mssRecent) structuralRisk += 20;
            }
            // Transition regime = elevated risk
            if (marketState.regime?.current === 'transition') structuralRisk += 15;
        }

        // 2. Liquidity risk — proximity to sweep zones, OB saturation
        let liquidityRisk = 40;
        if (liquidity) {
            if (liquidity.sweeps && liquidity.sweeps.length > 2) liquidityRisk += 15;
            const activeOBs = (liquidity.orderBlocks || []).filter(ob => !ob.mitigated).length;
            if (activeOBs > 5) liquidityRisk += 10;
            if (liquidity.premiumDiscount?.currentZone === 'premium') liquidityRisk += 10;
            else if (liquidity.premiumDiscount?.currentZone === 'discount') liquidityRisk -= 5;
        }

        // 3. Timing risk — ICE context
        let timingRisk = 40;
        if (context) {
            if (context.session?.current === 'off_hours') timingRisk += 25;
            else if (context.session?.current === 'asia') timingRisk += 10;
            if (context.range?.extensionRisk) timingRisk += 20;
            if (context.volatilityRatio !== null && context.volatilityRatio < 0.3) timingRisk += 15;
            if (context.session?.killZone) timingRisk -= 15;
        }

        // 4. Volatility risk — BB width, ATR expansion
        let volatilityRisk = 40;
        if (indicators.bb) {
            if (indicators.bb.percentB !== undefined) {
                if (indicators.bb.percentB > 1.2 || indicators.bb.percentB < -0.2)
                    volatilityRisk += 20; // Outside bands = elevated risk
            }
        }
        if (indicators.atr && indicators.atr.value) {
            // Can't compute expansion without history, so base assessment
            volatilityRisk += dimensions.volatility?.active && Math.abs(dimensions.volatility.score) > 50 ? 10 : 0;
        }

        // Clamp all to 0-100
        structuralRisk = Math.max(0, Math.min(100, Math.round(structuralRisk)));
        liquidityRisk = Math.max(0, Math.min(100, Math.round(liquidityRisk)));
        timingRisk = Math.max(0, Math.min(100, Math.round(timingRisk)));
        volatilityRisk = Math.max(0, Math.min(100, Math.round(volatilityRisk)));

        // Composite = worst-case axis (not average)
        const composite = Math.max(structuralRisk, liquidityRisk, timingRisk, volatilityRisk);

        return { structuralRisk, liquidityRisk, timingRisk, volatilityRisk, composite };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SETUP CLASSIFICATION
    // ═══════════════════════════════════════════════════════════════════════

    _classify(confidence, compositeRisk, alignment, conflict, context) {
        if (conflict.isConflict) {
            return { grade: 'Conflict', label: '⚠️ Conflict — No Trade', tradeable: false };
        }

        const kzActive = context?.session?.killZone ? true : false;

        if (confidence >= 75 && compositeRisk <= 35 && alignment.alignCount >= 3) {
            return {
                grade: 'S',
                label: kzActive ? '🏛️ S Institutional (Kill Zone)' : '🏛️ S Institutional',
                tradeable: true
            };
        }

        if (confidence >= 60 && compositeRisk <= 50 && alignment.alignCount >= 2) {
            return { grade: 'A', label: '✅ A High Probability', tradeable: true };
        }

        if (confidence >= 40 && compositeRisk <= 65) {
            return { grade: 'B', label: '🔵 B Contextual Setup', tradeable: true };
        }

        if (confidence >= 20) {
            return { grade: 'C', label: '⚪ C Micro Scalp', tradeable: true };
        }

        return { grade: 'D', label: '⚠ D Weak — Avoid', tradeable: true };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // REASONING SUMMARY
    // ═══════════════════════════════════════════════════════════════════════

    _buildReasoning(dimensions, dimEntries, weights, alignment, conflict) {
        const labels = {
            structure: 'Structure', liquidity: 'Liquidity', volume: 'Volume',
            timeContext: 'Time Context', indicators: 'Indicators',
            futures: 'Futures', volatility: 'Volatility',
            trend: 'Trend', momentum: 'Momentum'
        };

        const active = dimEntries
            .filter(([, d]) => d.active)
            .map(([key, d]) => ({
                factor: labels[key] || key,
                direction: d.score > 15 ? 'bullish' : d.score < -15 ? 'bearish' : 'neutral',
                strength: Math.abs(d.score),
                weight: weights ? (weights[key] || 0) : 0,
                score: d.score
            }));

        // Sort by weighted impact
        active.sort((a, b) => (b.strength * b.weight) - (a.strength * a.weight));

        // Top 3 dominant, top 2 suppressed (opposing direction)
        const dominant = active.slice(0, 3).map(f => ({
            ...f, role: 'dominant'
        }));

        const mainDir = alignment.direction;
        const suppressed = active
            .filter(f => f.direction !== 'neutral' && f.direction !== mainDir)
            .slice(0, 2)
            .map(f => ({ ...f, role: 'opposing' }));

        // Summary string
        const parts = [];
        if (dominant.length > 0) {
            parts.push(`Dominant: ${dominant.map(d => `${d.factor} (${d.direction})`).join(', ')}`);
        }
        if (conflict.severity > 0.3) {
            parts.push(`Conflict: ${conflict.bullCount}B vs ${conflict.bearCount}S (severity ${Math.round(conflict.severity * 100)}%)`);
        }
        if (alignment.isRare) {
            parts.push(`Rare alignment: ${alignment.alignCount} dims ${alignment.direction} (${Math.round((alignment.boost - 1) * 100)}% boost)`);
        }

        return {
            dominant,
            suppressed,
            summary: parts.join(' | ')
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ADAPTIVE LEARNING LAYER
    // Rolling 50-trade hit-rate per dimension
    // ═══════════════════════════════════════════════════════════════════════

    _recordPrediction(dimEntries, signal) {
        if (signal === 'hold') return;

        const entry = { timestamp: Date.now(), signal };
        for (const [dim, data] of dimEntries) {
            if (!data.active) continue;
            entry[dim] = {
                prediction: data.score > 15 ? 'buy' : data.score < -15 ? 'sell' : 'hold',
                score: data.score
            };
        }

        this._learning.history.push(entry);

        // Cap rolling buffer
        while (this._learning.history.length > this._learning.maxHistory) {
            this._learning.history.shift();
        }

        // Update hit rates (cheaply)
        this._updateHitRates();
    },

    _updateHitRates() {
        const history = this._learning.history;
        if (history.length < 5) return;

        const dims = ['structure', 'liquidity', 'volume', 'timeContext', 'indicators', 'futures', 'volatility'];

        for (const dim of dims) {
            let hits = 0, total = 0;

            for (let i = 0; i < history.length - 1; i++) {
                const entry = history[i];
                const next = history[i + 1];
                if (!entry[dim] || entry[dim].prediction === 'hold') continue;

                total++;
                // Simple check: did the dimension's prediction match the next overall signal?
                if (entry[dim].prediction === next.signal) hits++;
            }

            if (total >= 3) {
                this._learning.hitRates[dim] = hits / total;
            }
        }
    },

    /**
     * Feed outcome for adaptive learning (called externally when trade resolves).
     */
    feedOutcome(outcome) {
        if (!this._learning.enabled || this._learning.history.length === 0) return;
        const last = this._learning.history[this._learning.history.length - 1];
        last.outcome = outcome;
        this._updateHitRates();
    },

    // ═══════════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════════

    _makeDimResult(score, confidence, contributors) {
        const s = Math.round(Math.max(-100, Math.min(100, score)));
        return {
            rawScore: s,
            score: s,
            confidence: Math.max(0, Math.min(100, Math.round(confidence))),
            weight: 0, // Filled by weight resolution
            bias: s > 15 ? 'bullish' : s < -15 ? 'bearish' : 'neutral',
            contributors: contributors || 0,
            active: contributors > 0
        };
    },

    _emptyDim() {
        return { rawScore: 0, score: 0, confidence: 0, weight: 0, bias: 'neutral', contributors: 0, active: false };
    },

    _getBreakdown(dimEntries, weights) {
        const labels = {
            structure: 'Structure', liquidity: 'Liquidity', volume: 'Volume',
            timeContext: 'Time Context', indicators: 'Indicators',
            futures: 'Futures', volatility: 'Volatility',
            trend: 'Trend', momentum: 'Momentum', marketState: 'Market State',
            volumeProfile: 'Volume Profile'
        };

        return dimEntries.map(([key, data]) => ({
            name: labels[key] || key,
            score: data.score,
            active: data.active,
            weight: Math.round((weights[key] || 0) * 100),
            bias: data.score > 15 ? 'bullish' : data.score < -15 ? 'bearish' : 'neutral',
            contributors: data.contributors || 0,
            confidence: data.confidence || 0,
            tier: ['structure', 'liquidity', 'marketState'].includes(key) ? 1 : 2
        }));
    },

    /**
     * Reset adaptive learning state.
     */
    resetLearning() {
        this._learning.history = [];
        this._learning.hitRates = {};
    }
};

// Export for use in other modules
if (typeof window !== 'undefined') {
    window.ConfluenceEngine = ConfluenceEngine;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ConfluenceEngine;
}