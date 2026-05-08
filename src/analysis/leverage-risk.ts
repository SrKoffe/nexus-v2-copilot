/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LeverageAdjustedRiskEngine — SCALPER MODEL (margin-PnL targets) + EV gate (v5.2)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Layered gates, in order:
 *
 *   1. minConfidence       — basic prior on the analytical signal
 *   2. structureTolerance  — SL ajustado não pode violar estrutura natural
 *   3. minSurvival         — folga até liquidação
 *   4. NEGATIVE_NET_PROFIT — TP nets must be positive (config sanity)
 *   5. TP_LARGER_THAN_NATURAL — TP target shouldn't exceed naturalTP × 1.5
 *   6. EV_NOT_POSITIVE     — v5.2: Expected Value, after fees+slippage, must
 *                            exceed (fees + slippage) × evMultiplier (default 1.2)
 *
 * The EV gate is the most important addition: it forces every accepted setup
 * to have measurable statistical edge over friction. Probability comes from
 * `ProbabilityModel.estimateHitProbability()` which is heuristic until ≥30
 * outcomes are accumulated for calibration (see v5.2c flag in UI).
 */

import { ProbabilityModel } from './probability-model';
import type { Regime } from './regime-engine';

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type Direction = 'long' | 'short' | 'neutral';

export interface NaturalSetup {
    symbol: string;
    direction: Direction;
    entryPrice: number;
    /** SL natural em valor absoluto de preço (estrutura/swing point) */
    naturalStopLoss: number;
    /** TP natural em valor absoluto — usado só pra detectar se estrutura suporta o target */
    naturalTakeProfit: number;
    /** Confidence da análise (0..1) */
    confidence: number;
    reason: string;

    // ─── Optional v5.2 hints ───
    /** ATR em valor absoluto de preço — usado pelo ProbabilityModel pra distance penalty */
    atr?: number;
    /** Momentum aligned -1..+1 (positivo = aligned with direction) */
    momentumAlignment?: number;
    /** Liquidity strength 0..1 no nível do target */
    liquidityStrength?: number;
    /** Regime atual — usado pelo ProbabilityModel pra alignment bonus */
    regime?: Regime;

    // ─── v5.2e: Liquidity target hints (set by App.tsx from LiquidityTargetEngine) ───
    /** Override naturalTakeProfit with liquidity-derived target */
    liquidityTargetPrice?: number;
    /** Source of the liquidity target (EQH, POC, etc.) */
    liquidityTargetSource?: string;
    /** Confidence of the liquidity target 0..1 */
    liquidityTargetConfidence?: number;
}

export interface AdjustedSetup {
    accepted: true;
    symbol: string;
    direction: Direction;
    entryPrice: number;

    /** SL ajustado (preço absoluto) */
    stopLoss: number;
    /** SL como % do entry (movimento de preço) */
    stopLossPct: number;
    /** SL em % da margem (= stopLossPct × leverage) */
    stopLossMarginPct: number;

    /** TP1 (preço absoluto) */
    takeProfit1: number;
    takeProfit1Pct: number;            // % do entry
    takeProfit1MarginGross: number;    // % margem (antes de fees)
    takeProfit1MarginNet: number;      // % margem (depois de fees)

    /** TP2 (preço absoluto) */
    takeProfit2: number;
    takeProfit2Pct: number;
    takeProfit2MarginGross: number;
    takeProfit2MarginNet: number;

    /** Fees totais round-trip em % da margem */
    feesMarginPct: number;

    /** Slippage estimado round-trip em % da margem (v5.2) */
    slippageMarginPct: number;

    /**
     * Break-even win rate (0..1): com SL atual e TP2 atual, qual % de wins
     * é necessária pra o sistema ficar no zero. Valores acima da confidence
     * média = sinal de alerta.
     */
    breakEvenWinRate: number;

    // ─── Expected Value (v5.2) ───
    /** Probability estimate that TP1 hits before SL */
    probabilityHit: number;
    /** EV in % of margin, net of fees + slippage */
    expectedValueMarginPct: number;
    /** EV / total cost ratio (>0 means edge) */
    evCostRatio: number;
    /** "heuristic" until ≥30 outcomes; then "fitted" */
    probabilityCalibration: 'heuristic' | 'fitted';
    /** Human-readable EV reasoning */
    evExplanation: string;

