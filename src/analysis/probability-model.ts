/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ProbabilityModel (v5.2a)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Estimates `probability_hit` — the chance that price reaches `target` before
 * hitting `stop`. Used by `LeverageAdjustedRiskEngine` to compute Expected
 * Value:
 *
 *     EV = p × gain − (1 − p) × loss − fees − slippage
 *
 * The model is intentionally honest about its limitations:
 *
 *   - Initial implementation: HEURISTIC, hand-tuned weights based on
 *     domain knowledge of order-flow scalping. Returns `calibration: 'heuristic'`.
 *
 *   - When ≥30 outcomes are accumulated in SQLite (see F8 weekly report),
 *     a calibration job can replace the function with one fit from data.
 *     That version returns `calibration: 'fitted'` and updates UI badge.
 *
 * The UI surfaces the calibration flag prominently so Roberto knows the EV
 * number is a guess vs. a backed estimate.
 */

import type { Regime } from './regime-engine';

export type Direction = 'long' | 'short';
export type Calibration = 'heuristic' | 'fitted';

export interface ProbabilityInputs {
    /** Entry price */
    entryPrice: number;
    /** Take-profit price */
    target: number;
    /** Stop-loss price */
    stop: number;
    /** Direction of the trade */
    direction: Direction;

    /** -1..+1 scaled momentum aligned with direction (positive = aligned) */
    momentumAlignment?: number;
    /** 0..1 strength of liquidity at the target node (1 = strong wall) */
    liquidityStrength?: number;
    /** ATR over recent candles, in absolute price units */
    atr?: number;
    /** Current regime; used for alignment penalty/bonus */
    regime?: Regime;
}

export interface ProbabilityResult {
    /** 0..1, clamped to [0.30, 0.85] — never certainty either way */
    probability: number;
    calibration: Calibration;
    /** Each factor's contribution; helps debug + tune */
    factors: {
        base: number;
        distancePenalty: number;
        momentumBonus: number;
        liquidityBonus: number;
        regimeBonus: number;
    };
    /** Human-readable summary for tooltips */
    explanation: string;
}

// ─── Heuristic config ──────────────────────────────────────────────────────

const CONFIG = {
    /** Coin-flip baseline + small confluence prior (system has multi-dim filter). */
    base: 0.55,

    /** Min/max clamp — never pretend certainty. */
    minProbability: 0.30,
    maxProbability: 0.85,

    /**
     * Distance penalty: larger move → lower hit probability.
     * Measured in ATRs from entry to target.
     *   ≤ 1 ATR  → +0.05 (close, easy)
     *     2 ATR  → 0
     *     3 ATR  → -0.08
     *     5 ATR  → -0.20
     */
    distanceCurve: (atrMultiples: number): number => {
        if (atrMultiples <= 1) return 0.05;
        if (atrMultiples <= 2) return 0;
        if (atrMultiples <= 3) return -0.08;
        if (atrMultiples <= 5) return -0.20;
        return -0.30;
    },

    /** Momentum aligned (positive) helps; against (negative) hurts. */
    momentumWeight: 0.10,

    /** Strong liquidity at target = high probability of touch (acts as magnet). */
    liquidityWeight: 0.10,

    /** Regime modifiers — TREND aligned helps, counter-trend hurts. */
    regimeBonus: (regime: Regime | undefined, direction: Direction): number => {
        if (!regime) return 0;
        if (regime === 'trend_up' && direction === 'long') return 0.07;
        if (regime === 'trend_down' && direction === 'short') return 0.07;
        if (regime === 'trend_up' && direction === 'short') return -0.10;
        if (regime === 'trend_down' && direction === 'long') return -0.10;
        if (regime === 'range') return 0.03;       // mean reversion friendly to scalp
        if (regime === 'transition') return -0.04; // unclear edge
        if (regime === 'chaotic') return -0.15;   // high noise, low edge
        return 0;
    },
};

// ─── Engine ────────────────────────────────────────────────────────────────

