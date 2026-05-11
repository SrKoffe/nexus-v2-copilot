import React, { useState, useEffect } from 'react';
import { EventBus } from '../analysis/event-bus';
import { StateCache } from '../analysis/state-cache';
import { useNexusStore } from '../store';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * SETUP CHECKLIST — The "Should I take this trade?" panel.
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * Structured breakdown of every condition that must pass before a trade
 * is recommended. Each item is pass/warning/fail with explanation.
 */

type CheckStatus = 'pass' | 'warning' | 'fail';

interface CheckItem {
    label: string;
    status: CheckStatus;
    explanation: string;
}

interface ChecklistState {
    direction: 'LONG' | 'SHORT' | 'NONE';
    mode: string;
    confidence: number;
    score: number;
    items: CheckItem[];
    decision: 'STRONG SETUP' | 'CONDITIONAL' | 'NO TRADE';
}

const STATUS_ICON: Record<CheckStatus, string> = { pass: '✅', warning: '⚠️', fail: '❌' };
const STATUS_COLOR: Record<CheckStatus, string> = { pass: '#00ff88', warning: '#ffb800', fail: '#ff3366' };

const DECISION_STYLE: Record<string, { bg: string; border: string; color: string }> = {
    'STRONG SETUP': { bg: 'rgba(0,255,136,0.08)', border: '#00ff88', color: '#00ff88' },
    'CONDITIONAL': { bg: 'rgba(255,184,0,0.08)', border: '#ffb800', color: '#ffb800' },
    'NO TRADE': { bg: 'rgba(255,51,102,0.06)', border: '#ff3366', color: '#ff3366' },
};

function checkMarketRegime(marketRegime: string, marketRegimeConf: number, direction: 'LONG' | 'SHORT'): CheckItem {
    if (marketRegime === 'chaotic') {
        return {
            label: 'Market Regime',
            status: 'fail',
            explanation: `CHAOTIC regime — block trade. Confidence ${(marketRegimeConf * 100).toFixed(0)}%.`,
        };
    } else if (marketRegime === 'trend_up' && direction === 'SHORT') {
        return {
            label: 'Market Regime',
            status: 'warning',
            explanation: `Going SHORT against TREND_UP — counter-trend, only with strong reversal signal`,
        };
    } else if (marketRegime === 'trend_down' && direction === 'LONG') {
        return {
            label: 'Market Regime',
            status: 'warning',
            explanation: `Going LONG against TREND_DOWN — counter-trend, requires strong reversal`,
        };
    } else if (marketRegime === 'transition') {
        return {
            label: 'Market Regime',
            status: 'warning',
            explanation: `TRANSITION — no clear regime yet, expect lower edge`,
        };
    } else {
        return {
            label: 'Market Regime',
            status: 'pass',
            explanation: `${marketRegime.replace('_', ' ').toUpperCase()} aligned with ${direction} (${(marketRegimeConf * 100).toFixed(0)}%)`,
        };
    }
}

function checkSignalTriggered(confidence: number, mode: string): CheckItem {
    const fusionScore = confidence * 100;
    const threshold = mode === 'micro_scalp' ? 50 : mode === 'hybrid' ? 55 : 65;
    return {
        label: 'Signal Triggered',
        status: fusionScore >= threshold ? 'pass' : fusionScore >= threshold * 0.85 ? 'warning' : 'fail',
        explanation: `Score ${fusionScore.toFixed(0)}% ${fusionScore >= threshold ? '≥' : '<'} ${threshold}% (${mode})`,
    };
}

function checkProfitGate(takerFeePct: number, lev: number, tp1Net: number): CheckItem {
    const feePct = takerFeePct * 2 * lev;
    return {
        label: 'Profit Gate',
        status: tp1Net > feePct * 0.5 ? 'pass' : tp1Net > 0 ? 'warning' : 'fail',
        explanation: tp1Net > 0
            ? `TP1 net +${tp1Net.toFixed(1)}% > fees ${feePct.toFixed(1)}%`
            : `Expected PnL doesn't cover fees (${feePct.toFixed(1)}%)`,
    };
}

function checkVelocity(tpm: number, mode: string): CheckItem {
    const maxTpm = mode === 'micro_scalp' ? 5 : mode === 'hybrid' ? 2 : 1;
    return {
        label: 'Velocity OK',
        status: tpm < maxTpm ? 'pass' : tpm < maxTpm * 2 ? 'warning' : 'fail',
        explanation: `${tpm}/${maxTpm} trades/min${tpm >= maxTpm ? ' — throttling active' : ''}`,
    };
}

