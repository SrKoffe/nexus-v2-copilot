import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ChartPanel } from './components/ChartPanel';
import { SetupCard } from './components/SetupCard';
import { LiveFeed } from './components/LiveFeed';
import { PositionTracker } from './components/PositionTracker';
import { LeverageSelector } from './components/LeverageSelector';
import { DevTools } from './components/DevTools';
import { useMexcAccount } from './hooks/useMexcAccount';
import './App.css';
import { initAnalysisPipeline } from './analysis';
import { EventBus } from './analysis/event-bus';
import { LeverageAdjustedRiskEngine, type NaturalSetup } from './analysis/leverage-risk';
import { useNexusStore } from './store';

/**
 * Nexus V2 Co-Pilot — root layout.
 *
 * Header: brand + ticker + LeverageSelector + status pills.
 * Grid:   chart | setup card | intelligence feed | active operation tracker.
 */
function App() {
    const [livePrice, setLivePrice] = useState<number>(0);
    const [symbol] = useState('BTC_USDT');
    const [timeframe, setTimeframe] = useState('1m');

    const setPendingSetup = useNexusStore(s => s.setPendingSetup);
    const addToHistory = useNexusStore(s => s.addToHistory);
    const leverage = useNexusStore(s => s.leverage);
    const balance = useNexusStore(s => s.balanceUsd);
    const mexcConfigured = useNexusStore(s => s.mexcConfigured);

    // Poll MEXC private API for real-time balance (no-op if keys not configured)
    useMexcAccount();

    useEffect(() => {
        let cleanup: (() => void) | undefined;

        async function start() {
            // 🚀 Launch Institutional Analysis Pipeline (MEXC futures)
            cleanup = await initAnalysisPipeline();

            // Header ticker — Tauri event from Rust backend
            const unlistenTick = await listen<{ price: number; symbol: string }>('market-tick', (event) => {
                if (event.payload.price) {
                    setLivePrice(event.payload.price);
                    // Expose last price globally so DevTools can inject realistic setups
                    (window as any).__lastLivePrice = event.payload.price;
                }
            });

            return unlistenTick;
        }

        const unlistenPromise = start();

        // Subscribe to SETUP_DETECTED on internal EventBus (emitted by Maestro)
        const handleSetup = (natural: NaturalSetup) => {
            const { leverage: lev, balanceUsd } = useNexusStore.getState();
            const adjusted = LeverageAdjustedRiskEngine.adjust(natural, lev, balanceUsd);

            const entry = {
                natural,
                adjusted,
                detectedAt: Date.now(),
                outcome: null,
                pnlPct: null,
            };

            setPendingSetup(entry);
            addToHistory(entry);
        };

        EventBus.on('SETUP_DETECTED', handleSetup);

        return () => {
            if (cleanup) cleanup();
            unlistenPromise.then(u => u());
            EventBus.off?.('SETUP_DETECTED', handleSetup);
        };
    }, [setPendingSetup, addToHistory]);

    return (
        <div className="hud-container">
            {/* HUD Header */}
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

                <LeverageSelector />

                <div className="status-indicators">
                    <span className="status-pill text-green">● MEXC</span>
                    <span className="status-pill text-blue">🛡️ ORACLE</span>
                    {mexcConfigured === false && (
                        <span
                            className="status-pill"
                            style={{ color: '#ffaa00', borderColor: '#ffaa00' }}
                            title="MEXC API keys not in .env — using default $1000 balance"
                        >
                            ⚠ NO API
                        </span>
                    )}
                    {mexcConfigured === true && (
                        <span
                            className="status-pill text-green"
                            title="MEXC private API connected (read-only)"
                        >
                            ✓ API
                        </span>
                    )}
                    <span
                        className="mono text-xs text-secondary"
                        title={mexcConfigured === true ? 'Live MEXC equity' : 'Default fallback'}
                    >
                        ${balance.toFixed(2)}
                    </span>
                </div>
            </header>

            {/* Main Trading Grid */}
            <main className="trading-grid">
                <section className="chart-area panel">
                    <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>Market Chart</span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                            {['1m', '5m', '15m', '1H', '4H', '1D'].map(tf => (
                                <button
                                    key={tf}
                                    style={{
                                        background: timeframe === tf ? 'rgba(0, 153, 255, 0.2)' : 'transparent',
                                        border: `1px solid ${timeframe === tf ? '#0099ff' : 'transparent'}`,
                                        color: timeframe === tf ? '#0099ff' : '#8892b0',
                                        padding: '2px 8px',
                                        borderRadius: '4px',
                                        fontSize: '11px',
                                        cursor: 'pointer',
                                        fontWeight: timeframe === tf ? 'bold' : 'normal',
                                        fontFamily: 'JetBrains Mono, monospace'
                                    }}
                                    onClick={() => setTimeframe(tf)}
                                >
                                    {tf}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="panel-content" style={{ padding: 0 }}>
                        <ChartPanel timeframe={timeframe} />
                    </div>
                </section>

                <section className="order-area panel">
                    <div className="panel-header">Setup (lev {leverage}x)</div>
                    <div className="panel-content">
                        <SetupCard />
                    </div>
                </section>

                <section className="log-area panel">
                    <div className="panel-header">Intelligence Feed</div>
                    <div className="panel-content">
                        <LiveFeed />
                    </div>
                </section>

                <section className="position-area panel">
                    <div className="panel-header">Active Operation</div>
                    <div className="panel-content">
                        <PositionTracker />
                    </div>
                </section>
            </main>

            {/* Dev-only: inject synthetic setups for E2E testing */}
            <DevTools />
        </div>
    );
}

export default App;
