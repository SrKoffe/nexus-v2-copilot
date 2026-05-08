import React from 'react';
import { useNexusStore, useScannerStore } from '../store';
import type { AdjustedSetup, RejectedSetup } from '../analysis/leverage-risk';

/**
 * SetupCard — single decision interface (v5 redesign).
 *
 * Three states:
 *   1. Idle / pipeline running    — waiting for setup
 *   2. Accepted setup             — Entry/Target/Stop + EV details + take button
 *   3. Rejected setup             — show why so trader learns
 */
export const SetupCard: React.FC = () => {
    const pendingSetup = useNexusStore(s => s.pendingSetup);
    const pipelineStatus = useNexusStore(s => s.pipelineStatus);
    const pipelineStage = useNexusStore(s => s.pipelineStage);
    const markActive = useNexusStore(s => s.markPendingAsActive);

    // ─── Empty / pipeline running — v6.3 active scanner-aware idle state ───
    if (!pendingSetup) {
        return <ActiveIdleView pipelineStage={pipelineStage} pipelineStatus={pipelineStatus} />;
    }

    // ─── Rejected setup (still informative) ───
    if (!pendingSetup.adjusted.accepted) {
        return <RejectedView rejected={pendingSetup.adjusted} naturalSymbol={pendingSetup.natural.symbol} />;
    }

    // ─── Accepted setup ───
    const setup = pendingSetup.adjusted as AdjustedSetup;
    const isLong = setup.direction === 'long';
    const tier = setup.tier || 'C';
    const tierColor = tier === 'A+' ? '#00e1ff' : tier === 'A' ? '#00ff88' : tier === 'B' ? '#ffb800' : '#ff3366';

    const color = isLong ? '#00e1ff' : '#ff3366';

    const evColor =
        setup.expectedValueMarginPct > 0 ? '#00ff88' :
        setup.expectedValueMarginPct > -1 ? '#ffaa00' : '#ff3366';

    const ratioColor =
        setup.evCostRatio >= 1 ? '#00ff88' :
        setup.evCostRatio >= 0.3 ? '#ffaa00' : '#ff4444';

    return (
        <div style={{
            background: 'rgba(10,15,25,0.6)',
            border: `1px solid ${color}50`,
            borderRadius: '8px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
        }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span className="mono" style={{ color, fontWeight: 'bold', fontSize: '1.2rem' }}>
                        {isLong ? '↑ LONG' : '↓ SHORT'} {setup.symbol}
                    </span>
                    <span style={{
                        background: `${tierColor}22`,
                        color: tierColor,
                        border: `1px solid ${tierColor}66`,
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        fontWeight: 'bold',
                        marginLeft: '8px'
                    }}>
                        Tier {tier}
                    </span>
                </div>
                <span className="mono text-xs" style={{ background: `${color}20`, padding: '4px 8px', borderRadius: '4px', color }}>
                    CONF: {(setup.confidence * 100).toFixed(0)}% · {setup.leverage}x
                </span>
            </div>

            {/* Entry / Target / Stop — 3-col grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '4px' }}>
                    <div className="text-secondary mono text-xs">ENTRY</div>
                    <div className="mono text-md" style={{ color: '#fff' }}>${setup.entryPrice.toFixed(1)}</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '4px' }}>
                    <div className="text-secondary mono text-xs" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        TARGET (TP1 50%)
                        {setup.tp1LiquidityUsed && (
                            <span style={{
                                background: 'rgba(0, 225, 255, 0.15)',
                                color: '#00e1ff',
                                padding: '1px 5px',
                                borderRadius: '3px',
                                fontSize: '8px',
                                fontWeight: 'bold',
                                letterSpacing: '0.3px',
                            }}>
                                📍 {setup.tp1LiquiditySource}
                            </span>
                        )}
                    </div>
                    <div className="mono text-md" style={{ color: '#00e1ff' }}>${setup.takeProfit1.toFixed(1)}</div>
                    <div className="mono text-xs" style={{ color: '#00e1ff' }}>
                        +{setup.takeProfit1Pct.toFixed(3)}% · +{typeof setup.takeProfit1MarginNet === 'number' ? setup.takeProfit1MarginNet.toFixed(1) : setup.takeProfit1MarginNet}% margem net
                    </div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '4px' }}>
                    <div className="text-secondary mono text-xs">STOP LOSS</div>
                    <div className="mono text-md" style={{ color: '#ff3366' }}>${setup.stopLoss.toFixed(1)}</div>
                    <div className="mono text-xs" style={{ color: '#ff3366' }}>
                        -{setup.stopLossPct.toFixed(2)}% · -{setup.stopLossMarginPct.toFixed(0)}% margem
                    </div>
                </div>
            </div>

            {/* EV section (v5.2) */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr 1fr',
                gap: '8px',
                padding: '10px',
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.04)',
                borderRadius: '4px',
            }}>
                <Stat
                    label="P(hit)"
                    value={`${(setup.probabilityHit * 100).toFixed(0)}%`}
                    sub={setup.probabilityCalibration === 'fitted' ? 'fitted' : 'heuristic'}
                    subColor={setup.probabilityCalibration === 'fitted' ? '#00e1ff' : '#ffaa00'}
                />
                <Stat
                    label="EV"
                    value={`${setup.expectedValueMarginPct >= 0 ? '+' : ''}${setup.expectedValueMarginPct.toFixed(2)}%`}
                    valueColor={evColor}
                    sub="margem"
                />
                <Stat
                    label="EV/Cost"
                    value={`${setup.evCostRatio.toFixed(2)}×`}
                    valueColor={ratioColor}
                    sub={setup.evCostRatio >= 1 ? 'strong edge' : setup.evCostRatio >= 0.3 ? 'thin edge' : 'razor'}
                />
                <Stat
                    label="Fees+Slip"
                    value={`-${(setup.feesMarginPct + setup.slippageMarginPct).toFixed(2)}%`}
                    sub="round-trip"
                    valueColor="#ffaa00"
                />
            </div>

            {/* Probability explanation tooltip-like row */}
            {setup.evExplanation && (
                <div style={{
                    background: 'rgba(0, 225, 255, 0.04)',
                    border: '1px solid rgba(0, 225, 255, 0.15)',
                    borderRadius: '4px',
                    padding: '6px 10px',
                    fontSize: '10px',
                    color: '#88ccdd',
                    fontFamily: 'JetBrains Mono, monospace',
                }}>
                    {setup.evExplanation}
                </div>
            )}

            {/* Liquidity Target reasoning (v5.2e) */}
            {setup.tp1LiquidityUsed && setup.tp1LiquidityLabel && (
                <div style={{
                    background: 'rgba(0, 225, 255, 0.06)',
                    border: '1px solid rgba(0, 225, 255, 0.20)',
                    borderRadius: '4px',
                    padding: '6px 10px',
                    fontSize: '10px',
                    color: '#99ddee',
                    fontFamily: 'JetBrains Mono, monospace',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                }}>
                    <span style={{ fontSize: '12px' }}>📍</span>
                    <span>
                        Liquidity target: {setup.tp1LiquidityLabel}
                        {setup.tp1LiquidityConfidence > 0 && (
                            <span style={{
                                color: setup.tp1LiquidityConfidence >= 0.6 ? '#00ff88' : '#ffaa00',
                                marginLeft: '6px',
                            }}>
                                ({(setup.tp1LiquidityConfidence * 100).toFixed(0)}% confidence)
                            </span>
                        )}
                    </span>
                </div>
            )}
            {!setup.tp1LiquidityUsed && (
                <div style={{
                    background: 'rgba(255, 170, 0, 0.04)',
                    border: '1px solid rgba(255, 170, 0, 0.10)',
                    borderRadius: '4px',
                    padding: '5px 10px',
                    fontSize: '9px',
                    color: '#998866',
                    fontFamily: 'JetBrains Mono, monospace',
                }}>
                    TP from margin-PnL model (no liquidity node met dual-gate)
                </div>
            )}

            {/* Warnings */}
            {setup.warnings.length > 0 && (
                <div style={{
                    background: 'rgba(255, 170, 0, 0.06)',
                    border: '1px solid rgba(255, 170, 0, 0.25)',
                    borderRadius: '4px',
                    padding: '6px 10px',
                    fontSize: '10px',
                    color: '#ffcc55',
                    fontFamily: 'JetBrains Mono, monospace',
                }}>
                    {setup.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
            )}

            {/* Footer info */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '10px' }} className="text-secondary">
                <span className="mono">
                    Survival: <span style={{ color: setup.survivalScore >= 0.85 ? '#00ff88' : '#ffaa00' }}>{(setup.survivalScore * 100).toFixed(0)}%</span>
                </span>
                <span className="mono">
                    BE WR: <span style={{ color: setup.breakEvenWinRate <= setup.confidence ? '#00ff88' : '#ff4444' }}>{(setup.breakEvenWinRate * 100).toFixed(0)}%</span>
                </span>
                <span className="mono">
                    Margin: <span style={{ color: '#aaa' }}>${setup.positionSizeUsd.toFixed(2)}</span>
                </span>
            </div>

            {/* Take button — co-pilot mode: marks setup as active, never sends order */}
            <button
                onClick={markActive}
                style={{
                    background: `linear-gradient(135deg, ${color}33 0%, ${color}10 100%)`,
                    color,
                    border: `1px solid ${color}`,
                    padding: '10px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: '13px',
                    letterSpacing: '0.5px',
                    marginTop: '4px',
                }}
            >
                ✓ I'M TAKING THIS TRADE
            </button>
            <span className="text-xs text-secondary" style={{ textAlign: 'center', opacity: 0.5, fontSize: '9px' }}>
                Execute manually on MEXC, then mark outcome in Active Operation
            </span>
        </div>
    );
};

