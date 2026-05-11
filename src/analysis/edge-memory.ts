import { EventBus } from './event-bus';

export interface TradeOutcome {
    regime: string;
    archetype: string;
    session: string;
    volatility: string;
    outcome: 'win' | 'loss';
    pnlPct: number;
    timestamp: number;
}

export const EdgeMemoryEngine = {
    _state: {
        recentTrades: [] as TradeOutcome[],
        memoizedMultipliers: new Map<string, { value: number, timestamp: number }>(),
    },

    init() {
        console.log('🧠 [EdgeMemory] Initializing Evolutionary Memory Engine...');

        EventBus.on('TRADE_CLOSED', (payload: any) => {
            if (payload && payload.outcome) {
                this.recordTrade(payload);
            }
        });
    },

    recordTrade(payload: any) {
        const trade: TradeOutcome = {
            regime: payload.regime || 'unknown',
            archetype: payload.archetype || payload.type || 'unknown',
            session: payload.session || 'unknown',
            volatility: payload.volScore > 70 ? 'high' : payload.volScore < 30 ? 'low' : 'normal',
            outcome: payload.pnl_pct > 0 ? 'win' : 'loss',
            pnlPct: payload.pnl_pct || 0,
            timestamp: Date.now()
        };

        this._state.recentTrades.push(trade);

        // Keep last 300 trades for performance tracking
        if (this._state.recentTrades.length > 300) {
            this._state.recentTrades.shift();
        }

        // Invalidate memo cache on new data
        this._state.memoizedMultipliers.clear();

        console.log(`🧠 [EdgeMemory] Recorded trade: ${trade.outcome} (${trade.pnlPct.toFixed(2)}%) | Arch: ${trade.archetype} | Reg: ${trade.regime}`);

        // Emit edge update for UI
        EventBus.emit('EDGE_MEMORY_UPDATED', {
            latest: trade,
            multipliers: this.getAllMultipliers()
        });
    },

    /**
     * Computes the adaptive multiplier with asymmetric exponential decay,
     * hard caps [0.65, 1.35], and memoization.
     */
    getAdaptiveMultiplier(regime: string, archetype: string): number {
        const cacheKey = `${regime}_${archetype}`;
        const cached = this._state.memoizedMultipliers.get(cacheKey);

        // Cache valid for 1 minute or until cleared by new trade
        if (cached && (Date.now() - cached.timestamp < 60000)) {
            return cached.value;
        }

        const trades = this._state.recentTrades;
        if (trades.length < 5) return 1.0;

        // Filter for specific context
        const relevantTrades = trades.filter(t => t.regime === regime && t.archetype === archetype);
        if (relevantTrades.length < 3) return 1.0;

        let weightedScore = 0;
        let totalWeight = 0;

        // Asymmetric decay parameters (INVERTED to punish failures quickly):
        // Losses must carry heavy weight (slow decay = 0.95) so they drag down the WR longer.
        // Wins must be forgotten quickly (fast decay = 0.85) so the system must "prove" it's still winning.
        const LOSS_DECAY = 0.95;
        const WIN_DECAY = 0.85;

        // Process from newest to oldest
        const reversed = [...relevantTrades].reverse();

        reversed.forEach((t, i) => {
            // Apply exponential decay based on recency (index i)
            const decayFactor = t.outcome === 'win' ? WIN_DECAY : LOSS_DECAY;
            const weight = Math.pow(decayFactor, i);

            totalWeight += weight;
            if (t.outcome === 'win') {
                weightedScore += weight;
            }
        });

        const weightedWinRate = totalWeight > 0 ? (weightedScore / totalWeight) : 0.5;

        let multiplier = 1.0;

        // Scale multiplier linearly between the bounds based on WR relative to 0.5
        // e.g. WR 0.5 = 1.0, WR 0.7 = 1.35 (cap), WR 0.3 = 0.65 (cap)
        if (weightedWinRate > 0.5) {
            multiplier = 1.0 + ((weightedWinRate - 0.5) * 2.0 * 0.35);
        } else if (weightedWinRate < 0.5) {
            multiplier = 1.0 - ((0.5 - weightedWinRate) * 2.0 * 0.35);
        }

        // Hard Caps
        multiplier = Math.max(0.65, Math.min(1.35, multiplier));

        // Round to 3 decimals
        multiplier = Math.round(multiplier * 1000) / 1000;

        this._state.memoizedMultipliers.set(cacheKey, { value: multiplier, timestamp: Date.now() });

        return multiplier;
    },

    getAllMultipliers() {
        // Compute current multiplier for all unique archetypes in current regimes
        const map: Record<string, number> = {};
        const uniqueKeys = new Set(this._state.recentTrades.map(t => `${t.regime}_${t.archetype}`));

        for (const key of uniqueKeys) {
            const [regime, archetype] = key.split('_');
            map[key] = this.getAdaptiveMultiplier(regime, archetype);
        }
        return map;
    },

    getRecentTrades() {
        return this._state.recentTrades;
    }
};
