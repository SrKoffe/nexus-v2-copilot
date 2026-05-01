import React, { useMemo } from 'react';
import { useNexusStore, computeRejectionCounts } from '../store';
import type { AdjustedSetup, RejectedSetup } from '../analysis/leverage-risk';

/**
 * SetupCard — replaces the old OrderPanel.
 *
 * Shows the most recent setup detected by Maestro, recomputed for the user's
 * selected leverage. NEVER places orders. Roberto reviews and decides; if he
 * trades it manually on MEXC, he hits "Mark as my trade" so the system can
 * later track outcome and refine.
 */
export const SetupCard: React.FC = () => {
    const pending = useNexusStore(s => s.pendingSetup);
    const leverage = useNexusStore(s => s.leverage);
    const balance = useNexusStore(s => s.balanceUsd);
    const markActive = useNexusStore(s => s.markPendingAsActive);
    const history = useNexusStore(s => s.history);

    // Computed locally with useMemo — avoids the "new object every render" infinite loop
    // that happens when a Zustand selector returns a fresh object.
    const rejectionCounts = useMemo(() => computeRejectionCounts(history), [history]);

    if (!pending) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#555',
                gap: '8px',
            }}>
                <span style={{ fontSize: '24px', opacity: 0.4 }}>⌖</span>
                <span className="text-sm">Watching markets — no setup yet</span>
                <span className="text-xs text-secondary">Leverage: {leverage}x · Balance: ${balance.toFixed(0)}</span>
                {Object.keys(rejectionCounts).length > 0 && (
                    <div className="mono text-xs" style={{ marginTop: '12px', textAlign: 'center', color: '#666' }}>
                        Rejected (session):
                        {Object.entries(rejectionCounts).map(([code, n]) => (
                            <div key={code}>· {n}× {code.toLowerCase().replace(/_/g, ' ')}</div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    if (!pending.adjusted.accepted) {
        return <RejectedView setup={pending.adjusted} naturalSymbol={pending.natural.symbol} />;
    }

    return <AcceptedView setup={pending.adjusted} onTake={markActive} />;
};

// ─── Accepted setup ─────────────────────────────────────────────────────────

const AcceptedView: React.FC<{ setup: AdjustedSetup; onTake: () => void }> = ({ setup, onTake }) => {
    const isLong = setup.direction === 'long';
    const accent = isLong ? '#00ff88' : '#ff4444';
    const dirLabel = isLong ? 'LONG' : 'SHORT';
    const dirArrow = isLong ? '↑' : '↓';

    const grade = classify(setup);

    return (
        <div style={{ padding: '8px 4px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }}>
            {/* Direction + grade */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: '20px', color: accent, fontWeight: 'bold', letterSpacing: '1px' }}>
                    {dirArrow} {dirLabel}
                </span>
                <span style={{
                    background: `${accent}1a`,
                    border: `1px solid ${accent}`,
                    color: accent,
                    padding: '3px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                }}>
                    {grade}
                </span>
            </div>

            {/* Symbol + leverage */}
            <div className="mono text-sm text-secondary" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{setup.symbol}</span>
                <span>{setup.leverage}x · conf {(setup.confidence * 100).toFixed(0)}%</span>
            </div>

            {/* Entry / SL / TP */}
            <div style={{
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '13px',
            }}>
                <Row label="Entry" value={`$${setup.entryPrice.toFixed(1)}`} color="#fff" />
                <Row label="SL"
                     value={`$${setup.stopLoss.toFixed(1)}  (-${setup.stopLossPct.toFixed(2)}%)`}
                     color="#ff4444" />
                <Row label="TP1 (1R, 50%)"
                     value={`$${setup.takeProfit1.toFixed(1)}  (+${setup.takeProfit1Pct.toFixed(2)}%)`}
                     color="#00ff88" />
                <Row label="TP2 (2R, 50%)"
                     value={`$${setup.takeProfit2.toFixed(1)}  (+${setup.takeProfit2Pct.toFixed(2)}%)`}
                     color="#00ff88" />
                <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '8px 0' }} />
                <Row label="RR" value={setup.rr.toFixed(2)} color="#fff" />
                <Row label="Survival"
                     value={`${(setup.survivalScore * 100).toFixed(0)}%`}
                     color={setup.survivalScore >= 0.85 ? '#00ff88' : '#ffaa00'} />
                <Row label="Margin"
                     value={`$${setup.positionSizeUsd.toFixed(2)} (notional $${setup.notionalUsd.toFixed(0)})`}
                     color="#aaa" />
            </div>

            {/* Reason */}
            <div className="text-xs text-secondary" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                {setup.reason}
            </div>

            {/* Warnings */}
            {setup.warnings.length > 0 && (
                <div style={{
                    background: 'rgba(255, 170, 0, 0.06)',
                    border: '1px solid rgba(255, 170, 0, 0.25)',
                    borderRadius: '4px',
                    padding: '6px 10px',
                    fontSize: '11px',
                    color: '#ffcc55',
                }}>
                    {setup.warnings.map((w, i) => (
                        <div key={i}>⚠ {w}</div>
                    ))}
                </div>
            )}

            {/* Actions */}
            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <button
                    onClick={onTake}
                    style={{
                        background: `linear-gradient(135deg, ${accent}33 0%, ${accent}10 100%)`,
                        border: `1px solid ${accent}`,
                        color: accent,
                        padding: '10px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '13px',
                        letterSpacing: '0.5px',
                    }}
                >
                    ✓ I'm taking this trade
                </button>
                <span className="text-xs text-secondary" style={{ textAlign: 'center', opacity: 0.5 }}>
                    Execute manually on MEXC, then mark outcome below
                </span>
            </div>
        </div>
    );
};

// ─── Rejected setup ─────────────────────────────────────────────────────────

const RejectedView: React.FC<{ setup: RejectedSetup; naturalSymbol: string }> = ({ setup, naturalSymbol }) => {
    return (
        <div style={{
            padding: '8px 4px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            height: '100%',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: '14px', color: '#888' }}>{naturalSymbol}</span>
                <span style={{
                    background: 'rgba(136,136,136,0.1)',
                    color: '#888',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    fontSize: '10px',
                    fontWeight: 'bold',
                }}>
                    REJECTED
                </span>
            </div>

            <div style={{
                background: 'rgba(255, 68, 68, 0.04)',
                border: '1px solid rgba(255, 68, 68, 0.15)',
                borderRadius: '6px',
                padding: '12px',
                fontSize: '12px',
                color: '#aaa',
            }}>
                <div style={{ color: '#ff7777', fontWeight: 'bold', marginBottom: '6px', fontSize: '11px', letterSpacing: '0.5px' }}>
                    {setup.code}
                </div>
                {setup.reason}
            </div>

            <div className="text-xs text-secondary" style={{ marginTop: 'auto', textAlign: 'center', opacity: 0.5 }}>
                Watching for next setup...
            </div>
        </div>
    );
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const Row: React.FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
        <span style={{ color: '#888', fontSize: '11px' }}>{label}</span>
        <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
);

function classify(setup: AdjustedSetup): string {
    const c = setup.confidence;
    const s = setup.survivalScore;
    if (c >= 0.75 && s >= 0.85 && setup.rr >= 2) return 'A+';
    if (c >= 0.65 && s >= 0.80) return 'A';
    if (c >= 0.55 && s >= 0.70) return 'B';
    return 'C';
}
