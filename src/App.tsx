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
import { useScannerStore } from './store';
import './App.css';

function App() {
    const symbol = useScannerStore(s => s.activeSymbol);
    const [timeframe, setTimeframe] = useState('1m');

    // Poll MEXC private API for real-time balance (no-op if keys not configured)
    useMexcAccount();

    // v5.1 — Run RegimeEngine on every candle close, push result into store
    useRegimeDetection();

    // Setup events and real-time state synchronization
    const { livePrice } = useNexusEvents();

    return (
        <div className="terminal-container">
            {/* Header */}
            <HUDHeader livePrice={livePrice} />

            {/* 3-Column Terminal Layout */}
            <main className="terminal-layout">

                {/* LEFT: Market Universe */}
                <section className="terminal-panel panel-universe">
                    <div className="section-header">Market Universe</div>
                    <div className="section-content scrollable" style={{ padding: 0 }}>
                        <OpportunityScannerPanel />
                    </div>
                </section>

                {/* CENTER: Primary Decision Space */}
                <section className="terminal-panel panel-primary">
                    <div className="chart-area" style={{ display: 'flex', flexDirection: 'column' }}>
                        <div className="section-header">
                            <span>Primary Chart</span>
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
                        <div className="section-content" style={{ padding: 0 }}>
                            <ChartPanel timeframe={timeframe} symbol={symbol} />
                        </div>
                    </div>

                    <div className="feed-area">
                        <div className="section-header">Intelligence Feed</div>
                        <div className="section-content scrollable">
                            <LiveFeed />
                        </div>
                    </div>
                </section>

                {/* RIGHT: Intelligence Stack */}
                <section className="terminal-panel panel-intelligence">

                    <div className="intel-section" style={{ minHeight: '200px' }}>
                        <div className="section-header">Edge Extraction</div>
                        <div className="section-content" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <HUD />
                            <SetupCard />
                        </div>
                    </div>

                    <div className="intel-section">
                        <div className="section-header">Setup Validation</div>
                        <div className="section-content scrollable" style={{ maxHeight: '180px' }}>
                            <SetupChecklist />
                        </div>
                    </div>

                    <div className="intel-section">
                        <div className="section-header">Market Context</div>
                        <div className="section-content">
                            <MarketContextPanel />
                        </div>
                    </div>

                    <div className="intel-section">
                        <div className="section-header">Scalp Controls</div>
                        <div className="section-content" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <ScalpingControlPanel />
                            <SetupStrengthMeter />
                            <MarketDifficultyIndicator />
                        </div>
                    </div>

                    <div className="intel-section">
                        <div className="section-header">Active Operation</div>
                        <div className="section-content scrollable" style={{ maxHeight: '150px' }}>
                            <PositionTracker />
                        </div>
                    </div>

                    <div className="intel-section">
                        <div className="section-header">Trade Feedback</div>
                        <div className="section-content scrollable" style={{ maxHeight: '150px' }}>
                            <TradeFeedbackPanel />
                        </div>
                    </div>

                </section>

            </main>

            {/* Dev-only: inject synthetic setups for E2E testing */}
            <DevTools />
        </div>
    );
}

export default App;
