import React, { useState, useEffect } from 'react';
import { useNexusStore } from '../store';
import { EventBus } from '../analysis/event-bus';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * SCALPING CONTROL PANEL — System constraints + velocity state.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Shows leverage, operating mode, velocity, fees, and required move.
 * Alerts when system is overtrading or in throttle state.
 */

export const ScalpingControlPanel: React.FC = () => {
    const leverage = useNexusStore(s => s.leverage);
    const mode = useNexusStore(s => s.operatingMode);
    const velocity = useNexusStore(s => s.velocityState);
    const takerFee = useNexusStore(s => s.takerFeePct);
    const [tick, setTick] = useState(0);

    // Re-render periodically for velocity updates
    useEffect(() => {
        const interval = setInterval(() => setTick(t => t + 1), 2000);
        return () => clearInterval(interval);
    }, []);

    const feesRoundTrip = takerFee * 2 * leverage;
    const minMove = feesRoundTrip / leverage; // price move % needed to cover fees
    const expectedMoveStr = `~${(minMove * 1.5).toFixed(4)}%`; // 1.5× fees = profit gate

    const tpm = velocity?.tradesPerMinute ?? 0;
    const sizeReduction = velocity?.sizeReduction ?? 1.0;

    // Velocity state determination
    let velocityLabel = 'NORMAL';
    let velocityColor = '#00ff88';
    if (sizeReduction < 0.5) { velocityLabel = 'BLOCKED'; velocityColor = '#ff3366'; }
    else if (sizeReduction < 0.75) { velocityLabel = 'REDUCED'; velocityColor = '#ffb800'; }
    else if (sizeReduction < 1.0) { velocityLabel = 'THROTTLED'; velocityColor = '#ffb800'; }

    // Mode colors
    const modeColors: Record<string, string> = {
        'swing_scalp': '#00e1ff',
        'hybrid': '#ffb800',
        'micro_scalp': '#ff3366',
    };

    const rows = [
        { label: 'Leverage', value: `${leverage}x`, color: leverage > 50 ? '#ff3366' : leverage > 10 ? '#ffb800' : '#00ff88' },
        { label: 'Mode', value: mode.replace('_', ' ').toUpperCase(), color: modeColors[mode] || '#8892b0' },
        { label: 'Trades/min', value: `${tpm}`, color: tpm > 3 ? '#ff3366' : tpm > 1 ? '#ffb800' : '#8892b0' },
        { label: 'Velocity', value: velocityLabel, color: velocityColor },
        { label: 'Fees (RT)', value: `${feesRoundTrip.toFixed(2)}% margin`, color: feesRoundTrip > 10 ? '#ff3366' : '#ffb800' },
        { label: 'Min Move', value: `${minMove.toFixed(4)}%`, color: '#8892b0' },
        { label: 'Expected', value: expectedMoveStr, color: '#00e1ff' },
    ];

    const isOvertrading = sizeReduction < 1.0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', height: '100%' }}>
            {rows.map((r, i) => (
                <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '4px 6px', fontSize: '11px',
                    background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                    borderRadius: '3px',
                }}>
                    <span style={{ color: '#8892b0', fontSize: '10px', fontWeight: 600 }}>{r.label}</span>
                    <span className="mono" style={{ color: r.color, fontWeight: 700, fontSize: '11px' }}>{r.value}</span>
                </div>
            ))}

            {/* Overtrading warning */}
            {isOvertrading && (
                <div style={{
                    marginTop: 'auto', padding: '6px 8px', borderRadius: '4px',
                    background: 'rgba(255,51,102,0.08)', border: '1px solid rgba(255,51,102,0.3)',
                    fontSize: '10px', color: '#ff7799',
                }}>
                    ⚠ VELOCITY PENALTY — Size reduced to {(sizeReduction * 100).toFixed(0)}%
                </div>
            )}
        </div>
    );
};