    // ─── Liquidity Target (v5.2e) ───
    /** Source of TP1 if liquidity-derived (e.g. "EQH", "POC"), null if margin-PnL */
    tp1LiquiditySource: string | null;
    /** True if liquidity target overrode the margin-PnL target */
    tp1LiquidityUsed: boolean;
    /** Confidence of the liquidity target 0..1 (0 if not used) */
    tp1LiquidityConfidence: number;
    /** Human-readable liquidity target label */
    tp1LiquidityLabel: string | null;

    leverage: number;

    /** Position size em USD (margem usada) */
    positionSizeUsd: number;
    /** Notional = position × leverage */
    notionalUsd: number;

    confidence: number;

    /** Survival score 0..1 — folga até liquidação */
    survivalScore: number;

    reason: string;
    warnings: string[];
}

export interface RejectedSetup {
    accepted: false;
    reason: string;
    code:
        | 'SL_TOO_TIGHT_FOR_STRUCTURE'
        | 'TP_LARGER_THAN_NATURAL'
        | 'SURVIVAL_TOO_LOW'
        | 'CONFIDENCE_TOO_LOW'
        | 'INVALID_INPUT'
        | 'NEGATIVE_NET_PROFIT'
        | 'EV_NOT_POSITIVE';
}

export type SetupResult = AdjustedSetup | RejectedSetup;

// ─── Configuração ──────────────────────────────────────────────────────────

export interface LeverageRiskConfig {
    /** Mínima confidence aceitável (0..1). Default: 0.55 */
    minConfidence: number;

    /** Survival score mínimo aceitável (0..1). Default: 0.70 */
    minSurvival: number;

    /** Risco por trade como fração do balance. Default: 0.01 (1% de risk) */
    riskPerTrade: number;

    /** Margem de segurança até liquidação (0..1). Default: 0.4 (SL fica em 60% da liq distance) */
    liquidationSafetyMargin: number;

    /** MEXC liquida ~85% do colateral. Default: 0.85 */
    mexcLiquidationFraction: number;

    /** Tolerância pra SL ajustado violar estrutura. Default: 0.30 */
    structureTolerance: number;

    // ─── Scalper model (F7) ───
    /** Taker fee MEXC futures por trade (%). Default 0.04% (sem VIP tier) */
    takerFeePct: number;

    /** Target NET PnL em % da margem pra TP1 (parcial 50%). Default: 3% */
    tp1TargetNetMarginPct: number;

    /** Target NET PnL em % da margem pra TP2 (parcial 50%). Default: 8% */
    tp2TargetNetMarginPct: number;

    // ─── v5.2: EV gate ───
    /** Estimated round-trip slippage as % of nominal. Default 0.03% (MEXC futures). */
    slippagePct: number;

    /** EV must exceed (fees+slip) × evMultiplier to accept. Default 1.2 (20% buffer over friction). */
    evMultiplier: number;
}

export const DEFAULT_CONFIG: LeverageRiskConfig = {
    minConfidence: 0.55,
    minSurvival: 0.70,
    riskPerTrade: 0.01,
    liquidationSafetyMargin: 0.4,
    mexcLiquidationFraction: 0.85,
    structureTolerance: 0.30,
    takerFeePct: 0.04,
    tp1TargetNetMarginPct: 3,
    tp2TargetNetMarginPct: 8,
    slippagePct: 0.03,        // 0.03% round-trip — MEXC 1m futures average
    evMultiplier: 1.2,        // 20% buffer over (fees+slip)
};

// ─── Tabela de SL alvo por leverage (mantida do modelo anterior) ───────────

function targetSlPctForLeverage(leverage: number): number {
    if (leverage <= 25) return 1.5;   // x10-x25: SL até 1.5%
    if (leverage <= 50) return 0.9;
    if (leverage <= 100) return 0.45;
    if (leverage <= 200) return 0.25;
    return 0.15;
}

// NOTE: F9 (linear minConfidence-by-leverage) was reverted in favor of the
// v4.0 Operating Modes system (`swing_scalp` / `hybrid` / `micro_scalp`)
// implemented in ScalpEngine. Modes adapt threshold + max-trades-per-minute +
// position size simultaneously, which is more nuanced than scaling confidence
// alone. See ScalpingControlPanel.tsx and SetupChecklist.tsx for the user-facing
// surfacing of mode-driven thresholds.

// ─── Engine ────────────────────────────────────────────────────────────────

