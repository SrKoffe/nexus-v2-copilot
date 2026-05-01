import { create } from 'zustand';
import type { NaturalSetup, AdjustedSetup, SetupResult } from './analysis/leverage-risk';

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
}));
