// @ts-nocheck
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RegimeEngine (v5.1 — Level 0 of the decision pipeline)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Classifies the current market into one of:
 *
 *   TREND_UP   — directional, follow flow, ignore POC
 *   TREND_DOWN — directional, follow flow, ignore POC
 *   RANGE      — mean reversion at VAL/VAH, avoid POC
 *   CHAOTIC    — block trades or shrink size aggressively
 *   TRANSITION — default; treat conservatively
 *
 * Algorithm uses 4 factors, all derived from 1m candles:
 *
 *   1. trendStrength       = |EMA20 - EMA50| / price × 100
 *   2. directionalConsistency = % of last 10 candles closing same direction
 *   3. priceConcentration  = % of last 20 candles inside BB middle ± 1σ
 *   4. volatilityRatio     = ATR(14) / mean(ATR over last 20)
 *
 * Output is { regime, confidence (0..1), reasons[] } and is emitted on the
 * EventBus as `REGIME_DETECTED`. Listeners (App.tsx, ScalpEngine, HUD) push
 * it into the Zustand store.
 */

import { EventBus } from './event-bus';

export type Regime = 'trend_up' | 'trend_down' | 'range' | 'chaotic' | 'transition';

export interface RegimeResult {
    regime: Regime;
    confidence: number;     // 0..1
    reasons: string[];      // human-readable factors
    factors: {
        trendStrength: number;
        directionalConsistency: number;
        priceConcentration: number;
        volatilityRatio: number;
        emaDirection: number;       // sign(ema20 - ema50): +1 up, -1 down, 0 flat
    };
}

interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isClosed?: boolean;
}

// ─── Config ────────────────────────────────────────────────────────────────

interface RegimeConfig {
    minCandles: number;        // need at least this many to compute
    trendThreshold: number;    // trendStrength % above which it's "trending"
    flatThreshold: number;     // trendStrength % below which it's "flat"
    consistencyTrend: number;  // % of last 10 same-direction needed for TREND
    concentrationRange: number;// % of last 20 inside BB middle for RANGE
    volChaotic: number;        // volatilityRatio above which it's CHAOTIC
    consistencyChaos: number;  // upper bound consistency for CHAOTIC
}

const DEFAULT_CONFIG: RegimeConfig = {
    minCandles: 50,
    trendThreshold: 0.15,    // 0.15% gap between EMA20/50 = clearly trending
    flatThreshold: 0.05,     // < 0.05% gap = effectively flat
    consistencyTrend: 0.60,
    concentrationRange: 0.65,
    volChaotic: 1.8,
    consistencyChaos: 0.40,
};

// ─── Helpers (no external deps) ───────────────────────────────────────────

function ema(data: number[], period: number): number | null {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let result = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
        result = (data[i] - result) * k + result;
    }
    return result;
}

function trueRange(c: Candle, prev: Candle | null): number {
    if (!prev) return c.high - c.low;
    return Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
    );
}

function atr(candles: Candle[], period: number): number | null {
    if (candles.length < period + 1) return null;
    const trs: number[] = [];
    for (let i = candles.length - period; i < candles.length; i++) {
        trs.push(trueRange(candles[i], candles[i - 1] ?? null));
    }
    return trs.reduce((a, b) => a + b, 0) / period;
}

