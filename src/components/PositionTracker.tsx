import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useNexusStore, type SetupHistoryEntry, type MexcPosition } from '../store';
import type { AdjustedSetup } from '../analysis/leverage-risk';

/**
 * PositionTracker — shows the active setup (the one Roberto marked as "I'm
 * taking this trade") and lets him mark the outcome when the trade completes.
 *
 * F6c: cross-checks against live MEXC positions to detect:
 *   - Setup marked active but no MEXC position open (forgot to execute? or already closed?)
 *   - MEXC position open with no setup marked (forgot to mark?)
 *   - Symbol/side mismatch between marked setup and MEXC reality
 */
export const PositionTracker: React.FC = () => {
    const active = useNexusStore(s => s.activeSetup);
    const markOutcome = useNexusStore(s => s.markOutcome);
    const clearActive = useNexusStore(s => s.clearActive);
    const mexcPositions = useNexusStore(s => s.openMexcPositions);
    const mexcConfigured = useNexusStore(s => s.mexcConfigured);

    // ─── State 1: no active setup ───
    if (!active || !active.adjusted.accepted) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#555',
                gap: '6px',
                padding: '8px',
            }}>
                {mexcPositions.length === 0 ? (
                    <>
                        <span className="text-sm">No active operation</span>
                        <span className="text-xs text-secondary" style={{ opacity: 0.5 }}>
                            Mark a setup as "taken" from the Setup card
                        </span>
                    </>
                ) : (
                    <>
                        <span style={{ color: '#ffaa00', fontSize: '13px', fontWeight: 'bold' }}>
                            ⚠ {mexcPositions.length} open on MEXC, none marked here
                        </span>
                        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                            {mexcPositions.map(p => <MexcPositionRow key={p.position_id} pos={p} />)}
                        </div>
                    </>
                )}
            </div>
        );
    }

    // ─── State 2: active setup ───
    const setup = active.adjusted as AdjustedSetup;
    const isLong = setup.direction === 'long';
    const accent = isLong ? '#00ff88' : '#ff4444';

    // Match logic: same symbol + same side
    const match = mexcPositions.find(p =>
        p.symbol === setup.symbol && p.side === setup.direction
    );
    const otherMexcPositions = mexcPositions.filter(p => p !== match);

    const onMark = async (outcome: SetupHistoryEntry['outcome'], pnlPct: number) => {
        markOutcome(outcome, pnlPct);
        if (!outcome) return;

        // F8: persist with full metadata for the weekly report
        try {
            await invoke('record_setup_outcome', {
                outcome: {
                    id: 0,                          // auto-incremented in SQLite
                    setup_id: `setup_${active.detectedAt}`,
                    symbol: setup.symbol,
                    direction: setup.direction,
                    leverage: setup.leverage,
                    confidence: setup.confidence,
                    classification: classifyForRecord(setup),
                    entry_price: setup.entryPrice,
                    stop_loss: setup.stopLoss,
                    take_profit_1: setup.takeProfit1,
                    take_profit_2: setup.takeProfit2,
                    outcome_label: outcome,
                    pnl_pct: pnlPct,                // %  margin (not fraction)
                    detected_at_ms: active.detectedAt,
                    closed_at_ms: Date.now(),
                },
            });
        } catch (e) {
            console.warn('[PositionTracker] record_setup_outcome failed:', e);
        }
    };

    /** Same logic as SetupCard's classify — duplicated locally to avoid coupling. */
    function classifyForRecord(s: AdjustedSetup): string {
        const c = s.confidence;
        const sv = s.survivalScore;
        const edge = c - s.breakEvenWinRate;
        if (c >= 0.75 && sv >= 0.85 && edge >= 0.15) return 'A+';
        if (c >= 0.65 && sv >= 0.80 && edge >= 0.05) return 'A';
        if (c >= 0.55 && sv >= 0.70 && edge >= 0.00) return 'B';
        return 'C';
    }

    // PnL margem (scalper model F7):
    //   TP* já são "net" (após fees) configurados no engine → usa direto
    //   SL = -(SL_margin% + fees) → perde stoploss e ainda paga fees na saída
    const tp1Pnl = +setup.takeProfit1MarginNet.toFixed(2);
    const tp2Pnl = +setup.takeProfit2MarginNet.toFixed(2);
    const slPnl = -(setup.stopLossMarginPct + setup.feesMarginPct);

    return (
        <div style={{ padding: '4px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ color: accent, fontWeight: 'bold', fontSize: '14px' }}>
                    {setup.symbol} {isLong ? 'LONG' : 'SHORT'}
                    <span style={{ fontSize: '11px', color: '#888', marginLeft: '8px' }}>{setup.leverage}x</span>
                </span>
                <span className="mono text-xs text-secondary">
                    {timeAgo(active.detectedAt)}
                </span>
            </div>

            {/* Match indicator (if MEXC keys configured) */}
            {mexcConfigured === true && (
                <MatchBadge match={match} setup={setup} />
            )}

            <div style={{
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '6px',
                padding: '8px 10px',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '12px',
            }}>
                <Row label="Entry" value={`$${setup.entryPrice.toFixed(1)}`} />
                <Row label="SL"  value={`$${setup.stopLoss.toFixed(1)}`} color="#ff4444" />
                <Row label="TP1" value={`$${setup.takeProfit1.toFixed(1)}`} color="#00ff88" />
                <Row label="TP2" value={`$${setup.takeProfit2.toFixed(1)}`} color="#00ff88" />
                {match && (
                    <>
                        <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0' }} />
                        <Row label="MEXC entry"  value={`$${match.entry_price.toFixed(1)}`} color="#88ccff" />
                        <Row label="MEXC mark"   value={`$${match.mark_price.toFixed(1)}`} color="#88ccff" />
                        <Row label="Live PnL"
                             value={`$${match.unrealized_pnl.toFixed(2)}`}
                             color={match.unrealized_pnl >= 0 ? '#00ff88' : '#ff4444'} />
                    </>
                )}
            </div>

            <div className="text-xs text-secondary" style={{ marginTop: '2px' }}>
                Outcome (clica quando fechar na MEXC):
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <OutcomeButton label={`✓ TP1  (+${tp1Pnl}%)`} color="#00ff88" onClick={() => onMark('tp1_hit', tp1Pnl)} />
                <OutcomeButton label={`✓✓ TP2  (+${tp2Pnl}%)`} color="#00ff88" onClick={() => onMark('tp2_hit', tp2Pnl)} />
                <OutcomeButton label={`✗ SL  (${slPnl.toFixed(2)}%)`} color="#ff4444" onClick={() => onMark('sl_hit', slPnl)} />
                <OutcomeButton
                    label="↩ Manual exit"
                    color="#aaa"
                    onClick={() => {
                        const txt = prompt('PnL % no fechamento manual? (ex: 0.8 ou -0.3)', '0');
                        const n = parseFloat(txt || '0');
                        if (!isFinite(n)) return;
                        onMark('manual_exit', +n.toFixed(2));
                    }}
                />
            </div>

            {/* Other MEXC positions (didn't match the active setup — could be unrelated trades) */}
            {otherMexcPositions.length > 0 && (
                <div style={{ marginTop: '4px' }}>
                    <div className="text-xs text-secondary" style={{ marginBottom: '4px', color: '#aaa' }}>
                        Other open MEXC:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {otherMexcPositions.map(p => <MexcPositionRow key={p.position_id} pos={p} compact />)}
                    </div>
                </div>
            )}

            <button
                onClick={() => {
                    if (confirm('Descartar este setup sem registrar outcome?')) {
                        clearActive();
                    }
                }}
                style={{
                    marginTop: 'auto',
                    background: 'transparent',
                    border: '1px solid #444',
                    color: '#666',
                    padding: '6px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '10px',
                    letterSpacing: '0.5px',
                }}
            >
                discard (no log)
            </button>
        </div>
    );
};

// ─── Match badge ────────────────────────────────────────────────────────────

const MatchBadge: React.FC<{ match: MexcPosition | undefined; setup: AdjustedSetup }> = ({ match, setup }) => {
    if (match) {
        const sameLev = match.leverage === setup.leverage;
        return (
            <div style={{
                background: 'rgba(0, 255, 136, 0.08)',
                border: '1px solid rgba(0, 255, 136, 0.3)',
                color: '#00ff88',
                padding: '6px 10px',
                borderRadius: '4px',
                fontSize: '11px',
            }}>
                ✓ MEXC position matched · {match.leverage}x{!sameLev && ` (you marked ${setup.leverage}x)`}
            </div>
        );
    }
    return (
        <div style={{
            background: 'rgba(255, 170, 0, 0.06)',
            border: '1px solid rgba(255, 170, 0, 0.25)',
            color: '#ffcc55',
            padding: '6px 10px',
            borderRadius: '4px',
            fontSize: '11px',
        }}>
            ⚠ No matching {setup.direction.toUpperCase()} {setup.symbol} on MEXC. Did you execute?
        </div>
    );
};

// ─── MEXC position row (for "other" or no-active states) ───────────────────

const MexcPositionRow: React.FC<{ pos: MexcPosition; compact?: boolean }> = ({ pos, compact }) => {
    const isLong = pos.side === 'long';
    const color = isLong ? '#00ff88' : '#ff4444';
    return (
        <div style={{
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '4px',
            padding: compact ? '4px 8px' : '6px 10px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '11px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
        }}>
            <span style={{ color, fontWeight: 'bold' }}>
                {pos.symbol} {isLong ? '↑' : '↓'} {pos.leverage}x
            </span>
            <span style={{ color: '#aaa' }}>${pos.entry_price.toFixed(1)} → ${pos.mark_price.toFixed(1)}</span>
            <span style={{
                color: pos.unrealized_pnl >= 0 ? '#00ff88' : '#ff4444',
                fontWeight: 'bold',
            }}>
                {pos.unrealized_pnl >= 0 ? '+' : ''}${pos.unrealized_pnl.toFixed(2)}
            </span>
        </div>
    );
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const Row: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = '#fff' }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
        <span style={{ color: '#888', fontSize: '11px' }}>{label}</span>
        <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
);

const OutcomeButton: React.FC<{ label: string; color: string; onClick: () => void }> = ({ label, color, onClick }) => (
    <button
        onClick={onClick}
        style={{
            background: `${color}10`,
            border: `1px solid ${color}50`,
            color,
            padding: '8px 4px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 600,
            fontFamily: 'JetBrains Mono, monospace',
            transition: 'all 0.15s',
        }}
    >
        {label}
    </button>
);

function timeAgo(ts: number): string {
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return `${Math.floor(diffSec / 3600)}h ago`;
}
