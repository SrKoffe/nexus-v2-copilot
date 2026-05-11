import React, { useState, useEffect } from 'react';
import { EventBus } from '../analysis/event-bus';
import { StateCache } from '../analysis/state-cache';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * MARKET CONTEXT PANEL — WHERE is the trade happening?
 * ═══════════════════════════════════════════════════════════════════════
 *
 * AMT (Auction Market Theory) + Volume Profile context.
 * Shows market mode, price location, and human-readable recommendation.
 */

interface ContextState {
    marketMode: 'BALANCE' | 'IMBALANCE' | 'TRANSITION';
    location: string;
    interpretation: 'CHOP' | 'TREND' | 'REVERSAL ZONE' | 'FAST MOVE ZONE' | 'UNKNOWN';
    recommendation: string;
    details: { label: string; value: string; color: string }[];
}

function getContext(): ContextState {
    const regime = StateCache.get('currentRegime', 'unknown');
    const regimeConf = StateCache.get('regimeConfidence', 50);
    const poc = StateCache.get('currentPOC', 0) || StateCache.get('poc', 0);
    const vah = StateCache.get('currentVAH', 0) || StateCache.get('vah', 0);
    const val = StateCache.get('currentVAL', 0) || StateCache.get('val', 0);
    const price = StateCache.get('currentPrice', 0);
    const atr = StateCache.get('lastATR', 0);

    // Market Mode
    let marketMode: ContextState['marketMode'] = 'BALANCE';
    if (regime === 'trending_up' || regime === 'trending_down') {
        marketMode = regimeConf > 60 ? 'IMBALANCE' : 'TRANSITION';
    } else if (regime === 'range' || regime === 'choppy') {
        marketMode = 'BALANCE';
    } else {
        marketMode = regimeConf > 50 ? 'TRANSITION' : 'BALANCE';
    }

    // Location relative to VP
    let location = 'MID-RANGE';
    let interpretation: ContextState['interpretation'] = 'UNKNOWN';
    let recommendation = 'Neutral conditions — standard sizing';

    if (poc && price) {
        const distPoc = Math.abs(price - poc);
        const isNearPoc = atr > 0 ? distPoc < atr * 0.5 : distPoc / price < 0.001;

        if (isNearPoc) {
            location = 'POC';
            interpretation = 'CHOP';
            recommendation = '⚠ High chop risk at POC — reduce size or wait for breakout';
        } else if (vah && price > vah) {
            location = 'ABOVE VAH';
            interpretation = marketMode === 'IMBALANCE' ? 'TREND' : 'REVERSAL ZONE';
            recommendation = marketMode === 'IMBALANCE'
                ? '🚀 Above VAH in trend — continuation bias (long OK)'
                : '↩ Above VAH in balance — short bias / reversal zone';
        } else if (val && price < val) {
            location = 'BELOW VAL';
            interpretation = marketMode === 'IMBALANCE' ? 'TREND' : 'REVERSAL ZONE';
            recommendation = marketMode === 'IMBALANCE'
                ? '📉 Below VAL in trend — continuation bias (short OK)'
                : '↩ Below VAL in balance — long bias / reversal zone';
        } else if (vah && val) {
            // Between POC and edges
            const range = vah - val;
            if (range > 0) {
                const pctInRange = (price - val) / range;
                if (pctInRange > 0.7) {
                    location = 'NEAR VAH';
                    interpretation = 'REVERSAL ZONE';
                    recommendation = '↩ Near VAH — watch for rejection or breakout';
                } else if (pctInRange < 0.3) {
                    location = 'NEAR VAL';
                    interpretation = 'REVERSAL ZONE';
                    recommendation = '↩ Near VAL — watch for rejection or breakdown';
                } else {
                    location = 'VALUE AREA';
                    interpretation = 'CHOP';
                    recommendation = '⚠ Inside value area — choppy conditions likely';
                }
            }
        }
    }

    // Check for LVN (Low Volume Node = fast move zone)
    const lvn = StateCache.get('nearestLVN', null);
    if (lvn && price && atr > 0) {
        const lvnDist = Math.abs(price - (typeof lvn === 'number' ? lvn : lvn.price || 0));
        if (lvnDist < atr * 0.3) {
            location = 'LVN';
            interpretation = 'FAST MOVE ZONE';
            recommendation = '⚡ LVN detected — expect fast move, tight SL required';
        }
    }

    const details: ContextState['details'] = [
        { label: 'Regime', value: regime || 'unknown', color: regime?.includes('trending') ? '#00ff88' : '#8892b0' },
        { label: 'Probability', value: `${regimeConf}%`, color: regimeConf > 60 ? '#00ff88' : '#ffb800' },
    ];
    if (poc) details.push({ label: 'POC', value: `$${poc.toFixed(1)}`, color: '#00e1ff' });
    if (vah) details.push({ label: 'VAH', value: `$${vah.toFixed(1)}`, color: '#9d4edd' });
    if (val) details.push({ label: 'VAL', value: `$${val.toFixed(1)}`, color: '#9d4edd' });

    return { marketMode, location, interpretation, recommendation, details };
}

const MODE_COLORS: Record<string, string> = {
    'BALANCE': '#ffb800',
    'IMBALANCE': '#00ff88',
    'TRANSITION': '#00e1ff',
};

const INTERP_COLORS: Record<string, string> = {
    'CHOP': '#ff3366',
    'TREND': '#00ff88',
    'REVERSAL ZONE': '#ffb800',
    'FAST MOVE ZONE': '#00e1ff',
    'UNKNOWN': '#555',
};

export const MarketContextPanel: React.FC = () => {
    const [ctx, setCtx] = useState<ContextState>(getContext);

    useEffect(() => {
        const refresh = () => setCtx(getContext());
        EventBus.on('ANALYSIS_SIGNAL', refresh);
        EventBus.on('MARKET_TICK', refresh);
        const interval = setInterval(refresh, 2000);
        return () => {
            EventBus.off('ANALYSIS_SIGNAL', refresh);
            EventBus.off('MARKET_TICK', refresh);
            clearInterval(interval);
        };
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%' }}>
            {/* Mode + Location badges */}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <Badge label={ctx.marketMode} color={MODE_COLORS[ctx.marketMode] || '#555'} />
                <Badge label={ctx.location} color="#00e1ff" />
                <Badge label={ctx.interpretation} color={INTERP_COLORS[ctx.interpretation] || '#555'} />
            </div>

            {/* Detail rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                {ctx.details.map((d, i) => (
                    <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between',
                        padding: '3px 6px', fontSize: '11px',
                    }}>
                        <span style={{ color: '#8892b0' }}>{d.label}</span>
                        <span className="mono" style={{ color: d.color, fontWeight: 600 }}>{d.value}</span>
                    </div>
                ))}
            </div>

            {/* Recommendation */}
            <div style={{
                marginTop: 'auto', padding: '8px 10px', borderRadius: '2px',
                background: 'transparent', border: 'none',
                fontSize: '11px', color: '#ddd', lineHeight: '1.4',
            }}>
                {ctx.recommendation}
            </div>
        </div>
    );
};

const Badge: React.FC<{ label: string; color: string }> = ({ label, color }) => (
    <span style={{
        padding: '2px 8px', borderRadius: '2px', fontSize: '10px', fontWeight: 700,
        background: 'transparent', border: `1px solid ${color}20`, color, letterSpacing: '0.5px',
    }}>
        {label}
    </span>
);