// ─── Active idle view (v6.3) ──────────────────────────────────────────────
// Sistema NUNCA parece morto. Mostra contagem ao vivo do scanner pra dar
// sensação de atividade contínua mesmo sem setup confirmado.

const ActiveIdleView: React.FC<{
    pipelineStage: number;
    pipelineStatus: string;
}> = ({ pipelineStage, pipelineStatus }) => {
    const universeCount = useScannerStore(s => s.universe.length);
    const topCandidates = useScannerStore(s => s.topCandidates);
    const lastUpdateMs = useScannerStore(s => s.lastUpdateMs);
    const currentRegime = useNexusStore(s => s.currentRegime);

    // Buckets úteis ao trader, derivados em <1ms
    const highScore = topCandidates.filter(t => t.opportunity_score > 30).length;

    const ageSec = lastUpdateMs > 0 ? Math.floor((Date.now() - lastUpdateMs) / 1000) : null;
    const stale = ageSec !== null && ageSec > 5;

    const isEvaluating = pipelineStage > 0 && pipelineStage < 5 && pipelineStatus === 'evaluating';

    return (
        <div style={{
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            color: '#8892b0',
            fontFamily: 'JetBrains Mono, monospace',
        }}>
            {/* Pulse + status line */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: stale ? '#ff7777' : '#00e1ff',
                    boxShadow: stale ? '0 0 6px #ff777755' : '0 0 8px #00e1ff80',
                    animation: stale ? undefined : 'idle-pulse 1.6s ease-in-out infinite',
                }} />
                <span style={{ fontSize: '12px', fontWeight: 600, letterSpacing: '0.5px', color: '#ddd' }}>
                    {isEvaluating
                        ? `Pipeline L${pipelineStage} evaluating…`
                        : universeCount === 0
                            ? 'Connecting to scanner…'
                            : `Scanning ${universeCount} markets...`}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '9px', color: stale ? '#ff7777' : '#666' }}>
                    {ageSec !== null ? `${ageSec}s ago` : '—'}
                </span>
            </div>

            {/* Live counters */}
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                padding: '10px 12px',
                background: 'rgba(0, 225, 255, 0.04)',
                border: '1px solid rgba(0, 225, 255, 0.12)',
                borderRadius: '6px',
                fontSize: '11px',
            }}>
                <div style={{ color: '#00e1ff' }}>{topCandidates.filter(t => t.opportunity_score > 20).length} liquidity imbalances detected</div>
                <div style={{ color: '#00ff88' }}>{topCandidates.length} ranked opportunities</div>
                <div style={{ color: '#ffb800' }}>{highScore} high-EV setups</div>
            </div>

            {/* Top 3 preview line */}
            {topCandidates.length > 0 && (
                <div style={{
                    fontSize: '10px',
                    color: '#666',
                    padding: '8px 12px',
                    background: 'rgba(0,0,0,0.25)',
                    borderRadius: '4px',
                    border: '1px solid rgba(255,255,255,0.04)',
                }}>
                    <span style={{ color: '#888', letterSpacing: '0.5px' }}>TOP 3 ·</span>{' '}
                    {topCandidates.slice(0, 3).map((c, i) => (
                        <span key={c.symbol} style={{ marginRight: '10px' }}>
                            <span style={{ color: '#ddd' }}>{c.symbol.replace('_USDT', '')}</span>
                            <span style={{
                                color: c.rise_fall_rate >= 0 ? '#00ff88' : '#ff3366',
                                marginLeft: '4px',
                                fontSize: '9px',
                            }}>
                                {c.rise_fall_rate >= 0 ? '+' : ''}{(c.rise_fall_rate * 100).toFixed(1)}%
                            </span>
                            {i < 2 && <span style={{ color: '#444', marginLeft: '8px' }}>·</span>}
                        </span>
                    ))}
                </div>
            )}

            {/* Hint footer */}
            <div style={{ fontSize: '9px', color: '#444', textAlign: 'center', letterSpacing: '0.5px' }}>
                regime <span style={{ color: '#888' }}>{currentRegime.toUpperCase()}</span>
                {' · '}
                deep analysis on active symbol only — switch via scanner panel
            </div>

            <style>{`
                @keyframes idle-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.4; }
                }
            `}</style>
        </div>
    );
};


