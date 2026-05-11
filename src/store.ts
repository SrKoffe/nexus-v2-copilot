import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type { NaturalSetup, SetupResult } from './analysis/leverage-risk';
import { EdgeMemoryEngine } from './analysis/edge-memory';
import type { Regime, RegimeResult } from './analysis/regime-engine';
import { ScalpEngine } from './analysis/scalp-engine';

/**
 * Zustand store for Nexus V2 Co-Pilot.
 *
 * Single source of truth for:
 *  - Selected leverage (synced with Tauri set_leverage)
 *  - Pending setup (last SETUP_DETECTED from Maestro, awaiting user decision)
 *  - Active setup (the one Roberto marked as "I'm taking this trade")
 *  - Setup history (rolling buffer for review/stats)
 *  - Account balance (hardcoded for now; will read from MEXC API later)
 */

export type SetupHistoryEntry = {
    /** Original natural setup detected by Maestro */
    natural: NaturalSetup;
    /** Result of LeverageAdjustedRiskEngine — accepted (with SL/TP) or rejected */
    adjusted: SetupResult;
    /** When the user saw this — set when stored */
    detectedAt: number;
    /** Outcome marked by user (null until they trade + mark) */
    outcome: 'tp1_hit' | 'tp2_hit' | 'sl_hit' | 'manual_exit' | 'not_taken' | null;
    /** PnL % when outcome marked */
    pnlPct: number | null;
};

interface NexusState {
    // ─── Leverage ───
    leverage: number;
    setLeverage: (v: number) => void;

    // ─── Setups ───
    pendingSetup: SetupHistoryEntry | null;
    setPendingSetup: (entry: SetupHistoryEntry | null) => void;

    activeSetup: SetupHistoryEntry | null;
    /** "I'm taking this trade" — moves pending → active */
    markPendingAsActive: () => void;
    clearActive: () => void;

    // ─── History ───
    history: SetupHistoryEntry[];
    addToHistory: (entry: SetupHistoryEntry) => void;
    /** Mark outcome on the active setup (or specific id if needed later) */
    markOutcome: (outcome: SetupHistoryEntry['outcome'], pnlPct: number) => void;

    // ─── Account ───
    balanceUsd: number;
    setBalance: (b: number) => void;

    /**
     * MEXC API key status:
     *  - null  = unknown (still checking)
     *  - true  = keys present in .env, polling balance/positions
     *  - false = keys missing, balance falls back to default
     */
    mexcConfigured: boolean | null;
    setMexcConfigured: (v: boolean | null) => void;

    /** Last successful balance fetch timestamp (ms). 0 if never. */
    lastBalanceFetchAt: number;
    setLastBalanceFetchAt: (ts: number) => void;

    // ─── Aggression Mode (v6.1) ───
    /**
     * User-controlled aggression mode. Modulates EV gate + min confidence in
     * runtime so the trader can shift between strict edge filtering (Conservative)
     * and opportunistic scalp hunting (Hunter) without changing engine code.
     *
     * Multipliers applied in App.tsx handleSetup → LeverageRiskConfig:
     *   conservative → evMultiplier 1.5,  minConfidence 0.65  (very strict)
     *   balanced     → evMultiplier 1.2,  minConfidence 0.55  (default)
     *   aggressive   → evMultiplier 1.0,  minConfidence 0.45  (cover friction only)
     *   hunter       → evMultiplier 0.8,  minConfidence 0.35  (accept thin edge)
     */
    aggressionMode: 'conservative' | 'balanced' | 'aggressive' | 'hunter';
    setAggressionMode: (m: 'conservative' | 'balanced' | 'aggressive' | 'hunter') => void;

    /** Live open positions from MEXC futures (read-only). [] if no positions or keys missing. */
    openMexcPositions: MexcPosition[];
    setOpenMexcPositions: (positions: MexcPosition[]) => void;

