import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useNexusStore, type SetupHistoryEntry } from '../store';
import type { AdjustedSetup } from '../analysis/leverage-risk';

/**
 * PositionTracker — shows the active setup (the one Roberto marked as "I'm
 * taking this trade") and lets him mark the outcome when the trade completes.
 *
 * Co-pilot mode: we don't read positions from any exchange. We track the
 * setup as a logical "active operation". When Roberto closes manually on MEXC,
 * he comes back here and clicks the appropriate outcome button so the system
 * can learn over time.
 */
export const PositionTracker: React.FC = () => {
    const active = useNexusStore(s => s.activeSetup);
    const markOutcome = useNexusStore(s => s.markOutcome);
    const clearActive = useNexusStore(s => s.clearActive);

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
            }}>
                <span className="text-sm">No active operation</span>
                <span className="text-xs text-secondary" style={{ opacity: 0.5 }}>
                    Mark a setup as "taken" from the Setup card
                </span>
            </div>
        );
    }

    const setup = active.adjusted as AdjustedSetup;
    const isLong = setup.direction === 'long';
    const accent = isLong ? '#00ff88' : '#ff4444';

    const onMark = async (outcome: SetupHistoryEntry['outcome'], pnlPct: number) => {
        markOutcome(outcome, pnlPct);
        try {
            await invoke('record_trade_outcome', {
                outcome: {
                    id: `setup_${active.detectedAt}`,
                    pnl_pct: pnlPct / 100, // backend wants fraction, not percent
                    exit_price: 0,
                    timestamp: Date.now(),
                },
            });
        } catch (e) {
            console.warn('[PositionTracker] record_trade_outcome failed (UI-only fallback):', e);
        }
    };

    // PnL percentage relative to margin (1R = stopLossPct × leverage of margin)
    const r = setup.stopLossPct * setup.leverage;
    const tp1Pnl = +(r * 1.0).toFixed(2);    // 1R = 100% of margin risk gain
    const tp2Pnl = +(r * 2.0).toFixed(2);    // 2R
    const slPnl = -r;

    return (
        <div style={{ padding: '4px', display: 'flex', flexDirection: 'column', gap: '14px', height: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ color: accent, fontWeight: 'bold', fontSize: '14px' }}>
                    {setup.symbol} {isLong ? 'LONG' : 'SHORT'}
                    <span style={{ fontSize: '11px', color: '#888', marginLeft: '8px' }}>{setup.leverage}x</span>
                </span>
                <span className="mono text-xs text-secondary">
                    {timeAgo(active.detectedAt)}
                </span>
            </div>

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
            </div>

            <div className="text-xs text-secondary" style={{ marginTop: '4px' }}>
                Outcome (clica quando fechar na MEXC):
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <OutcomeButton
                    label={`✓ TP1  (+${tp1Pnl}%)`}
                    color="#00ff88"
                    onClick={() => onMark('tp1_hit', tp1Pnl)}
                />
                <OutcomeButton
                    label={`✓✓ TP2  (+${tp2Pnl}%)`}
                    color="#00ff88"
                    onClick={() => onMark('tp2_hit', tp2Pnl)}
                />
                <OutcomeButton
                    label={`✗ SL  (${slPnl.toFixed(2)}%)`}
                    color="#ff4444"
                    onClick={() => onMark('sl_hit', slPnl)}
                />
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
