/**
 * StateCache - Centralized Structural Cache
 * Stores market state, indicators, and institutional nodes for the analysis engines.
 */
export class StateCacheSystem {
    private cache: Map<string, any>;

    constructor() {
        this.cache = new Map();
    }

    set(key: string, value: any) {
        this.cache.set(key, value);
        // Persist some specific keys to localStorage if needed
        if (['dailyPnL', 'currentLeverage'].includes(key)) {
            localStorage.setItem(`ag_cache_${key}`, JSON.stringify(value));
        }
    }

    get(key: string, defaultValue?: any): any {
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }
        return defaultValue;
    }

    computeVolatilityScore(atrPct: number, volumeRatio: number, deltaAcc: number): number {
        const atrScore = Math.min(40, (atrPct || 0) * 20000);
        const volScore = Math.min(30, Math.max(0, ((volumeRatio || 1) - 1) * 30));
        const deltaScore = Math.min(30, (deltaAcc || 0) * 15);
        return Math.round(atrScore + volScore + deltaScore);
    }

    snapshot(): Record<string, any> {
        return Object.fromEntries(this.cache);
    }

    reset() {
        this.cache.clear();
    }
}

export const StateCache = new StateCacheSystem();
