/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LeverageAdjustedRiskEngine — SCALPER MODEL (margin-PnL targets)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Roberto's mental model (refatorado em F7):
 *
 *   "Quanto maior a leverage, menor o TP em distância de preço.
 *    O alvo é uma % FIXA de PnL líquido sobre a margem (3-10%) depois de fees."
 *
 * Isso muda fundamentalmente o cálculo:
 *
 * ─ ANTES (R-multiples):  TP = 1× ou 2× distância do SL
 *                          → em x100 com SL 0.45%, TP = 0.9% (90% margem) — swing-style
 *
 * ─ AGORA (margin-PnL):    TP = (target_net + fees) / leverage
 *                          → em x100 com TP_net 3%, TP = 0.11% (3% líquido) — scalp-style
 *
 * Em scalping de alta-leverage, RR convencional ≥ 1.5 não se aplica. O
 * profit factor vem do WIN RATE, não da magnitude individual. Por isso
 * removemos o `minRR` gate — ele rejeitaria todo setup válido nesse modelo.
 *
 * O sistema agora mostra o BREAK-EVEN win rate pra cada setup (a porcentagem
 * mínima de wins que torna o setup lucrativo dado o RR efetivo). Isso dá
 * transparência total — Roberto vê se a confidence prevista cobre o WR
 * necessário.
 */

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

    /**
     * Break-even win rate (0..1): com SL atual e TP2 atual, qual % de wins
     * é necessária pra o sistema ficar no zero. Valores acima da confidence
     * média = sinal de alerta.
     */
    breakEvenWinRate: number;

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
        | 'NEGATIVE_NET_PROFIT';
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
};

// ─── Tabela de SL alvo por leverage (mantida do modelo anterior) ───────────

function targetSlPctForLeverage(leverage: number): number {
    if (leverage <= 25) return 1.5;   // x10-x25: SL até 1.5%
    if (leverage <= 50) return 0.9;
    if (leverage <= 100) return 0.45;
    if (leverage <= 200) return 0.25;
    return 0.15;
}

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

        // ─── 5. TPs no modelo scalper (margin-PnL) ───
        // TP gross margin = target_net + fees → TP price move = gross / leverage
        const tp1GrossMargin = config.tp1TargetNetMarginPct + feesMarginPct;
        const tp2GrossMargin = config.tp2TargetNetMarginPct + feesMarginPct;

        // Sanity: target net não pode ser negativo (fees > target)
        if (config.tp1TargetNetMarginPct <= 0 || config.tp2TargetNetMarginPct <= 0) {
            return {
                accepted: false,
                code: 'NEGATIVE_NET_PROFIT',
                reason: `TP net targets must be positive (got tp1=${config.tp1TargetNetMarginPct}%, tp2=${config.tp2TargetNetMarginPct}%)`,
            };
        }

        const tp1PricePct = tp1GrossMargin / leverage;
        const tp2PricePct = tp2GrossMargin / leverage;

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

        // ─── 7. Break-even win rate ───
        // Em parcial 50/50 (TP1 50%, TP2 50%):
        //   E[win] = 0.5 × tp1_net + 0.5 × tp2_net
        //   E[loss] = sl_margin + fees_margin (SL hit também paga fees)
        //   Breakeven WR: WR × E[win] = (1-WR) × E[loss]
        //              → WR = E[loss] / (E[win] + E[loss])
        const expectedWin = 0.5 * config.tp1TargetNetMarginPct + 0.5 * config.tp2TargetNetMarginPct;
        const expectedLoss = slMarginPct + feesMarginPct;
        const breakEvenWinRate = expectedLoss / (expectedWin + expectedLoss);

        // ─── 8. Converter em preços ───
        const dirSign = isLong ? -1 : 1;
        const stopLoss   = setup.entryPrice * (1 + dirSign * (slFinalPct / 100));
        const takeProfit1 = setup.entryPrice * (1 - dirSign * (tp1PricePct / 100));
        const takeProfit2 = setup.entryPrice * (1 - dirSign * (tp2PricePct / 100));

        // ─── 9. Position sizing ───
        const riskAmountUsd = balanceUsd * config.riskPerTrade;
        const positionSizeUsd = (riskAmountUsd / slFinalPct) * 100;
        const notionalUsd = positionSizeUsd * leverage;

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
        if (feesMarginPct > config.tp1TargetNetMarginPct) {
            warnings.push(
                `Fees (${feesMarginPct.toFixed(1)}% margem) > TP1 net (${config.tp1TargetNetMarginPct}%). ` +
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
            takeProfit1MarginGross: tp1GrossMargin,
            takeProfit1MarginNet: config.tp1TargetNetMarginPct,
            takeProfit2,
            takeProfit2Pct: tp2PricePct,
            takeProfit2MarginGross: tp2GrossMargin,
            takeProfit2MarginNet: config.tp2TargetNetMarginPct,
            feesMarginPct,
            breakEvenWinRate,
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
