import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { initAnalysisPipeline } from '../analysis';
import { EventBus } from '../analysis/event-bus';
import { LeverageAdjustedRiskEngine, DEFAULT_CONFIG, type NaturalSetup } from '../analysis/leverage-risk';
import { RegimeEngine } from '../analysis/regime-engine';
import { ScalpEngine } from '../analysis/scalp-engine';
import { LiquidityTargetEngine } from '../analysis/liquidity-target';
import { LiquidityEngine } from '../analysis/liquidity';
import { useNexusStore, useScannerStore, type UniverseTicker } from '../store';
import { aggressionModifiers } from '../components/AggressionModeSelector';

export function useNexusEvents() {
    const [livePrice, setLivePrice] = useState<number>(0);
    const setPendingSetup = useNexusStore(s => s.setPendingSetup);
    const addToHistory = useNexusStore(s => s.addToHistory);

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

            // Phase 1: Universe Scanner Listener
            const unlistenScanner = await listen<UniverseTicker[]>('universe-scan-update', (event) => {
                useScannerStore.getState().setUniverse(event.payload);
            });

            return () => {
                unlistenTick();
                unlistenScanner();
            };
        }

        const cleanupTauriPromise = start();

        // Subscribe to SETUP_DETECTED on internal EventBus (emitted by Maestro)
        const handleSetup = (natural: NaturalSetup) => {
            const s = useNexusStore.getState();

            // v6.2: regime is a MODULATOR, not a blocker. AggressionMode is
            // the user's lever; regime hint stacks multiplicatively on top.
            // Hunter mode + chaotic regime can still produce setups if EV is
            // strong enough; Conservative mode + chaotic effectively rejects.
            const regimeHint = RegimeEngine.behaviorHint(s.currentRegime);
            const aggrMods = aggressionModifiers(s.aggressionMode);

            // Stack multipliers: stricter of the two wins, but they compose.
            const stackedEvMul = DEFAULT_CONFIG.evMultiplier * aggrMods.evMultiplier * regimeHint.evMultiplier;
            const stackedMinConf = Math.min(0.85,
                Math.max(0.20, aggrMods.minConfidence + regimeHint.confidenceDelta)
            );

            // Build config: defaults + user F7 overrides + v6.1/v6.2 modulators
            const config = {
                ...DEFAULT_CONFIG,
                tp1TargetNetMarginPct: s.tp1NetTarget,
                tp2TargetNetMarginPct: s.tp2NetTarget,
                takerFeePct: s.takerFeePct,
                evMultiplier: stackedEvMul,
                minConfidence: stackedMinConf,
            };
            // v5.2: enrich natural setup with current regime so ProbabilityModel
            // can apply alignment bonus/penalty.
            const enriched: NaturalSetup = {
                ...natural,
                regime: natural.regime ?? s.currentRegime,
            };

            // v5.2e: Query LiquidityTargetEngine for structural targets.
            // ATR from LiquidityEngine's cached state (computed during analysis).
            const atr = enriched.atr || LiquidityEngine?._state?.atr || 0;
            if (atr > 0 && enriched.entryPrice > 0 && enriched.direction !== 'neutral') {
                const liqResult = LiquidityTargetEngine.findTargets(
                    enriched.entryPrice,
                    enriched.direction as 'long' | 'short',
                    atr
                );
                if (!liqResult.fallbackUsed && liqResult.primaryTarget) {
                    enriched.liquidityTargetPrice = liqResult.primaryTarget.price;
                    enriched.liquidityTargetSource = liqResult.primaryTarget.source;
                    enriched.liquidityTargetConfidence = liqResult.primaryTarget.confidence;
                    enriched.liquidityStrength = LiquidityTargetEngine.getLiquidityStrength(liqResult);
                }
            }

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
                const s = (ScalpEngine as any)._state;
                const perf = (ScalpEngine as any)._performance;
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
            cleanupTauriPromise.then(u => u());
            EventBus.off?.('SETUP_DETECTED', handleSetup);
            EventBus.off?.('SCALP_SETUP', handleScalpUpdate);
            EventBus.off?.('ANALYSIS_SIGNAL', handleAnalysisSync);
        };
    }, [setPendingSetup, addToHistory]);

    return { livePrice };
}
