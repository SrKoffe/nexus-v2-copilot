import { MarketStateBadge } from './MarketStateBadge';
import { AggressionModeSelector } from './AggressionModeSelector';
import { LeverageSelector } from './LeverageSelector';
import { useNexusStore, useScannerStore } from '../store';

export function HUDHeader({ livePrice }: { livePrice: number }) {
    const symbol = useScannerStore(s => s.activeSymbol);

    const balance = useNexusStore(s => s.balanceUsd);
    const mexcConfigured = useNexusStore(s => s.mexcConfigured);
    const operatingMode = useNexusStore(s => s.operatingMode);

    // Mode badge color
    const modeColor = operatingMode === 'micro_scalp' ? '#ff3366' : operatingMode === 'hybrid' ? '#ffb800' : '#00e1ff';

    return (
        <header className="hud-topbar panel">
            <div className="brand">
                <span className="text-blue mono">▶</span> NEXUS <span className="text-secondary text-sm">V2 / CO-PILOT</span>
            </div>

            <div className="global-ticker">
                <span className="mono text-secondary">{symbol}</span>
                <span className="mono text-xl" style={{ marginLeft: '12px' }}>
                    ${livePrice > 0 ? livePrice.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '---.-'}
                </span>
            </div>

            {/* v5.1: Level-0 regime cue, prominent next to ticker */}
            <MarketStateBadge />

            {/* v6.1: Aggression mode — user-controlled EV gate modulator */}
            <AggressionModeSelector />

            <LeverageSelector />

            <div className="status-indicators">
                <span className="status-pill" style={{ color: modeColor, borderColor: `${modeColor}40` }}>
                    {operatingMode.replace('_', ' ').toUpperCase()}
                </span>
                <span className="status-pill text-green">● MEXC</span>
                <span className="status-pill text-blue">🛡️ ORACLE</span>
                {mexcConfigured === false && (
                    <span className="status-pill" style={{ color: '#ffaa00', borderColor: '#ffaa00' }}
                        title="MEXC API keys not in .env — using default $1000 balance">
                        ⚠ NO API
                    </span>
                )}
                {mexcConfigured === true && (
                    <span className="status-pill text-green" title="MEXC private API connected (read-only)">✓ API</span>
                )}
                <span className="mono text-xs text-secondary"
                    title={mexcConfigured === true ? 'Live MEXC equity' : 'Default fallback'}>
                    ${balance.toFixed(2)}
                </span>
            </div>
        </header>
    );
}
