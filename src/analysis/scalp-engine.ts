// @ts-nocheck
import { EventBus } from './event-bus';
import { StateCache } from './state-cache';
import { LiquidityEngine } from './liquidity';
import { MarketStateEngine } from './market-state';

export const ScalpEngine = {

    // ═══════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════

    _config: {
        minSetupScore: 65,
        highQualityThreshold: 75,
        premiumThreshold: 85,

        // ─── Leverage Behavior Model (3 operating modes) ───
        leverageModel: {
            modes: {
                swing_scalp:  { maxLeverage: 10,  minConfidence: 0.70, targetPct: [0.5, 1.0],   maxHoldCandles: 20, scannerGateMult: 0.8 },
                hybrid:       { maxLeverage: 50,  minConfidence: 0.60, targetPct: [0.15, 0.50],  maxHoldCandles: 10, scannerGateMult: 0.65 },
                micro_scalp:  { maxLeverage: 999, minConfidence: 0.50, targetPct: [0.05, 0.15],  maxHoldCandles: 3,  scannerGateMult: 0.5 },
            },
            signalSensitivity: {
                low:    { partialSignals: false, microSpikes: false, persistenceReq: 3 },
                medium: { partialSignals: true,  microSpikes: false, persistenceReq: 2 },
                high:   { partialSignals: true,  microSpikes: true,  persistenceReq: 1 },
            }
        },

        // ─── ATR profiles per mode ───
        atrProfiles: {
            swing_scalp:  { stopMultiple: 0.5, tp1Multiple: 1.5, tp2Multiple: 2.5, tp3Multiple: 3.5, trailActivation: 1.0, trailDistance: 0.3 },
            hybrid:       { stopMultiple: 0.35, tp1Multiple: 1.0, tp2Multiple: 1.8, tp3Multiple: 2.5, trailActivation: 0.7, trailDistance: 0.25 },
            micro_scalp:  { stopMultiple: 0.2, tp1Multiple: 0.4, tp2Multiple: 0.8, tp3Multiple: 1.2, trailActivation: 0.3, trailDistance: 0.15 },
        },

        // ─── Default ATR (swing_scalp baseline) ───
        atr: {
            stopMultiple: 0.5,
            tp1Multiple: 1.5,
            tp2Multiple: 2.5,
            tp3Multiple: 3.5,
            trailActivation: 1.0,
            trailDistance: 0.3
        },

        scaleOut: {
            tp1Pct: 0.50,
            tp2Pct: 0.30,
            tp3Pct: 0.20
        },

        risk: {
            maxConcurrentSetups: 3,
            maxScalpsPerSession: 12,
            cooldownCandles: 10,
            maxConsecutiveLosses: 3,
            sizeReduction: [1.0, 0.5, 0.25, 0.0]
        },

        // ─── Velocity control (anti-churn) ───
        velocity: {
            swing_scalp:  { maxTradesPerMin: 1 },
            hybrid:       { maxTradesPerMin: 2 },
            micro_scalp:  { maxTradesPerMin: 5 },  // dynamic: 3-8 based on leverage
        },

        // ─── Direction stickiness ───
        directionSticky: {
            maxTrades: 3,       // stay sticky for N trades
            maxDurationMs: 30000, // or 30 seconds
            flipPenalty: 0.6,   // score multiplier for direction flip without reversal
        },

        // ─── Profitability gate ───
        takerFeePct: 0.04,      // MEXC default taker fee per side
        profitGateMultiplier: 1.5, // expected move must exceed this × fees

        setupTTL: 3,
        confirmationWindow: 3,
        offHoursPenalty: 0.9,
        killZoneBoost: 1.15,
        spreadHardBlockPct: 0.02,

        proximityPct: 0.002,
        entryZoneWidthATR: 0.3,

        tuning: {
            minSample: 10,
            boostThreshold: 0.60,
            penaltyThreshold: 0.40,
            maxBoost: 1.25,
            maxPenalty: 0.75,
            rollingWindow: 30
        },

        frequency: {
            tiers: [
                { maxLeverage: 5, minScoreMod: 35, targetTradesPerDay: 5 },
                { maxLeverage: 10, minScoreMod: 25, targetTradesPerDay: 15 },
                { maxLeverage: 20, minScoreMod: 15, targetTradesPerDay: 30 },
                { maxLeverage: 50, minScoreMod: 5, targetTradesPerDay: 50 },
                { maxLeverage: 999, minScoreMod: -5, targetTradesPerDay: 100 }
            ]
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    _state: {
        activeSetups: [],
        bestSetup: null,
        candlesSinceEval: 0,
        sessionScalpCount: 0,
        consecutiveLosses: 0,
        cooldownRemaining: 0,
        locked: false,
        lockReason: null,
        lastSessionId: null,
        lastATR: 0,
        lastEventSource: null,
        lastLatencyMs: 0,
        lastVolatilityScore: 0,
        currentLeverage: 10,
        isLiveSimActive: false,
        // ─── Velocity control (anti-churn) ───
        recentTradeTimestamps: [],
        velocityReduction: 1.0,
        // ─── Direction stickiness ───
        lastTradeDirection: null,
        directionStickyUntil: 0,
        directionStickyCount: 0,
        // ─── Operating mode ───
        currentMode: 'swing_scalp',
        // ─── Win rate throttle ───
        winRateThrottleActive: false,
        winRateThrottleFactor: 1.0,
        // ─── Auto-downgrade ───
        modeDowngradedUntil: 0,
    },



    // ═══════════════════════════════════════════════════════════════════════
    // RADAR (stores all detected setups for display)
    // ═══════════════════════════════════════════════════════════════════════

    _radar: [],

    getRadarSetups() {
        return this._radar;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PERFORMANCE TRACKING
    // ═══════════════════════════════════════════════════════════════════════

    _performance: {
        history: [],
        // v4.0: Institutional + micro-scalp setup types
        byType: {
            liquidity_sweep_reversal: { wins: 0, losses: 0, totalRR: 0, count: 0 },
            order_block_retest: { wins: 0, losses: 0, totalRR: 0, count: 0 },
            volume_node_rejection: { wins: 0, losses: 0, totalRR: 0, count: 0 },
            micro_bos_continuation: { wins: 0, losses: 0, totalRR: 0, count: 0 },
            fvg_fill_rejection: { wins: 0, losses: 0, totalRR: 0, count: 0 },
            micro_spike: { wins: 0, losses: 0, totalRR: 0, count: 0 },
            absorption_reversal: { wins: 0, losses: 0, totalRR: 0, count: 0 }
        },
        typeMultipliers: {
            liquidity_sweep_reversal: 1.0,
            order_block_retest: 1.0,
            volume_node_rejection: 1.0,
            micro_bos_continuation: 1.0,
            fvg_fill_rejection: 1.0,
            micro_spike: 1.0,
            absorption_reversal: 1.0
        },
        // ─── Net profitability tracking ───
        netPnl: 0,
        grossPnl: 0,
        totalFeesPaid: 0,
        recentWinRate: 0.5,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════

    setLeverage(val) {
        if (!val || isNaN(val)) return;
        this._state.currentLeverage = Math.max(1, parseInt(val, 10));
        this._state.currentMode = this._getOperatingMode();
        if (typeof StateCache !== 'undefined') {
            StateCache.set('currentLeverage', this._state.currentLeverage);
            StateCache.set('operatingMode', this._state.currentMode);
        }
        console.log(`[ScalpEngine] Leverage set to ${this._state.currentLeverage}x → mode: ${this._state.currentMode}`);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // LEVERAGE BEHAVIOR MODEL — CORE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Resolve operating mode from current leverage.
     * swing_scalp (x1-x10) | hybrid (x10-x50) | micro_scalp (x50-x500)
     */
    _getOperatingMode() {
        const lev = this._state.currentLeverage || 10;
        // Check auto-downgrade
        if (this._state.modeDowngradedUntil > Date.now()) {
            return 'hybrid'; // forced downgrade from micro_scalp
        }
        const modes = this._config.leverageModel.modes;
        if (lev <= modes.swing_scalp.maxLeverage) return 'swing_scalp';
        if (lev <= modes.hybrid.maxLeverage) return 'hybrid';
        return 'micro_scalp';
    },

    /** Get signal sensitivity profile for current mode */
    _getSignalSensitivity() {
        const mode = this._state.currentMode || this._getOperatingMode();
        if (mode === 'micro_scalp') return this._config.leverageModel.signalSensitivity.high;
        if (mode === 'hybrid') return this._config.leverageModel.signalSensitivity.medium;
        return this._config.leverageModel.signalSensitivity.low;
    },

    /** Get ATR profile for current operating mode */
    _getActiveATRProfile() {
        const mode = this._state.currentMode || this._getOperatingMode();
        return this._config.atrProfiles[mode] || this._config.atrProfiles.swing_scalp;
    },

    /** Get mode config (minConfidence, targetPct, etc) */
    _getModeConfig() {
        const mode = this._state.currentMode || this._getOperatingMode();
        return this._config.leverageModel.modes[mode] || this._config.leverageModel.modes.swing_scalp;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PROFIT GATE — MANDATORY (expected move > 1.5× fees)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Hard gate: reject setups where expected profit doesn't cover fees + slippage.
     * At x100, round-trip fees = 0.04% × 2 × 100 = 8% of margin.
     * Expected NET margin PnL must exceed 1.2× total costs (fees + slippage).
     *
     * FIX C7: Uses leverage-risk TP net targets instead of mode targetPct,
     * which was too small for micro_scalp at x100+ and caused 100% rejection.
     */
    _profitGate(setup) {
        const leverage = this._state.currentLeverage || 10;
        const feePct = (this._config.takerFeePct || 0.04) * 2; // round-trip % of notional
        const feeMarginPct = feePct * leverage; // fees as % of margin

        // Estimate slippage (new: slippage model)
        const slippageMarginPct = this._estimateSlippage() * leverage;
        const totalCostMarginPct = feeMarginPct + slippageMarginPct;

        // FIX C7: Compute expected margin PnL from the leverage-risk TP target,
        // NOT from the mode's raw targetPct (which is too small at high leverage).
        const entry = setup.entryZone?.center || 0;
        const tp1 = setup.targets?.[0] || 0;
        let expectedMarginPnl = 0;
        if (entry > 0 && tp1 > 0) {
            // Structural TP exists — use it
            const expectedMovePct = Math.abs(tp1 - entry) / entry * 100;
            expectedMarginPnl = expectedMovePct * leverage;
        } else {
            // Fallback: use the leverage-risk engine's TP1 NET target + fees
            // This is the actual margin PnL the system targets for this leverage level
            const mode = this._state.currentMode || this._getOperatingMode();
            if (mode === 'micro_scalp') {
                // TP1 net target = 2% margin at >x50 (capped in leverage-risk.ts)
                expectedMarginPnl = 2 + feeMarginPct; // gross = net + fees
            } else if (mode === 'hybrid') {
                expectedMarginPnl = 3 + feeMarginPct;
            } else {
                expectedMarginPnl = (this._config.tp1TargetNetMarginPct || 3) + feeMarginPct;
            }
        }

        // Gate: expected gross must exceed 1.2× total costs
        const threshold = totalCostMarginPct * 1.2;

        if (expectedMarginPnl < threshold) {
            console.warn(`[ScalpEngine] ⛔ PROFIT GATE: expected ${expectedMarginPnl.toFixed(1)}% margin < ${threshold.toFixed(1)}% (1.2×costs) — REJECTED`);
            return { pass: false, reason: `Expected ${expectedMarginPnl.toFixed(1)}% < ${threshold.toFixed(1)}% threshold`, feeMarginPct, slippageMarginPct, expectedMarginPnl };
        }

        return { pass: true, netProfit: expectedMarginPnl - totalCostMarginPct, feeMarginPct, slippageMarginPct, expectedMarginPnl };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SLIPPAGE MODEL — conservative estimate
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Estimate slippage as % of notional.
     * f(volatility, spread, TPS) — uses conservative default if data unavailable.
     * Returns notional % (divide by leverage for margin %, multiply for margin %).
     */
    _estimateSlippage() {
        const cache = typeof StateCache !== 'undefined' ? StateCache : null;
        if (!cache) return 0.01; // conservative default: 0.01% notional

        const bestBid = cache.get('bestBid', 0);
        const bestAsk = cache.get('bestAsk', 0);
        const price = cache.get('currentPrice', 0);
        const tps = cache.get('tps', 0);
        const volScore = this._state.lastVolatilityScore || 0;

        // Base: half the spread (you cross it)
        let slippage = 0.005; // 0.005% conservative base
        if (bestBid > 0 && bestAsk > 0 && price > 0) {
            const spreadPct = (bestAsk - bestBid) / price;
            slippage = spreadPct / 2;
        }

        // Volatility premium: high vol = more slippage
        if (volScore > 60) slippage *= 1.5;
        else if (volScore > 40) slippage *= 1.2;

        // Low TPS = thin book = more slippage
        if (tps > 0 && tps < 5) slippage *= 1.3;

        // Floor: never assume zero slippage
        return Math.max(0.002, slippage);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // VELOCITY CONTROL — ANTI-CHURN
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Instead of blocking trades, reduce position size when over threshold.
     * Returns size multiplier (1.0 = full, 0.25 = min, 0 = blocked).
     */
    _velocityControl() {
        const now = Date.now();
        const mode = this._state.currentMode || this._getOperatingMode();
        const velocityCfg = this._config.velocity[mode] || { maxTradesPerMin: 2 };

        // Dynamic max for micro_scalp based on leverage
        let maxPerMin = velocityCfg.maxTradesPerMin;
        if (mode === 'micro_scalp') {
            const lev = this._state.currentLeverage || 50;
            if (lev >= 200) maxPerMin = 8;
            else if (lev >= 100) maxPerMin = 6;
            else maxPerMin = 3;
        }

        // Clean old timestamps (keep last 60s)
        this._state.recentTradeTimestamps = this._state.recentTradeTimestamps.filter(t => now - t < 60000);
        const tradesLast60s = this._state.recentTradeTimestamps.length;

        if (tradesLast60s >= maxPerMin * 3) {
            this._state.velocityReduction = 0; // BLOCK
            console.warn(`[ScalpEngine] 🛑 VELOCITY BLOCK: ${tradesLast60s} trades/min (3× max ${maxPerMin})`);
            return 0;
        }
        if (tradesLast60s >= maxPerMin * 2) {
            this._state.velocityReduction = 0.25;
        } else if (tradesLast60s >= maxPerMin * 1.5) {
            this._state.velocityReduction = 0.50;
        } else if (tradesLast60s >= maxPerMin * 1.2) {
            this._state.velocityReduction = 0.75;
        } else {
            this._state.velocityReduction = 1.0;
        }

        if (this._state.velocityReduction < 1.0) {
            console.debug(`[ScalpEngine] Velocity throttle: ${tradesLast60s}/${maxPerMin}/min → size ×${this._state.velocityReduction}`);
        }
        return this._state.velocityReduction;
    },

    /** Record a trade emission for velocity tracking */
    _recordTradeEmission(direction) {
        this._state.recentTradeTimestamps.push(Date.now());
        // Direction stickiness
        this._state.lastTradeDirection = direction;
        this._state.directionStickyUntil = Date.now() + this._config.directionSticky.maxDurationMs;
        this._state.directionStickyCount = this._config.directionSticky.maxTrades;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DIRECTION STICKINESS — avoid constant flipping
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Penalize direction flips unless strong reversal evidence exists.
     * Modifies setup.score in-place. Returns true if flip was penalized.
     */
    _applyDirectionStickiness(setup, data) {
        const lastDir = this._state.lastTradeDirection;
        if (!lastDir) return false; // no history, no stickiness

        const now = Date.now();
        const isSticky = (now < this._state.directionStickyUntil) || (this._state.directionStickyCount > 0);
        if (!isSticky) return false;

        // Same direction → small bonus
        if (setup.direction === lastDir) {
            setup.score += 5;
            setup.confirmations.push('direction_continuation');
            return false;
        }

        // Different direction → check for strong reversal evidence
        const hasStrongReversal =
            setup.confirmations.includes('mss_bullish') ||
            setup.confirmations.includes('mss_bearish') ||
            setup.confirmations.includes('absorption') ||
            setup.confirmations.includes('absorption_at_ob') ||
            setup.confirmations.includes('absorption_confirmed') ||
            setup.confirmations.includes('sweep_mss_linked') ||
            setup.type === 'absorption_reversal';

        if (hasStrongReversal) {
            // Strong reversal → allow flip, clear stickiness
            this._state.directionStickyCount = 0;
            this._state.directionStickyUntil = 0;
            setup.confirmations.push('reversal_override');
            return false;
        }

        // No strong reversal → heavy penalty
        const penalty = this._config.directionSticky.flipPenalty;
        const origScore = setup.score;
        setup.score = Math.round(setup.score * penalty);
        setup.confirmations.push('direction_flip_penalty');
        console.debug(`[ScalpEngine] Direction flip penalty: ${origScore} → ${setup.score} (×${penalty})`);
        return true;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // CONTEXT MODULATION — Accelerators/Dampeners (NOT blockers)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Volume Profile as accelerator/dampener on setup.
     * POC → reduce size | LVN → boost (fast moves) | VAH/VAL → boost reversals
     */
    _volumeProfileModulation(setup, data) {
        const vp = data.volumeProfile;
        if (!vp) return;
        const price = data.currentPrice;
        const proxPct = this._config.proximityPct;
        const threshold = price * proxPct * 3;

        // Near POC → reduce size (high liquidity = choppy)
        if (vp.poc && Math.abs(price - vp.poc) < threshold) {
            setup.sizeMultiplier = (setup.sizeMultiplier || 1.0) * 0.7;
            setup.confirmations.push('poc_dampened');
        }

        // In LVN → fast moves expected, accelerate
        const lvns = vp.lvn || [];
        for (const lvn of lvns) {
            const lvnPrice = lvn.price || lvn;
            if (Math.abs(price - lvnPrice) < threshold) {
                setup.score += 8;
                setup.confirmations.push('lvn_accelerate');
                break;
            }
        }

        // Near VAH → boost short reversals | Near VAL → boost long reversals
        if (vp.vah && Math.abs(price - vp.vah) < threshold && setup.direction === 'short') {
            setup.score += 12;
            setup.confirmations.push('vah_reversal_boost');
        }
        if (vp.val && Math.abs(price - vp.val) < threshold && setup.direction === 'long') {
            setup.score += 12;
            setup.confirmations.push('val_reversal_boost');
        }
    },

    /**
     * AMT (Auction Market Theory) modulation.
     * BALANCE → favor mean reversion | IMBALANCE → favor continuation
     */
    _amtModulation(setup, data) {
        const regime = data.marketState?.regime?.current;
        if (!regime) return;

        const isBalance = regime === 'range' || regime === 'ranging';
        const isImbalance = regime === 'trending_up' || regime === 'trending_down' || regime === 'breakout';

        const isReversalSetup = ['liquidity_sweep_reversal', 'volume_node_rejection', 'fvg_fill_rejection', 'absorption_reversal'].includes(setup.type);
        const isContinuationSetup = ['micro_bos_continuation', 'micro_spike'].includes(setup.type);

        if (isBalance) {
            if (isReversalSetup) {
                setup.score += 10;
                setup.confirmations.push('amt_balance_reversal');
            }
            if (isContinuationSetup) {
                setup.score -= 5;
                setup.confirmations.push('amt_balance_cont_penalty');
            }
        }

        if (isImbalance) {
            if (isContinuationSetup) {
                setup.score += 10;
                setup.confirmations.push('amt_imbalance_continuation');
            }
            if (isReversalSetup) {
                setup.score -= 8;
                setup.confirmations.push('amt_imbalance_rev_penalty');
            }
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // MICROSTRUCTURE PRIORITY — order flow weight boost at high leverage
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * At high leverage, order flow signals get weighted more heavily.
     * micro_scalp: OBI×1.5, CVD×1.5, TPS×2.0, LTB×2.0, Absorption×2.0
     */
    _microstructureBoost(setup, data) {
        const mode = this._state.currentMode || this._getOperatingMode();
        if (mode === 'swing_scalp') return; // no boost

        const mult = mode === 'micro_scalp' ? 1.0 : 0.5; // hybrid gets half the bonus
        const of = data.orderFlow;
        if (!of) return;

        let boost = 0;

        // CVD acceleration
        if (of.cumulativeDelta) {
            const cdTrend = typeof of.cumulativeDelta === 'object' ? of.cumulativeDelta.trend : null;
            const aligned = (setup.direction === 'long' && cdTrend === 'bullish') ||
                (setup.direction === 'short' && cdTrend === 'bearish');
            if (aligned) boost += Math.round(8 * mult);
        }

        // Absorption — KEY signal at high leverage
        if (of.absorption?.detected) {
            const absAligned = (setup.direction === 'long' && of.absorption.mostRecent?.direction === 'selling_absorbed') ||
                (setup.direction === 'short' && of.absorption.mostRecent?.direction === 'buying_absorbed');
            if (absAligned) boost += Math.round(12 * mult);
        }

        // Aggressive imbalance
        if (of.aggressiveImbalance?.detected) {
            const imbAligned = (setup.direction === 'long' && of.aggressiveImbalance.direction === 'buy_aggression') ||
                (setup.direction === 'short' && of.aggressiveImbalance.direction === 'sell_aggression');
            if (imbAligned) boost += Math.round(10 * mult);
        }

        // Delta divergence
        if (of.deltaDivergence?.detected) {
            const divAligned = (setup.direction === 'long' && of.deltaDivergence.direction === 'bullish') ||
                (setup.direction === 'short' && of.deltaDivergence.direction === 'bearish');
            if (divAligned) boost += Math.round(8 * mult);
        }

        if (boost > 0) {
            setup.score += boost;
            setup.confirmations.push(`microstructure_boost_${boost}`);
            console.debug(`[ScalpEngine] Microstructure boost: +${boost} (mode=${mode})`);
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // NEW SCANNERS — Micro-Scalp Specific
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Micro Spike Scanner — detects sub-candle volume/delta bursts.
     * Only active in micro_scalp or hybrid mode.
     * Triggers: OBI ratio, CVD acceleration, volume spike, large trade burst.
     */
    _scanMicroSpike(data) {
        const sensitivity = this._getSignalSensitivity();
        if (!sensitivity.microSpikes) return null; // Only in micro_scalp

        const { orderFlow, currentPrice, candles } = data;
        if (!candles || candles.length < 5) return null;

        let score = 20;
        const confirmations = [];
        let direction = null;

        // Volume spike (last candle vs 10-candle avg)
        const last = candles[candles.length - 1];
        const windowSize = Math.min(10, candles.length - 1);
        const avgVol = candles.slice(-windowSize - 1, -1)
            .reduce((s, c) => s + (c.volume || 0), 0) / Math.max(windowSize, 1);

        if (avgVol > 0 && last.volume > avgVol * 2.0) {
            score += 15;
            confirmations.push('volume_spike_2x');
            // Direction from candle body
            direction = last.close > last.open ? 'long' : 'short';
        } else if (avgVol > 0 && last.volume > avgVol * 1.5) {
            score += 8;
            confirmations.push('volume_spike_1.5x');
            direction = last.close > last.open ? 'long' : 'short';
        }

        // CVD acceleration
        if (orderFlow?.cumulativeDelta) {
            const cd = orderFlow.cumulativeDelta;
            const cdVal = typeof cd === 'object' ? (cd.value || 0) : (cd || 0);
            if (Math.abs(cdVal) > 500) {
                score += 12;
                direction = cdVal > 0 ? 'long' : 'short';
                confirmations.push('cvd_acceleration');
            }
        }

        // Aggressive imbalance (OBI proxy)
        if (orderFlow?.aggressiveImbalance?.detected) {
            score += 15;
            direction = orderFlow.aggressiveImbalance.direction === 'buy_aggression' ? 'long' : 'short';
            confirmations.push('obi_imbalance');
        }

        // Delta divergence (spike)
        if (orderFlow?.deltaDivergence?.detected) {
            score += 12;
            direction = orderFlow.deltaDivergence.direction === 'bullish' ? 'long' : 'short';
            confirmations.push('delta_spike');
        }

        if (!direction || confirmations.length < 2) return null; // Need at least 2 triggers

        const modeConfig = this._getModeConfig();
        const gate = this._config.minSetupScore * modeConfig.scannerGateMult;
        if (score < gate) {
            console.debug(`[ScalpEngine] _scanMicroSpike: score ${score} < gate ${gate}`);
            return null;
        }

        return this._buildSetup('micro_spike', direction, score, confirmations, data);
    },

    /**
     * Absorption Reversal Scanner — immediate counter-trade on absorption.
     * "If aggressive buying + absorption → immediate short scalp"
     * This is the KEY signal at high leverage per the spec.
     */
    _scanAbsorptionReversal(data) {
        const mode = this._state.currentMode || this._getOperatingMode();
        if (mode === 'swing_scalp') return null; // Only hybrid + micro_scalp

        const { orderFlow, currentPrice, candles } = data;
        if (!orderFlow?.absorption?.detected || !orderFlow.absorption.mostRecent) return null;
        if (!candles || candles.length < 3) return null;

        const abs = orderFlow.absorption.mostRecent;
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];

        let score = 40;
        const confirmations = ['absorption_key'];
        let direction = null;

        if (abs.direction === 'buying_absorbed') {
            // Aggressive buying but price NOT rising → sellers absorbing → short
            if (last.close <= prev.close * 1.0002) { // price flat or down
                direction = 'short';
                score += 15;
                confirmations.push('buy_absorbed_flat');
            }
        } else if (abs.direction === 'selling_absorbed') {
            // Aggressive selling but price NOT falling → buyers absorbing → long
            if (last.close >= prev.close * 0.9998) { // price flat or up
                direction = 'long';
                score += 15;
                confirmations.push('sell_absorbed_flat');
            }
        }

        if (!direction) return null;

        // Bonus: aggressive imbalance confirms
        if (orderFlow.aggressiveImbalance?.detected) {
            const oppAligned = (direction === 'short' && orderFlow.aggressiveImbalance.direction === 'buy_aggression') ||
                (direction === 'long' && orderFlow.aggressiveImbalance.direction === 'sell_aggression');
            if (oppAligned) {
                score += 12;
                confirmations.push('imbalance_confirms_absorption');
            }
        }

        // Bonus: delta divergence
        if (orderFlow.deltaDivergence?.detected) {
            score += 8;
            confirmations.push('delta_div_absorption');
        }

        const modeConfig = this._getModeConfig();
        const gate = this._config.minSetupScore * modeConfig.scannerGateMult;
        if (score < gate) return null;

        return this._buildSetup('absorption_reversal', direction, score, confirmations, data);
    },

    /**
     * Calculates institutional SL/TP levels for bracket orders.
     * v3.0: OB-based SL, FVG/LVN-based TP, 1% capital risk cap.
     *
     * @param {string} direction - 'long' or 'short'
     * @param {number} volatility - Fallback (default 0.2% of price)
     * @returns {Object} { entry, stopLoss, tp1, tp2, takeProfit, risk, positionSize }
     */
    calculateSetup(direction, volatility = 0.002) {
        const cache = typeof StateCache !== 'undefined' ? StateCache : null;
        const currentPrice = cache ? cache.get('currentPrice', 0) : 0;
        const atr = this._state.lastATR || 0;

        if (currentPrice <= 0) return { entry: 0, stopLoss: 0, tp1: 0, tp2: 0, risk: 0, positionSize: 0 };

        // ─── SL: OB far edge + 0.5× ATR buffer ───
        // Try to find the nearest OB to use for SL placement
        let riskDistance = atr > 0 ? (atr * (this._config.atr.stopMultiple || 0.7)) : (currentPrice * volatility);
        const activeOBs = cache ? cache.get('activeOrderBlocks', []) : [];
        const proximityThreshold = currentPrice * this._config.proximityPct;

        if (activeOBs.length > 0) {
            for (const ob of activeOBs) {
                if (ob.mitigated) continue;
                const isAligned = (direction === 'long' && ob.type === 'bullish') ||
                                  (direction === 'short' && ob.type === 'bearish');
                if (!isAligned) continue;
                const obDist = Math.abs(currentPrice - ((ob.high + ob.low) / 2));
                if (obDist < proximityThreshold * 5) {
                    // SL = far edge of OB + 0.5× ATR buffer
                    const obEdgeSL = direction === 'long'
                        ? ob.low - (atr * 0.5)
                        : ob.high + (atr * 0.5);
                    riskDistance = Math.abs(currentPrice - obEdgeSL);
                    break;
                }
            }
        }

        let stopLoss, tp1, tp2;
        const dir = (direction || '').toLowerCase();

        if (dir === 'long' || dir === 'buy') {
            stopLoss = currentPrice - riskDistance;
            tp1 = currentPrice + (riskDistance * 1.5); // 1.5R
            tp2 = currentPrice + (riskDistance * 2.5); // 2.5R
        } else if (dir === 'short' || dir === 'sell') {
            stopLoss = currentPrice + riskDistance; // Stop fica ACIMA
            tp1 = currentPrice - (riskDistance * 1.5); // Alvo fica ABAIXO
            tp2 = currentPrice - (riskDistance * 2.5);
        } else {
            // Caso falhe, protege
            stopLoss = currentPrice;
            tp1 = currentPrice;
            tp2 = currentPrice;
        }

        console.log(`[Matemática] Dir: ${direction} | In: $${currentPrice.toFixed(2)} | SL: $${stopLoss.toFixed(2)} | TP1: $${tp1.toFixed(2)}`);

        // ─── Snap TP to structural levels (LVN, VAH/VAL, HVN) ───
        const lvns = cache ? cache.get('lvnLevels', []) : [];
        const hvns = cache ? cache.get('hvnLevels', []) : [];
        const vah = cache ? cache.get('currentVAH', 0) : 0;
        const val = cache ? cache.get('currentVAL', 0) : 0;

        const tpCandidates = [
            ...lvns.map(l => l.price || l),
            ...hvns.map(h => h.price || h),
            vah, val
        ].filter(p => p > 0);

        // Snap TP1 to nearest structural level if within 1 ATR
        for (const lvl of tpCandidates) {
            const isValidTarget = direction === 'long' ? lvl > currentPrice : lvl < currentPrice;
            if (isValidTarget && Math.abs(lvl - tp1) < atr) {
                tp1 = lvl;
                break;
            }
        }

        // ─── 1% Capital Risk Position Sizing ───
        const capital = cache ? cache.get('accountBalance', 10000) : 10000;
        const maxRisk = capital * 0.01; // 1% max risk
        const positionSize = riskDistance > 0 ? Math.floor((maxRisk / riskDistance) * 100) / 100 : 0;

        return {
            entry: currentPrice,
            stopLoss: parseFloat(stopLoss.toFixed(2)),
            tp1: parseFloat(tp1.toFixed(2)),
            tp2: parseFloat(tp2.toFixed(2)),
            takeProfit: parseFloat(tp1.toFixed(2)), // Primary TP for bracket orders
            risk: riskDistance,
            positionSize: positionSize,
            riskPct: 0.01
        };
    },

    async handleEvent(event, params) {
        const perfStart = (event && event._perfStart) ||
            (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const eventType = event?.type || 'CANDLE_CLOSE';

        const data = this._buildDataFromCache(params);
        if (!data.currentPrice || !data.candles || data.candles.length < 10) {
            return this._emptyResult('Insufficient data');
        }

        this._state.lastATR = data.indicators?.atr?.value || this._calcFallbackATR(data.candles);
        if (typeof StateCache !== 'undefined') {
            StateCache.set('currentATR', this._state.lastATR);
        }

        const sessionId = data.context?.session?.current || 'unknown';
        if (sessionId !== this._state.lastSessionId && this._state.lastSessionId !== null) {
            this._state.sessionScalpCount = 0;
        }
        this._state.lastSessionId = sessionId;

        this._updateCooldown();
        const riskCheck = this._checkRiskControls(data.context);
        if (riskCheck.locked) {
            return this._emptyResult(riskCheck.reason, riskCheck);
        }

        const volScore = this._computeVolatilityScore(data);
        this._state.lastVolatilityScore = volScore;
        console.debug(`[ScalpEngine] Volatility score: ${volScore}`);

        this._ageSetups();

        let newSetups = [];
        const E = typeof EventBus !== 'undefined' ? EventBus.EVENTS : {};

        switch (eventType) {
            case E.LIQUIDITY_SWEEP:
                newSetups = await this._targetedScan('liquidity_sweep_reversal', data, eventType);
                break;
            case E.OB_RETEST:
                newSetups = await this._targetedScan('order_block_retest', data, eventType);
                break;
            case E.HVN_REJECTION:
                newSetups = await this._targetedScan('volume_node_rejection', data, eventType);
                break;
            case E.MICRO_BOS:
                newSetups = await this._targetedScan('micro_bos_continuation', data, eventType);
                break;
            case E.FVG_FILL:
                newSetups = await this._targetedScan('fvg_fill_rejection', data, eventType);
                break;
            case E.DELTA_SPIKE:
            case E.ABSORPTION:
                this._boostActiveSetups(eventType, event?.data);
                break;
            case E.ANALYSIS_SIGNAL:
                this._handleAnalysisSignal(params || event.payload);
                break;
            case E.CANDLE_CLOSE:
            default:
                newSetups = await this._scanAllSetups(data, eventType);
                break;
        }

        for (const s of newSetups) {
            s.eventSource = eventType;
        }

        this._mergeNewSetups(newSetups);

        for (const setup of this._state.activeSetups) {
            this._applyExecutionTiming(setup, data.currentPrice, data.candles);
        }

        const currentThreshold = this._getDynamicThreshold();
        const actionable = this._state.activeSetups.filter(s => s.score >= currentThreshold);
        this._state.bestSetup = actionable.length > 0
            ? actionable.reduce((best, s) => s.score > best.score ? s : best, actionable[0])
            : null;

        // FIX C5: Only increment sessionScalpCount when a real setup is emitted,
        // NOT on every evaluation cycle (was inflating counter to 1440/day).
        if (this._state.bestSetup) {
            this._state.sessionScalpCount++;
        }
        this._state.candlesSinceEval = 0;
        this._state.lastEventSource = eventType;

        const perfEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._state.lastLatencyMs = Math.round((perfEnd - perfStart) * 100) / 100;

        // FIX C6: Do NOT auto-record trade emission here.
        // Velocity tracking should reflect ACTUAL user trades, not signal generation.
        // _recordTradeEmission() is now called from the store's markPendingAsActive().
        // We still track direction for stickiness (no velocity impact).
        if (this._state.bestSetup) {
            this._state.lastTradeDirection = this._state.bestSetup.direction;
            this._state.directionStickyUntil = Date.now() + this._config.directionSticky.maxDurationMs;
            this._state.directionStickyCount = this._config.directionSticky.maxTrades;
        }

        return {
            active: this._state.bestSetup !== null,
            bestSetup: this._state.bestSetup,
            allSetups: this._state.activeSetups.map(s => ({ ...s })),
            setupCount: this._state.activeSetups.length,
            status: this._getStatusLabel(),
            riskState: this._getRiskState(),
            eventSource: eventType,
            latencyMs: this._state.lastLatencyMs,
            volatilityScore: volScore,
            // v4.0: Leverage-adaptive metadata — consumed by C1 sync bridge in App.tsx
            operatingMode: this._state.currentMode || this._getOperatingMode(),
            velocityState: {
                tradesPerMinute: this._state.recentTradeTimestamps.filter(t => Date.now() - t < 60000).length,
                sizeReduction: this._state.velocityReduction,
            },
            netPnlSession: this._performance.netPnl,
            totalFeesSession: this._performance.totalFeesPaid,
            recentWinRate: this._performance.recentWinRate,
            profitGate: this._state.bestSetup?.profitGate || null,
            // EV check result for UI (new enhancement)
            evResult: this._computeEV(),
        };
    },

    async evaluate(params) {
        return await this.handleEvent({ type: 'CANDLE_CLOSE' }, params);
    },

    recordOutcome(result) {
        if (!result || !result.type) return;
        const isWin = (result.pnlPct || 0) > 0;
        const bucket = this._performance.byType[result.type];
        if (bucket) {
            bucket.count++;
            if (isWin) bucket.wins++;
            else bucket.losses++;
            bucket.totalRR += result.rrRealized || 0;
        }
        this._performance.history.push({ timestamp: Date.now(), ...result, isWin });
        while (this._performance.history.length > this._config.tuning.rollingWindow * 2) {
            this._performance.history.shift();
        }

        // ─── Net PnL tracking (FIX C4: standardize to margin %) ───
        // All values must be in MARGIN % (= price_move% × leverage).
        // result.pnlPct should be the NET price move % (after fees from exchange).
        // If pnlPct is already net-of-fees, we just multiply by leverage.
        // If pnlPct is gross, we subtract fees.
        const leverage = this._state.currentLeverage || 10;
        const pricePnl = result.pnlPct || 0;  // price move % (from exchange, already net of fees)
        const marginPnl = pricePnl * leverage; // margin PnL %
        const feeMarginPct = result.feePct
            ? result.feePct  // if caller provides margin-based fee, use it
            : (this._config.takerFeePct || 0.04) * 2 * leverage; // otherwise compute

        // If pnlPct is NET (exchange-reported), gross = net + fees
        // If pnlPct is GROSS, net = gross - fees
        // We assume exchange-reported = NET (standard for MEXC/Binance APIs)
        this._performance.grossPnl += marginPnl + feeMarginPct; // reconstruct gross
        this._performance.totalFeesPaid += feeMarginPct;
        this._performance.netPnl = this._performance.grossPnl - this._performance.totalFeesPaid;

        // ─── Rolling win rate (last 20 trades) ───
        const recent20 = this._performance.history.slice(-20);
        if (recent20.length >= 5) {
            this._performance.recentWinRate = recent20.filter(h => h.isWin).length / recent20.length;
        }

        if (isWin) {
            this._state.consecutiveLosses = 0;
        } else {
            this._state.consecutiveLosses++;
            if (this._state.consecutiveLosses >= this._config.risk.maxConsecutiveLosses) {
                this._state.cooldownRemaining = this._config.risk.cooldownCandles;
                this._state.locked = true;
                this._state.lockReason = `${this._state.consecutiveLosses} consecutive scalp losses — cooling down`;
            }
        }

        // ─── Win rate auto-reducer (Component 6.2) ───
        const mode = this._state.currentMode || this._getOperatingMode();
        if (this._performance.recentWinRate < 0.40 && mode !== 'swing_scalp') {
            this._state.winRateThrottleActive = true;
            this._state.winRateThrottleFactor = 0.7;
            console.warn(`[ScalpEngine] ⚠️ Win rate ${(this._performance.recentWinRate * 100).toFixed(0)}% < 40% → throttle active`);
        } else {
            this._state.winRateThrottleActive = false;
            this._state.winRateThrottleFactor = 1.0;
        }

        // ─── Overtrading detection + auto-downgrade (Component 6.3) ───
        if (mode === 'micro_scalp' && this._state.consecutiveLosses >= 5) {
            this._state.modeDowngradedUntil = Date.now() + (5 * 60 * 1000); // 5 min
            this._state.currentMode = 'hybrid';
            console.warn(`[ScalpEngine] 🛑 5 consecutive losses in micro_scalp → auto-downgrade to hybrid for 5 min`);
        }

        this._selfTune();
    },

    getStatus() {
        return {
            state: this._getStatusLabel(),
            activeSetups: this._state.activeSetups.length,
            bestSetup: this._state.bestSetup,
            sessionScalps: this._state.sessionScalpCount,
            maxSessionScalps: this._config.risk.maxScalpsPerSession,
            consecutiveLosses: this._state.consecutiveLosses,
            locked: this._state.locked,
            lockReason: this._state.lockReason,
            cooldownRemaining: this._state.cooldownRemaining,
            performance: this._getPerformanceSummary(),
            typeMultipliers: { ...this._performance.typeMultipliers }
        };
    },

    reset() {
        this._state.activeSetups = [];
        this._state.bestSetup = null;
        this._state.candlesSinceEval = 0;
        this._state.sessionScalpCount = 0;
        this._state.consecutiveLosses = 0;
        this._state.cooldownRemaining = 0;
        this._state.locked = false;
        this._state.lockReason = null;
        this._state.lastSessionId = null;
        this._state.lastATR = 0;
        this._state.lastEventSource = null;
        this._state.lastLatencyMs = 0;
        this._state.lastVolatilityScore = 0;
        // v4.0: new state fields
        this._state.recentTradeTimestamps = [];
        this._state.velocityReduction = 1.0;
        this._state.lastTradeDirection = null;
        this._state.directionStickyUntil = 0;
        this._state.directionStickyCount = 0;
        this._state.winRateThrottleActive = false;
        this._state.winRateThrottleFactor = 1.0;
        this._state.modeDowngradedUntil = 0;
        this._radar = [];
    },

    subscribe() {
        if (typeof EventBus === 'undefined') return;
        const E = EventBus.EVENTS;
        const self = this;
        
        // Listen to Level 2 (Bidirectional Confluence)
        EventBus.on('LEVEL_2_PASSED', async function (setup) {
            try {
                const result = await self.processLevel2Setup(setup);
                if (result && result.active) {
                    EventBus.emit(E.SCALP_SETUP, {
                        setup: result.bestSetup,
                        eventSource: 'LEVEL_2_PASSED',
                        latencyMs: 0,
                        // Include engine state for sync bridge
                        operatingMode: result.operatingMode,
                        velocityState: result.velocityState,
                        netPnlSession: result.netPnlSession,
                        totalFeesSession: result.totalFeesSession,
                    });
                }
            } catch (e) {
                console.warn('[ScalpEngine] Level 2 processing error:', e);
            }
        });

        // Still listen to ANALYSIS_SIGNAL to keep mode/velocity in sync for UI even without setups
        EventBus.on(E.ANALYSIS_SIGNAL, () => {
             // Just keeping state updated, no setup processing
        });
    },

    // ═══════════════════════════════════════════════════════════════════════
    // LEVEL 3 & 4 CASCADING PIPELINE
    // ═══════════════════════════════════════════════════════════════════════

    async processLevel2Setup(setup) {
        console.log(`[LEVEL 3] Evaluating setup ${setup.direction.toUpperCase()} from Level 2...`);
        const mode = this._state.currentMode || this._getOperatingMode();
        this._state.currentMode = mode;

        // ─── PIPELINE HUD ───
        let store;
        if (typeof window !== 'undefined') {
            try {
                store = require('../store').useNexusStore;
                store.getState().setPipelineStage(3, 'evaluating', setup.direction, `Level 3 (${mode})`);
            } catch (e) {}
        }

        // Level 3: Dynamic Leverage Sensitivity
        const modeConfig = this._getModeConfig();
        const executionThreshold = modeConfig.minConfidence; // From config (micro_scalp is looser)
        
        if (setup.confidence < executionThreshold) {
            console.log(`[LEVEL 3] Rejected: Confidence ${(setup.confidence * 100).toFixed(0)}% < ${Math.round(executionThreshold * 100)}% required for ${mode} leverage tier.`);
            if (store) store.getState().setPipelineStage(3, 'rejected', setup.direction, `Low Confidence for ${mode}`);
            return this._emptyResult(`Low confidence for ${mode} tier`);
        }

        // Level 3: Profit Gate (EV > 1.2 * fees)
        const fakeData = this._buildDataFromCache({ currentPrice: setup.entryPrice });
        const entryZone = this._computeEntryZone(setup.direction, fakeData);
        const tradeMgmt = this._computeTradeManagement(setup.direction, entryZone, fakeData);
        
        setup.stopLoss = tradeMgmt.stopLoss;
        setup.targets = tradeMgmt.targets;
        
        const gate = this._profitGate(setup, fakeData);
        if (gate.blocked) {
            console.log(`[LEVEL 3] Rejected: Profit Gate Failed - ${gate.reason}`);
            if (store) store.getState().setPipelineStage(3, 'rejected', setup.direction, `Profit Gate Failed: ${gate.reason}`);
            return this._emptyResult(`Profit Gate: ${gate.reason}`);
        }

        if (store) store.getState().setPipelineStage(3, 'passed', setup.direction, `Profit Gate Passed`);

        // Level 4: Velocity Control (Anti-Churn)
        if (store) store.getState().setPipelineStage(4, 'evaluating', setup.direction, `Level 4 (Velocity Check)`);
        
        const vel = this._velocityControl(setup);
        if (vel.blocked) {
            console.log(`[LEVEL 4] Rejected: Velocity Control - ${vel.reason}`);
            if (store) store.getState().setPipelineStage(4, 'rejected', setup.direction, `Anti-Churn: ${vel.reason}`);
            return this._emptyResult(`Velocity: ${vel.reason}`);
        }

        // Passed L3 and L4!
        console.log(`✅ [LEVEL 4] PASSED. Finalizing SCALP_SETUP...`);
        if (store) store.getState().setPipelineStage(4, 'passed', setup.direction, `Setup Confirmed`);
        
        setup.score = setup.confidence * 100;
        setup.type = 'cascading_confluence';
        setup.quality = setup.score > 80 ? 'premium' : 'standard';
        
        this._state.bestSetup = setup;
        
        // Return structured state for UI / Sync Bridge
        return {
            active: true,
            bestSetup: setup,
            operatingMode: this._state.currentMode,
            velocityState: {
                tradesPerMinute: this._state.recentTradeTimestamps?.filter(t => Date.now() - t < 60000).length || 0,
                sizeReduction: this._state.velocityReduction ?? 1.0,
            },
            netPnlSession: this._performance.netPnl ?? 0,
            totalFeesSession: this._performance.totalFeesPaid ?? 0
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SETUP SCANNER – existing scanners
    // ═══════════════════════════════════════════════════════════════════════

    _getDynamicThreshold() {
        const leverage = this._state.currentLeverage || 10;
        const mode = this._state.currentMode || this._getOperatingMode();
        const modeConfig = this._getModeConfig();

        // Mode-driven base: convert minConfidence to score (0.50 → 50, 0.70 → 70)
        let dynamicMin = Math.round(modeConfig.minConfidence * 100);

        // Legacy tier modifier still applies as fine-tuning
        let activeTier = this._config.frequency.tiers[0];
        for (const tier of this._config.frequency.tiers) {
            if (leverage <= tier.maxLeverage) {
                activeTier = tier;
                break;
            }
        }
        dynamicMin += Math.round(activeTier.minScoreMod * 0.3); // reduced influence

        // Under-trading → ease threshold slightly
        if (this._state.sessionScalpCount < activeTier.targetTradesPerDay * 0.5) {
            dynamicMin -= 2;
        }

        // Win rate throttle increases threshold
        if (this._state.winRateThrottleActive) {
            dynamicMin += 8;
        }

        console.debug(`[ScalpEngine] dynamicMinScore = ${dynamicMin} (mode=${mode}, leverage=${leverage}x)`);
        return Math.max(10, dynamicMin);
    },

    async _scanAllSetups(data, eventSource = 'CANDLE_CLOSE') {
        return await this._fastScan(data, eventSource);
    },

    async _fastScan(data, eventSource = 'CANDLE_CLOSE') {
        const { liquidity, marketState, orderFlow, currentPrice, candles } = data;
        const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        const mode = this._state.currentMode || this._getOperatingMode();

        // --- Analysis Engine Integration ---
        const intent = typeof IntentEngine !== 'undefined' ? IntentEngine.detect(data) : { type: 'unknown', confidence: 0 };
        const preSignals = typeof PreSignalEngine !== 'undefined' ? PreSignalEngine.scan(data) : [];

        // Spread filter (always hard block)
        if (typeof StateCache !== 'undefined') {
            const bestBid = StateCache.get('bestBid', 0);
            const bestAsk = StateCache.get('bestAsk', 0);
            if (bestBid > 0 && bestAsk > 0 && currentPrice > 0) {
                const spreadPct = (bestAsk - bestBid) / currentPrice;
                if (spreadPct > this._config.spreadHardBlockPct) {
                    console.debug(`[ScalpEngine] Spread too wide (${(spreadPct * 100).toFixed(2)}%) – blocking`);
                    return [];
                }
            }
        }

        // --- Range Guard → Dampener (NOT hard block at high leverage) ---
        const rg = this._rangeGuard(data);
        let rangeDampener = 1.0;
        if (rg.blocked) {
            console.debug(`[ScalpEngine] _rangeGuard: BLOCKED (${rg.reason})`);
            return []; // swing_scalp still blocks
        }
        if (rg.dampener && rg.dampener < 1.0) {
            rangeDampener = rg.dampener;
            console.debug(`[ScalpEngine] _rangeGuard: dampened ×${rangeDampener}`);
        }

        // --- Velocity Control ---
        const velocityMult = this._velocityControl();
        if (velocityMult <= 0) {
            return []; // velocity hard block (3× over threshold)
        }

        const regime = marketState?.regime?.current;
        const regimeConf = marketState?.regime?.confidence ?? 50;
        const volScore = this._state.lastVolatilityScore || 0;
        const volMult = this._volatilityPenaltyMultiplier(volScore);
        const dynamicMinScore = this._getDynamicThreshold();

        console.debug(
            `[ScalpEngine._fastScan] mode=${mode} vol=${volScore}(x${volMult}) limit=${dynamicMinScore} regime=${regime}(${regimeConf}%) price=${currentPrice}`
        );

        // v4.0: 5 institutional + 2 micro-scalp scanners
        const scanners = [
            async () => this._scanLiquiditySweepReversal(data),
            async () => this._scanOrderBlockRetest(data),
            async () => this._scanVolumeNodeRejection(data),
            async () => this._scanMicroBOSContinuation(data),
            async () => this._scanFVGFillRejection(data),
            // NEW: Micro-scalp scanners (self-gate based on mode)
            async () => this._scanMicroSpike(data),
            async () => this._scanAbsorptionReversal(data),
        ];

        const scanResults = await Promise.all(scanners.map(s => s().catch(e => {
            console.warn('[ScalpEngine] Scanner error in _fastScan:', e.message);
            return null;
        })));

        const results = [];
        for (let result of scanResults) {
            if (result && result.type) {
                const tf = data.context?.timeframe || '1m';
                if ((tf.includes('h') || tf.includes('d')) && ['DELTA_SPIKE', 'LIQUIDITY_SWEEP', 'MICRO_BOS'].includes(eventSource)) {
                    result.score += 5;
                    result.confirmations.push('high_tf_sub_event');
                }
                if (volMult < 1.0) {
                    result.score = Math.round(result.score * volMult);
                    result.confirmations.push(`vol_penalty_${Math.round(volMult * 100)}pct`);
                }

                // Apply Intent bonus (FIX H1: check DIRECTION alignment, not just type)
                if (intent.type !== 'unknown' && intent.confidence > 0.4 && intent.direction) {
                    const intentDirAligned = intent.direction === result.direction;
                    const intentTypeValid = (intent.type === 'breakout' || intent.type === 'sweep');
                    if (intentDirAligned && intentTypeValid) {
                        result.score += Math.round(intent.confidence * 15);
                        result.confirmations.push(`intent_${intent.type}_${intent.direction}`);
                    }
                }

                // ═══ Apply leverage-adaptive modulations ═══
                this._microstructureBoost(result, data);
                this._volumeProfileModulation(result, data);
                this._amtModulation(result, data);
                this._applyDirectionStickiness(result, data);

                // ═══ Signal correlation penalty (new) ═══
                // OBI, CVD, TPS are correlated — if all 3 agree, apply 0.8× to prevent
                // inflated confidence from counting the same underlying signal 3 times.
                this._applyCorrelationPenalty(result);

                // Apply range dampener to size
                if (rangeDampener < 1.0) {
                    result.sizeMultiplier = (result.sizeMultiplier || 1.0) * rangeDampener;
                    result.confirmations.push('equilibrium_dampened');
                }

                // Apply velocity reduction to size
                if (velocityMult < 1.0) {
                    result.sizeMultiplier = (result.sizeMultiplier || 1.0) * velocityMult;
                    result.confirmations.push(`velocity_throttle_${Math.round(velocityMult * 100)}pct`);
                }

                // ═══ PROFIT GATE — mandatory fee check ═══
                const profitCheck = this._profitGate(result);
                if (!profitCheck.pass) {
                    console.debug(`[ScalpEngine] Setup ${result.type} rejected by profit gate: ${profitCheck.reason}`);
                    result.confirmations.push('profit_gate_rejected');
                    continue; // skip this setup entirely
                }
                result.profitGate = profitCheck;

                if (result.score >= dynamicMinScore) {
                    results.push(result);
                    this._radar.push({ ...result, timestamp: Date.now() });
                    if (this._radar.length > 50) this._radar.shift();
                } else {
                    console.debug(`[ScalpEngine] Setup ${result.type} dropped: score=${result.score} < req=${dynamicMinScore}`);
                }
            } else if (Array.isArray(result) && result.length > 0) {
                for (let subResult of result) {
                    if (subResult && subResult.score >= dynamicMinScore) {
                        results.push(subResult);
                        this._radar.push({ ...subResult, timestamp: Date.now() });
                        if (this._radar.length > 50) this._radar.shift();
                    }
                }
            }
        }

        const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (results.length > 0 || t1 - t0 > 5) {
            console.debug(`[ScalpEngine._fastScan] ${results.length} setups found in ${(t1 - t0).toFixed(2)}ms (mode=${mode})`);
        }

        return results.length > 1 ? this._deduplicateSetups(results) : results;
    },

    async _targetedScan(setupType, data, eventSource = 'CANDLE_CLOSE') {
        const scanMap = {
            liquidity_sweep_reversal: '_scanLiquiditySweepReversal',
            order_block_retest: '_scanOrderBlockRetest',
            volume_node_rejection: '_scanVolumeNodeRejection',
            micro_bos_continuation: '_scanMicroBOSContinuation',
            fvg_fill_rejection: '_scanFVGFillRejection'
        };
        const scanFn = scanMap[setupType];
        if (!scanFn || typeof this[scanFn] !== 'function') return [];
        let result = null;
        try {
            result = await this[scanFn](data);
        } catch (e) {
            console.warn('[ScalpEngine] Targeted scanner error:', e.message);
        }
        if (result) {
            const tf = data.context?.timeframe || '1m';
            if ((tf.includes('h') || tf.includes('d')) && ['DELTA_SPIKE', 'LIQUIDITY_SWEEP', 'MICRO_BOS'].includes(eventSource)) {
                result.score += 5;
                result.confirmations.push('high_tf_sub_event');
            }
            if (result.score >= this._getDynamicThreshold()) {
                return [result];
            }
        }
        return [];
    },

    _boostActiveSetups(eventType, eventData) {
        for (const setup of this._state.activeSetups) {
            const E = typeof EventBus !== 'undefined' ? EventBus.EVENTS : {};
            if (eventType === E.DELTA_SPIKE && eventData) {
                const aligned = (setup.direction === 'long' && eventData.direction === 'bullish') ||
                    (setup.direction === 'short' && eventData.direction === 'bearish');
                if (aligned) {
                    setup.score = Math.min(100, setup.score + 5);
                    if (!setup.confirmations.includes('live_delta_spike')) {
                        setup.confirmations.push('live_delta_spike');
                    }
                }
            }
            if (eventType === E.ABSORPTION && eventData) {
                const aligned = (setup.direction === 'long' && eventData.direction === 'selling_absorbed') ||
                    (setup.direction === 'short' && eventData.direction === 'buying_absorbed');
                if (aligned) {
                    setup.score = Math.min(100, setup.score + 7);
                    if (!setup.confirmations.includes('live_absorption')) {
                        setup.confirmations.push('live_absorption');
                    }
                }
            }
        }
    },

    _mergeNewSetups(newSetups) {
        for (const setup of newSetups) {
            if (this._state.activeSetups.length >= this._config.risk.maxConcurrentSetups) {
                const worst = this._state.activeSetups.reduce(
                    (min, s) => s.score < min.score ? s : min,
                    this._state.activeSetups[0]
                );
                if (setup.score > worst.score) {
                    this._state.activeSetups = this._state.activeSetups.filter(s => s !== worst);
                    this._state.activeSetups.push(setup);
                }
            } else {
                this._state.activeSetups.push(setup);
            }
        }
    },

    _buildDataFromCache(params) {
        const p = params || {};
        const cache = typeof StateCache !== 'undefined' ? StateCache : null;
        const lastSweepRaw = cache ? cache.get('lastSweep') : null;
        const sweepList = lastSweepRaw
            ? (Array.isArray(lastSweepRaw) ? lastSweepRaw : [lastSweepRaw])
            : [];
        return {
            marketState: p.marketState || (cache ? {
                structure: { lastBOS: cache.get('lastBOS'), lastMSS: cache.get('lastMSS') },
                regime: { current: cache.get('currentRegime'), confidence: cache.get('regimeConfidence', 50) }
            } : null),
            liquidity: p.liquidity || (cache ? {
                sweeps: sweepList,
                orderBlocks: cache.get('activeOrderBlocks', []),
                liquidityPools: cache.get('liquidityPools', []),
                displacements: cache.get('displacements', [])
            } : null),
            volumeProfile: p.volumeProfile || (cache ? {
                poc: cache.get('poc') || cache.get('currentPOC'),
                vah: cache.get('vah') || cache.get('currentVAH'),
                val: cache.get('val') || cache.get('currentVAL'),
                lvn: cache.get('lvnLevels', []),
                hvn: cache.get('hvnLevels', [])
            } : null),
            orderFlow: p.orderFlow || (cache ? {
                deltaDivergence: cache.get('lastDeltaSpike'),
                absorption: cache.get('lastAbsorption'),
                cumulativeDelta: cache.get('cumulativeDelta'),
                aggressiveImbalance: cache.get('aggressiveImbalance'),
                microPullback: cache.get('microPullback'),
                footprint: cache.get('footprint')
            } : null),
            context: p.context || (cache ? {
                session: { current: cache.get('currentSession'), killZone: cache.get('isKillZone') },
                volatilityRatio: cache.get('volatilityRatio')
            } : null),
            fibonacci: p.fibonacci || null,
            indicators: p.indicators || (cache ? {
                atr: { value: cache.get('currentATR') },
                fvg: cache.get('activeFVGs')
            } : null),
            currentPrice: p.currentPrice || (cache ? cache.get('currentPrice') : 0),
            candles: p.candles || []
        };
    },

    _volatilityGate(volScore) { return true; },

    _volatilityPenaltyMultiplier(volScore) {
        if (volScore >= 20) return 1.0;
        if (volScore >= 10) return 0.85;
        if (volScore >= 5) return 0.70;
        return 0.60;
    },

    _computeVolatilityScore(data) {
        const atr = this._state.lastATR;
        const price = data.currentPrice || 1;
        const atrPct = price > 0 ? atr / price : 0;
        let volumeRatio = 1;
        if (data.candles && data.candles.length > 2) {
            const last = data.candles[data.candles.length - 1];
            const recent = last?.volume || 0;
            const windowSize = Math.min(10, data.candles.length - 1);
            const avg = data.candles.slice(-windowSize - 1, -1)
                .reduce((s, c) => s + (c.volume || 0), 0) / Math.max(windowSize, 1);
            volumeRatio = avg > 0 ? recent / avg : 1;
        }
        let deltaAcc = 0;
        const cd = data.orderFlow?.cumulativeDelta;
        if (cd) {
            const rawVal = typeof cd === 'object' ? (cd.value || 0) : (cd || 0);
            deltaAcc = Math.min(1, Math.abs(rawVal) / 1000);
        }
        if (typeof StateCache !== 'undefined' && typeof StateCache.computeVolatilityScore === 'function') {
            return StateCache.computeVolatilityScore(atrPct, volumeRatio, deltaAcc);
        }
        const atrScore = Math.min(40, atrPct * 4000);
        const volScore = Math.min(30, Math.max(0, (volumeRatio - 1) * 30));
        const deltaScore = Math.min(30, deltaAcc * 30);
        const total = Math.round(atrScore + volScore + deltaScore);
        console.debug(`[ScalpEngine] volScore=${total} (atr%=${(atrPct * 100).toFixed(3)} atrScore=${atrScore.toFixed(1)} volR=${volumeRatio.toFixed(2)} delta=${deltaAcc.toFixed(3)})`);
        return total;
    },

    _handleAnalysisSignal(signal) {
        if (!signal) return;
        console.log('[ScalpEngine] Received external ANALYSIS_SIGNAL:', signal);

        // Boost existing setups that align with the high-probability analysis
        // FIX H3: Only boost if signal DIRECTION matches setup direction
        for (const setup of this._state.activeSetups) {
            if (signal.probability > 0.7) {
                const sigDir = signal.direction; // 'long' | 'short' | 'neutral'
                if (sigDir === setup.direction) {
                    setup.score = Math.min(100, setup.score + 10);
                    if (!setup.confirmations.includes('master_analysis_confirmed')) {
                        setup.confirmations.push('master_analysis_confirmed');
                    }
                }
            }
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SIGNAL CORRELATION PENALTY — prevent inflated confidence
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * If OBI, CVD, and TPS (or absorption) all align in the same direction,
     * these are correlated order-flow signals. Apply 0.8× penalty to prevent
     * triple-counting the same underlying flow.
     */
    _applyCorrelationPenalty(setup) {
        const correlated = ['obi_imbalance', 'cvd_acceleration', 'delta_spike',
            'absorption_key', 'imbalance_confirms_absorption'];
        const matches = setup.confirmations.filter(c => correlated.includes(c));
        if (matches.length >= 3) {
            const original = setup.score;
            setup.score = Math.round(setup.score * 0.8);
            setup.confirmations.push(`corr_penalty_${matches.length}signals`);
            console.debug(`[ScalpEngine] Correlation penalty: ${original} → ${setup.score} (${matches.length} correlated signals)`);
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // EXPECTED VALUE CHECK — statistical viability
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Compute Expected Value per trade:
     *   EV = (WR × avgWin) − ((1 − WR) × avgLoss)
     * Returns { ev, viable, action }.
     */
    _computeEV() {
        const history = this._performance.history;
        if (history.length < 5) return { ev: 0, viable: true, action: 'insufficient_data' };

        const recent = history.slice(-20);
        const wins = recent.filter(h => h.isWin);
        const losses = recent.filter(h => !h.isWin);

        const wr = wins.length / recent.length;
        const avgWin = wins.length > 0
            ? wins.reduce((s, h) => s + Math.abs(h.pnlPct || 0), 0) / wins.length
            : 0;
        const avgLoss = losses.length > 0
            ? losses.reduce((s, h) => s + Math.abs(h.pnlPct || 0), 0) / losses.length
            : 0;

        const ev = (wr * avgWin) - ((1 - wr) * avgLoss);

        let action = 'normal';
        if (ev <= 0 && recent.length >= 10) {
            action = 'reduce_frequency'; // EV negative → throttle
        } else if (ev > avgWin * 0.3) {
            action = 'edge_confirmed';
        }

        return { ev: Math.round(ev * 1000) / 1000, viable: ev > 0, action, winRate: wr, avgWin, avgLoss };
    },

    /**
     * FIX C6: Public method for external callers (store/UI) to record a real trade.
     * Called when user marks a setup as "taken" via markPendingAsActive().
     */
    recordUserTradeEmission(direction) {
        this._recordTradeEmission(direction);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // EXISTING SCANNERS (unchanged)
    // ═══════════════════════════════════════════════════════════════════════

    _scanLiquiditySweepReversal(data) {
        const { liquidity, marketState, orderFlow, currentPrice, candles } = data;
        if (!liquidity?.sweeps || liquidity.sweeps.length === 0) {
            console.debug('[ScalpEngine] _scanLiquiditySweepReversal: no sweeps');
            return null;
        }
        const recentSweep = liquidity.sweeps[liquidity.sweeps.length - 1];
        const candleCount = candles.length;
        const sweepAge = candleCount - (recentSweep.index || candleCount - 1);
        if (sweepAge > this._config.confirmationWindow + 2) {
            console.debug('[ScalpEngine] _scanLiquiditySweepReversal: sweep too old', sweepAge);
            return null;
        }
        let score = 35;
        const confirmations = [];
        const direction = recentSweep.direction === 'bullish' ? 'long' : 'short';
        confirmations.push(`sweep_${recentSweep.direction === 'bullish' ? 'eql' : 'eqh'}`);
        const lastMSS = marketState?.structure?.lastMSS;
        if (lastMSS) {
            const mssAge = candleCount - (lastMSS.index || candleCount);
            if (mssAge <= this._config.confirmationWindow) {
                const mssAligned = (direction === 'long' && lastMSS.direction === 'bullish') ||
                    (direction === 'short' && lastMSS.direction === 'bearish');
                if (mssAligned) {
                    score += 25;
                    confirmations.push('mss_' + lastMSS.direction);
                }
            }
        }
        if (recentSweep.mssLinked) {
            score += 10;
            confirmations.push('sweep_mss_linked');
        }
        if (orderFlow?.deltaDivergence?.detected) {
            const divAligned = (direction === 'long' && orderFlow.deltaDivergence.direction === 'bullish') ||
                (direction === 'short' && orderFlow.deltaDivergence.direction === 'bearish');
            if (divAligned) {
                score += 15;
                confirmations.push('delta_divergence');
            }
        }
        if (orderFlow?.absorption?.detected) {
            const absAligned = (direction === 'long' && orderFlow.absorption.mostRecent?.direction === 'selling_absorbed') ||
                (direction === 'short' && orderFlow.absorption.mostRecent?.direction === 'buying_absorbed');
            if (absAligned) {
                score += 10;
                confirmations.push('absorption');
            }
        }
        if (liquidity.displacements && liquidity.displacements.length > 0) {
            const lastDisp = liquidity.displacements[liquidity.displacements.length - 1];
            const dispAge = candleCount - (lastDisp.index || candleCount);
            if (dispAge <= 3) {
                score += 8;
                confirmations.push('displacement');
            }
        }
        if (score < this._config.minSetupScore * 0.8) {
            console.debug(`[ScalpEngine] _scanLiquiditySweepReversal: score ${score} too low`);
            return null;
        }
        console.debug(`[ScalpEngine] _scanLiquiditySweepReversal: returning setup score=${score} confirmations=${confirmations.join(',')}`);
        return this._buildSetup('liquidity_sweep_reversal', direction, score, confirmations, data);
    },

    _scanOrderBlockRetest(data) {
        const { liquidity, orderFlow, currentPrice, volumeProfile } = data;
        if (!liquidity?.orderBlocks) {
            console.debug('[ScalpEngine] _scanOrderBlockRetest: no orderBlocks');
            return null;
        }
        const activeOBs = liquidity.orderBlocks.filter(ob => !ob.mitigated);
        if (activeOBs.length === 0) {
            console.debug('[ScalpEngine] _scanOrderBlockRetest: no active OBs');
            return null;
        }
        const atr = this._state.lastATR;
        const proximityThreshold = currentPrice * this._config.proximityPct;
        let bestOB = null;
        let bestDist = Infinity;
        for (const ob of activeOBs) {
            const obMid = (ob.high + ob.low) / 2;
            const dist = Math.abs(currentPrice - obMid);
            if (currentPrice >= ob.low - proximityThreshold &&
                currentPrice <= ob.high + proximityThreshold &&
                dist < bestDist) {
                bestOB = ob;
                bestDist = dist;
            }
        }
        if (!bestOB) {
            console.debug('[ScalpEngine] _scanOrderBlockRetest: no OB near price');
            return null;
        }
        let score = 30;
        const confirmations = [];
        const direction = bestOB.type === 'bullish' ? 'long' : 'short';
        confirmations.push(`ob_retest_${bestOB.type}`);
        if (currentPrice >= bestOB.low && currentPrice <= bestOB.high) {
            score += 10;
            confirmations.push('inside_ob');
        }
        if (orderFlow?.absorption?.detected) {
            const absAligned = (direction === 'long' && orderFlow.absorption.mostRecent?.direction === 'selling_absorbed') ||
                (direction === 'short' && orderFlow.absorption.mostRecent?.direction === 'buying_absorbed');
            if (absAligned) {
                score += 20;
                confirmations.push('absorption_at_ob');
            }
        }
        if (orderFlow?.microPullback?.detected) {
            const pbAligned = (direction === 'long' && orderFlow.microPullback.direction === 'bullish_continuation') ||
                (direction === 'short' && orderFlow.microPullback.direction === 'bearish_continuation');
            if (pbAligned) {
                score += 15;
                confirmations.push('micro_pullback_failure');
            }
        }
        if (orderFlow?.aggressiveImbalance?.detected) {
            const imbAligned = (direction === 'long' && orderFlow.aggressiveImbalance.direction === 'buy_aggression') ||
                (direction === 'short' && orderFlow.aggressiveImbalance.direction === 'sell_aggression');
            if (imbAligned) {
                score += 12;
                confirmations.push('aggressive_imbalance');
            }
        }
        if (volumeProfile?.poc) {
            const pocDist = Math.abs(volumeProfile.poc - ((bestOB.high + bestOB.low) / 2));
            if (pocDist < proximityThreshold * 2) {
                score += 8;
                confirmations.push('ob_poc_cluster');
            }
        }
        if (score < this._config.minSetupScore * 0.8) {
            console.debug(`[ScalpEngine] _scanOrderBlockRetest: score ${score} too low`);
            return null;
        }
        console.debug(`[ScalpEngine] _scanOrderBlockRetest: returning setup score=${score} confirmations=${confirmations.join(',')}`);
        return this._buildSetup('order_block_retest', direction, score, confirmations, data);
    },

    _scanVolumeNodeRejection(data) {
        const { volumeProfile, orderFlow, currentPrice } = data;
        if (!volumeProfile || !currentPrice) return null;
        const lvns = volumeProfile.lvn || [];
        if (lvns.length === 0) {
            console.debug('[ScalpEngine] _scanVolumeNodeRejection: no LVNs');
            return null;
        }
        const proximityThreshold = currentPrice * this._config.proximityPct;
        let nearestLVN = null;
        let nearestDist = Infinity;
        for (const lvn of lvns) {
            const price = lvn.price || lvn;
            const dist = Math.abs(currentPrice - price);
            if (dist < proximityThreshold * 2 && dist < nearestDist) {
                nearestLVN = price;
                nearestDist = dist;
            }
        }
        if (!nearestLVN) {
            console.debug('[ScalpEngine] _scanVolumeNodeRejection: no LVN near price');
            return null;
        }
        const poc = volumeProfile.poc || currentPrice;
        const direction = currentPrice > poc ? 'short' : 'long';
        let score = 28;
        const confirmations = [];
        confirmations.push('lvn_proximity');
        if (orderFlow?.footprint?.detected) {
            const fpAligned = (direction === 'long' && orderFlow.footprint.direction === 'buy_dominant') ||
                (direction === 'short' && orderFlow.footprint.direction === 'sell_dominant');
            if (fpAligned) {
                score += 18;
                confirmations.push('footprint_imbalance');
            }
        }
        if (orderFlow?.aggressiveImbalance?.detected) {
            const imbAligned = (direction === 'long' && orderFlow.aggressiveImbalance.direction === 'buy_aggression') ||
                (direction === 'short' && orderFlow.aggressiveImbalance.direction === 'sell_aggression');
            if (imbAligned) {
                score += 15;
                confirmations.push('delta_shift');
            }
        }
        if (orderFlow?.cumulativeDelta) {
            const cdAligned = (direction === 'long' && orderFlow.cumulativeDelta.trend === 'bullish') ||
                (direction === 'short' && orderFlow.cumulativeDelta.trend === 'bearish');
            if (cdAligned) {
                score += 10;
                confirmations.push('cd_aligned');
            }
        }
        if (volumeProfile.vah && volumeProfile.val) {
            const nearVAH = Math.abs(currentPrice - volumeProfile.vah) < proximityThreshold;
            const nearVAL = Math.abs(currentPrice - volumeProfile.val) < proximityThreshold;
            if (nearVAH && direction === 'short') {
                score += 10;
                confirmations.push('vah_rejection');
            }
            if (nearVAL && direction === 'long') {
                score += 10;
                confirmations.push('val_rejection');
            }
        }
        if (score < this._config.minSetupScore * 0.8) {
            console.debug(`[ScalpEngine] _scanVolumeNodeRejection: score ${score} too low`);
            return null;
        }
        console.debug(`[ScalpEngine] _scanVolumeNodeRejection: returning setup score=${score} confirmations=${confirmations.join(',')}`);
        return this._buildSetup('volume_node_rejection', direction, score, confirmations, data);
    },

    _scanMicroBOSContinuation(data) {
        const { marketState, orderFlow, volumeProfile, currentPrice, candles } = data;
        if (!marketState?.structure?.lastBOS) {
            console.debug('[ScalpEngine] _scanMicroBOSContinuation: no BOS');
            return null;
        }
        const regime = marketState.regime?.current;
        const TRENDING_REGIMES = ['trending', 'trending_up', 'trending_down',
            'breakout', 'ranging', 'range', 'uptrend', 'downtrend'];
        const isUsefulRegime = !regime || TRENDING_REGIMES.includes(regime);
        if (!isUsefulRegime) {
            console.debug('[ScalpEngine] _scanMicroBOSContinuation: regime not useful', regime);
            return null;
        }
        const lastBOS = marketState.structure.lastBOS;
        const candleCount = Math.max(candles.length, 1);
        const bosIdx = lastBOS.index || lastBOS.candleIndex || (candleCount - 1);
        const bosAge = candleCount - bosIdx;
        if (bosAge > this._config.confirmationWindow + 3) {
            console.debug('[ScalpEngine] _scanMicroBOSContinuation: BOS too old', bosAge);
            return null;
        }
        const direction = lastBOS.direction === 'bullish' ? 'long' : 'short';
        let score = 30;
        const confirmations = [];
        confirmations.push('micro_bos_' + lastBOS.direction);
        if (lastBOS.confidence && lastBOS.confidence > 60) {
            score += 8;
            confirmations.push('high_confidence_bos');
        }
        const regimeConf = marketState.regime?.confidence || 50;
        if ((direction === 'long' && (regime === 'trending_up' || regime === 'uptrend')) ||
            (direction === 'short' && (regime === 'trending_down' || regime === 'downtrend'))) {
            score += 10;
            confirmations.push('regime_aligned');
        }
        if (regimeConf > 70) {
            score += 5;
            confirmations.push('high_regime_confidence');
        }
        if (orderFlow?.cumulativeDelta) {
            const cdTrend = orderFlow.cumulativeDelta.trend || orderFlow.cumulativeDelta;
            const alignedLong = direction === 'long' && (cdTrend === 'bullish' || cdTrend?.trend === 'bullish');
            const alignedShort = direction === 'short' && (cdTrend === 'bearish' || cdTrend?.trend === 'bearish');
            if (alignedLong || alignedShort) {
                score += 15;
                confirmations.push('delta_aligned');
            }
        }
        if (volumeProfile?.poc) {
            const abovePOC = currentPrice > volumeProfile.poc;
            const pocAligned = (direction === 'long' && abovePOC) ||
                (direction === 'short' && !abovePOC);
            if (pocAligned) {
                score += 10;
                confirmations.push('poc_aligned');
            }
        }
        if (orderFlow?.aggressiveImbalance?.detected) {
            const imbAligned = (direction === 'long' && orderFlow.aggressiveImbalance.direction === 'buy_aggression') ||
                (direction === 'short' && orderFlow.aggressiveImbalance.direction === 'sell_aggression');
            if (imbAligned) {
                score += 12;
                confirmations.push('aggressive_flow');
            }
        }
        if (data.fibonacci?.levels) {
            const retracements = data.fibonacci.levels.retracements || [];
            const proximityThreshold = currentPrice * this._config.proximityPct;
            for (const ret of retracements) {
                if (ret.isKey && Math.abs(currentPrice - ret.price) < proximityThreshold) {
                    score += 8;
                    confirmations.push('fib_' + ret.label);
                    break;
                }
            }
        }
        if (score < this._config.minSetupScore * 0.8) {
            console.debug(`[ScalpEngine] _scanMicroBOSContinuation: score ${score} too low`);
            return null;
        }
        console.debug(`[ScalpEngine] _scanMicroBOSContinuation: returning setup score=${score} confirmations=${confirmations.join(',')}`);
        return this._buildSetup('micro_bos_continuation', direction, score, confirmations, data);
    },

    _scanFVGFillRejection(data) {
        const { indicators, liquidity, orderFlow, currentPrice, candles } = data;
        if (!indicators?.fvg) {
            console.debug('[ScalpEngine] _scanFVGFillRejection: no FVG data');
            return null;
        }
        const fvgData = indicators.fvg;
        const bullFVGs = fvgData.bullishGaps || [];
        const bearFVGs = fvgData.bearishGaps || [];
        const proximityThreshold = currentPrice * this._config.proximityPct;
        let fillingFVG = null;
        let fvgDirection = null;
        for (const gap of bullFVGs) {
            if (currentPrice >= gap.low && currentPrice <= gap.high) {
                fillingFVG = gap;
                fvgDirection = 'long';
                break;
            }
        }
        if (!fillingFVG) {
            for (const gap of bearFVGs) {
                if (currentPrice >= gap.low && currentPrice <= gap.high) {
                    fillingFVG = gap;
                    fvgDirection = 'short';
                    break;
                }
            }
        }
        if (!fillingFVG || !fvgDirection) {
            console.debug('[ScalpEngine] _scanFVGFillRejection: not filling any FVG');
            return null;
        }
        let score = 25;
        const confirmations = [];
        confirmations.push('fvg_fill_' + fvgDirection);
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles.length > 1 ? candles[candles.length - 2] : null;
        if (lastCandle && prevCandle) {
            const body = Math.abs(lastCandle.close - lastCandle.open);
            const totalRange = lastCandle.high - lastCandle.low;
            if (totalRange > 0 && body / totalRange < 0.4) {
                const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
                const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
                if (fvgDirection === 'long' && lowerWick > upperWick) {
                    score += 15;
                    confirmations.push('rejection_wick_long');
                } else if (fvgDirection === 'short' && upperWick > lowerWick) {
                    score += 15;
                    confirmations.push('rejection_wick_short');
                }
            }
        }
        if (liquidity?.orderBlocks) {
            const activeOBs = liquidity.orderBlocks.filter(ob => !ob.mitigated);
            for (const ob of activeOBs) {
                const obAligned = (fvgDirection === 'long' && ob.type === 'bullish') ||
                    (fvgDirection === 'short' && ob.type === 'bearish');
                if (obAligned) {
                    const obMid = (ob.high + ob.low) / 2;
                    const fvgMid = (fillingFVG.high + fillingFVG.low) / 2;
                    if (Math.abs(obMid - fvgMid) < proximityThreshold * 3) {
                        score += 18;
                        confirmations.push('fvg_ob_cluster');
                        break;
                    }
                }
            }
        }
        if (lastCandle && prevCandle && prevCandle.volume > 0) {
            const volRatio = (lastCandle.volume || 0) / prevCandle.volume;
            if (volRatio > 1.5) {
                score += 10;
                confirmations.push('volume_spike');
            }
        }
        if (orderFlow?.absorption?.detected) {
            score += 10;
            confirmations.push('absorption');
        }
        if (score < this._config.minSetupScore * 0.8) {
            console.debug(`[ScalpEngine] _scanFVGFillRejection: score ${score} too low`);
            return null;
        }
        console.debug(`[ScalpEngine] _scanFVGFillRejection: returning setup score=${score} confirmations=${confirmations.join(',')}`);
        return this._buildSetup('fvg_fill_rejection', fvgDirection, score, confirmations, data);
    },

    _scanDeltaMomentumEntry(data) {
        const { orderFlow, currentPrice, candles, indicators } = data;
        const deltaSpike = orderFlow?.deltaDivergence;
        const tf = data.context?.timeframe;
        const is5m = tf === '5m' || tf === '15m';
        let direction = null;
        let score = 28;
        const confirmations = [];
        let isSimFallback = false;
        if (deltaSpike && deltaSpike.detected !== false) {
            direction = deltaSpike.direction === 'bullish' ? 'long' : 'short';
            confirmations.push('delta_spike');
            const magnitude = deltaSpike.magnitude || deltaSpike.size || 1;
            if (magnitude > 2) {
                score += 10;
                confirmations.push('large_spike');
            }
        } else if (is5m && candles && candles.length > 5) {
            isSimFallback = true;
            const recentClose = candles[candles.length - 1].close;
            const prevClose = candles[candles.length - 2].close;
            const isStrongBull = recentClose > prevClose * 1.001;
            const isStrongBear = recentClose < prevClose * 0.999;
            if (isStrongBull) {
                direction = 'long';
                score += 5;
                confirmations.push('native_momentum_bull');
            } else if (isStrongBear) {
                direction = 'short';
                score += 5;
                confirmations.push('native_momentum_bear');
            } else {
                console.debug('[ScalpEngine] _scanDeltaMomentumEntry: no native momentum');
                return null;
            }
        } else {
            console.debug('[ScalpEngine] _scanDeltaMomentumEntry: no delta spike');
            return null;
        }
        if (candles && candles.length >= 3) {
            const last3 = candles.slice(-3);
            const isAllGreen = last3.every(c => c.close >= c.open);
            const isAllRed = last3.every(c => c.close <= c.open);
            if ((direction === 'long' && (isAllGreen || (isSimFallback && last3[2].close > last3[0].open))) ||
                (direction === 'short' && (isAllRed || (isSimFallback && last3[2].close < last3[0].open)))) {
                score += 8;
                confirmations.push('momentum_aligned');
            }
        }
        if (typeof StateCache !== 'undefined') {
            const bid = StateCache.get('bestBid', 0);
            const ask = StateCache.get('bestAsk', 0);
            if (bid > 0 && ask > 0) {
                const spreadPct = (ask - bid) / currentPrice;
                if (spreadPct < 0.0003) {
                    score += 5;
                    confirmations.push('tight_spread');
                }
            }
        }
        const cd = orderFlow?.cumulativeDelta;
        if (cd) {
            const cdTrend = typeof cd === 'object' ? cd.trend : null;
            const aligned = (direction === 'long' && cdTrend === 'bullish') ||
                (direction === 'short' && cdTrend === 'bearish');
            if (aligned) {
                score += 10;
                confirmations.push('cumulative_delta_aligned');
            }
        }
        if (score < this._config.minSetupScore * 0.7) {
            console.debug(`[ScalpEngine] _scanDeltaMomentumEntry: score ${score} too low`);
            return null;
        }
        console.debug(`[ScalpEngine] _scanDeltaMomentumEntry: returning setup score=${score} confirmations=${confirmations.join(',')}`);
        return this._buildSetup('delta_momentum_entry', direction, score, confirmations, data);
    },

    _scanLiquidityTrapEntry(data) {
        const { liquidity, orderFlow, currentPrice, candles } = data;
        const sweep = liquidity?.sweeps?.[liquidity.sweeps.length - 1];
        if (!sweep) {
            console.debug('[ScalpEngine] _scanLiquidityTrapEntry: no recent sweep');
            return null;
        }
        const absorption = orderFlow?.absorption;
        const hasAbsorption = absorption?.detected ||
            (typeof StateCache !== 'undefined' && !!StateCache.get('lastAbsorption'));
        const tf = data.context?.timeframe;
        const currentCandle = candles?.[candles.length - 1];
        const is5m = tf === '5m' || tf === '15m';
        let hasVolumeSpike = false;
        if (is5m && !hasAbsorption && candles?.length > 10 && currentCandle) {
            const recentVols = candles.slice(-10, -1).map(c => c.volume || 0);
            const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
            if (currentCandle.volume > avgVol * 1.5) {
                hasVolumeSpike = true;
            }
        }
        let score = 30;
        const confirmations = ['liquidity_sweep'];
        const direction = sweep.direction === 'bullish' ? 'long' : 'short';
        if (hasAbsorption) {
            score += 20;
            confirmations.push('absorption_confirmed');
        } else if (hasVolumeSpike) {
            score += 15;
            confirmations.push('volume_spike_confirmed');
        } else if (!is5m) {
            console.debug('[ScalpEngine] _scanLiquidityTrapEntry: no absorption/volume spike');
            return null;
        }
        if (candles && candles.length > 0) {
            const sweepIdx = sweep.index || (candles.length - 1);
            const sweepAge = candles.length - sweepIdx;
            if (sweepAge <= 2) {
                score += 8;
                confirmations.push('fresh_sweep');
            }
            if (sweepAge > this._config.confirmationWindow + 5) {
                console.debug('[ScalpEngine] _scanLiquidityTrapEntry: sweep too old', sweepAge);
                return null;
            }
        }
        const lastCandle = candles?.[candles.length - 1];
        if (lastCandle) {
            const range = lastCandle.high - lastCandle.low;
            if (range > 0) {
                const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
                const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
                if (direction === 'long' && lowerWick / range > 0.4) {
                    score += 10;
                    confirmations.push('rejection_wick');
                }
                if (direction === 'short' && upperWick / range > 0.4) {
                    score += 10;
                    confirmations.push('rejection_wick');
                }
            }
        }
        if (score < this._config.minSetupScore * 0.7) {
            console.debug(`[ScalpEngine] _scanLiquidityTrapEntry: score ${score} too low`);
            return null;
        }
        console.debug(`[ScalpEngine] _scanLiquidityTrapEntry: returning setup score=${score} confirmations=${confirmations.join(',')}`);
        return this._buildSetup('liquidity_trap_entry', direction, score, confirmations, data);
    },

    _scanMicroPullbackContinuation(data) {
        const { marketState, orderFlow, currentPrice, candles } = data;
        const lastBOS = marketState?.structure?.lastBOS;
        if (!lastBOS) {
            console.debug('[ScalpEngine] _scanMicroPullbackContinuation: no BOS');
            return null;
        }
        const direction = lastBOS.direction === 'bullish' ? 'long' : 'short';
        if (!candles || candles.length < 5) return null;
        const recent5 = candles.slice(-5);
        const swingHigh = Math.max(...recent5.map(c => c.high));
        const swingLow = Math.min(...recent5.map(c => c.low));
        const range = swingHigh - swingLow;
        if (range === 0) return null;
        const pullbackPct = direction === 'long'
            ? (swingHigh - currentPrice) / range
            : (currentPrice - swingLow) / range;
        const tf = data.context?.timeframe;
        const is5m = tf === '5m' || tf === '15m';
        const minPullback = is5m ? 0.15 : 0.25;
        const maxPullback = is5m ? 0.85 : 0.75;
        const inPullbackZone = pullbackPct >= minPullback && pullbackPct <= maxPullback;
        if (!inPullbackZone) {
            console.debug('[ScalpEngine] _scanMicroPullbackContinuation: pullback outside zone', pullbackPct);
            return null;
        }
        let score = 26;
        const confirmations = ['bos_pullback'];
        if (pullbackPct >= 0.35 && pullbackPct <= 0.55) {
            score += 8;
            confirmations.push('golden_ratio_pullback');
        }
        const cd = orderFlow?.cumulativeDelta;
        if (cd) {
            const cdTrend = typeof cd === 'object' ? cd.trend : null;
            const aligned = (direction === 'long' && cdTrend === 'bullish') ||
                (direction === 'short' && cdTrend === 'bearish');
            if (aligned) {
                score += 15;
                confirmations.push('delta_aligned');
            } else if (!is5m) {
                score -= 5;
            }
        } else if (is5m) {
            score += 5;
        }
        const bosIdx = lastBOS.index || lastBOS.candleIndex || (candles.length - 1);
        const bosAge = candles.length - bosIdx;
        if (bosAge <= 5) {
            score += 5;
            confirmations.push('fresh_bos');
        }
        if (score < this._config.minSetupScore * 0.65) {
            console.debug(`[ScalpEngine] _scanMicroPullbackContinuation: score ${score} too low`);
            return null;
        }
        console.debug(`[ScalpEngine] _scanMicroPullbackContinuation: returning setup score=${score} confirmations=${confirmations.join(',')}`);
        return this._buildSetup('micro_pullback_continuation', direction, score, confirmations, data);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // NEW SCANNERS
    // ═══════════════════════════════════════════════════════════════════════

    _scanMomentumBreakout(data) {
        const { candles, currentPrice, volumeProfile } = data;
        if (candles.length < 10) return null;
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const range = Math.max(...candles.slice(-5).map(c => c.high)) - Math.min(...candles.slice(-5).map(c => c.low));
        // Breakout above recent range with volume
        if (last.close > prev.high * 1.005 && last.volume > prev.volume * 1.2) {
            const direction = 'long';
            let score = 30;
            const confirmations = ['momentum_breakout'];
            if (volumeProfile && currentPrice > volumeProfile.poc) score += 10;
            return this._buildSetup('momentum_breakout', direction, score, confirmations, data);
        }
        // Breakout below
        if (last.close < prev.low * 0.995 && last.volume > prev.volume * 1.2) {
            const direction = 'short';
            let score = 30;
            const confirmations = ['momentum_breakout'];
            if (volumeProfile && currentPrice < volumeProfile.poc) score += 10;
            return this._buildSetup('momentum_breakout', direction, score, confirmations, data);
        }
        return null;
    },

    _scanPullbackEntry(data) {
        const { candles, currentPrice, marketState } = data;
        if (candles.length < 20) return null;
        if (!data.indicators || !data.indicators.ma) return null;
        const ma = data.indicators.ma.sma20;
        if (!ma) return null;
        const regime = marketState?.regime?.current;
        if (regime === 'trending_up') {
            if (candles[candles.length - 1].low <= ma && candles[candles.length - 1].close > ma) {
                let score = 35;
                const confirmations = ['pullback_to_ma'];
                return this._buildSetup('pullback_entry', 'long', score, confirmations, data);
            }
        } else if (regime === 'trending_down') {
            if (candles[candles.length - 1].high >= ma && candles[candles.length - 1].close < ma) {
                let score = 35;
                const confirmations = ['pullback_to_ma'];
                return this._buildSetup('pullback_entry', 'short', score, confirmations, data);
            }
        }
        return null;
    },

    _scanVolumeCluster(data) {
        const { volumeProfile, currentPrice } = data;
        if (!volumeProfile || !volumeProfile.hvn) return null;
        const threshold = currentPrice * 0.002;
        for (const hvn of volumeProfile.hvn) {
            if (Math.abs(hvn.price - currentPrice) < threshold) {
                let score = 25;
                const confirmations = ['hvn_proximity'];
                return this._buildSetup('volume_cluster', 'neutral', score, confirmations, data);
            }
        }
        return null;
    },

    _scanSmallCandleReversal(data) {
        const { candles } = data;
        if (candles.length < 3) return null;
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const prev2 = candles[candles.length - 3];
        const body = Math.abs(last.close - last.open);
        const prevBody = Math.abs(prev.close - prev.open);
        if (body < prevBody * 0.3 && body > 0) {
            const direction = last.close > last.open ? 'long' : 'short';
            let score = 20;
            const confirmations = ['small_candle'];
            return this._buildSetup('small_candle_reversal', direction, score, confirmations, data);
        }
        return null;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ENTRY PRECISION MODULE
    // ═══════════════════════════════════════════════════════════════════════

    _computeEntryZone(direction, data) {
        const { currentPrice, liquidity, volumeProfile, fibonacci } = data;
        const atr = this._state.lastATR;
        const zoneWidth = atr * this._config.entryZoneWidthATR;
        const levels = [];
        if (fibonacci?.levels?.retracements) {
            for (const ret of fibonacci.levels.retracements) {
                if (ret.isKey) {
                    levels.push({ price: ret.price, weight: 3, source: 'fib_' + ret.label });
                } else {
                    levels.push({ price: ret.price, weight: 1, source: 'fib_' + ret.label });
                }
            }
        }
        if (liquidity?.orderBlocks) {
            for (const ob of liquidity.orderBlocks.filter(o => !o.mitigated)) {
                if ((direction === 'long' && ob.type === 'bullish') ||
                    (direction === 'short' && ob.type === 'bearish')) {
                    levels.push({ price: direction === 'long' ? ob.high : ob.low, weight: 3, source: 'ob_edge' });
                    levels.push({ price: (ob.high + ob.low) / 2, weight: 2, source: 'ob_mid' });
                }
            }
        }
        if (volumeProfile) {
            if (volumeProfile.poc) levels.push({ price: volumeProfile.poc, weight: 2, source: 'poc' });
            if (volumeProfile.vah) levels.push({ price: volumeProfile.vah, weight: 2, source: 'vah' });
            if (volumeProfile.val) levels.push({ price: volumeProfile.val, weight: 2, source: 'val' });
            if (volumeProfile.hvn) {
                for (const h of volumeProfile.hvn) {
                    levels.push({ price: h.price || h, weight: 1, source: 'hvn' });
                }
            }
        }
        const nearby = levels.filter(l => Math.abs(l.price - currentPrice) < atr * 2);
        if (nearby.length === 0) {
            return {
                low: direction === 'long' ? currentPrice - zoneWidth : currentPrice,
                high: direction === 'long' ? currentPrice : currentPrice + zoneWidth,
                center: currentPrice,
                precision: 'fallback',
                clusterCount: 0,
                levels: []
            };
        }
        const totalWeight = nearby.reduce((s, l) => s + l.weight, 0);
        const weightedCenter = nearby.reduce((s, l) => s + l.price * l.weight, 0) / totalWeight;
        let clusterCount = 0;
        const proximityThreshold = currentPrice * this._config.proximityPct;
        for (let i = 0; i < nearby.length; i++) {
            for (let j = i + 1; j < nearby.length; j++) {
                if (Math.abs(nearby[i].price - nearby[j].price) < proximityThreshold) {
                    clusterCount++;
                }
            }
        }
        const precision = clusterCount >= 3 ? 'high' : clusterCount >= 1 ? 'moderate' : 'low';
        return {
            low: weightedCenter - zoneWidth / 2,
            high: weightedCenter + zoneWidth / 2,
            center: weightedCenter,
            precision,
            clusterCount,
            levels: nearby.map(l => l.source)
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // EXECUTION TIMING
    // ═══════════════════════════════════════════════════════════════════════

    _applyExecutionTiming(setup, currentPrice, candles) {
        const inZone = currentPrice >= setup.entryZone.low &&
            currentPrice <= setup.entryZone.high;
        const lastCandle = candles[candles.length - 1];
        const closeConfirmed = lastCandle &&
            ((setup.direction === 'long' && lastCandle.close > lastCandle.open) ||
                (setup.direction === 'short' && lastCandle.close < lastCandle.open));
        if (inZone && closeConfirmed) {
            setup.urgency = 'immediate';
        } else if (inZone) {
            setup.urgency = 'confirming';
        } else {
            const atr = this._state.lastATR;
            const distToZone = setup.direction === 'long'
                ? currentPrice - setup.entryZone.high
                : setup.entryZone.low - currentPrice;
            if (Math.abs(distToZone) < atr * 0.5) {
                setup.urgency = 'approaching';
            } else {
                setup.urgency = 'developing';
            }
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // TRADE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    _computeTradeManagement(direction, entryZone, data) {
        const atr = this._state.lastATR;
        const entryPrice = entryZone.center || (entryZone.low + entryZone.high) / 2;
        // v4.0: Use mode-aware ATR profile (micro_scalp = tighter TP/SL)
        const cfg = this._getActiveATRProfile();
        let stopLoss, tp1, tp2, tp3;
        if (direction === 'long') {
            stopLoss = entryPrice - atr * cfg.stopMultiple;
            tp1 = entryPrice + atr * cfg.tp1Multiple;
            tp2 = entryPrice + atr * cfg.tp2Multiple;
            tp3 = entryPrice + atr * cfg.tp3Multiple;
        } else {
            stopLoss = entryPrice + atr * cfg.stopMultiple;
            tp1 = entryPrice - atr * cfg.tp1Multiple;
            tp2 = entryPrice - atr * cfg.tp2Multiple;
            tp3 = entryPrice - atr * cfg.tp3Multiple;
        }
        tp3 = this._snapToStructuralLevel(tp3, direction, data) || tp3;
        const risk = Math.abs(entryPrice - stopLoss);
        const reward = Math.abs(tp1 - entryPrice);
        const riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : 0;
        return {
            stopLoss: Math.round(stopLoss * 100) / 100,
            targets: [
                Math.round(tp1 * 100) / 100,
                Math.round(tp2 * 100) / 100,
                Math.round(tp3 * 100) / 100
            ],
            riskReward,
            atrMultiple: {
                stop: cfg.stopMultiple,
                tp1: cfg.tp1Multiple,
                tp2: cfg.tp2Multiple,
                tp3: cfg.tp3Multiple
            },
            scaleOut: { ...this._config.scaleOut },
            trailActivation: direction === 'long'
                ? entryPrice + atr * cfg.trailActivation
                : entryPrice - atr * cfg.trailActivation,
            trailDistance: atr * cfg.trailDistance
        };
    },

    _snapToStructuralLevel(targetPrice, direction, data) {
        const candidates = [];
        const { fibonacci, liquidity, volumeProfile } = data;
        if (fibonacci?.levels?.extensions) {
            for (const ext of fibonacci.levels.extensions) {
                candidates.push(ext.price);
            }
        }
        if (liquidity?.liquidityPools) {
            for (const pool of liquidity.liquidityPools) {
                candidates.push(pool.price);
            }
        }
        if (volumeProfile?.hvn) {
            for (const h of volumeProfile.hvn) {
                candidates.push(h.price || h);
            }
        }
        if (candidates.length === 0) return null;
        const atr = this._state.lastATR;
        let nearest = null;
        let nearestDist = Infinity;
        for (const price of candidates) {
            const isValid = direction === 'long' ? price > targetPrice * 0.95 : price < targetPrice * 1.05;
            if (!isValid) continue;
            const dist = Math.abs(price - targetPrice);
            if (dist < atr * 1.5 && dist < nearestDist) {
                nearest = price;
                nearestDist = dist;
            }
        }
        return nearest;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // RISK CONTROLS
    // ═══════════════════════════════════════════════════════════════════════

    _checkRiskControls(context) {
        if (this._state.locked && this._state.cooldownRemaining > 0) {
            return { locked: true, reason: this._state.lockReason || 'Scalp cooldown active' };
        }
        if (this._state.sessionScalpCount >= this._config.risk.maxScalpsPerSession) {
            return { locked: true, reason: `Session limit reached (${this._config.risk.maxScalpsPerSession})` };
        }
        return { locked: false };
    },

    /**
     * Range Guard: Equilibrium zone (40-60% of daily range).
     * swing_scalp → BLOCKS trades (original behavior).
     * hybrid/micro_scalp → DAMPENS (reduce size, not block).
     */
    _rangeGuard(data) {
        if (!data.candles || data.candles.length < 50) return { blocked: false, dampener: 1.0 };
        
        const dayCandles = data.candles.slice(-100);
        const dayHigh = Math.max(...dayCandles.map(c => c.high));
        const dayLow = Math.min(...dayCandles.map(c => c.low));
        const range = dayHigh - dayLow;
        
        if (range === 0) return { blocked: true, reason: 'zero_range', dampener: 0 };
        
        const equilibriumLow = dayLow + (range * 0.40);
        const equilibriumHigh = dayLow + (range * 0.60);
        const currentPrice = data.currentPrice;
        const isEquilibrium = currentPrice >= equilibriumLow && currentPrice <= equilibriumHigh;
        
        if (isEquilibrium) {
            const mode = this._state.currentMode || this._getOperatingMode();
            if (mode === 'swing_scalp') {
                return { blocked: true, reason: 'equilibrium_zone', dampener: 0 };
            }
            // High leverage: dampen, don't block
            const dampener = mode === 'micro_scalp' ? 0.6 : 0.7;
            return { blocked: false, dampener, reason: 'equilibrium_dampened' };
        }
        
        return { blocked: false, dampener: 1.0 };
    },

    _updateCooldown() {
        if (this._state.cooldownRemaining > 0) {
            this._state.cooldownRemaining--;
            if (this._state.cooldownRemaining <= 0) {
                this._state.locked = false;
                this._state.lockReason = null;
                this._state.consecutiveLosses = Math.max(0, this._state.consecutiveLosses - 1);
            }
        }
    },

    _getSizeMultiplier() {
        const losses = this._state.consecutiveLosses;
        const reductions = this._config.risk.sizeReduction;
        const idx = Math.min(losses, reductions.length - 1);
        return reductions[idx];
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PERFORMANCE TRACKER & SELF-TUNING
    // ═══════════════════════════════════════════════════════════════════════

    _selfTune() {
        const cfg = this._config.tuning;
        for (const [type, bucket] of Object.entries(this._performance.byType)) {
            if (bucket.count < cfg.minSample) continue;
            const winRate = bucket.count > 0 ? bucket.wins / bucket.count : 0.5;
            let multiplier = 1.0;
            if (winRate >= cfg.boostThreshold) {
                multiplier = Math.min(cfg.maxBoost, 1.0 + (winRate - 0.5) * 0.5);
            } else if (winRate <= cfg.penaltyThreshold) {
                multiplier = Math.max(cfg.maxPenalty, 1.0 - (0.5 - winRate) * 0.5);
            }
            this._performance.typeMultipliers[type] = Math.round(multiplier * 100) / 100;
        }
    },

    _getPerformanceSummary() {
        const summary = {};
        for (const [type, bucket] of Object.entries(this._performance.byType)) {
            if (bucket.count === 0) continue;
            summary[type] = {
                count: bucket.count,
                winRate: Math.round((bucket.wins / bucket.count) * 100),
                avgRR: bucket.count > 0 ? Math.round((bucket.totalRR / bucket.count) * 100) / 100 : 0,
                multiplier: this._performance.typeMultipliers[type]
            };
        }
        return summary;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SETUP BUILDER & HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    _buildSetup(type, direction, rawScore, confirmations, data) {
        const { context } = data;
        let score = rawScore * (this._performance.typeMultipliers[type] || 1.0);
        let penaltyLog = `raw=${rawScore} `;
        if (context?.session?.killZone) {
            score *= this._config.killZoneBoost;
            penaltyLog += `kz(x${this._config.killZoneBoost}) `;
        }
        if (context?.session?.current === 'off_hours') {
            score *= 0.90;
            penaltyLog += `offh(x0.9) `;
        }
        if (context?.session?.current === 'asia') {
            score *= 0.95;
            penaltyLog += `asia(x0.95) `;
        }
        if (context?.volatilityRatio !== undefined && context.volatilityRatio !== null) {
            if (context.volatilityRatio < 0.4) {
                score *= 0.90;
                penaltyLog += `volR(x0.9) `;
            } else if (context.volatilityRatio > 1.3) {
                score *= 1.08;
                penaltyLog += `volR+(x1.08) `;
            }
        }
        const finalScore = Math.round(Math.min(100, Math.max(0, score)));
        
        // Institutional Kill Zone Enforcement
        if (context?.session?.killZone) {
            console.debug(`[ScalpEngine._buildSetup] ${type} | KILL ZONE BOOST (x${this._config.killZoneBoost})`);
        } else if (context?.session?.current === 'off_hours' || context?.session?.current === 'asia') {
            console.warn(`[ScalpEngine._buildSetup] ${type} | OFF-HOURS PENALTY (x0.9)`);
        }
        
        console.debug(`[ScalpEngine._buildSetup] ${type} | ${penaltyLog} -> final=${finalScore}`);
        score = finalScore;
        const entryZone = this._computeEntryZone(direction, data);
        const tradeMgmt = this._computeTradeManagement(direction, entryZone, data);
        const sizeMultiplier = this._getSizeMultiplier();
        let quality;
        if (score >= this._config.premiumThreshold) quality = 'premium';
        else if (score >= this._config.highQualityThreshold) quality = 'high';
        else if (score >= this._config.minSetupScore) quality = 'standard';
        else quality = 'developing';
        return {
            type,
            direction,
            score,
            quality,
            entryZone: {
                low: Math.round(entryZone.low * 100) / 100,
                high: Math.round(entryZone.high * 100) / 100,
                center: Math.round((entryZone.center || (entryZone.low + entryZone.high) / 2) * 100) / 100,
                precision: entryZone.precision,
                clusterCount: entryZone.clusterCount
            },
            stopLoss: tradeMgmt.stopLoss,
            targets: tradeMgmt.targets,
            riskReward: tradeMgmt.riskReward,
            atrMultiple: tradeMgmt.atrMultiple,
            scaleOut: tradeMgmt.scaleOut,
            trailActivation: tradeMgmt.trailActivation,
            trailDistance: tradeMgmt.trailDistance,
            confirmations,
            urgency: 'developing',
            ttl: this._config.setupTTL,
            candlesAlive: 0,
            sizeMultiplier,
            createdAt: Date.now()
        };
    },

    _deduplicateSetups(setups) {
        const longs = setups.filter(s => s.direction === 'long');
        const shorts = setups.filter(s => s.direction === 'short');
        if (longs.length > 0 && shorts.length > 0) {
            const bestLong = longs.reduce((best, s) => s.score > best.score ? s : best, longs[0]);
            const bestShort = shorts.reduce((best, s) => s.score > best.score ? s : best, shorts[0]);
            if (bestLong.score > bestShort.score + 10) {
                return longs;
            } else if (bestShort.score > bestLong.score + 10) {
                return shorts;
            } else {
                return [];
            }
        }
        return setups;
    },

    _ageSetups() {
        for (const setup of this._state.activeSetups) {
            setup.candlesAlive++;
            setup.ttl--;
        }
        this._state.activeSetups = this._state.activeSetups.filter(s => s.ttl > 0);
    },

    _calcFallbackATR(candles) {
        const period = Math.min(14, candles.length - 1);
        if (period <= 0) return 0;
        let sum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i];
            const prev = candles[i - 1];
            if (!prev) continue;
            const tr = Math.max(
                c.high - c.low,
                Math.abs(c.high - prev.close),
                Math.abs(c.low - prev.close)
            );
            sum += tr;
        }
        return sum / period;
    },

    _getStatusLabel() {
        if (this._state.locked) return 'LOCKED';
        if (this._state.cooldownRemaining > 0) return 'COOLDOWN';
        if (this._state.bestSetup) {
            if (this._state.bestSetup.urgency === 'immediate') return 'SIGNAL';
            if (this._state.bestSetup.urgency === 'confirming') return 'CONFIRMING';
            if (this._state.bestSetup.urgency === 'approaching') return 'APPROACHING';
            return 'MONITORING';
        }
        return 'SCANNING';
    },

    _getRiskState() {
        return {
            consecutiveLosses: this._state.consecutiveLosses,
            sizeMultiplier: this._getSizeMultiplier(),
            sessionScalps: this._state.sessionScalpCount,
            maxSessionScalps: this._config.risk.maxScalpsPerSession,
            locked: this._state.locked,
            lockReason: this._state.lockReason,
            cooldownRemaining: this._state.cooldownRemaining
        };
    },

    _emptyResult(reason, riskState) {
        return {
            active: false,
            bestSetup: null,
            allSetups: [],
            setupCount: 0,
            status: this._getStatusLabel(),
            reason,
            riskState: riskState || this._getRiskState(),
            eventSource: this._state.lastEventSource,
            latencyMs: this._state.lastLatencyMs,
            volatilityScore: this._state.lastVolatilityScore
        };
    }
};

// --- FINAL DO ARQUIVO scalp-engine.js ---

// Exposição global para o Electron
if (typeof window !== 'undefined') {
    window.ScalpEngine = ScalpEngine;

    // Auto-subscribe para começar a ouvir o EventBus imediatamente
    document.addEventListener('DOMContentLoaded', () => {
        if (window.ScalpEngine.subscribe) {
            window.ScalpEngine.subscribe();
            console.log('[Antigravity OS] ScalpEngine subscrito aos eventos de mercado.');
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ScalpEngine;
}