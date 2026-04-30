// @ts-nocheck
import { EventBus } from './event-bus';
import { StateCache } from './state-cache';

export const LiquidityEngine = {

    // ═══════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════

    config: {
        // --- EQH / EQL ---
        eqhEqlBaseTolerance: 0.003,   // 0.3% base tolerance for equal levels
        eqhEqlToleranceFloor: 0.001,  // Minimum 0.1% (tight ATR safeguard)
        eqhEqlToleranceCeiling: 0.015,// Maximum 1.5% (high volatility cap)
        eqhMinTouches: 2,             // Minimum touches to form a pool
        maxPools: 50,                 // Cap historic pools

        // --- Sweeps ---
        sweepMinDisplacement: 0.10,   // 0.10× ATR (era 0.15)
        sweepMaxWick: 3.0,
        sweepMinWickRatio: 0.3,
        sweepReversalBars: 2,         // 2 bars to confirm (era 3)
        sweepVolumeThreshold: 1.2,    // Sweep candle volume > 1.2× volumeMA
        sweepMSSLinkageBars: 5,       // MSS within N bars → linked
        sweepMSSBoost: 0.30,          // 30% reversal probability boost
        maxSweeps: 30,                // Cap historic sweeps

        // --- Order Blocks ---
        obMinBodyRatio: 0.50,
        obMaxAge: 40,                 // 40 bars (era 60)
        obAgeDecay: 2,
        obMitigationDepth: 0.50,
        obVolumeThreshold: 1.1,       // 1.1× volumeMA (era 1.0)
        maxOrderBlocks: 10,           // Cap tracked OBs

        // --- Displacements ---
        displacementATRMultiple: 1.5, // Body > 1.5× ATR
        displacementMinBodyRatio: 0.70,// Body ≥ 70% of range
        displacementVolumeThreshold: 1.3, // Volume > 1.3× volumeMA
        maxDisplacements: 20,         // Cap historic displacements

        // --- Premium / Discount ---
        equilibriumBand: 0.10,        // 10% band around equilibrium

        // --- Volume MA ---
        volumeMAPeriod: 20,           // Period for volume moving average
        atrPeriod: 14,                // ATR period

        // --- Pool strength ---
        minPoolStrength: 30           // Minimum strength to retain a pool
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL STATE (for incremental processing)
    // ═══════════════════════════════════════════════════════════════════════

    _state: {
        pools: [],              // LiquidityPool[]
        sweeps: [],             // LiquidityEvent[]
        orderBlocks: [],        // OrderBlock[]
        displacements: [],      // LiquidityEvent[]
        fvgs: [],               // v3.0: Fair Value Gaps (integrated)
        premiumDiscount: null,  // LiquidityZone
        lastCandleCount: 0,     // Track processed candles for incremental
        atr: 0,                 // Cached ATR
        volumeMA: 0,            // Cached volume MA
        volumeBuffer: [],       // Rolling volume buffer
        lastRegime: null,       // Previous regime for change detection
        bootstrapped: false     // First full run complete?
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Core analysis entry point.
     * First call: full bootstrap. Subsequent calls: incremental updates.
     *
     * @param {Array} candles - Array of OHLC candles
     * @param {object} marketState - Output of MarketStateEngine.analyze()
     * @returns {object} Full liquidity analysis
     */
    analyze(candles, marketState) {
        if (!candles || candles.length < 30 || !marketState) {
            return this._emptyResult();
        }

        const regime = marketState.regime?.current || 'unknown';

        // Update cached indicators
        this._updateATR(candles);
        this._updateVolumeMA(candles);

        // Detect if we need full reprocess or can do incremental
        const isNewData = candles.length !== this._state.lastCandleCount;
        const regimeChanged = regime !== this._state.lastRegime;

        if (!this._state.bootstrapped || regimeChanged) {
            // Full reprocess on first run or regime change
            this._fullProcess(candles, marketState);
        } else if (isNewData) {
            // Incremental: only process new candle(s)
            this._incrementalProcess(candles, marketState);
        }

        this._state.lastCandleCount = candles.length;
        this._state.lastRegime = regime;

        return this._buildResult(candles, marketState);
    },

    /**
     * Get a compact summary for UI and confluence integration.
     * Preserves the same shape as the original for backward compatibility.
     */
    getSummary(analysis) {
        if (!analysis) return { signal: 'hold', confidence: 0, active: false };

        let score = 0;
        let factors = 0;

        // --- Order blocks near price → directional signal ---
        const activeOBs = analysis.orderBlocks.filter(ob => !ob.mitigated);
        const bullOBs = activeOBs.filter(ob => ob.type === 'bullish');
        const bearOBs = activeOBs.filter(ob => ob.type === 'bearish');

        if (bullOBs.length > bearOBs.length) { score += 50; factors++; }
        else if (bearOBs.length > bullOBs.length) { score -= 50; factors++; }

        // --- Premium/Discount zone ---
        if (analysis.premiumDiscount) {
            const pd = analysis.premiumDiscount;
            if (pd.currentZone === 'discount') { score += 40; factors++; }
            else if (pd.currentZone === 'premium') { score -= 40; factors++; }
        }

        // --- Recent sweeps → reversal signal ---
        if (analysis.liquiditySweeps.length > 0) {
            const lastSweep = analysis.liquiditySweeps[analysis.liquiditySweeps.length - 1];
            const sweepScore = lastSweep.mssLinked ? 45 : 30;
            if (lastSweep.type === 'buy_side') { score -= sweepScore; factors++; }
            else { score += sweepScore; factors++; }
        }

        // --- Displacement momentum ---
        if (analysis.displacements.length > 0) {
            const lastDisp = analysis.displacements[analysis.displacements.length - 1];
            const dispScore = Math.min(35, lastDisp.strength * 10);
            if (lastDisp.direction === 'bullish') { score += dispScore; factors++; }
            else { score -= dispScore; factors++; }
        }

        // --- EQH/EQL as potential targets ---
        const unsweptEQH = analysis.equalLevels.eqh.filter(e => !e.swept);
        const unsweptEQL = analysis.equalLevels.eql.filter(e => !e.swept);
        if (unsweptEQH.length > 0) { factors++; } // Buy-side liquidity resting above
        if (unsweptEQL.length > 0) { factors++; } // Sell-side liquidity resting below

        const avgScore = factors > 0 ? score / factors : 0;
        const signal = avgScore > 15 ? 'buy' : avgScore < -15 ? 'sell' : 'hold';
        const confidence = Math.min(100, Math.abs(Math.round(avgScore)));

        return {
            signal,
            confidence,
            active: factors > 0,
            activeOrderBlocks: activeOBs.length,
            zone: analysis.premiumDiscount?.currentZone || 'unknown',
            sweepsDetected: analysis.liquiditySweeps.length,
            eqhCount: analysis.equalLevels.eqh.length,
            eqlCount: analysis.equalLevels.eql.length,
            // New fields for enhanced confluence
            lastSweepMSSLinked: analysis.liquiditySweeps.length > 0
                ? analysis.liquiditySweeps[analysis.liquiditySweeps.length - 1].mssLinked || false
                : false,
            obRetestActive: activeOBs.some(ob => ob.retesting),
            displacementActive: analysis.displacements.length > 0,
            equilibrium: analysis.premiumDiscount?.equilibrium || null,
            unsweptEQH: unsweptEQH.map(e => e.priceLevel),
            unsweptEQL: unsweptEQL.map(e => e.priceLevel)
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // FULL PROCESS (Bootstrap / Regime Change)
    // ═══════════════════════════════════════════════════════════════════════

    _fullProcess(candles, marketState) {
        // Reset state
        this._state.pools = [];
        this._state.sweeps = [];
        this._state.orderBlocks = [];
        this._state.displacements = [];
        this._state.fvgs = [];

        const regime = marketState.regime?.current || 'unknown';

        // Step 1: Detect EQH/EQL from MSE confirmed swings
        this._detectEqualLevels(marketState.swings, regime);

        // Step 2: Detect displacements across full history
        this._detectDisplacements(candles);

        // Step 3: Detect order blocks (requires displacements)
        this._detectOrderBlocks(candles, marketState);

        // Step 4: Calculate premium/discount zones
        this._state.premiumDiscount = this._calcPremiumDiscount(candles, marketState);

        // Step 5: Detect liquidity sweeps
        this._detectSweeps(candles, marketState);

        // Step 6: Update mitigation status on OBs
        this._updateMitigationStatus(candles);

        // Step 7: Check for OB retests near current price
        this._checkOBRetests(candles);

        // Step 8 (v3.0): Detect Fair Value Gaps
        this._detectFVGs(candles);

        this._state.bootstrapped = true;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INCREMENTAL PROCESS (Per-candle update)
    // ═══════════════════════════════════════════════════════════════════════

    _incrementalProcess(candles, marketState) {
        const latest = candles[candles.length - 1];
        const latestIdx = candles.length - 1;
        const regime = marketState.regime?.current || 'unknown';

        // 1. Check if new swings form new EQH/EQL pools
        this._updateEqualLevels(marketState.swings, regime);

        // 2. Check if latest candle is a displacement
        this._checkDisplacement(latest, latestIdx);

        // 3. Check if latest candle creates a new OB (from recent displacement)
        this._checkNewOrderBlock(candles, marketState);

        // 4. Update premium/discount
        this._state.premiumDiscount = this._calcPremiumDiscount(candles, marketState);

        // 5. Check if latest candle swept any pools
        this._checkSweep(candles, marketState);

        // 6. Update OB mitigation with latest candle
        this._updateMitigationIncremental(latest);

        // 7. Check OB retests
        this._checkOBRetests(candles);

        // 8. Age-decay and prune old entities
        this._pruneStaleEntities(latestIdx);

        // 9. (v3.0) Check for new FVG from latest candle group
        this._checkFVG(candles, latestIdx);

        // 10. (v3.0) Mitigate FVGs if price revisited
        this._mitigateFVGs(latest);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // EQH / EQL DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Detect Equal Highs and Equal Lows from MSE confirmed swings.
     * Tolerance adapts to regime:
     *   RANGE: tighter (0.7×) — accumulation precision matters
     *   TRANSITION: wider (1.3×) — volatility expansion
     *   TREND: base tolerance
     */
    _detectEqualLevels(swings, regime) {
        if (!swings) return;

        const { highs, lows } = swings;
        const tolerance = this._getAdaptiveTolerance(regime);

        // Detect EQH clusters
        this._clusterSwings(highs, 'EQH', tolerance);
        // Detect EQL clusters
        this._clusterSwings(lows, 'EQL', tolerance);
    },

    _updateEqualLevels(swings, regime) {
        if (!swings) return;
        const { highs, lows } = swings;
        const tolerance = this._getAdaptiveTolerance(regime);

        // Check if latest swing forms a new pool or extends existing
        if (highs.length > 0) {
            const latest = highs[highs.length - 1];
            this._tryExtendPool(latest, 'EQH', tolerance);
        }
        if (lows.length > 0) {
            const latest = lows[lows.length - 1];
            this._tryExtendPool(latest, 'EQL', tolerance);
        }
    },

    _clusterSwings(swings, type, tolerance) {
        if (!swings || swings.length < 2) return;

        const used = new Set();

        for (let i = 0; i < swings.length; i++) {
            if (used.has(i)) continue;

            const cluster = [swings[i]];
            used.add(i);

            for (let j = i + 1; j < swings.length; j++) {
                if (used.has(j)) continue;
                const diff = Math.abs(swings[i].price - swings[j].price) / swings[i].price;
                if (diff <= tolerance) {
                    cluster.push(swings[j]);
                    used.add(j);
                }
            }

            if (cluster.length >= this.config.eqhMinTouches) {
                const avgPrice = cluster.reduce((s, c) => s + c.price, 0) / cluster.length;

                // Avoid duplicate pools at similar levels
                const existing = this._state.pools.find(
                    p => p.type === type && Math.abs(p.priceLevel - avgPrice) / avgPrice < tolerance
                );

                if (existing) {
                    // Extend existing pool
                    existing.touchCount = Math.max(existing.touchCount, cluster.length);
                    existing.indices = [...new Set([...existing.indices, ...cluster.map(c => c.index)])];
                    existing.strengthScore = this._calcPoolStrength(existing, cluster);
                } else {
                    // New pool
                    const pool = {
                        type,
                        priceLevel: avgPrice,
                        strengthScore: 0,
                        touchCount: cluster.length,
                        indices: cluster.map(c => c.index),
                        swept: false,
                        sweepIndex: null,
                        createdAt: cluster[0].index
                    };
                    pool.strengthScore = this._calcPoolStrength(pool, cluster);

                    if (pool.strengthScore >= this.config.minPoolStrength) {
                        this._state.pools.push(pool);
                    }
                }
            }
        }

        // Cap pools
        if (this._state.pools.length > this.config.maxPools) {
            this._state.pools.sort((a, b) => b.strengthScore - a.strengthScore);
            this._state.pools = this._state.pools.slice(0, this.config.maxPools);
        }
    },

    _tryExtendPool(swing, type, tolerance) {
        // Check if new swing matches any existing pool
        for (const pool of this._state.pools) {
            if (pool.type !== type || pool.swept) continue;
            const diff = Math.abs(pool.priceLevel - swing.price) / pool.priceLevel;
            if (diff <= tolerance) {
                if (!pool.indices.includes(swing.index)) {
                    pool.touchCount++;
                    pool.indices.push(swing.index);
                    pool.strengthScore = this._calcPoolStrength(pool, []);
                }
                return;
            }
        }

        // Check if we now have 2+ unmatched swings at this level
        // (handled by next full EQL/EQH scan on regime change)
    },

    _calcPoolStrength(pool, cluster) {
        let strength = 0;

        // Touch count: 25 points per touch, capped at 75
        strength += Math.min(75, pool.touchCount * 25);

        // Recency bonus: if most recent touch is within last 10 bars
        const maxIdx = Math.max(...pool.indices);
        if (this._state.lastCandleCount - maxIdx < 10) strength += 20;

        // Volume weight: check if any volume data available from cluster
        const hasVolumeCluster = cluster.length > 0 && cluster.some(c => c.volume);
        if (hasVolumeCluster) {
            const avgVol = cluster.reduce((s, c) => s + (c.volume || 0), 0) / cluster.length;
            if (avgVol > this._state.volumeMA) strength += 15;
        }

        return Math.min(100, strength);
    },

    _getAdaptiveTolerance(regime) {
        const base = this.config.eqhEqlBaseTolerance;
        let multiplier = 1.0;

        if (regime === 'range') multiplier = 0.7;          // Tighter — precision matters
        else if (regime === 'transition') multiplier = 1.3; // Wider — volatility expansion
        else if (regime === 'trending_up' || regime === 'trending_down') multiplier = 1.0;

        // ATR-adaptive component: scale with volatility
        if (this._state.atr > 0) {
            const atrPct = this._state.atr / (this._state.pools.length > 0
                ? this._state.pools[0].priceLevel
                : 1);
            // Blend base tolerance with ATR-derived tolerance
            const atrTolerance = atrPct * 0.5;
            const blended = base * 0.6 + atrTolerance * 0.4;
            return Math.max(
                this.config.eqhEqlToleranceFloor,
                Math.min(this.config.eqhEqlToleranceCeiling, blended * multiplier)
            );
        }

        return Math.max(
            this.config.eqhEqlToleranceFloor,
            Math.min(this.config.eqhEqlToleranceCeiling, base * multiplier)
        );
    },

    // ═══════════════════════════════════════════════════════════════════════
    // LIQUIDITY SWEEP DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Full sweep scan across all candles.
     * A sweep occurs when:
     *   - Price wicks above EQH but closes below (buy-side sweep)
     *   - Price wicks below EQL but closes above (sell-side sweep)
     * With:
     *   - Volume confirmation
     *   - Minimum displacement beyond pool
     *   - Reversal confirmation within N bars
     *   - MSS linkage check
     */
    _detectSweeps(candles, marketState) {
        const atr = this._state.atr;
        if (atr <= 0) return;

        const pools = this._state.pools.filter(p => !p.swept);

        for (const pool of pools) {
            const lastPoolIdx = Math.max(...pool.indices);

            for (let i = lastPoolIdx + 1; i < candles.length; i++) {
                if (this._isSweepCandle(candles, i, pool, atr, marketState)) {
                    break; // One sweep per pool
                }
            }
        }
    },

    /**
     * Incremental: check if latest candle swept any unswept pool.
     */
    _checkSweep(candles, marketState) {
        const atr = this._state.atr;
        if (atr <= 0) return;

        const latestIdx = candles.length - 1;
        const unswept = this._state.pools.filter(p => !p.swept);

        for (const pool of unswept) {
            this._isSweepCandle(candles, latestIdx, pool, atr, marketState);
        }
    },

    /**
     * Test if candle at index `i` sweeps the given pool.
     * Returns true if sweep detected (and recorded).
     */
    _isSweepCandle(candles, i, pool, atr, marketState) {
        const c = candles[i];
        const body = Math.abs(c.close - c.open);
        const totalRange = c.high - c.low;

        if (totalRange === 0) return false;

        const isBuySideSweep = pool.type === 'EQH';
        const isSellSideSweep = pool.type === 'EQL';

        let wickBeyond = 0;
        let wickRatio = 0;
        let closedBack = false;

        if (isBuySideSweep) {
            // Wick above EQH, close below
            wickBeyond = c.high - pool.priceLevel;
            const upperWick = c.high - Math.max(c.open, c.close);
            wickRatio = body > 0 ? upperWick / body : 0;
            closedBack = c.close < pool.priceLevel;
        } else if (isSellSideSweep) {
            // Wick below EQL, close above
            wickBeyond = pool.priceLevel - c.low;
            const lowerWick = Math.min(c.open, c.close) - c.low;
            wickRatio = body > 0 ? lowerWick / body : 0;
            closedBack = c.close > pool.priceLevel;
        }

        // --- Filters ---
        // 1. Must have wicked beyond the pool level
        if (wickBeyond <= 0) return false;

        // 2. Minimum displacement beyond pool
        if (wickBeyond < atr * this.config.sweepMinDisplacement) return false;

        // 3. News spike filter: wick too extreme
        if (wickBeyond > atr * this.config.sweepMaxWick) return false;

        // 4. Wick ratio check
        if (wickRatio < this.config.sweepMinWickRatio) return false;

        // 5. Close back inside
        if (!closedBack) return false;

        // 6. Volume confirmation
        const volumeOK = this._state.volumeMA > 0
            ? (c.volume || 0) > this._state.volumeMA * this.config.sweepVolumeThreshold
            : true;

        // 7. Reversal confirmation
        let reversed = false;
        if (i + this.config.sweepReversalBars < candles.length) {
            const afterClose = candles[i + this.config.sweepReversalBars].close;
            if (isBuySideSweep && afterClose < c.close) reversed = true;
            if (isSellSideSweep && afterClose > c.close) reversed = true;
        } else if (i === candles.length - 1) {
            // Last candle — potential sweep, lower confidence
            reversed = true;
        }

        if (!reversed) return false;

        // 8. MSS linkage check
        const lastMSS = marketState.structure?.lastMSS;
        const mssLinked = lastMSS
            ? Math.abs(i - lastMSS.index) <= this.config.sweepMSSLinkageBars
            : false;

        // Calculate strength
        let strength = 50;
        strength += Math.min(20, (wickBeyond / atr) * 15);
        strength += pool.touchCount * 5;
        if (volumeOK) strength += 15;
        if (mssLinked) strength += strength * this.config.sweepMSSBoost;
        if (i < candles.length - 1) strength += 10; // Not last candle = confirmed
        strength = Math.min(100, Math.round(strength));

        // Record sweep
        const sweep = {
            type: isBuySideSweep ? 'buy_side' : 'sell_side',
            level: pool.priceLevel,
            sweepCandle: { index: i, candle: c },
            confidence: strength,
            levelsSwept: pool.touchCount,
            mssLinked,
            volumeConfirmed: volumeOK,
            direction: isBuySideSweep ? 'bearish' : 'bullish',
            strength
        };

        this._state.sweeps.push(sweep);
        pool.swept = true;
        pool.sweepIndex = i;

        // Cap sweeps
        if (this._state.sweeps.length > this.config.maxSweeps) {
            this._state.sweeps = this._state.sweeps.slice(-this.config.maxSweeps);
        }

        return true;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DISPLACEMENT DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * A displacement is:
     *   - Body > ATR × multiplier
     *   - Body ≥ 70% of total candle range
     *   - Volume > 1.3× volumeMA
     *   - Cascading: consecutive displacement candles boost magnitude
     */
    _detectDisplacements(candles) {
        const atr = this._state.atr;
        if (atr <= 0) return;

        const threshold = atr * this.config.displacementATRMultiple;

        for (let i = 1; i < candles.length; i++) {
            this._evaluateDisplacement(candles[i], i, threshold);
        }

        // Cap
        if (this._state.displacements.length > this.config.maxDisplacements) {
            this._state.displacements = this._state.displacements.slice(-this.config.maxDisplacements);
        }
    },

    _checkDisplacement(candle, index) {
        const atr = this._state.atr;
        if (atr <= 0) return;

        const threshold = atr * this.config.displacementATRMultiple;
        this._evaluateDisplacement(candle, index, threshold);
    },

    _evaluateDisplacement(candle, index, threshold) {
        const body = Math.abs(candle.close - candle.open);
        const totalRange = candle.high - candle.low;

        if (totalRange === 0 || body < threshold) return;

        // Body-to-range ratio filter
        const bodyRatio = body / totalRange;
        if (bodyRatio < this.config.displacementMinBodyRatio) return;

        // Volume confirmation
        const volumeOK = this._state.volumeMA > 0
            ? (candle.volume || 0) > this._state.volumeMA * this.config.displacementVolumeThreshold
            : true;

        const direction = candle.close > candle.open ? 'bullish' : 'bearish';
        const magnitude = body / (this._state.atr || 1);

        // Check for cascading displacement (consecutive bars in same direction)
        const prevDisp = this._state.displacements.length > 0
            ? this._state.displacements[this._state.displacements.length - 1]
            : null;
        const isCascading = prevDisp
            && prevDisp.direction === direction
            && index - prevDisp.endIndex <= 2;

        let strength = magnitude;
        if (isCascading) {
            // Boost cascading displacement
            strength *= 1.3;
            prevDisp.endIndex = index;
            prevDisp.magnitude += magnitude;
            prevDisp.strength = Math.min(5, prevDisp.strength + strength * 0.3);
            prevDisp.cascadeCount = (prevDisp.cascadeCount || 1) + 1;
            return; // Merged into previous displacement
        }

        // Check FVG creation potential
        // (gap between candle i-1 high and candle i+1 low, or vice versa)
        // Note: can only check if we have neighbors — skip for live candle

        this._state.displacements.push({
            direction,
            startIndex: index,
            endIndex: index,
            magnitude,
            strength: Math.min(5, magnitude * 0.7),
            bodyRatio,
            volumeConfirmed: volumeOK,
            cascadeCount: 1
        });
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ORDER BLOCK DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Order Block: last opposing candle before a displacement.
     * Enhanced requirements:
     *   - OB candle body ≥ 50% of its range (filters dojis/star patterns)
     *   - OB candle volume ≥ average
     *   - Must be followed by a displacement (structure confirmation)
     *   - Progressive mitigation tracking
     */
    _detectOrderBlocks(candles, marketState) {
        const atr = this._state.atr;
        if (atr <= 0) return;

        for (const disp of this._state.displacements) {
            this._findOrderBlockForDisplacement(candles, disp, marketState);
        }

        // Sort by strength, cap
        this._state.orderBlocks.sort((a, b) => b.strengthScore - a.strengthScore);
        if (this._state.orderBlocks.length > this.config.maxOrderBlocks) {
            this._state.orderBlocks = this._state.orderBlocks.slice(0, this.config.maxOrderBlocks);
        }
    },

    _checkNewOrderBlock(candles, marketState) {
        // Check if the most recent displacement creates a new OB
        if (this._state.displacements.length === 0) return;

        const lastDisp = this._state.displacements[this._state.displacements.length - 1];
        // Only process if the displacement is from the recent candles
        if (candles.length - lastDisp.startIndex > 5) return;

        this._findOrderBlockForDisplacement(candles, lastDisp, marketState);
    },

    _findOrderBlockForDisplacement(candles, disp, marketState) {
        const dispIdx = disp.startIndex;

        // Structure confirmation: check if BOS or MSS is near this displacement
        const lastBOS = marketState.structure?.lastBOS;
        const lastMSS = marketState.structure?.lastMSS;
        const hasStructureConfirmation =
            (lastBOS && Math.abs(lastBOS.index - dispIdx) <= 5) ||
            (lastMSS && Math.abs(lastMSS.index - dispIdx) <= 5);

        // Not strictly required, but boosts strength significantly
        const structureBonus = hasStructureConfirmation ? 25 : 0;

        if (disp.direction === 'bullish') {
            // Find last BEARISH candle before bullish displacement
            for (let j = dispIdx - 1; j >= Math.max(0, dispIdx - 5); j--) {
                const c = candles[j];
                
                // 🛑 A VACINA DO LIVE FEED: Se o candle for um "fantasma" do websocket, pule!
                if (!c || typeof c.close === 'undefined') {
                    continue;
                }

                if (c.close >= c.open) continue; // Skip bullish candles

                if (!this._isValidOBCandle(c)) continue;

                const zone = { high: c.open, low: c.close }; // Bearish: open > close

                // Check for duplicate OBs at same zone
                const isDuplicate = this._state.orderBlocks.some(
                    ob => ob.type === 'bullish' && Math.abs(ob.zone.low - zone.low) / zone.low < 0.002
                );
                if (isDuplicate) break;

                const age = candles.length - 1 - j;
                const freshness = Math.max(0, 1 - age / this.config.obMaxAge);
                const strength = Math.round(Math.min(100,
                    disp.magnitude * 15,
                    + freshness * 30
                    + (disp.volumeConfirmed ? 15 : 0)
                    + structureBonus
                    + 10 // Base
                ));

                this._state.orderBlocks.push({
                    type: 'bullish',
                    direction: 'bullish',
                    zone,
                    originIndex: j,
                    displacementIndex: dispIdx,
                    displacementMagnitude: disp.magnitude,
                    mitigated: false,
                    mitigationDepth: 0,
                    retesting: false,
                    strengthScore: strength,
                    age,
                    structureConfirmed: hasStructureConfirmation,
                    volumeConfirmed: disp.volumeConfirmed
                });
                break;
            }
        } else {
            // Find last BULLISH candle before bearish displacement
            for (let j = dispIdx - 1; j >= Math.max(0, dispIdx - 5); j--) {
                const c = candles[j];

                // 🛑 A VACINA DO LIVE FEED: Se o candle for um "fantasma" do websocket, pule!
                if (!c || typeof c.close === 'undefined') {
                    continue;
                }

                if (c.close <= c.open) continue; // Skip bearish candles

                if (!this._isValidOBCandle(c)) continue;

                const zone = { high: c.close, low: c.open }; // Bullish: close > open

                const isDuplicate = this._state.orderBlocks.some(
                    ob => ob.type === 'bearish' && Math.abs(ob.zone.high - zone.high) / zone.high < 0.002
                );
                if (isDuplicate) break;

                const age = candles.length - 1 - j;
                const freshness = Math.max(0, 1 - age / this.config.obMaxAge);
                const strength = Math.round(Math.min(100,
                    disp.magnitude * 15
                    + freshness * 30
                    + (disp.volumeConfirmed ? 15 : 0)
                    + structureBonus
                    + 10
                ));

                this._state.orderBlocks.push({
                    type: 'bearish',
                    direction: 'bearish',
                    zone,
                    originIndex: j,
                    displacementIndex: dispIdx,
                    displacementMagnitude: disp.magnitude,
                    mitigated: false,
                    mitigationDepth: 0,
                    retesting: false,
                    strengthScore: strength,
                    age,
                    structureConfirmed: hasStructureConfirmation,
                    volumeConfirmed: disp.volumeConfirmed
                });
                break;
            }
        }
    },

    _isValidOBCandle(candle) {
        const body = Math.abs(candle.close - candle.open);
        const totalRange = candle.high - candle.low;

        // Must have meaningful range
        if (totalRange === 0) return false;

        // Body must be ≥ 50% of range (filters dojis/stars)
        if (body / totalRange < this.config.obMinBodyRatio) return false;

        // Volume check against MA
        if (this._state.volumeMA > 0 && candle.volume) {
            if (candle.volume < this._state.volumeMA * this.config.obVolumeThreshold) return false;
        }

        return true;
    },

    /**
     * Full mitigation scan.
     * OB is mitigated when price closes past 50% of its zone.
     */
    _updateMitigationStatus(candles) {
        for (const ob of this._state.orderBlocks) {
            if (ob.mitigated) continue;

            const zoneMid = (ob.zone.high + ob.zone.low) / 2;
            const mitigationLevel = ob.type === 'bullish'
                ? zoneMid  // Bullish OB: mitigated if price closes below midpoint
                : zoneMid; // Bearish OB: mitigated if price closes above midpoint

            for (let i = ob.displacementIndex + 1; i < candles.length; i++) {
                const c = candles[i];
                if (ob.type === 'bullish' && c.close < mitigationLevel) {
                    ob.mitigated = true;
                    ob.mitigationDepth = (ob.zone.high - c.close) / (ob.zone.high - ob.zone.low);
                    break;
                }
                if (ob.type === 'bearish' && c.close > mitigationLevel) {
                    ob.mitigated = true;
                    ob.mitigationDepth = (c.close - ob.zone.low) / (ob.zone.high - ob.zone.low);
                    break;
                }
            }
        }
    },

    /**
     * Incremental mitigation check with latest candle only.
     */
    _updateMitigationIncremental(candle) {
        for (const ob of this._state.orderBlocks) {
            if (ob.mitigated) continue;

            const zoneMid = (ob.zone.high + ob.zone.low) / 2;

            if (ob.type === 'bullish' && candle.close < zoneMid) {
                ob.mitigated = true;
                ob.mitigationDepth = (ob.zone.high - candle.close) / (ob.zone.high - ob.zone.low);
            }
            if (ob.type === 'bearish' && candle.close > zoneMid) {
                ob.mitigated = true;
                ob.mitigationDepth = (candle.close - ob.zone.low) / (ob.zone.high - ob.zone.low);
            }
        }
    },

    /**
     * Check if current price is retesting any active (unmitigated) OB.
     */
    _checkOBRetests(candles) {
        if (candles.length === 0) return;
        const price = candles[candles.length - 1].close;

        for (const ob of this._state.orderBlocks) {
            ob.retesting = !ob.mitigated && price >= ob.zone.low && price <= ob.zone.high;
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PREMIUM / DISCOUNT / EQUILIBRIUM
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Calculate Premium/Discount zones from structural range.
     * After BOS, recalculate from post-BOS swing extremes.
     */
    _calcPremiumDiscount(candles, marketState) {
        let rangeHigh, rangeLow;

        // Use MSE range if available; otherwise use structural swings
        if (marketState.range && marketState.range.isRange) {
            rangeHigh = marketState.range.high;
            rangeLow = marketState.range.low;
        } else if (marketState.swings) {
            const { highs, lows } = marketState.swings;
            if (highs.length > 0 && lows.length > 0) {
                // Use most recent structural swing high/low
                rangeHigh = Math.max(...highs.slice(-5).map(h => h.price));
                rangeLow = Math.min(...lows.slice(-5).map(l => l.price));
            } else {
                const recent = candles.slice(-50);
                rangeHigh = Math.max(...recent.map(c => c.high));
                rangeLow = Math.min(...recent.map(c => c.low));
            }
        } else {
            const recent = candles.slice(-50);
            rangeHigh = Math.max(...recent.map(c => c.high));
            rangeLow = Math.min(...recent.map(c => c.low));
        }

        const rangeSize = rangeHigh - rangeLow;
        if (rangeSize === 0) {
            return {
                rangeHigh, rangeLow,
                equilibrium: rangeHigh,
                currentZone: 'equilibrium',
                oteZone: null,
                fibLevels: null
            };
        }

        const equilibrium = (rangeHigh + rangeLow) / 2;
        const currentPrice = candles[candles.length - 1].close;

        // Determine current zone
        let currentZone = 'equilibrium';
        const eqBand = rangeSize * this.config.equilibriumBand;
        if (currentPrice > equilibrium + eqBand) currentZone = 'premium';
        else if (currentPrice < equilibrium - eqBand) currentZone = 'discount';

        // Fibonacci levels
        const fibLevels = {
            fib236: rangeHigh - rangeSize * 0.236,
            fib382: rangeHigh - rangeSize * 0.382,
            fib500: equilibrium,
            fib618: rangeHigh - rangeSize * 0.618,
            fib786: rangeHigh - rangeSize * 0.786
        };

        // OTE zones
        const oteZone = {
            bullish: {
                high: fibLevels.fib618,
                low: fibLevels.fib786
            },
            bearish: {
                high: rangeLow + rangeSize * 0.786,
                low: rangeLow + rangeSize * 0.618
            }
        };

        return {
            rangeHigh,
            rangeLow,
            equilibrium,
            currentZone,
            oteZone,
            fibLevels,
            currentPrice
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ENTITY LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Age-decay and prune stale entities.
     */
    _pruneStaleEntities(currentIndex) {
        // Decay OB strength by age
        for (const ob of this._state.orderBlocks) {
            ob.age = currentIndex - ob.originIndex;
            if (!ob.mitigated) {
                // Decay 2 points per bar beyond displacement
                const barsAfterDisp = currentIndex - ob.displacementIndex;
                ob.strengthScore = Math.max(0,
                    ob.strengthScore - barsAfterDisp * this.config.obAgeDecay * 0.05
                );
            }
        }

        // Prune OBs that are too old and mitigated
        this._state.orderBlocks = this._state.orderBlocks.filter(ob => {
            if (ob.mitigated && ob.age > this.config.obMaxAge) return false;
            if (ob.strengthScore <= 0) return false;
            return true;
        });

        // Prune old swept pools
        this._state.pools = this._state.pools.filter(p => {
            if (p.swept && currentIndex - p.sweepIndex > this.config.obMaxAge) return false;
            return true;
        });

        // Cap displacements to recent only
        if (this._state.displacements.length > this.config.maxDisplacements) {
            this._state.displacements = this._state.displacements.slice(-this.config.maxDisplacements);
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INDICATOR HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    _updateATR(candles) {
        const period = this.config.atrPeriod;
        if (candles.length < period + 1) {
            this._state.atr = 0;
            return;
        }
        let atrSum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const tr = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i - 1].close),
                Math.abs(candles[i].low - candles[i - 1].close)
            );
            atrSum += tr;
        }
        this._state.atr = atrSum / period;
    },

    _updateVolumeMA(candles) {
        const period = this.config.volumeMAPeriod;
        if (candles.length < period) {
            this._state.volumeMA = 0;
            return;
        }
        let volSum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            volSum += (candles[i].volume || 0);
        }
        this._state.volumeMA = volSum / period;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // OUTPUT / RESULT BUILDING
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Build the result object that matches the original API contract.
     */
    /**
     * Build the result object that matches the original API contract.
     * ESTA É A VERSÃO CORRIGIDA PARA EVITAR O ERRO DE UNDEFINED
     */
    _buildResult(candles, marketState) {
        // 1. Criamos a estrutura de dados separando EQH/EQL
        const eqh = this._state.pools.filter(p => p.type === 'EQH');
        const eql = this._state.pools.filter(p => p.type === 'EQL');

        // 2. Criamos o objeto 'output'
        const output = {
            equalLevels: {
                eqh: eqh.map(p => ({
                    price: p.priceLevel,
                    indices: p.indices,
                    count: p.touchCount,
                    swept: p.swept,
                    strengthScore: p.strengthScore
                })),
                eql: eql.map(p => ({
                    price: p.priceLevel,
                    indices: p.indices,
                    count: p.touchCount,
                    swept: p.swept,
                    strengthScore: p.strengthScore
                }))
            },
            orderBlocks: this._state.orderBlocks.map(ob => ({
                type: ob.type,
                zone: ob.zone,
                origin: { index: ob.originIndex },
                displacement: { index: ob.displacementIndex, magnitude: ob.displacementMagnitude },
                mitigated: ob.mitigated,
                mitigationDepth: ob.mitigationDepth,
                retesting: ob.retesting,
                strength: ob.strengthScore,
                age: ob.age,
                structureConfirmed: ob.structureConfirmed,
                volumeConfirmed: ob.volumeConfirmed
            })),
            premiumDiscount: this._state.premiumDiscount,
            liquiditySweeps: this._state.sweeps.map(s => ({
                type: s.type,
                level: s.level,
                sweepCandle: s.sweepCandle,
                confidence: s.confidence,
                levelsSwept: s.levelsSwept,
                mssLinked: s.mssLinked,
                volumeConfirmed: s.volumeConfirmed,
                direction: s.direction,
                strength: s.strength
            })),
            displacements: this._state.displacements.map(d => ({
                direction: d.direction,
                startIndex: d.startIndex,
                endIndex: d.endIndex,
                magnitude: d.magnitude,
                strength: d.strength,
                bodyRatio: d.bodyRatio,
                volumeConfirmed: d.volumeConfirmed,
                cascadeCount: d.cascadeCount
            })),
            // v3.0: Fair Value Gaps
            fairValueGaps: this._state.fvgs.map(fvg => ({
                type: fvg.type,
                high: fvg.high,
                low: fvg.low,
                midpoint: fvg.midpoint,
                index: fvg.index,
                mitigated: fvg.mitigated,
                session: fvg.session,
                volumeContext: fvg.volumeContext,
                recency: fvg.recency,
                linkedSweep: fvg.linkedSweep || false
            }))
        };

        // 3. Processamos Cache e Eventos
        if (typeof window.StateCache !== 'undefined') {
            const activeOBs = this._state.orderBlocks.filter(ob => !ob.mitigated);
            window.StateCache.set('activeOrderBlocks', activeOBs);

            if (this._state.sweeps.length > 0) {
                const lastSweep = this._state.sweeps[this._state.sweeps.length - 1];
                window.StateCache.set('lastSweep', {
                    direction: lastSweep.direction,
                    price: lastSweep.level,
                    pool: lastSweep.levelsSwept
                });
            }
        }

        if (typeof window.EventBus !== 'undefined' && window.EventBus.EVENTS) {
            const E = window.EventBus.EVENTS;

            // Emitir novos Sweeps
            const previousSweepCount = this._state.lastSweepCount || 0;
            if (this._state.sweeps.length > previousSweepCount) {
                for (let i = previousSweepCount; i < this._state.sweeps.length; i++) {
                    const swp = this._state.sweeps[i];
                    window.EventBus.emit(E.LIQUIDITY_SWEEP || 'LIQUIDITY_SWEEP', {
                        direction: swp.direction,
                        price: swp.level,
                        pool: swp.type,
                        timestamp: swp.sweepCandle?.candle?.time || 0,
                        mssLinked: swp.mssLinked
                    });
                }
            }
            this._state.lastSweepCount = this._state.sweeps.length;

            // Emitir novos OB Retests
            const retestingOBs = output.orderBlocks.filter(ob => ob.retesting);
            const prevRetesting = this._state.lastRetestingOBs || [];

            for (const ob of retestingOBs) {
                const isNew = !prevRetesting.some(p => p.origin.index === ob.origin.index);
                if (isNew) {
                    window.EventBus.emit(E.OB_RETEST || 'OB_RETEST', {
                        direction: ob.type === 'bullish' ? 'bullish' : 'bearish',
                        orderBlock: ob
                    });
                }
            }
            this._state.lastRetestingOBs = [...retestingOBs];
        }

        return output;
    },

    _emptyResult() {
        return {
            equalLevels: { eqh: [], eql: [] },
            orderBlocks: [],
            premiumDiscount: null,
            liquiditySweeps: [],
            displacements: [],
            fairValueGaps: []
        };
    },

    reset() {
        this._state = {
            pools: [],
            sweeps: [],
            orderBlocks: [],
            displacements: [],
            fvgs: [],
            premiumDiscount: null,
            lastCandleCount: 0,
            atr: 0,
            volumeMA: 0,
            volumeBuffer: [],
            lastRegime: null,
            bootstrapped: false,
            lastSweepCount: 0,
            lastRetestingOBs: []
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // v3.0: FAIR VALUE GAP DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Detect all FVGs from full candle history (bootstrap).
     * An FVG is a gap between candle[i-2].high/low and candle[i].low/high
     * where candle[i-1] is the impulse candle.
     */
    _detectFVGs(candles) {
        this._state.fvgs = [];
        for (let i = 2; i < candles.length; i++) {
            this._checkFVG(candles, i);
        }
        // Cap buffer
        while (this._state.fvgs.length > 30) this._state.fvgs.shift();
    },

    /**
     * Check if candle at idx forms an FVG with its neighbors.
     */
    _checkFVG(candles, idx) {
        if (idx < 2 || idx >= candles.length) return;

        const c0 = candles[idx - 2]; // pre-impulse
        const c1 = candles[idx - 1]; // impulse candle
        const c2 = candles[idx];     // post-impulse

        if (!c0 || !c1 || !c2) return;

        // Bullish FVG: gap between c0.high and c2.low
        if (c2.low > c0.high) {
            const fvg = {
                type: 'bullish',
                high: c2.low,
                low: c0.high,
                midpoint: (c2.low + c0.high) / 2,
                index: idx - 1,
                mitigated: false,
                session: this._classifySession ? this._classifySession(c1) : 'unknown',
                volumeContext: c1.volume > this._state.volumeMA ? 'high' : 'normal',
                recency: 1.0,
                linkedSweep: this._isNearSweep(idx, 'bullish')
            };
            this._state.fvgs.push(fvg);
        }

        // Bearish FVG: gap between c2.high and c0.low
        if (c0.low > c2.high) {
            const fvg = {
                type: 'bearish',
                high: c0.low,
                low: c2.high,
                midpoint: (c0.low + c2.high) / 2,
                index: idx - 1,
                mitigated: false,
                session: this._classifySession ? this._classifySession(c1) : 'unknown',
                volumeContext: c1.volume > this._state.volumeMA ? 'high' : 'normal',
                recency: 1.0,
                linkedSweep: this._isNearSweep(idx, 'bearish')
            };
            this._state.fvgs.push(fvg);
        }

        // Cap buffer
        while (this._state.fvgs.length > 30) this._state.fvgs.shift();
    },

    /**
     * Mitigate (fill) FVGs when price revisits them.
     */
    _mitigateFVGs(candle) {
        if (!candle) return;
        for (const fvg of this._state.fvgs) {
            if (fvg.mitigated) continue;
            // Bullish FVG mitigated when price closes below FVG low
            if (fvg.type === 'bullish' && candle.close <= fvg.low) {
                fvg.mitigated = true;
            }
            // Bearish FVG mitigated when price closes above FVG high
            if (fvg.type === 'bearish' && candle.close >= fvg.high) {
                fvg.mitigated = true;
            }
        }
    },

    /**
     * Check if an FVG is near a recent sweep (for sweep→FVG setup detection).
     */
    _isNearSweep(fvgIdx, fvgType) {
        for (const sweep of this._state.sweeps) {
            const sweepIdx = sweep.sweepCandle?.idx || 0;
            const isRecent = Math.abs(fvgIdx - sweepIdx) <= this.config.sweepMSSLinkageBars;
            const isAligned = (fvgType === 'bullish' && sweep.direction === 'bullish') ||
                              (fvgType === 'bearish' && sweep.direction === 'bearish');
            if (isRecent && isAligned) return true;
        }
        return false;
    }
}; // Fim do objeto LiquidityEngine

// EXPOSIÇÃO GLOBAL
if (typeof window !== 'undefined') {
    window.LiquidityEngine = LiquidityEngine;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LiquidityEngine;
}