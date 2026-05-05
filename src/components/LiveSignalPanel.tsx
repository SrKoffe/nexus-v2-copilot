import React, { useState, useEffect } from 'react';
import { EventBus } from '../analysis/event-bus';
import { StateCache } from '../analysis/state-cache';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * LIVE SIGNAL PANEL — Real-time microstructure signal display.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Exposes OBI, CVD, TPS, Absorption, Iceberg, Sweep, VWAP in real time.
 * Highlights conflicts (e.g. OBI Trade=BUY vs OBI Book=SELL).
 */

interface SignalRow {
    name: string;
    direction: '↑' | '↓' | '—';
    value: string;
    interpretation: string;
    color: string;
}

function getSignals(): { signals: SignalRow[]; conflicts: string[] } {
    const signals: SignalRow[] = [];
    const conflicts: string[] = [];

    // OBI (Trade Aggression)
    const obi = StateCache.get('aggressiveImbalance', null);
    if (obi?.detected) {
        const isBuy = obi.direction === 'buy_aggression';
        signals.push({
            name: 'OBI Trade', direction: isBuy ? '↑' : '↓',
            value: `${(obi.ratio || 0).toFixed(1)}x`,
            interpretation: isBuy ? 'BUY pressure' : 'SELL pressure',
            color: isBuy ? '#00ff88' : '#ff3366',
        });
    } else {
        signals.push({ name: 'OBI Trade', direction: '—', value: '—', interpretation: 'Balanced', color: '#555' });
    }

    // OBI Book
    const book = StateCache.get('bookImbalance', null);
    if (book?.detected) {
        const isBuyHeavy = book.direction === 'buy_heavy';
        signals.push({
            name: 'OBI Book', direction: isBuyHeavy ? '↑' : '↓',
            value: `${(book.ratio || 0).toFixed(1)}x`,
            interpretation: isBuyHeavy ? 'BID heavy' : 'ASK heavy',
            color: isBuyHeavy ? '#00ff88' : '#ff3366',
        });
        // Check conflict
        if (obi?.detected) {
            const tradeDir = obi.direction === 'buy_aggression' ? 'BUY' : 'SELL';
            const bookDir = isBuyHeavy ? 'BUY' : 'SELL';
            if (tradeDir !== bookDir) {
                conflicts.push(`OBI Trade=${tradeDir} vs Book=${bookDir}`);
            }
        }
    } else {
        signals.push({ name: 'OBI Book', direction: '—', value: '—', interpretation: 'Balanced', color: '#555' });
    }

    // CVD
    const cd = StateCache.get('cumulativeDelta', null);
    if (cd) {
        const val = typeof cd === 'object' ? (cd.value || 0) : (cd || 0);
        const isBullish = val > 0;
        signals.push({
            name: 'CVD', direction: isBullish ? '↑' : '↓',
            value: val > 0 ? `+${val.toFixed(0)}` : val.toFixed(0),
            interpretation: isBullish ? 'Net buying' : 'Net selling',
            color: isBullish ? '#00ff88' : '#ff3366',
        });
    } else {
        signals.push({ name: 'CVD', direction: '—', value: '—', interpretation: 'No data', color: '#555' });
    }

    // TPS (via volume ratio proxy)
    const tps = StateCache.get('tradesPerSecond', null);
    if (tps) {
        const isHigh = tps > 50;
        signals.push({
            name: 'TPS', direction: isHigh ? '↑' : '—',
            value: `${tps.toFixed(0)}/s`,
            interpretation: isHigh ? 'High activity' : 'Normal flow',
            color: isHigh ? '#00e1ff' : '#555',
        });
    } else {
        signals.push({ name: 'TPS', direction: '—', value: '—', interpretation: 'No data', color: '#555' });
    }

    // Absorption
    const abs = StateCache.get('lastAbsorption', null);
    if (abs?.detected && abs.mostRecent) {
        const dir = abs.mostRecent.direction;
        const isSellAbsorbed = dir === 'selling_absorbed';
        signals.push({
            name: 'Absorption', direction: isSellAbsorbed ? '↑' : '↓',
            value: 'ACTIVE',
            interpretation: isSellAbsorbed ? 'SELL absorbed → bullish' : 'BUY absorbed → bearish',
            color: isSellAbsorbed ? '#00ff88' : '#ff3366',
        });
    } else {
        signals.push({ name: 'Absorption', direction: '—', value: 'NONE', interpretation: 'No absorption', color: '#555' });
    }

    // Iceberg
    const iceberg = StateCache.get('icebergDetected', null);
    if (iceberg?.detected) {
        signals.push({
            name: 'Iceberg', direction: iceberg.side === 'bid' ? '↑' : '↓',
            value: `${iceberg.side?.toUpperCase()}`,
            interpretation: `Hidden ${iceberg.side} orders detected`,
            color: '#9d4edd',
        });
    } else {
        signals.push({ name: 'Iceberg', direction: '—', value: 'NONE', interpretation: 'Not detected', color: '#555' });
    }

    // Sweep
    const sweep = StateCache.get('lastSweep', null);
    const sweepData = Array.isArray(sweep) ? sweep[sweep.length - 1] : sweep;
    if (sweepData) {
        const isBullish = sweepData.direction === 'bullish';
        signals.push({
            name: 'Sweep', direction: isBullish ? '↑' : '↓',
            value: sweepData.confirmed ? 'CONFIRMED' : 'PENDING',
            interpretation: `${isBullish ? 'Bullish' : 'Bearish'} liquidity sweep`,
            color: isBullish ? '#00ff88' : '#ff3366',
        });
    } else {
        signals.push({ name: 'Sweep', direction: '—', value: 'NONE', interpretation: 'No sweep', color: '#555' });
    }

    return { signals, conflicts };
}