export const ProbabilityModel = {
    /**
     * Estimate probability that `target` is hit before `stop`.
     * Returns clamped probability + factor breakdown.
     */
    estimateHitProbability(input: ProbabilityInputs): ProbabilityResult {
        const { entryPrice, target, direction, momentumAlignment, liquidityStrength, atr, regime } = input;

        // Distance to target in ATRs (defaults to 2 ATRs if no ATR provided)
        let atrMultiples = 2;
        if (atr && atr > 0) {
            atrMultiples = Math.abs(target - entryPrice) / atr;
        }
        const distancePenalty = CONFIG.distanceCurve(atrMultiples);

        // Momentum alignment: -1..+1 input, weight applied
        const momentumBonus = (momentumAlignment ?? 0) * CONFIG.momentumWeight;

        // Liquidity strength: 0..1 input, weight applied
        const liquidityBonus = (liquidityStrength ?? 0) * CONFIG.liquidityWeight;

        // Regime alignment
        const regimeBonus = CONFIG.regimeBonus(regime, direction);

        const raw =
            CONFIG.base +
            distancePenalty +
            momentumBonus +
            liquidityBonus +
            regimeBonus;

        const probability = clamp(raw, CONFIG.minProbability, CONFIG.maxProbability);

        const explanation = buildExplanation({
            base: CONFIG.base,
            distancePenalty,
            momentumBonus,
            liquidityBonus,
            regimeBonus,
            atrMultiples,
            probability,
        });

        return {
            probability: round(probability, 3),
            calibration: 'heuristic',
            factors: {
                base: CONFIG.base,
                distancePenalty: round(distancePenalty, 3),
                momentumBonus: round(momentumBonus, 3),
                liquidityBonus: round(liquidityBonus, 3),
                regimeBonus: round(regimeBonus, 3),
            },
            explanation,
        };
    },

    /**
     * Quick utility: compute Expected Value given a probability and the trade
     * payoff structure. Used by LeverageAdjustedRiskEngine to gate setups.
     *
     * All values in % of margin (consistent with the scalper model).
     */
    expectedValueMarginPct(args: {
        probability: number;
        tpGrossMarginPct: number;   // gain if TP hit (already includes fees adjusted upstream? no — gross)
        slLossMarginPct: number;    // loss if SL hit (positive number)
        feesMarginPct: number;
        slippageMarginPct: number;
    }): { ev: number; cost: number; ratio: number; profitable: boolean } {
        const { probability, tpGrossMarginPct, slLossMarginPct, feesMarginPct, slippageMarginPct } = args;

        // Fees + slippage are paid regardless of outcome
        const cost = feesMarginPct + slippageMarginPct;

        // Expected value of the position itself, before friction
        const grossEV = probability * tpGrossMarginPct - (1 - probability) * slLossMarginPct;

        // Net EV after friction
        const ev = grossEV - cost;

        // Ratio of EV to total cost — "how many cost-units of edge do we have?"
        const ratio = cost > 0 ? ev / cost : ev;

        return {
            ev: round(ev, 3),
            cost: round(cost, 3),
            ratio: round(ratio, 3),
            profitable: ev > 0,
        };
    },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

function round(v: number, digits: number): number {
    const k = 10 ** digits;
    return Math.round(v * k) / k;
}

function buildExplanation(args: {
    base: number;
    distancePenalty: number;
    momentumBonus: number;
    liquidityBonus: number;
    regimeBonus: number;
    atrMultiples: number;
    probability: number;
}): string {
    const parts: string[] = [];
    parts.push(`Base ${(args.base * 100).toFixed(0)}%`);

    if (args.distancePenalty !== 0) {
        const sign = args.distancePenalty > 0 ? '+' : '';
        parts.push(
            `${sign}${(args.distancePenalty * 100).toFixed(1)}% (target @ ${args.atrMultiples.toFixed(1)} ATR)`
        );
    }
    if (args.momentumBonus !== 0) {
        const sign = args.momentumBonus > 0 ? '+' : '';
        parts.push(`${sign}${(args.momentumBonus * 100).toFixed(1)}% momentum`);
    }
    if (args.liquidityBonus !== 0) {
        const sign = args.liquidityBonus > 0 ? '+' : '';
        parts.push(`${sign}${(args.liquidityBonus * 100).toFixed(1)}% liquidity`);
    }
    if (args.regimeBonus !== 0) {
        const sign = args.regimeBonus > 0 ? '+' : '';
        parts.push(`${sign}${(args.regimeBonus * 100).toFixed(1)}% regime`);
    }

    return parts.join(' · ') + ` → ${(args.probability * 100).toFixed(0)}%`;
}
