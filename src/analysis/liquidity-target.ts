/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LiquidityTargetEngine (v5.2e)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Identifies the nearest high-confidence liquidity nodes and produces
 * structural TP targets that reflect *where liquidity actually rests*,
 * rather than mechanical margin-PnL percentages.
 *
 * Sources (queried from existing engines):
 *   - LiquidityEngine: EQH/EQL pools (unswept), FVGs
 *   - VolumeProfile: POC, VAH, VAL, HVN, LVN levels
 *
 * Each candidate is scored by:
 *   1. proximity       — distance from entry in ATR multiples (closer = easier)
 *   2. persistence     — touch count × recency (more = stronger wall)
 *   3. executionRatio  — how often pools at similar levels get swept (structural heuristic)
 *   4. directionAlign  — is the node directionally valid for this trade
 *
 * Anti-spoofing:
 *   - Reject nodes with persistence < 0.3
 *   - Reject nodes with executionRatio < 0.2
 *
 * Output feeds into LeverageAdjustedRiskEngine via the dual-gate:
 *   TP = max(liquidityTarget, marginPnLFloor)
 * Both conditions must pass.
 *
 * The engine does NOT import or depend on the Zustand store. It is a pure
 * function of price, direction, and the analysis engine states.
 */

// @ts-nocheck
import { LiquidityEngine } from './liquidity';
import { VolumeProfile } from './volume-profile';

// ─── Types ──────────────────────────────────────────────────────────────────

export type LiquiditySource = 'EQH' | 'EQL' | 'POC' | 'VAH' | 'VAL' | 'HVN' | 'LVN' | 'FVG';

export interface LiquidityNode {
    /** Absolute price level */
    price: number;
    /** Relative size 0..1 (normalized strength from source engine) */
    size: number;
    /** 0..1 — touch count × recency weighting */
    persistence: number;
    /** 0..1 — swept-vs-abandoned heuristic from historical pools */
    executionRatio: number;
    /** Where this node came from */
    source: LiquiditySource;
    /** Composite confidence 0..1 */
    confidence: number;
    /** Human-readable label for UI */
    label: string;
}

export interface LiquidityTargetResult {
    /** Best candidate for TP1 (closest high-confidence node in target direction) */
    primaryTarget: LiquidityNode | null;
    /** Runner for TP2 (next node beyond primary, if any) */
    secondaryTarget: LiquidityNode | null;
    /** All scored candidates, sorted by confidence desc */
    allCandidates: LiquidityNode[];
    /** True if no liquidity node found — caller should use margin-PnL fallback */
    fallbackUsed: boolean;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
    /** Don't look further than N ATR from entry */
    maxDistanceATR: 5,
    /** Minimum node distance from entry in ATR (ignore nodes too close) */
    minDistanceATR: 0.3,
    /** Anti-spoofing: minimum persistence to accept */
    minPersistence: 0.3,
    /** Anti-spoofing: minimum execution ratio to accept */
    minExecutionRatio: 0.2,
    /** Minimum composite confidence to accept */
    minConfidence: 0.25,

    /** Weight factors for composite confidence */
    weights: {
        proximity: 0.30,    // closer = better
        persistence: 0.35,  // more persistent = stronger magnet
        execution: 0.20,    // higher swept ratio = more real
        size: 0.15,         // bigger = more important
    },

    /** Recency half-life in bars — pools older than this get persistence decay */
    recencyHalfLife: 30,
};

// ─── Engine ─────────────────────────────────────────────────────────────────