export const LeverageAdjustedRiskEngine = {

    adjust(
        setup: NaturalSetup,
        leverage: number,
        balanceUsd: number,
        config: LeverageRiskConfig = DEFAULT_CONFIG
    ): SetupResult {
        // ─── 0. Validação básica ───
        if (!setup || !setup.entryPrice || setup.direction === 'neutral') {
            return { accepted: false, code: 'INVALID_INPUT', reason: 'Setup neutral or missing entry price' };
        }
        if (leverage <= 0 || leverage > 500) {
            return { accepted: false, code: 'INVALID_INPUT', reason: `Invalid leverage: ${leverage}` };
        }
        // Min confidence gate. Mode-aware threshold lives in ScalpEngine/Maestro;
        // this is just the floor. If a setup got here, the upstream pipeline
        // already passed its mode-specific threshold.
        if (setup.confidence < config.minConfidence) {
            return {
                accepted: false,
                code: 'CONFIDENCE_TOO_LOW',
                reason: `Confidence ${(setup.confidence * 100).toFixed(0)}% < ${(config.minConfidence * 100).toFixed(0)}%`,
            };
        }

        const isLong = setup.direction === 'long';

        // ─── 1. SL — mesma lógica de antes ───
        const naturalSlPct = pctDistance(setup.entryPrice, setup.naturalStopLoss);
        const naturalTpPct = pctDistance(setup.entryPrice, setup.naturalTakeProfit);

        if (naturalSlPct <= 0) {
            return { accepted: false, code: 'INVALID_INPUT', reason: 'Natural SL equals entry price' };
        }

        const targetSlPct = Math.min(naturalSlPct, targetSlPctForLeverage(leverage));
        const liqDistancePct = (config.mexcLiquidationFraction / leverage) * 100;
        const slMaxSafePct = liqDistancePct * (1 - config.liquidationSafetyMargin);
        const slFinalPct = Math.min(targetSlPct, slMaxSafePct);

        // Estrutura check (mesmo do modelo anterior)
        const slShrinkRatio = slFinalPct / naturalSlPct;
        if (slShrinkRatio < (1 - config.structureTolerance)) {
            return {
                accepted: false,
                code: 'SL_TOO_TIGHT_FOR_STRUCTURE',
                reason:
                    `Leverage ${leverage}x exige SL ${slFinalPct.toFixed(2)}% mas estrutura natural ` +
                    `pede ${naturalSlPct.toFixed(2)}% — provável stop hunt`,
            };
        }

        // ─── 2. Survival ───
        const survivalScore = clamp(1 - slFinalPct / liqDistancePct, 0, 1);
        if (survivalScore < config.minSurvival) {
            return {
                accepted: false,
                code: 'SURVIVAL_TOO_LOW',
                reason: `Survival ${(survivalScore * 100).toFixed(0)}% < ${(config.minSurvival * 100).toFixed(0)}%`,
            };
        }

        // ─── 3. SL em % da margem (pra calcular RR efetivo e WR breakeven) ───
        const slMarginPct = slFinalPct * leverage;

        // ─── 4. Fees totais round-trip (em % da margem) ───
        // takerFee é % do nominal; em margem = takerFee × leverage por lado, × 2 round-trip
        const feesMarginPct = config.takerFeePct * 2 * leverage;

        // ─── 4.5 Micro-scalp TP override (v4.0) ───
        // At high leverage (>50), tighten targets for faster micro-scalps
        let effectiveTp1Net = config.tp1TargetNetMarginPct;
        let effectiveTp2Net = config.tp2TargetNetMarginPct;
        if (leverage > 50) {
            effectiveTp1Net = Math.min(effectiveTp1Net, 2); // 2% net margin max for micro-scalp TP1
            effectiveTp2Net = Math.min(effectiveTp2Net, 5); // 5% net margin max for micro-scalp TP2
        }

        // ─── 5. TPs no modelo scalper (margin-PnL) ───
        // TP gross margin = target_net + fees → TP price move = gross / leverage
        const tp1GrossMargin = effectiveTp1Net + feesMarginPct;
        const tp2GrossMargin = effectiveTp2Net + feesMarginPct;

        // Sanity: target net não pode ser negativo (fees > target)
        if (config.tp1TargetNetMarginPct <= 0 || config.tp2TargetNetMarginPct <= 0) {
            return {
                accepted: false,
                code: 'NEGATIVE_NET_PROFIT',
                reason: `TP net targets must be positive (got tp1=${config.tp1TargetNetMarginPct}%, tp2=${config.tp2TargetNetMarginPct}%)`,
            };
        }

        let tp1PricePct = tp1GrossMargin / leverage;
        let tp2PricePct = tp2GrossMargin / leverage;

        // ─── 5.5. Liquidity Target dual-gate (v5.2e) ───
        // If a liquidity-derived target was provided, check if it exceeds the
        // margin-PnL floor. If yes, use it. If no, keep the mechanical target.
        let tp1LiqUsed = false;
        let tp1LiqSource: string | null = null;
        let tp1LiqConfidence = 0;
        let tp1LiqLabel: string | null = null;

        if (setup.liquidityTargetPrice && setup.liquidityTargetPrice > 0) {
            const liqTpPct = pctDistance(setup.entryPrice, setup.liquidityTargetPrice);
            const liqTpGrossMargin = liqTpPct * leverage;
            const liqTpNetMargin = liqTpGrossMargin - feesMarginPct;

            // Dual-gate: liquidity TP must cover the margin-PnL floor
            if (liqTpNetMargin >= effectiveTp1Net) {
                tp1PricePct = liqTpPct;
                tp1LiqUsed = true;
                tp1LiqSource = setup.liquidityTargetSource || 'LIQ';
                tp1LiqConfidence = setup.liquidityTargetConfidence || 0;
                tp1LiqLabel = `${tp1LiqSource} @ ${setup.liquidityTargetPrice.toFixed(1)} (${(tp1LiqConfidence * 100).toFixed(0)}%)`;
            }
            // else: liquidity node too close to cover fees — fall back to margin-PnL target
        }

        // ─── 6. Estrutura check pro TP — só se a confidence é alta o bastante ───
        // Em scalp HL, TP é micro-movimento então quase sempre cabe na estrutura.
        // Mas se TP > naturalTP, significa que estamos pedindo mais do que a estrutura prevê — REJECT.
        if (naturalTpPct > 0 && tp2PricePct > naturalTpPct * 1.5) {
            return {
                accepted: false,
                code: 'TP_LARGER_THAN_NATURAL',
                reason:
                    `TP2 (${tp2PricePct.toFixed(3)}%) bem maior que TP natural (${naturalTpPct.toFixed(2)}%) — ` +
                    `estrutura não suporta esse target nesta leverage`,
            };
        }

        // FIX H2: Use EFFECTIVE (capped) TP targets for break-even calculation,
        // not the raw config values which are uncapped and too optimistic at high leverage.
        // Recalculate TP1 gross after potential liquidity override
        const effectiveTp1Gross = tp1PricePct * leverage;
        const effectiveTp1NetFinal = tp1LiqUsed ? (effectiveTp1Gross - feesMarginPct) : effectiveTp1Net;
        const expectedWin = 0.5 * effectiveTp1NetFinal + 0.5 * effectiveTp2Net;
        const expectedLoss = slMarginPct + feesMarginPct;
        const breakEvenWinRate = expectedLoss / (expectedWin + expectedLoss);

        // ─── 8. Converter em preços ───
        const dirSign = isLong ? -1 : 1;
        const stopLoss   = setup.entryPrice * (1 + dirSign * (slFinalPct / 100));
        const takeProfit1 = setup.entryPrice * (1 - dirSign * (tp1PricePct / 100));
        const takeProfit2 = setup.entryPrice * (1 - dirSign * (tp2PricePct / 100));

        // ─── 9. Position sizing ───
        const riskAmountUsd = balanceUsd * config.riskPerTrade;
        const notionalFromRisk = (riskAmountUsd / slFinalPct) * 100;
        const positionSizeUsd = notionalFromRisk / leverage; // margin = notional / leverage
        const notionalUsd = notionalFromRisk;

        // ─── 10. Warnings ───
        const warnings: string[] = [];
        if (leverage >= 100) {
            warnings.push(`Leverage ${leverage}x — qualquer ruído de 0.5%+ liquida.`);
        }
        if (breakEvenWinRate > setup.confidence) {
            warnings.push(
                `Break-even WR ${(breakEvenWinRate * 100).toFixed(0)}% > confidence ${(setup.confidence * 100).toFixed(0)}%. ` +
                `Estatisticamente perdedor se confidence calibrada.`
            );
        }
        if (feesMarginPct > effectiveTp1NetFinal) {
            warnings.push(
                `Fees (${feesMarginPct.toFixed(1)}% margem) > TP1 net (${effectiveTp1NetFinal.toFixed(1)}%). ` +
                `TP1 mal cobre fees — considere TP1 maior ou leverage menor.`
            );
        }
        if (slFinalPct < naturalSlPct * 0.85) {
            warnings.push(
                `SL apertado vs estrutura (${slFinalPct.toFixed(2)}% vs ${naturalSlPct.toFixed(2)}% natural).`
            );
        }
        if (survivalScore < 0.85) {
            warnings.push(`Survival ${(survivalScore * 100).toFixed(0)}% — folga apertada até liquidação.`);
        }

        // ─── 10.5. Expected Value gate (v5.2) ───
        // Slippage in margin terms: slip_pct × leverage (per trade) × 2 (round-trip)
        const slippageMarginPct = config.slippagePct * 2 * leverage;

        // Probability that TP1 hits before SL — heuristic until calibrated.
        // Use TP1 (50% partial) as the conservative anchor: it's the easier of the two.
        const probResult = ProbabilityModel.estimateHitProbability({
            entryPrice: setup.entryPrice,
            target: takeProfit1,
            stop: stopLoss,
            direction: setup.direction as 'long' | 'short',
            momentumAlignment: setup.momentumAlignment,
            liquidityStrength: setup.liquidityStrength,
            atr: setup.atr,
            regime: setup.regime,
        });

        // Blended TP gain: 50% at TP1 net + 50% at TP2 net (matches outcome semantics)
        const blendedTpNet = 0.5 * effectiveTp1Net + 0.5 * effectiveTp2Net;

        const ev = ProbabilityModel.expectedValueMarginPct({
            probability: probResult.probability,
            tpGrossMarginPct: blendedTpNet,                 // already net of fees in our model
            slLossMarginPct: slMarginPct,
            feesMarginPct,
            slippageMarginPct,
        });

        const totalCost = feesMarginPct + slippageMarginPct;
        const evThreshold = totalCost * config.evMultiplier;

        if (ev.ev < evThreshold) {
            return {
                accepted: false,
                code: 'EV_NOT_POSITIVE',
                reason:
                    `EV ${ev.ev.toFixed(2)}% < threshold ${evThreshold.toFixed(2)}% margem ` +
                    `(p=${(probResult.probability * 100).toFixed(0)}%, fees+slip=${totalCost.toFixed(2)}%, blended TP=${blendedTpNet.toFixed(1)}%, SL=${slMarginPct.toFixed(1)}%). ` +
                    `Sem edge estatístico.`,
            };
        }

        // EV warnings (non-blocking but visible)
        if (probResult.calibration === 'heuristic') {
            warnings.push(`EV based on heuristic probability (${(probResult.probability * 100).toFixed(0)}%) — calibrate after ≥30 outcomes.`);
        }
        if (ev.ratio < 0.5) {
            warnings.push(`Edge thin: EV/cost ratio ${ev.ratio.toFixed(2)}. Pequenas mudanças de probability quebram o setup.`);
        }

        return {
            accepted: true,
            symbol: setup.symbol,
            direction: setup.direction,
            entryPrice: setup.entryPrice,
            stopLoss,
            stopLossPct: slFinalPct,
            stopLossMarginPct: slMarginPct,
            takeProfit1,
            takeProfit1Pct: tp1PricePct,
            takeProfit1MarginGross: tp1LiqUsed ? (tp1PricePct * leverage) : tp1GrossMargin,
            takeProfit1MarginNet: effectiveTp1NetFinal,
            takeProfit2,
            takeProfit2Pct: tp2PricePct,
            takeProfit2MarginGross: tp2GrossMargin,
            takeProfit2MarginNet: effectiveTp2Net,
            feesMarginPct,
            slippageMarginPct,
            breakEvenWinRate,
            tp1LiquiditySource: tp1LiqSource,
            tp1LiquidityUsed: tp1LiqUsed,
            tp1LiquidityConfidence: tp1LiqConfidence,
            tp1LiquidityLabel: tp1LiqLabel,
            probabilityHit: probResult.probability,
            expectedValueMarginPct: ev.ev,
            evCostRatio: ev.ratio,
            probabilityCalibration: probResult.calibration,
            evExplanation: probResult.explanation,
            leverage,
            positionSizeUsd,
            notionalUsd,
            confidence: setup.confidence,
            survivalScore,
            reason: setup.reason,
            warnings,
        };
    },

    /** Util pro UI: SL% recomendado por leverage. */
    targetSlPctForLeverage,

    /** Util pro UI: fees totais em % margem. */
    feesMarginPctFor(leverage: number, takerFeePct: number = DEFAULT_CONFIG.takerFeePct): number {
        return takerFeePct * 2 * leverage;
    },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function pctDistance(entry: number, target: number): number {
    if (entry <= 0) return 0;
    return Math.abs((target - entry) / entry) * 100;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}