export const LiveSignalPanel: React.FC = () => {
    const [data, setData] = useState(getSignals);

    useEffect(() => {
        const refresh = () => setData(getSignals());
        EventBus.on('MARKET_TICK', refresh);
        EventBus.on('ANALYSIS_SIGNAL', refresh);
        const interval = setInterval(refresh, 1500);
        return () => {
            EventBus.off('MARKET_TICK', refresh);
            EventBus.off('ANALYSIS_SIGNAL', refresh);
            clearInterval(interval);
        };
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', height: '100%', overflow: 'auto' }}>
            {/* Signal rows */}
            {data.signals.map((s, i) => (
                <div key={i} style={{
                    display: 'grid', gridTemplateColumns: '70px 20px 55px 1fr',
                    alignItems: 'center', gap: '4px', padding: '4px 6px',
                    background: s.color !== '#555' ? 'rgba(255,255,255,0.02)' : 'transparent',
                    borderRadius: '3px', fontSize: '11px',
                }}>
                    <span style={{ color: '#8892b0', fontWeight: 600, fontSize: '10px' }}>{s.name}</span>
                    <span className="mono" style={{ color: s.color, fontSize: '14px', textAlign: 'center' }}>{s.direction}</span>
                    <span className="mono" style={{ color: s.color, fontWeight: 700, fontSize: '11px' }}>{s.value}</span>
                    <span style={{ color: s.color, opacity: 0.8, fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.interpretation}
                    </span>
                </div>
            ))}

            {/* Conflicts */}
            {data.conflicts.length > 0 && (
                <div style={{
                    marginTop: '4px', padding: '6px 8px', borderRadius: '4px',
                    background: 'rgba(255,184,0,0.08)', border: '1px solid rgba(255,184,0,0.25)',
                    fontSize: '10px', color: '#ffcc55',
                }}>
                    ⚠ DIVERGENCE: {data.conflicts.join(' | ')}
                </div>
            )}
        </div>
    );
};
