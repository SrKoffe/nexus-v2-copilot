/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LeverageAdjustedRiskEngine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Recebe um setup "natural" (entry + SL/TP baseados em estrutura) e a leverage
 * escolhida pelo usuário. Retorna o setup com SL/TP recalculados, position size
 * sugerido e survival score — ou REJEITA o setup se ele não for compatível com
 * a leverage.
 *
 * Princípios:
 *   1. Survival > Profit. Em dúvida, recusa.
 *   2. SL nunca pode ficar acima de suporte estrutural (LONG) ou abaixo de
 *      resistência (SHORT). Se ajustar invalida estrutura → REJECT.
 *   3. RR < 1.5 = REJECT.
 *   4. Survival < 0.7 = REJECT.
 *   5. Nunca distorce estrutura pra "caber" na leverage.
 */

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type Direction = 'long' | 'short' | 'neutral';

export interface NaturalSetup {
    /** Símbolo (BTC_USDT) */
    symbol: string;
    /** Direção sugerida pela análise */
    direction: Direction;
    /** Preço de entrada (mid ou último tick) */
    entryPrice: number;
    /** SL em valor absoluto (preço), conforme estrutura natural detectada */
    naturalStopLoss: number;
    /** TP em valor absoluto (preço), conforme estrutura natural detectada */
    naturalTakeProfit: number;
    /** Confidence da análise (0..1) */
    confidence: number;
    /** Razão textual ("Institutional Confluence", "Liquidity Sweep", etc) */
    reason: string;
}

export interface AdjustedSetup {
    accepted: true;
    symbol: string;
    direction: Direction;
    entryPrice: number;
    /** SL ajustado (preço absoluto) */
    stopLoss: number;
    /** SL como percentual do entryPrice */
    stopLossPct: number;
    /** TP1 (preço absoluto) — 1R = 1× SL distance */
    takeProfit1: number;
    /** TP1 como percentual */
    takeProfit1Pct: number;
    /** TP2 (preço absoluto) — 2R */
    takeProfit2: number;
    /** TP2 como percentual */
    takeProfit2Pct: number;
    /** Risk-Reward final (TP2 / SL) */
    rr: number;
    /** Leverage que o usuário escolheu */
    leverage: number;
    /** Position size USD (margin a usar) */
    positionSizeUsd: number;
    /** Notional USD (size × leverage) */
    notionalUsd: number;
    /** Confidence original da análise */
    confidence: number;
    /** Survival score 0..1 — mede folga até liquidação */
    survivalScore: number;
    /** Razão textual */
    reason: string;
    /** Avisos não-bloqueantes */
    warnings: string[];
}

export interface RejectedSetup {
    accepted: false;
    reason: string;
    /** Código curto para classificação no histórico */
    code:
        | 'SL_TOO_TIGHT_FOR_STRUCTURE'
        | 'RR_TOO_LOW'
        | 'SURVIVAL_TOO_LOW'
        | 'CONFIDENCE_TOO_LOW'
        | 'INVALID_INPUT';
}

export type SetupResult = AdjustedSetup | RejectedSetup;

// ─── Configuração ──────────────────────────────────────────────────────────

export interface LeverageRiskConfig {
    /** Mínima confidence aceitável (0..1). Default: 0.55 */
    minConfidence: number;
    /** RR mínimo aceitável. Default: 1.5 */
    minRR: number;
    /** Survival score mínimo aceitável (0..1). Default: 0.7 */
    minSurvival: number;
    /** Risco por trade como fração do balance. Default: 0.01 (1%) */
    riskPerTrade: number;
    /** Margem de segurança até liquidação (0..1). Default: 0.4 (= SL fica em 60% da distância pra liq) */
    liquidationSafetyMargin: number;
    /** MEXC liquida ~85% do colateral. Default: 0.85 */
    mexcLiquidationFraction: number;
    /** Tolerância pra SL ajustado violar estrutura (fração da distância natural). Default: 0.30 */
    structureTolerance: number;
}

export const DEFAULT_CONFIG: LeverageRiskConfig = {
    minConfidence: 0.55,
    minRR: 1.5,
    minSurvival: 0.7,
    riskPerTrade: 0.01,
    liquidationSafetyMargin: 0.4,
    mexcLiquidationFraction: 0.85,
    structureTolerance: 0.30,
};

// ─── Tabela de SL alvo por leverage ────────────────────────────────────────

