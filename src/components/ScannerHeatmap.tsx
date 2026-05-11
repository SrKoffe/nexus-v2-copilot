import React, { useEffect, useState } from 'react';
import { useScannerStore, UniverseTicker } from '../store';

export const ScannerHeatmap: React.FC = () => {
    const universe = useScannerStore(s => s.universe);
    const [renderedUniverse, setRenderedUniverse] = useState<UniverseTicker[]>([]);

    useEffect(() => {
        // Throttle heatmap updates to 250ms batching to prevent render storms
        const interval = setInterval(() => {
            setRenderedUniverse(useScannerStore.getState().universe.slice(0, 50));
        }, 250);
        return () => clearInterval(interval);
    }, []);

    const getHeatColor = (ticker: UniverseTicker) => {
        // Red for downside aggression, green for upside aggression
        const isUp = ticker.rise_fall_rate >= 0;

        // Intensity based on opportunity score
        const intensity = Math.min(1.0, (ticker.adaptiveOpportunityScore || ticker.opportunity_score) / 500);

        if (isUp) {
            return `rgba(0, 255, 136, ${0.2 + (intensity * 0.8)})`;
        } else {
            return `rgba(255, 51, 102, ${0.2 + (intensity * 0.8)})`;
        }
    };

    const getStateLabel = (ticker: UniverseTicker) => {
        const score = ticker.adaptiveOpportunityScore || ticker.opportunity_score;
        if (score > 400 && ticker.volatility > 0.05) return 'IGNITION';
        if (score > 300) return 'TREND EXPANSION';
        if (ticker.volatility < 0.01) return 'COMPRESSION';
        return 'CHAOTIC';
    };

    return (
        <div style={{ padding: '12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#888', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Adaptive Battlefield Radar
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {renderedUniverse.map((ticker) => {
                    const bgColor = getHeatColor(ticker);
                    const stateLabel = getStateLabel(ticker);
                    return (
                        <div
                            key={ticker.symbol}
                            title={`${ticker.symbol}\\nState: ${stateLabel}\\nScore: ${(ticker.adaptiveOpportunityScore || ticker.opportunity_score).toFixed(0)}\\nVolatility: ${(ticker.volatility * 100).toFixed(2)}%\\nDelta: ${(ticker.rise_fall_rate * 100).toFixed(2)}%`}
                            style={{
                                padding: '4px 6px',
                                background: bgColor,
                                color: '#fff',
                                fontSize: '10px',
                                fontWeight: 'bold',
                                borderRadius: '2px',
                                cursor: 'crosshair',
                                border: '1px solid rgba(255,255,255,0.1)',
                                transition: 'all 0.2s ease',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}
                        >
                            {ticker.symbol.replace('_USDT', '')}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
