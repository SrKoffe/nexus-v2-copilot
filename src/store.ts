import { create } from 'zustand';
import type { NaturalSetup, AdjustedSetup, SetupResult } from './analysis/leverage-risk';
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

    // FIX C1: Sync bridge — pushes ScalpEngine state into store
    syncEngineState: (r) => set({
        operatingMode: (r.operatingMode as 'swing_scalp' | 'hybrid' | 'micro_scalp') || 'swing_scalp',
        velocityState: r.velocityState || { tradesPerMinute: 0, sizeReduction: 1.0 },
        netPnlSession: r.netPnlSession ?? 0,
        totalFeesSession: r.totalFeesSession ?? 0,
    }),
}));