export const LiquidityTargetEngine = {

    config: CONFIG,

    /**
     * Find the best liquidity targets for TP placement.
     *
     * @param entryPrice  Current / expected entry price
     * @param direction   Trade direction
     * @param atr         ATR in absolute price units (from candle data)
     * @param maxDistATR  Optional max search distance (default 5 ATR)
     */
    findTargets(
        entryPrice: number,
        direction: 'long' | 'short',
        atr: number,
        maxDistATR: number = CONFIG.maxDistanceATR
    ): LiquidityTargetResult {

        if (!entryPrice || entryPrice <= 0 || !atr || atr <= 0) {
            return { primaryTarget: null, secondaryTarget: null, allCandidates: [], fallbackUsed: true };
        }

        const candidates: LiquidityNode[] = [];

        // ─── 1. Collect from LiquidityEngine pools (EQH/EQL) ───
        this._collectPoolTargets(candidates, entryPrice, direction, atr, maxDistATR);

        // ─── 2. Collect from VolumeProfile (POC, VAH, VAL, HVN, LVN) ───
        this._collectVolumeTargets(candidates, entryPrice, direction, atr, maxDistATR);

        // ─── 3. Collect from FVGs (unmitigated, directionally valid) ───
        this._collectFVGTargets(candidates, entryPrice, direction, atr, maxDistATR);

        // ─── 4. Anti-spoofing filter ───
        const filtered = candidates.filter(n =>
            n.persistence >= CONFIG.minPersistence &&
            n.executionRatio >= CONFIG.minExecutionRatio &&
            n.confidence >= CONFIG.minConfidence
        );

        // ─── 5. Sort by distance from entry (closest first for primary) ───
        const isLong = direction === 'long';
        const directional = filtered.filter(n =>
            isLong ? n.price > entryPrice : n.price < entryPrice
        );

        // Sort by distance ascending (closest to entry first)
        directional.sort((a, b) => {
            const distA = Math.abs(a.price - entryPrice);
            const distB = Math.abs(b.price - entryPrice);
            // If similar distance, prefer higher confidence
            if (Math.abs(distA - distB) < atr * 0.2) {
                return b.confidence - a.confidence;
            }
            return distA - distB;
        });

        const primaryTarget = directional.length > 0 ? directional[0] : null;
        const secondaryTarget = directional.length > 1 ? directional[1] : null;

        return {
            primaryTarget,
            secondaryTarget,
            allCandidates: directional,
            fallbackUsed: primaryTarget === null,
        };
    },

    // ─── Pool collectors ────────────────────────────────────────────────────

    _collectPoolTargets(
        out: LiquidityNode[],
        entryPrice: number,
        direction: 'long' | 'short',
        atr: number,
        maxDistATR: number
    ) {
        const state = LiquidityEngine?._state;
        if (!state || !state.pools) return;

        const maxDist = atr * maxDistATR;
        const minDist = atr * CONFIG.minDistanceATR;
        const isLong = direction === 'long';

        // Historical sweep stats for execution ratio
        const sweepStats = this._computeSweepStats(state);

        for (const pool of state.pools) {
            if (pool.swept) continue;

            const price = pool.priceLevel;
            const dist = Math.abs(price - entryPrice);

            // Distance filter
            if (dist > maxDist || dist < minDist) continue;

            // Direction filter: EQH = target for longs (price above entry)
            //                   EQL = target for shorts (price below entry)
            const isAbove = price > entryPrice;
            if (pool.type === 'EQH' && !isLong) continue;   // EQH only valid as long target
            if (pool.type === 'EQL' && isLong) continue;     // EQL only valid as short target
            if (isLong && !isAbove) continue;
            if (!isLong && isAbove) continue;

            // Score components
            const proximity = this._proximityScore(dist, atr, maxDistATR);
            const persistence = this._persistenceScore(pool, state.lastCandleCount || 0);
            const executionRatio = sweepStats[pool.type] ?? 0.5;
            const size = Math.min(1, (pool.strengthScore || 0) / 100);

            const confidence = this._compositeScore(proximity, persistence, executionRatio, size);

            const touchLabel = pool.touchCount === 1 ? '1 touch' : `${pool.touchCount} touches`;

            out.push({
                price,
                size,
                persistence,
                executionRatio,
                source: pool.type as LiquiditySource,
                confidence,
                label: `${pool.type} @ ${price.toFixed(1)} (${touchLabel}, ${(confidence * 100).toFixed(0)}%)`,
            });
        }
    },

    _collectVolumeTargets(
        out: LiquidityNode[],
        entryPrice: number,
        direction: 'long' | 'short',
        atr: number,
        maxDistATR: number
    ) {
        const vpState = VolumeProfile?._state;
        if (!vpState || !vpState.bootstrapped) return;

        const maxDist = atr * maxDistATR;
        const minDist = atr * CONFIG.minDistanceATR;
        const isLong = direction === 'long';

        // Helper to add a VP level
        const tryAdd = (price: number, source: LiquiditySource, sizeHint: number) => {
            if (!price || price <= 0) return;
            const dist = Math.abs(price - entryPrice);
            if (dist > maxDist || dist < minDist) return;

            // Direction check
            const isAbove = price > entryPrice;
            if (isLong && !isAbove) return;
            if (!isLong && isAbove) return;

            const proximity = this._proximityScore(dist, atr, maxDistATR);
            // VP levels have inherent persistence (they're derived from volume distribution)
            const persistence = 0.65; // VP nodes are structurally persistent by definition
            const executionRatio = 0.55; // Conservative default — VP levels often act as S/R
            const size = Math.min(1, sizeHint);

            const confidence = this._compositeScore(proximity, persistence, executionRatio, size);

            out.push({
                price,
                size,
                persistence,
                executionRatio,
                source,
                confidence,
                label: `${source} @ ${price.toFixed(1)} (${(confidence * 100).toFixed(0)}%)`,
            });
        };

        // POC — the main attractor
        const poc = vpState.pocBinKey !== null ? VolumeProfile._getPOCPrice() : 0;
        tryAdd(poc, 'POC', 0.85);

        // Value Area boundaries
        const va = VolumeProfile._calcValueArea();
        if (va) {
            tryAdd(va.high, 'VAH', 0.70);
            tryAdd(va.low, 'VAL', 0.70);
        }

        // HVN levels (high volume nodes = magnets)
        const nodes = VolumeProfile._detectNodes();
        if (nodes) {
            for (const hvn of (nodes.hvn || [])) {
                tryAdd(hvn.price, 'HVN', Math.min(1, (hvn.volume / (vpState.totalVolume / Math.max(1, vpState.bins.size))) / 3));
            }
            // LVN levels (low volume = acceleration zones, less reliable as targets)
            for (const lvn of (nodes.lvn || [])) {
                tryAdd(lvn.price, 'LVN', 0.30); // Low size = low confidence as target
            }
        }
    },

    _collectFVGTargets(
        out: LiquidityNode[],
        entryPrice: number,
        direction: 'long' | 'short',
        atr: number,
        maxDistATR: number
    ) {
        const state = LiquidityEngine?._state;
        if (!state || !state.fvgs) return;

        const maxDist = atr * maxDistATR;
        const minDist = atr * CONFIG.minDistanceATR;
        const isLong = direction === 'long';

        for (const fvg of state.fvgs) {
            if (fvg.mitigated) continue;

            // FVG midpoint as target
            const price = fvg.midpoint;
            if (!price || price <= 0) continue;

            const dist = Math.abs(price - entryPrice);
            if (dist > maxDist || dist < minDist) continue;

            // Direction check
            const isAbove = price > entryPrice;
            if (isLong && !isAbove) continue;
            if (!isLong && isAbove) continue;

            // FVG direction alignment: bullish FVG = support (long target makes less sense)
            // Actually for TP: we want to target where price is *attracted to*
            // Unmitigated FVGs act as magnets regardless of type
            const proximity = this._proximityScore(dist, atr, maxDistATR);
            const persistence = 0.50; // FVGs are moderately persistent
            const executionRatio = 0.45; // FVGs often get partially filled
            const sizeHint = fvg.volumeContext === 'high' ? 0.60 : 0.40;

            const confidence = this._compositeScore(proximity, persistence, executionRatio, sizeHint);

            out.push({
                price,
                size: sizeHint,
                persistence,
                executionRatio,
                source: 'FVG',
                confidence,
                label: `FVG ${fvg.type} @ ${price.toFixed(1)} (${(confidence * 100).toFixed(0)}%)`,
            });
        }
    },

    // ─── Scoring helpers ────────────────────────────────────────────────────

    /**
     * Proximity score: 1.0 at minDist, decays linearly to 0.0 at maxDist.
     */
    _proximityScore(dist: number, atr: number, maxDistATR: number): number {
        const atrMultiples = dist / atr;
        if (atrMultiples <= CONFIG.minDistanceATR) return 1.0;
        if (atrMultiples >= maxDistATR) return 0.0;
        return 1.0 - (atrMultiples - CONFIG.minDistanceATR) / (maxDistATR - CONFIG.minDistanceATR);
    },

    /**
     * Persistence score: touch count normalized, with recency decay.
     */
    _persistenceScore(pool: any, currentBarIndex: number): number {
        const touches = Math.min(5, pool.touchCount || 1);
        const touchScore = touches / 5; // 5 touches = max

        // Recency: how recent is the most recent touch?
        const maxIdx = Math.max(...(pool.indices || [0]));
        const age = Math.max(0, currentBarIndex - maxIdx);
        const recency = Math.exp(-0.693 * age / CONFIG.recencyHalfLife); // exponential decay, half-life

        return clamp(touchScore * 0.6 + recency * 0.4, 0, 1);
    },

    /**
     * Compute historical sweep ratio per pool type (EQH vs EQL).
     * Returns { EQH: ratio, EQL: ratio } where ratio = swept / total.
     */
    _computeSweepStats(state: any): Record<string, number> {
        const stats: Record<string, { total: number; swept: number }> = {
            EQH: { total: 0, swept: 0 },
            EQL: { total: 0, swept: 0 },
        };

        for (const pool of (state.pools || [])) {
            const type = pool.type;
            if (!stats[type]) continue;
            stats[type].total++;
            if (pool.swept) stats[type].swept++;
        }

        const result: Record<string, number> = {};
        for (const [type, s] of Object.entries(stats)) {
            // Default 0.5 if not enough data
            result[type] = s.total >= 3 ? s.swept / s.total : 0.5;
        }
        return result;
    },

    /**
     * Composite confidence from the 4 factors.
     */
    _compositeScore(
        proximity: number,
        persistence: number,
        executionRatio: number,
        size: number
    ): number {
        const w = CONFIG.weights;
        return clamp(
            proximity * w.proximity +
            persistence * w.persistence +
            executionRatio * w.execution +
            size * w.size,
            0, 1
        );
    },

    /**
     * Get the liquidityStrength value for ProbabilityModel.
     * This is the confidence of the primary target (0..1), or 0 if no target.
     */
    getLiquidityStrength(result: LiquidityTargetResult): number {
        if (!result.primaryTarget) return 0;
        return result.primaryTarget.confidence;
    },

    /**
     * Get a human-readable summary for the EV explanation tooltip.
     */
    getSummaryLabel(result: LiquidityTargetResult): string {
        if (result.fallbackUsed) {
            return 'No liquidity node found — using margin-PnL target';
        }
        const t = result.primaryTarget!;
        return `Target: ${t.source} @ ${t.price.toFixed(1)} (${(t.confidence * 100).toFixed(0)}% confidence)`;
    },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}