    // ─── Risk config (F7 scalper model) ───
    /** Target NET PnL margem pra TP1 (após fees). Default 3% */
    tp1NetTarget: number;
    /** Target NET PnL margem pra TP2 (após fees). Default 8% */
    tp2NetTarget: number;
    /** MEXC taker fee % (do nominal). Default 0.04 */
    takerFeePct: number;
    setRiskConfig: (cfg: { tp1NetTarget?: number; tp2NetTarget?: number; takerFeePct?: number }) => void;

    // ─── Leverage-adaptive engine state (v4.0) ───
    operatingMode: 'swing_scalp' | 'hybrid' | 'micro_scalp';
    setOperatingMode: (mode: 'swing_scalp' | 'hybrid' | 'micro_scalp') => void;
    velocityState: { tradesPerMinute: number; sizeReduction: number };
    setVelocityState: (v: { tradesPerMinute: number; sizeReduction: number }) => void;
    netPnlSession: number;
    totalFeesSession: number;
    setSessionPnl: (net: number, fees: number) => void;

    // ─── 5-Level Pipeline State (HUD Visualizer, v5.1) ───
    /** Pipeline stage 0-5: 0=idle, 1=Regime, 2=Microstructure, 3=AMT, 4=EV/Target, 5=Execution */
    pipelineStage: 0 | 1 | 2 | 3 | 4 | 5;
    pipelineDirection: 'long' | 'short' | null;
    pipelineStatus: 'idle' | 'evaluating' | 'passed' | 'rejected';
    pipelineReason: string | null;
    setPipelineStage: (stage: 0 | 1 | 2 | 3 | 4 | 5, status?: 'idle' | 'evaluating' | 'passed' | 'rejected', direction?: 'long' | 'short' | null, reason?: string | null) => void;

    // ─── Market Regime (v5.1 — Level 0 of pipeline) ───
    currentRegime: Regime;
    regimeConfidence: number;       // 0..1
    regimeReasons: string[];
    regimeUpdatedAt: number;        // ms timestamp of last evaluation
    setRegime: (r: RegimeResult) => void;

    /**
     * FIX C1: Sync bridge — called after each ScalpEngine.handleEvent() return.
     * Pushes engine state into the store so UI panels read REAL data.
     */
    syncEngineState: (engineResult: {
        operatingMode: string;
        velocityState: { tradesPerMinute: number; sizeReduction: number };
        netPnlSession: number;
        totalFeesSession: number;
    }) => void;
}

/**
 * Mirror of Rust struct `OpenPosition` from src-tauri/src/market_data/mexc_private.rs.
 * Field names use snake_case because Tauri serializes Rust → JSON without renaming.
 */
export interface MexcPosition {
    symbol: string;
    position_id: number;
    side: 'long' | 'short';
    leverage: number;
    size: number;
    entry_price: number;
    mark_price: number;
    liquidation_price: number;
    unrealized_pnl: number;
    margin: number;
}

// ─── Pure helper, NOT a store method (avoids re-render loops) ───────────────
export function computeRejectionCounts(history: SetupHistoryEntry[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const h of history) {
        if (!h.adjusted.accepted) {
            const code = h.adjusted.code;
            counts[code] = (counts[code] || 0) + 1;
        }
    }
    return counts;
}

const HISTORY_MAX = 30;

