import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
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
import { LeverageSelector } from './components/LeverageSelector';
import { DevTools } from './components/DevTools';
import { MarketStateBadge } from './components/MarketStateBadge';
import { useMexcAccount } from './hooks/useMexcAccount';
import { useRegimeDetection } from './hooks/useRegimeDetection';
import './App.css';
import { initAnalysisPipeline } from './analysis';
import { EventBus } from './analysis/event-bus';
import { LeverageAdjustedRiskEngine, DEFAULT_CONFIG, type NaturalSetup } from './analysis/leverage-risk';
import { RegimeEngine } from './analysis/regime-engine';
import { ScalpEngine } from './analysis/scalp-engine';
import { useNexusStore } from './store';

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
    const [livePrice, setLivePrice] = useState<number>(0);
    const [symbol] = useState('BTC_USDT');
    const [timeframe, setTimeframe] = useState('1m');

    const setPendingSetup = useNexusStore(s => s.setPendingSetup);
    const addToHistory = useNexusStore(s => s.addToHistory);
    const leverage = useNexusStore(s => s.leverage);
    const balance = useNexusStore(s => s.balanceUsd);
    const mexcConfigured = useNexusStore(s => s.mexcConfigured);
    const operatingMode = useNexusStore(s => s.operatingMode);

    // Poll MEXC private API for real-time balance (no-op if keys not configured)
    useMexcAccount();

    // v5.1 — Run RegimeEngine on every candle close, push result into store
    useRegimeDetection();

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
            const s = useNexusStore.getState();

            // v5.2d: hard block via regime behavior hint.
            // CHAOTIC regime returns block=true and we reject before running the
            // EV pipeline at all. Other regimes flow through normally.
            const hint = RegimeEngine.behaviorHint(s.currentRegime);
            if (hint.block) {
                const blockedEntry = {
                    natural,
                    adjusted: {
                        accepted: false as const,
                        code: 'EV_NOT_POSITIVE' as const, // closest existing code; v5.2 reuses it for chaos
                        reason: `Regime ${s.currentRegime.toUpperCase()} blocks setups (volatility spike + whipsaw)`,
                    },
                    detectedAt: Date.now(),
                    outcome: null,
                    pnlPct: null,
                };
                setPendingSetup(blockedEntry);
                addToHistory(blockedEntry);
                return;
            }

            // Build config: defaults + user overrides from store (F7 scalper config)
            const config = {
                ...DEFAULT_CONFIG,
                tp1TargetNetMarginPct: s.tp1NetTarget,
                tp2TargetNetMarginPct: s.tp2NetTarget,
                takerFeePct: s.takerFeePct,
            };
            // v5.2: enrich natural setup with current regime so ProbabilityModel
            // can apply alignment bonus/penalty.
            const enriched: NaturalSetup = {
                ...natural,
                regime: natural.regime ?? s.currentRegime,
            };
            const adjusted = LeverageAdjustedRiskEngine.adjust(enriched, s.leverage, s.balanceUsd, config);

            const entry = {
                natural: enriched,
                adjusted,
                detectedAt: Date.now(),
                outcome: null,
                pnlPct: null,
            };

            setPendingSetup(entry);
            addToHistory(entry);
        };

        EventBus.on('SETUP_DETECTED', handleSetup);

        // FIX C1: Sync bridge — ScalpEngine emits SCALP_SETUP with engine state
        // after every handleEvent(). We push that state into the Zustand store
        // so ALL UI panels (mode badge, velocity, PnL, checklist) see REAL data.
        const handleScalpUpdate = (payload: any) => {
            const syncState = useNexusStore.getState().syncEngineState;
            if (payload && syncState) {
                // The SCALP_SETUP event includes the full handleEvent return
                const engineResult = payload._engineState || payload;
                syncState({
                    operatingMode: engineResult.operatingMode || payload.operatingMode,
                    velocityState: engineResult.velocityState || { tradesPerMinute: 0, sizeReduction: 1.0 },
                    netPnlSession: engineResult.netPnlSession ?? 0,
                    totalFeesSession: engineResult.totalFeesSession ?? 0,
                });
            }
        };
        EventBus.on('SCALP_SETUP', handleScalpUpdate);

        // Also sync on every ANALYSIS_SIGNAL for continuous mode/velocity updates
        // even when no setup is emitted (keeps header mode badge accurate).
        const handleAnalysisSync = () => {
            // Read directly from ScalpEngine state (lightweight — no computation)
            if (typeof ScalpEngine !== 'undefined' && ScalpEngine._state) {
                const s = ScalpEngine._state;
                const perf = ScalpEngine._performance;
                useNexusStore.getState().syncEngineState({
                    operatingMode: s.currentMode || 'swing_scalp',
                    velocityState: {
                        tradesPerMinute: s.recentTradeTimestamps?.filter((t: number) => Date.now() - t < 60000).length || 0,
                        sizeReduction: s.velocityReduction ?? 1.0,
                    },
                    netPnlSession: perf?.netPnl ?? 0,
                    totalFeesSession: perf?.totalFeesPaid ?? 0,
                });
            }
        };
        EventBus.on('ANALYSIS_SIGNAL', handleAnalysisSync);

        return () => {
            if (cleanup) cleanup();
            unlistenPromise.then(u => u());
            EventBus.off?.('SETUP_DETECTED', handleSetup);
            EventBus.off?.('SCALP_SETUP', handleScalpUpdate);
            EventBus.off?.('ANALYSIS_SIGNAL', handleAnalysisSync);
        };
    }, [setPendingSetup, addToHistory]);

    // Mode badge color
    const modeColor = operatingMode === 'micro_scalp' ? '#ff3366' : operatingMode === 'hybrid' ? '#ffb800' : '#00e1ff';

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

                {/* v5.1: Level-0 regime cue, prominent next to ticker */}
                <MarketStateBadge />

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

            {/* Decision Interface Grid */}
            <main className="decision-grid">
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
                        <ChartPanel timeframe={timeframe} />
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
