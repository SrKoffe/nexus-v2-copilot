import { useState } from 'react';
import { ChartPanel } from './components/ChartPanel';
import { SetupCard } from './components/SetupCard';
import { SetupChecklist } from './components/SetupChecklist';
import { MarketContextPanel } from './components/MarketContextPanel';
import { ScalpingControlPanel } from './components/ScalpingControlPanel';
import { TradeFeedbackPanel } from './components/TradeFeedbackPanel';
import { HUD } from './components/HUD';
import { SetupStrengthMeter, MarketDifficultyIndicator } from './components/Indicators';
import { LiveFeed } from './components/LiveFeed';
import { PositionTracker } from './components/PositionTracker';
import { DevTools } from './components/DevTools';
import { OpportunityScannerPanel } from './components/OpportunityScannerPanel';
import { HUDHeader } from './components/HUDHeader';
import { useMexcAccount } from './hooks/useMexcAccount';
import { useRegimeDetection } from './hooks/useRegimeDetection';
import { useNexusEvents } from './hooks/useNexusEvents';
import { useScannerStore, useNexusStore } from './store';
import './App.css';

/**
 * Nexus V2 Co-Pilot — Leverage-Adaptive Decision Interface.
 *
 * Layout: 7-panel decision grid designed for real-time micro-scalping.
 *
 *  ┌──────────────────────────────────────────────────────┐
 *  │ HEADER: brand · ticker · leverage · status           │
 *  ├───────────────────────┬──────────┬───────────────────┤
 *  │                       │ CHECKLIST│  SCALP CONTROLS   │
 *  │      CHART            │          │  STRENGTH METER   │
 *  │                       │          │  DIFFICULTY        │
 *  │                       ├──────────┤───────────────────┤
 *  │                       │ SETUP    │  MARKET CONTEXT   │
 *  │                       │ CARD     │                   │
 *  ├───────────────────────┼──────────┼───────────────────┤
 *  │ SIGNALS (live)        │ POSITION │  TRADE FEEDBACK   │
 *  │ INTEL FEED            │ TRACKER  │                   │
 *  └───────────────────────┴──────────┴───────────────────┘
 */
function App() {
    const symbol = useScannerStore(s => s.activeSymbol);
    const [timeframe, setTimeframe] = useState('1m');
    const leverage = useNexusStore(s => s.leverage);

    // Poll MEXC private API for real-time balance (no-op if keys not configured)
    useMexcAccount();

    // v5.1 — Run RegimeEngine on every candle close, push result into store
    useRegimeDetection();

    // Setup events and real-time state synchronization
    const { livePrice } = useNexusEvents();

    return (
        <div className="hud-container">
            {/* HUD Header */}
            <HUDHeader livePrice={livePrice} />

            {/* Decision Interface Grid */}
            <main className="decision-grid">
                {/* Scanner Sidebar */}
                <section className="grid-scanner">
                    <OpportunityScannerPanel />
                </section>

                {/* ROW 1: Chart + Checklist + Controls Column */}
                <section className="grid-chart panel">
                    <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>Market Chart</span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                            {['1m', '5m', '15m', '1H', '4H', '1D'].map(tf => (
                                <button
                                    key={tf}
                                    className={`tf-btn ${timeframe === tf ? 'tf-active' : ''}`}
                                    onClick={() => setTimeframe(tf)}
                                >
                                    {tf}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="panel-content" style={{ padding: 0 }}>
                        <ChartPanel timeframe={timeframe} symbol={symbol} />
                    </div>
                </section>

                <section className="grid-checklist panel">
                    <div className="panel-header">✅ Setup Checklist</div>
                    <div className="panel-content"><SetupChecklist /></div>
                </section>

                <section className="grid-controls panel">
                    <div className="panel-header">⚙️ Scalping Controls</div>
                    <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <ScalpingControlPanel />
                        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
                            <SetupStrengthMeter />
                        </div>
                        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
                            <MarketDifficultyIndicator />
                        </div>
                    </div>
                </section>

                {/* ROW 2: Setup Card + Market Context */}
                <section className="grid-setup panel">
                    <div className="panel-header">Setup (lev {leverage}x)</div>
                    <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <HUD />
                        <SetupCard />
                    </div>
                </section>

                <section className="grid-context panel">
                    <div className="panel-header">🧠 Market Context</div>
                    <div className="panel-content"><MarketContextPanel /></div>
                </section>

                {/* ROW 3: Signals + Position + Feedback */}
                <section className="grid-signals panel">
                    <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>📊 Live Signals</span>
                        <span className="text-xs text-secondary">real-time</span>
                    </div>
                    <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'auto' }}>
                        <div style={{ paddingBottom: '6px' }}>
                            <div style={{ fontSize: '10px', fontWeight: 600, color: '#8892b0', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Intelligence Feed
                            </div>
                            <LiveFeed />
                        </div>
                    </div>
                </section>

                <section className="grid-position panel">
                    <div className="panel-header">Active Operation</div>
                    <div className="panel-content"><PositionTracker /></div>
                </section>

                <section className="grid-feedback panel">
                    <div className="panel-header">🔁 Trade Feedback</div>
                    <div className="panel-content"><TradeFeedbackPanel /></div>
                </section>
            </main>

            {/* Dev-only: inject synthetic setups for E2E testing */}
            <DevTools />
        </div>
    );
}

export default App;
