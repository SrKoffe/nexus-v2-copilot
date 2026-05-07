import React from 'react';
import { useNexusStore } from '../store';
import { RegimeEngine } from '../analysis/regime-engine';

/**
 * MarketStateBadge — prominent Level-0 visual cue.
 *
 * Sits in the header next to the ticker so the trader sees the regime
 * immediately on every glance. Color + icon convey state without reading.
 *
 *   TREND ↑ / TREND ↓ — directional flow (cyan / red)
 *   RANGE 🔄         — mean reversion zone (amber)
 *   CHAOTIC ⚠        — block-trade signal (red, pulsing)
 *   TRANSITION       — wait state (gray)
 *
 * Tooltip shows the regime reasons + confidence + last update timestamp.
 */
export const MarketStateBadge: React.FC = () => {
    const regime = useNexusStore(s => s.currentRegime);
    const confidence = useNexusStore(s => s.regimeConfidence);
    const reasons = useNexusStore(s => s.regimeReasons);
    const updatedAt = useNexusStore(s => s.regimeUpdatedAt);

    const color = RegimeEngine.color(regime);
    const label = RegimeEngine.label(regime);

    const icon =
        regime === 'trend_up'   ? '↑' :
        regime === 'trend_down' ? '↓' :
        regime === 'range'      ? '↻' :
        regime === 'chaotic'    ? '⚠' :
                                  '·';

    const ageSec = updatedAt > 0 ? Math.floor((Date.now() - updatedAt) / 1000) : null;
    const tooltip = [
        `${label} — confidence ${(confidence * 100).toFixed(0)}%`,
        ...reasons,
        ageSec !== null ? `Updated ${ageSec}s ago` : 'No data yet',
    ].join('\n');

    const isAlert = regime === 'chaotic';
    const isStale = ageSec !== null && ageSec > 90;

    return (
        <div
            title={tooltip}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 12px',
                borderRadius: '6px',
                background: `${color}1a`,
                border: `1px solid ${color}${isAlert ? 'cc' : '66'}`,
                color,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.5px',
                cursor: 'help',
                animation: isAlert ? 'mb-pulse 1.4s ease-in-out infinite' : undefined,
                opacity: isStale ? 0.55 : 1,
                transition: 'opacity 0.3s, background 0.3s',
            }}
        >
            <span style={{ fontSize: '14px' }}>{icon}</span>
            <span>{label}</span>
            {confidence > 0 && (
                <span style={{
                    fontSize: '10px',
                    color: `${color}cc`,
                    marginLeft: '2px',
                }}>
                    {(confidence * 100).toFixed(0)}%
                </span>
            )}

            <style>{`
                @keyframes mb-pulse {
                    0%, 100% { box-shadow: 0 0 0 0 ${color}66; }
                    50% { box-shadow: 0 0 0 6px ${color}00; }
                }
            `}</style>
        </div>
    );
};