/**
 * Para cada leverage, qual SL% MÁXIMO o sistema recomenda.
 * Baseado no design doc §3.1. Quanto maior leverage, mais apertado o SL relativo.
 */
function targetSlPctForLeverage(leverage: number): number {
    if (leverage <= 25) return 1.5;   // x10-x25: SL até 1.5%
    if (leverage <= 50) return 0.9;   // x50: SL até 0.9%
    if (leverage <= 100) return 0.45; // x100: SL até 0.45%
    if (leverage <= 200) return 0.25; // x200: SL até 0.25%
    return 0.15;                       // x500: SL até 0.15%
}

// ─── Engine ────────────────────────────────────────────────────────────────

export const LeverageAdjustedRiskEngine = {

    /**
     * Recebe setup natural + leverage + balance. Retorna setup ajustado ou
     * objeto de rejeição com motivo.
     */
    adjust(
        setup: NaturalSetup,
        leverage: number,
        balanceUsd: number,
        config: LeverageRiskConfig = DEFAULT_CONFIG
    ): SetupResult {
        // ─── Validação básica ───
        if (!setup || !setup.entryPrice || setup.direction === 'neutral') {
            return {
                accepted: false,
                code: 'INVALID_INPUT',
                reason: 'Setup neutral or missing entry price',
            };
        }
        if (leverage <= 0 || leverage > 500) {
            return {
                accepted: false,
                code: 'INVALID_INPUT',
                reason: `Invalid leverage: ${leverage} (allowed 1..500)`,
            };
        }
        if (setup.confidence < config.minConfidence) {
            return {
                accepted: false,
                code: 'CONFIDENCE_TOO_LOW',
                reason: `Confidence ${(setup.confidence * 100).toFixed(0)}% < min ${(config.minConfidence * 100).toFixed(0)}%`,
            };
        }

        const isLong = setup.direction === 'long';

        // Distâncias naturais (em % do entry)
        const naturalSlPct = pctDistance(setup.entryPrice, setup.naturalStopLoss);
        const naturalTpPct = pctDistance(setup.entryPrice, setup.naturalTakeProfit);

        if (naturalSlPct <= 0 || naturalTpPct <= 0) {
            return {
                accepted: false,
                code: 'INVALID_INPUT',
                reason: 'Natural SL or TP equals entry price',
            };
        }

        // ─── 1. RR check no setup natural (antes de ajuste) ───
        const naturalRr = naturalTpPct / naturalSlPct;
        if (naturalRr < config.minRR) {
            return {
                accepted: false,
                code: 'RR_TOO_LOW',
                reason: `Natural RR ${naturalRr.toFixed(2)} < ${config.minRR}`,
            };
        }

        // ─── 2. SL alvo conforme leverage ───
        const targetSlPct = Math.min(naturalSlPct, targetSlPctForLeverage(leverage));

        // ─── 3. Distância segura até liquidação ───
        // MEXC liquida quando perda atinge ~85% do margin. Em leverage L, isso
        // equivale a um movimento adverso de (0.85 / L) × 100 % do preço.
        const liqDistancePct = (config.mexcLiquidationFraction / leverage) * 100;
        // Manter SL em (1 - safety) × liqDistance (default 60% da distância pra liq)
        const slMaxSafePct = liqDistancePct * (1 - config.liquidationSafetyMargin);

        const slFinalPct = Math.min(targetSlPct, slMaxSafePct);

        // ─── 4. Estrutura: SL ajustado não pode ficar muito mais perto que o natural ───
        // Se o ajuste por leverage fez o SL ficar < (1 - tolerance) × natural,
        // significa "stop hunt zone" — REJECT.
        const slShrinkRatio = slFinalPct / naturalSlPct;
        if (slShrinkRatio < (1 - config.structureTolerance)) {
            return {
                accepted: false,
                code: 'SL_TOO_TIGHT_FOR_STRUCTURE',
                reason:
                    `Leverage ${leverage}x exige SL ${slFinalPct.toFixed(2)}% mas estrutura natural ` +
                    `pede ${naturalSlPct.toFixed(2)}% (shrink ${(slShrinkRatio * 100).toFixed(0)}% < ` +
                    `${((1 - config.structureTolerance) * 100).toFixed(0)}%) — provável stop hunt`,
            };
        }

        // ─── 5. Survival score ───
        // Folga entre SL e liquidação, normalizada. Quanto maior, mais saudável.
        // 1.0 = SL na metade da distância pra liq. < 0.5 = SL muito próximo da liq.
        const survivalScore = clamp(1 - slFinalPct / liqDistancePct, 0, 1);

        if (survivalScore < config.minSurvival) {
            return {
                accepted: false,
                code: 'SURVIVAL_TOO_LOW',
                reason:
                    `Survival ${(survivalScore * 100).toFixed(0)}% < ${(config.minSurvival * 100).toFixed(0)}%. ` +
                    `SL ${slFinalPct.toFixed(2)}% vs liquidação a ${liqDistancePct.toFixed(2)}%`,
            };
        }

        // ─── 6. TPs em múltiplos de R ───
        const tp1Pct = slFinalPct * 1.0;  // 1R
        const tp2Pct = slFinalPct * 2.0;  // 2R

        // RR final (TP2 / SL = 2). Mantemos check formal aqui também.
        const finalRr = tp2Pct / slFinalPct;
        if (finalRr < config.minRR) {
            return {
                accepted: false,
                code: 'RR_TOO_LOW',
                reason: `Final RR ${finalRr.toFixed(2)} < ${config.minRR}`,
            };
        }

        // ─── 7. Position sizing (1% risk per trade) ───
        const riskAmountUsd = balanceUsd * config.riskPerTrade;
        const positionSizeUsd = (riskAmountUsd / slFinalPct) * 100; // margin
        const notionalUsd = positionSizeUsd * leverage;

        // ─── 8. Converter percentuais em preços absolutos ───
        const dirSign = isLong ? -1 : 1;  // SL fica abaixo pra LONG, acima pra SHORT
        const stopLoss = setup.entryPrice * (1 + dirSign * (slFinalPct / 100));
        const takeProfit1 = setup.entryPrice * (1 - dirSign * (tp1Pct / 100));
        const takeProfit2 = setup.entryPrice * (1 - dirSign * (tp2Pct / 100));

        // ─── 9. Warnings (não-bloqueantes) ───
        const warnings: string[] = [];
        if (leverage >= 100) {
            warnings.push(`Leverage ${leverage}x — qualquer ruído de 0.5%+ liquida.`);
        }
        if (slFinalPct < naturalSlPct * 0.85) {
            warnings.push(
                `SL apertado vs estrutura (${slFinalPct.toFixed(2)}% vs ${naturalSlPct.toFixed(2)}% natural). ` +
                `Aumenta chance de stop hunt.`
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
            takeProfit1,
            takeProfit1Pct: tp1Pct,
            takeProfit2,
            takeProfit2Pct: tp2Pct,
            rr: finalRr,
            leverage,
            positionSizeUsd,
            notionalUsd,
            confidence: setup.confidence,
            survivalScore,
            reason: setup.reason,
            warnings,
        };
    },

    /** Mostrar SL% recomendado por leverage (utilitário pro UI). */
    targetSlPctForLeverage,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function pctDistance(entry: number, target: number): number {
    if (entry <= 0) return 0;
    return Math.abs((target - entry) / entry) * 100;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

// ─── Sanity tests (rodam só em dev, comentar pra produção) ──────────────────
// Simples checks pra evitar regressões enquanto desenvolvemos.
// Pra rodar: `import './leverage-risk.ts'` e ver console.

if (typeof window !== 'undefined' && (window as any).__NEXUS_RISK_TEST__) {
    const t1 = LeverageAdjustedRiskEngine.adjust(
        {
            symbol: 'BTC_USDT',
            direction: 'long',
            entryPrice: 65000,
            naturalStopLoss: 64675,   // ~0.5% abaixo
            naturalTakeProfit: 65975, // ~1.5% acima
            confidence: 0.75,
            reason: 'test',
        },
        25,
        1000,
    );
    console.log('[risk-test] x25 long:', t1);

    const t2 = LeverageAdjustedRiskEngine.adjust(
        {
            symbol: 'BTC_USDT',
            direction: 'long',
            entryPrice: 65000,
            naturalStopLoss: 63700,   // ~2% abaixo
            naturalTakeProfit: 66950, // ~3% acima
            confidence: 0.75,
            reason: 'test',
        },
        100,
        1000,
    );
    console.log('[risk-test] x100 long with 2% natural SL:', t2);
}