function stdev(data: number[]): number {
    if (data.length === 0) return 0;
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const variance = data.reduce((s, x) => s + (x - mean) ** 2, 0) / data.length;
    return Math.sqrt(variance);
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

// ─── Factor calculators ───────────────────────────────────────────────────

function computeTrendStrength(candles: Candle[]): { strength: number; direction: number } {
    const closes = candles.map(c => c.close);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    if (e20 === null || e50 === null) return { strength: 0, direction: 0 };
    const price = closes[closes.length - 1] || 1;
    const strength = (Math.abs(e20 - e50) / price) * 100;
    const direction = e20 > e50 ? 1 : e20 < e50 ? -1 : 0;
    return { strength, direction };
}

/** Proportion (0..1) of last 10 candles whose close is on the same side as the dominant direction. */
function computeDirectionalConsistency(candles: Candle[]): number {
    const last10 = candles.slice(-10);
    if (last10.length < 5) return 0;
    let up = 0, down = 0;
    for (let i = 1; i < last10.length; i++) {
        const delta = last10[i].close - last10[i - 1].close;
        if (delta > 0) up++;
        else if (delta < 0) down++;
    }
    const dominant = Math.max(up, down);
    return dominant / Math.max(1, up + down);
}

/** Proportion (0..1) of last 20 candles closing inside BB(20) middle ± 1σ. */
function computePriceConcentration(candles: Candle[]): number {
    const last20 = candles.slice(-20);
    if (last20.length < 20) return 0;
    const closes = last20.map(c => c.close);
    const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
    const sigma = stdev(closes);
    if (sigma === 0) return 1; // total flat = total concentration
    let inside = 0;
    for (const c of closes) {
        if (Math.abs(c - mean) <= sigma) inside++;
    }
    return inside / closes.length;
}

/** ATR(14) atual / mean(ATR last 20) — ratio > 1 = expansão, < 1 = compressão. */
function computeVolatilityRatio(candles: Candle[]): number {
    if (candles.length < 35) return 1;
    const currentATR = atr(candles, 14);
    if (!currentATR) return 1;
    // Compute ATR at 20 different points back, get mean
    const atrs: number[] = [];
    for (let lookback = 0; lookback < 20; lookback++) {
        const sliced = candles.slice(0, candles.length - lookback);
        const a = atr(sliced, 14);
        if (a !== null) atrs.push(a);
    }
    if (atrs.length === 0) return 1;
    const meanATR = atrs.reduce((a, b) => a + b, 0) / atrs.length;
    return meanATR > 0 ? currentATR / meanATR : 1;
}

// ─── Engine ────────────────────────────────────────────────────────────────

export const RegimeEngine = {
    config: DEFAULT_CONFIG,

    /**
     * Run a fresh classification on the given candles. Returns null if not
     * enough data; otherwise emits REGIME_DETECTED on the EventBus and returns
     * the result.
     */
    evaluate(candles: Candle[]): RegimeResult | null {
        if (!candles || candles.length < this.config.minCandles) return null;

        const trend = computeTrendStrength(candles);
        const consistency = computeDirectionalConsistency(candles);
        const concentration = computePriceConcentration(candles);
        const volRatio = computeVolatilityRatio(candles);

        const factors = {
            trendStrength: +trend.strength.toFixed(4),
            directionalConsistency: +consistency.toFixed(3),
            priceConcentration: +concentration.toFixed(3),
            volatilityRatio: +volRatio.toFixed(3),
            emaDirection: trend.direction,
        };

        const reasons: string[] = [];
        let regime: Regime = 'transition';
        let confidence = 0.4;

        // ─── CHAOTIC check first (priority — overrides everything) ───
        if (volRatio > this.config.volChaotic && consistency < this.config.consistencyChaos) {
            regime = 'chaotic';
            confidence = clamp(
                (volRatio - this.config.volChaotic) * 0.5 + (1 - consistency) * 0.5,
                0.5, 0.95,
            );
            reasons.push(`Volatility spike (×${volRatio.toFixed(2)} of mean ATR)`);
            reasons.push(`Whipsaw — only ${(consistency * 100).toFixed(0)}% directional consistency`);
        }
        // ─── TREND check ───
        else if (trend.strength > this.config.trendThreshold && consistency > this.config.consistencyTrend) {
            regime = trend.direction > 0 ? 'trend_up' : 'trend_down';
            confidence = clamp(
                (trend.strength / 0.5) * 0.55 + consistency * 0.45,
                0.5, 0.95,
            );
            reasons.push(
                `EMA20 ${trend.direction > 0 ? 'above' : 'below'} EMA50 by ${trend.strength.toFixed(3)}%`
            );
            reasons.push(`${(consistency * 100).toFixed(0)}% directional consistency over last 10 candles`);
        }
        // ─── RANGE check ───
        else if (
            trend.strength < this.config.flatThreshold &&
            concentration > this.config.concentrationRange &&
            volRatio < 1.3
        ) {
            regime = 'range';
            confidence = clamp(
                concentration * 0.55 + (1.3 - volRatio) * 0.30 + (this.config.flatThreshold - trend.strength) * 4,
                0.5, 0.95,
            );
            reasons.push(`Price oscillating: ${(concentration * 100).toFixed(0)}% inside ±1σ band`);
            reasons.push(`EMAs flat (gap ${trend.strength.toFixed(3)}%)`);
            reasons.push(`Volatility stable (×${volRatio.toFixed(2)})`);
        }
        // ─── TRANSITION (fallback) ───
        else {
            regime = 'transition';
            confidence = 0.4;
            reasons.push(
                `Mixed: trend ${trend.strength.toFixed(3)}%, consistency ${(consistency * 100).toFixed(0)}%, vol ×${volRatio.toFixed(2)}`
            );
            reasons.push('No regime fully qualifies — wait for clearer structure');
        }

        const result: RegimeResult = { regime, confidence: +confidence.toFixed(3), reasons, factors };

        EventBus.emit('REGIME_DETECTED', result);

        return result;
    },

    /** Visual label for UI badges. */
    label(regime: Regime): string {
        switch (regime) {
            case 'trend_up': return 'TREND ↑';
            case 'trend_down': return 'TREND ↓';
            case 'range': return 'RANGE';
            case 'chaotic': return 'CHAOTIC';
            case 'transition': return 'TRANSITION';
        }
    },

    /** Color hint for UI. */
    color(regime: Regime): string {
        switch (regime) {
            case 'trend_up': return '#00e1ff';
            case 'trend_down': return '#ff3366';
            case 'range': return '#ffb800';
            case 'chaotic': return '#ff3366';
            case 'transition': return '#8892b0';
        }
    },

    /**
     * Suggested behavior modifier for downstream engines.
     * Used by ScalpEngine to decide whether to relax/block setups.
     */
    behaviorHint(regime: Regime): {
        block: boolean;            // hard block all setups
        thresholdDelta: number;    // adjust min confidence threshold (negative = looser)
        sizeMultiplier: number;    // multiply position size
        biasDirection: 'long' | 'short' | null;   // preferred direction (or null = both)
    } {
        switch (regime) {
            case 'trend_up':
                return { block: false, thresholdDelta: -0.05, sizeMultiplier: 1.0, biasDirection: 'long' };
            case 'trend_down':
                return { block: false, thresholdDelta: -0.05, sizeMultiplier: 1.0, biasDirection: 'short' };
            case 'range':
                return { block: false, thresholdDelta: 0.0, sizeMultiplier: 0.85, biasDirection: null };
            case 'chaotic':
                return { block: true, thresholdDelta: 0.20, sizeMultiplier: 0.0, biasDirection: null };
            case 'transition':
                return { block: false, thresholdDelta: 0.05, sizeMultiplier: 0.65, biasDirection: null };
        }
    },
};