function checkDirectionBias(direction: 'LONG' | 'SHORT', adjDirection: string): CheckItem {
    const lastDir = StateCache.get('lastTradeDirection', null);
    const sameDir = !lastDir || (lastDir === adjDirection);
    return {
        label: 'Direction Bias',
        status: sameDir ? 'pass' : 'warning',
        explanation: sameDir ? `Aligned with ${direction} bias` : `Direction flip from ${lastDir?.toUpperCase()} — needs strong reversal`,
    };
}

function checkContextCondition(direction: 'LONG' | 'SHORT'): CheckItem {
    const poc = StateCache.get('currentPOC', 0) || StateCache.get('poc', 0);
    const vah = StateCache.get('currentVAH', 0) || StateCache.get('vah', 0);
    const val = StateCache.get('currentVAL', 0) || StateCache.get('val', 0);
    const price = StateCache.get('currentPrice', 0);
    const regime = StateCache.get('currentRegime', 'unknown');
    let ctxStatus: CheckStatus = 'pass';
    let ctxExplain = `Regime: ${regime}`;
    if (poc && price && Math.abs(price - poc) / price < 0.002) {
        ctxStatus = 'warning';
        ctxExplain = 'Near POC — high chop risk, reduce size';
    } else if (vah && price > vah) {
        ctxExplain = direction === 'SHORT' ? 'Above VAH — short bias ✓' : 'Above VAH — long against profile';
        ctxStatus = direction === 'SHORT' ? 'pass' : 'warning';
    } else if (val && price < val) {
        ctxExplain = direction === 'LONG' ? 'Below VAL — long bias ✓' : 'Below VAL — short against profile';
        ctxStatus = direction === 'LONG' ? 'pass' : 'warning';
    }
    return { label: 'Context Condition', status: ctxStatus, explanation: ctxExplain };
}

function checkAbsorption(direction: 'LONG' | 'SHORT'): CheckItem {
    const absorption = StateCache.get('lastAbsorption', null);
    if (absorption?.detected) {
        const absAligned = (direction === 'LONG' && absorption.mostRecent?.direction === 'selling_absorbed') ||
                          (direction === 'SHORT' && absorption.mostRecent?.direction === 'buying_absorbed');
        return {
            label: 'Absorption',
            status: absAligned ? 'pass' : 'warning',
            explanation: absAligned ? `${absorption.mostRecent?.direction} — confirms ${direction}` : 'Absorption opposes trade direction',
        };
    } else {
        return { label: 'Absorption', status: 'warning', explanation: 'No absorption detected' };
    }
}

function checkOBIDivergence(): CheckItem {
    const obi = StateCache.get('aggressiveImbalance', null);
    const bookObi = StateCache.get('bookImbalance', null);
    let obiStatus: CheckStatus = 'pass';
    let obiExplain = 'No divergence';
    if (obi?.detected && bookObi?.detected) {
        const tradeDir = obi.direction === 'buy_aggression' ? 'BUY' : 'SELL';
        const bookDir = bookObi.direction === 'buy_heavy' ? 'BUY' : 'SELL';
        if (tradeDir !== bookDir) {
            obiStatus = 'warning';
            obiExplain = `OBI Trade=${tradeDir} vs Book=${bookDir} — DIVERGENCE`;
        } else {
            obiExplain = `Trade + Book aligned: ${tradeDir}`;
        }
    }
    return { label: 'OBI Divergence', status: obiStatus, explanation: obiExplain };
}

function checkLiquidityTarget(liqUsed: boolean, liqSource: string | null, liqConf: number): CheckItem {
    if (liqUsed && liqSource) {
        return {
            label: 'Liquidity Target',
            status: liqConf >= 0.5 ? 'pass' : 'warning',
            explanation: `TP1 backed by ${liqSource} (${(liqConf * 100).toFixed(0)}% confidence)`,
        };
    } else {
        return {
            label: 'Liquidity Target',
            status: 'warning',
            explanation: 'No structural liquidity node — TP from margin-PnL model',
        };
    }
}