export const useNexusStore = create<NexusState>((set, get) => ({
    leverage: 25,
    setLeverage: (v) => set({ leverage: v }),

    pendingSetup: null,
    setPendingSetup: (entry) => set({ pendingSetup: entry }),

    activeSetup: null,
    markPendingAsActive: () => {
        const pending = get().pendingSetup;
        if (!pending || !pending.adjusted.accepted) return;
        // FIX C6: Record ACTUAL trade emission for velocity control.
        // This fires ONLY when the user confirms "I'm taking this trade",
        // not when a signal is generated.
        const adj = pending.adjusted as any;
        if (adj.direction && typeof ScalpEngine !== 'undefined') {
            ScalpEngine.recordUserTradeEmission(adj.direction);
        }
        set({ activeSetup: pending, pendingSetup: null });
    },
    clearActive: () => set({ activeSetup: null }),

    history: [],
    addToHistory: (entry) =>
        set((state) => ({
            history: [entry, ...state.history].slice(0, HISTORY_MAX),
        })),
    markOutcome: (outcome, pnlPct) =>
        set((state) => {
            if (!state.activeSetup) return {};

            // FIX C2: Push outcome back to ScalpEngine for velocity/PnL tracking
            const adj = state.activeSetup.adjusted as any;
            if (typeof ScalpEngine !== 'undefined') {
                ScalpEngine.recordOutcome({
                    type: adj.type || 'unknown',
                    pnlPct: pnlPct,
                    feesMarginPct: adj.feesMarginPct || 0,
                    rrRealized: pnlPct / (adj.stopLossMarginPct || 1)
                });
            }

            const updated: SetupHistoryEntry = {
                ...state.activeSetup,
                outcome,
                pnlPct,
            };
            return {
                activeSetup: null,
                history: [updated, ...state.history.filter(h => h !== state.activeSetup)].slice(0, HISTORY_MAX),
            };
        }),

    balanceUsd: 1000, // Default fallback. Replaced by real MEXC equity when API keys are configured.
    setBalance: (b) => set({ balanceUsd: b }),

    mexcConfigured: null,
    setMexcConfigured: (v) => set({ mexcConfigured: v }),

    lastBalanceFetchAt: 0,
    setLastBalanceFetchAt: (ts) => set({ lastBalanceFetchAt: ts }),

    // ─── Aggression Mode (v6.1) ───
    aggressionMode: 'balanced' as const,
    setAggressionMode: (m) => set({ aggressionMode: m }),

    openMexcPositions: [],
    setOpenMexcPositions: (positions) => set({ openMexcPositions: positions }),

    // ─── Risk config overrides (F7 scalper model) ───
    tp1NetTarget: 3,        // % margin net target for TP1 (default; user can tweak in DevTools)
    tp2NetTarget: 8,        // % margin net target for TP2
    takerFeePct: 0.04,      // MEXC default; lower if VIP tier
    setRiskConfig: (cfg: { tp1NetTarget?: number; tp2NetTarget?: number; takerFeePct?: number }) =>
        set((s) => ({
            tp1NetTarget: cfg.tp1NetTarget ?? s.tp1NetTarget,
            tp2NetTarget: cfg.tp2NetTarget ?? s.tp2NetTarget,
            takerFeePct: cfg.takerFeePct ?? s.takerFeePct,
        })),

    // ─── Leverage-adaptive engine state (v4.0) ───
    operatingMode: 'swing_scalp' as const,
    setOperatingMode: (mode) => set({ operatingMode: mode }),
    velocityState: { tradesPerMinute: 0, sizeReduction: 1.0 },
    setVelocityState: (v) => set({ velocityState: v }),
    netPnlSession: 0,
    totalFeesSession: 0,
    setSessionPnl: (net, fees) => set({ netPnlSession: net, totalFeesSession: fees }),

    // ─── 5-Level Pipeline State (HUD Visualizer, v5.1) ───
    pipelineStage: 0,
    pipelineDirection: null,
    pipelineStatus: 'idle',
    pipelineReason: null,
    setPipelineStage: (stage, status, direction, reason) => set((s) => ({
        pipelineStage: stage,
        pipelineStatus: status !== undefined ? status : s.pipelineStatus,
        pipelineDirection: direction !== undefined ? direction : s.pipelineDirection,
        pipelineReason: reason !== undefined ? reason : s.pipelineReason
    })),

    // ─── Market Regime (v5.1) ───
    currentRegime: 'transition' as Regime,
    regimeConfidence: 0,
    regimeReasons: [],
    regimeUpdatedAt: 0,
    setRegime: (r) => set({
        currentRegime: r.regime,
        regimeConfidence: r.confidence,
        regimeReasons: r.reasons,
        regimeUpdatedAt: Date.now(),
    }),

    syncEngineState: (r) => set({
        operatingMode: (r.operatingMode as 'swing_scalp' | 'hybrid' | 'micro_scalp') || 'swing_scalp',
        velocityState: r.velocityState || { tradesPerMinute: 0, sizeReduction: 1.0 },
        netPnlSession: r.netPnlSession ?? 0,
        totalFeesSession: r.totalFeesSession ?? 0,
    }),
}));

