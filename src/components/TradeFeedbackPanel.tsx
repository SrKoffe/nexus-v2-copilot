import React from 'react';
import { useNexusStore } from '../store';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * TRADE FEEDBACK PANEL — Post-trade learning loop.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Shows results of recent trades: direction, gross/net PnL, fees,
 * entry reason, and actionable insight.
 */

export const TradeFeedbackPanel: React.FC = () => {
    const history = useNexusStore(s => s.history);
    const netPnl = useNexusStore(s => s.netPnlSession);
    const totalFees = useNexusStore(s => s.totalFeesSession);

    // Get last 5 completed trades (those with outcomes)
    const completedTrades = history
        .filter(h => h.outcome !== null && h.outcome !== undefined)
        .slice(-5)
        .reverse();

    const hasData = completedTrades.length > 0 || netPnl !== 0;

    if (!hasData) {
        return (
            <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', height: '100%', gap: '6px',
            }}>
                <span style={{ fontSize: '20px', opacity: 0.3 }}>📊</span>
                <span className="text-xs" style={{ color: '#555' }}>No trades recorded this session</span>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', height: '100%', overflow: 'auto' }}>
            {/* Session summary */}
            <div style={{
                display: 'flex', justifyContent: 'space-between', padding: '6px 8px',
                background: 'rgba(0,0,0,0.3)', borderRadius: '4px', fontSize: '11px',
            }}>
                <span style={{ color: '#8892b0' }}>Session Net</span>
                <span className="mono" style={{
                    color: netPnl > 0 ? '#00ff88' : netPnl < 0 ? '#ff3366' : '#8892b0',
                    fontWeight: 700,
                }}>
                    {netPnl > 0 ? '+' : ''}{netPnl.toFixed(2)}%
                </span>
            </div>
            <div style={{
                display: 'flex', justifyContent: 'space-between', padding: '4px 8px',
                fontSize: '10px',
            }}>
                <span style={{ color: '#555' }}>Total Fees Paid</span>
                <span className="mono" style={{ color: '#ff7799' }}>-{totalFees.toFixed(2)}%</span>
            </div>

            {/* Trade history */}
            {completedTrades.map((trade, i) => {
                const adj = trade.adjusted as any;
                if (!adj?.accepted) return null;

                const isLong = adj.direction === 'long';
                const dirColor = isLong ? '#00ff88' : '#ff3366';
                const dirLabel = isLong ? '↑ LONG' : '↓ SHORT';
                const pnl = trade.pnlPct || 0;
                const isWin = pnl > 0;
                const fees = adj.feesMarginPct || 0;
                const gross = pnl + fees;

                // Build insight
                let insight = '';
                if (adj.confidence < adj.breakEvenWinRate) {
                    insight = 'Confidence below break-even WR — risky entry';
                } else if (adj.survivalScore < 0.80) {
                    insight = 'Low survival score — tight margin to liquidation';
                } else if (isWin) {
                    insight = 'Edge confirmed — confidence > BE win rate ✓';
                } else {
                    insight = 'Loss within acceptable risk parameters';
                }

                return (
                    <div key={i} style={{
                        padding: '6px 8px', borderRadius: '4px',
                        background: 'rgba(255,255,255,0.02)',
                        borderLeft: `2px solid ${dirColor}`,
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                            <span className="mono" style={{ color: dirColor, fontSize: '11px', fontWeight: 700 }}>{dirLabel}</span>
                            <span className="mono" style={{
                                color: isWin ? '#00ff88' : '#ff3366',
                                fontSize: '11px', fontWeight: 700,
                            }}>
                                {pnl > 0 ? '+' : ''}{pnl.toFixed(2)}% net
                            </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#666' }}>
                            <span>Gross: {gross > 0 ? '+' : ''}{gross.toFixed(2)}%</span>
                            <span>Fees: -{fees.toFixed(2)}%</span>
                        </div>
                        <div style={{ fontSize: '9px', color: '#777', marginTop: '3px', fontStyle: 'italic' }}>
                            {insight}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