// ─── Rejected setup view ──────────────────────────────────────────────────

const RejectedView: React.FC<{ rejected: RejectedSetup; naturalSymbol: string }> = ({ rejected, naturalSymbol }) => {
    return (
        <div style={{
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            background: 'rgba(10,15,25,0.4)',
            border: '1px solid rgba(255, 68, 68, 0.2)',
            borderRadius: '8px',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: '14px', color: '#888' }}>{naturalSymbol}</span>
                <span style={{
                    background: 'rgba(255, 68, 68, 0.1)',
                    color: '#ff7777',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    fontSize: '10px',
                    fontWeight: 'bold',
                    letterSpacing: '0.5px',
                }}>
                    REJECTED
                </span>
            </div>

            <div style={{
                background: 'rgba(255, 68, 68, 0.04)',
                border: '1px solid rgba(255, 68, 68, 0.15)',
                borderRadius: '6px',
                padding: '10px',
                fontSize: '11px',
                color: '#aaa',
            }}>
                <div style={{ color: '#ff7777', fontWeight: 'bold', marginBottom: '4px', fontSize: '10px', letterSpacing: '0.5px' }}>
                    {rejected.code}
                </div>
                {rejected.reason}
            </div>

            <div className="text-xs text-secondary" style={{ textAlign: 'center', opacity: 0.5 }}>
                Watching for next setup...
            </div>
        </div>
    );
};

// ─── Helpers ──────────────────────────────────────────────────────────────

const Stat: React.FC<{
    label: string;
    value: string;
    valueColor?: string;
    sub?: string;
    subColor?: string;
}> = ({ label, value, valueColor = '#fff', sub, subColor = '#888' }) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
        <div className="text-secondary mono" style={{ fontSize: '9px', letterSpacing: '0.5px' }}>{label}</div>
        <div className="mono" style={{ fontSize: '13px', fontWeight: 'bold', color: valueColor }}>{value}</div>
        {sub && (
            <div className="mono" style={{ fontSize: '8px', color: subColor, opacity: 0.8 }}>{sub}</div>
        )}
    </div>
);