// ─── Phase 1: Universe Scanner Store ───────────────────────────────────────

export interface UniverseTicker {
    symbol: string;
    last_price: number;
    volume_24h: number;
    amount_24h: number;
    rise_fall_rate: number;
    high_24h: number;
    low_24h: number;
    volatility: number;
    regime: string;
    opportunity_score: number;
    adaptiveOpportunityScore?: number;

    timestamp: number;
}

interface ScannerState {
    universe: UniverseTicker[];
    topCandidates: UniverseTicker[];
    favorites: string[];
    activeSymbol: string;
    lastUpdateMs: number;
    setUniverse: (tickers: UniverseTicker[]) => void;
    setActiveSymbol: (symbol: string) => void;
    toggleFavorite: (symbol: string) => void;
}

export const useScannerStore = create<ScannerState>()(
    persist(
        (set, get) => ({
            universe: [],
            topCandidates: [],
            favorites: [],
            activeSymbol: 'BTC_USDT',
            lastUpdateMs: 0,
            setUniverse: (tickers) => {
                const updated = tickers.map(t => {
                    // EdgeMemoryEngine was implemented in the backend/other modules previously but in this session we didn't add it.
                    // We will just use the base score for now if EdgeMemoryEngine is missing.
                    let adaptiveMult = 1.0;
                    if (EdgeMemoryEngine) {
                        adaptiveMult = EdgeMemoryEngine.getAdaptiveMultiplier(t.regime || 'unknown', 'universe_scan');
                    }
                    return { ...t, adaptiveOpportunityScore: t.opportunity_score * adaptiveMult };
                });
                updated.sort((a, b) => (b.adaptiveOpportunityScore || 0) - (a.adaptiveOpportunityScore || 0));
                set({
                    universe: updated,
                    topCandidates: updated.slice(0, 10),
                    lastUpdateMs: Date.now()
                });
            },
            setActiveSymbol: (symbol) => {
                const previous = get().activeSymbol;
                if (symbol === previous) return;

                set({ activeSymbol: symbol });

                // Full chain: Rust WS re-subscribe → frontend candle cache reset →
                // refetch history → engines re-bootstrap.
                (async () => {
                    try {
                        // 1. Rust backend re-subscribes the WebSocket
                        await invoke('set_active_analysis_symbol', { symbol });

                        // 2. Reset frontend candle cache + emit SYMBOL_CHANGED for engines
                        const { candleManager } = await import('./analysis/candle-manager');
                        candleManager.setSymbol(symbol);

                        // 3. Re-fetch history with new symbol so engines have data immediately
                        const history = await invoke<any[]>('fetch_historical_candles', {
                            symbol,
                            interval: 'Min1',
                            limit: 200,
                        });
                        if (history && history.length > 0) {
                            candleManager.setHistory(history);
                        }
                    } catch (e) {
                        console.error('[setActiveSymbol] chain failed:', e);
                    }
                })();
            },
            toggleFavorite: (symbol) => {
                const { favorites } = get();
                if (favorites.includes(symbol)) {
                    set({ favorites: favorites.filter(s => s !== symbol) });
                } else {
                    set({ favorites: [...favorites, symbol] });
                }
            },
        }),
        {
            name: 'nexus-scanner-storage', // key in localStorage
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({ favorites: state.favorites }), // only save favorites
        }
    )
);