function buildChecklist(): ChecklistState {
    const store = useNexusStore.getState();
    const lev = store.leverage;
    const mode = store.operatingMode || 'swing_scalp';
    const pending = store.pendingSetup;
    const velocity = store.velocityState;
    const marketRegime = store.currentRegime;
    const marketRegimeConf = store.regimeConfidence;

    if (!pending || !pending.adjusted.accepted) {
        return { direction: 'NONE', mode, confidence: 0, score: 0, items: [], decision: 'NO TRADE' };
    }

    const adj = pending.adjusted as any;
    const direction: 'LONG' | 'SHORT' = adj.direction === 'long' ? 'LONG' : 'SHORT';
    const confidence = adj.confidence || 0;
    const fusionScore = confidence * 100;

    // Build individual checks
    const items: CheckItem[] = [
        checkMarketRegime(marketRegime, marketRegimeConf, direction),
        checkSignalTriggered(confidence, mode),
        checkProfitGate(store.takerFeePct || 0.04, lev, adj.takeProfit1MarginNet ?? 0),
        checkVelocity(velocity?.tradesPerMinute ?? 0, mode),
        checkDirectionBias(direction, adj.direction),
        checkContextCondition(direction),
        checkAbsorption(direction),
        checkOBIDivergence(),
        checkLiquidityTarget(adj.tp1LiquidityUsed ?? false, adj.tp1LiquiditySource ?? null, adj.tp1LiquidityConfidence ?? 0)
    ];

    // Compute decision
    const fails = items.filter(i => i.status === 'fail').length;
    const warnings = items.filter(i => i.status === 'warning').length;
    const decision = fails > 0 ? 'NO TRADE' : warnings >= 3 ? 'CONDITIONAL' : 'STRONG SETUP';

    return { direction, mode, confidence, score: fusionScore, items, decision };
}

export const SetupChecklist: React.FC = () => {
    const [state, setState] = useState<ChecklistState>(buildChecklist);
    const leverage = useNexusStore(s => s.leverage);
    const pending = useNexusStore(s => s.pendingSetup);
    const operatingMode = useNexusStore(s => s.operatingMode);

    useEffect(() => {
        setState(buildChecklist());
    }, [leverage, pending, operatingMode]);

    // Subscribe to analysis updates
    useEffect(() => {
        const refresh = () => setState(buildChecklist());
        EventBus.on('ANALYSIS_SIGNAL', refresh);
        EventBus.on('SCALP_SETUP', refresh);
        EventBus.on('REGIME_DETECTED', refresh);   // v5.1: refresh on regime change
        const interval = setInterval(refresh, 2000);
        return () => {
            EventBus.off('ANALYSIS_SIGNAL', refresh);
            EventBus.off('SCALP_SETUP', refresh);
            EventBus.off('REGIME_DETECTED', refresh);
            clearInterval(interval);
        };
    }, []);

    const ds = DECISION_STYLE[state.decision] || DECISION_STYLE['NO TRADE'];

    if (state.direction === 'NONE') {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '8px' }}>
                <span style={{ fontSize: '28px', opacity: 0.3 }}>⌖</span>
                <span className="text-sm" style={{ color: '#555' }}>Hunting targets...</span>
                <span className="mono text-xs" style={{ color: '#444' }}>{leverage}x · {operatingMode}</span>
            </div>
        );
    }

    const dirColor = state.direction === 'LONG' ? '#00ff88' : '#ff3366';
    const dirArrow = state.direction === 'LONG' ? '↑' : '↓';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', padding: '4px' }}>
            {/* Header: Direction + Mode */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: '18px', color: dirColor, fontWeight: 'bold' }}>
                    {dirArrow} {state.direction}
                </span>
                <span className="mono text-xs" style={{ color: '#8892b0' }}>
                    {state.mode} · {(state.confidence * 100).toFixed(0)}%
                </span>
            </div>

            {/* Checklist items */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', overflow: 'auto' }}>
                {state.items.map((item, i) => (
                    <div key={i} style={{
                        display: 'flex', alignItems: 'flex-start', gap: '8px',
                        padding: '6px 8px', borderRadius: '2px',
                        background: item.status === 'fail' ? 'rgba(255,51,102,0.05)' : 'rgba(255,255,255,0.02)',
                        borderLeft: `2px solid ${STATUS_COLOR[item.status]}`,
                    }}>
                        <span style={{ fontSize: '12px', flexShrink: 0 }}>{STATUS_ICON[item.status]}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: '#ddd' }}>{item.label}</div>
                            <div className="mono" style={{ fontSize: '10px', color: STATUS_COLOR[item.status], opacity: 0.85, wordBreak: 'break-word' }}>
                                {item.explanation}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Decision badge */}
            <div style={{
                textAlign: 'center', padding: '8px 12px', borderRadius: '2px',
                background: 'transparent', border: `1px solid ${ds.border}`,
                color: ds.color, fontWeight: 'bold', fontSize: '13px', letterSpacing: '1px',
            }}>
                {state.decision}
            </div>
        </div>
    );
};
