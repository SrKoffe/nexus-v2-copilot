// @ts-nocheck
import { EventBus } from './event-bus';

export const FastPathEngine = {
    _state: {
        tickQueue: [],
        lastSetupMs: 0
    },

    subscribe() {
        if (typeof EventBus === 'undefined') return;

        EventBus.on('MARKET_TICK', (tick) => {
            this._processTick(tick);
        });

        console.log('🚀 [FastPathEngine] Microstructure detection active.');
    },

    _processTick(tick) {
        const now = Date.now();
        this._state.tickQueue.push({ ...tick, receivedAt: now });

        // Maintain trailing 60 seconds
        const cutoff = now - 60000;
        while (this._state.tickQueue.length > 0 && this._state.tickQueue[0].receivedAt < cutoff) {
            this._state.tickQueue.shift();
        }

        this._detectAnomaly(now, tick.price);
    },

    _detectAnomaly(now, currentPrice) {
        const q = this._state.tickQueue;
        if (q.length < 50) return;

        // We look for volume spikes in the last 5 seconds compared to the 60s window
        const recentCutoff = now - 5000;
        let recentVol = 0;
        let recentBuyVol = 0;
        let recentSellVol = 0;
        let totalVol = 0;

        for (let i = 0; i < q.length; i++) {
            const t = q[i];
            const v = t.quantity || t.volume || 0;
            totalVol += v;
            if (t.receivedAt >= recentCutoff) {
                recentVol += v;
                if (t.is_buyer_maker === false) { // Buyer is taker
                    recentBuyVol += v;
                } else if (t.is_buyer_maker === true) {
                    recentSellVol += v;
                }
            }
        }

        // Calculate the actual elapsed time in the queue
        const firstTickTime = q[0].receivedAt;
        const elapsedTime = now - firstTickTime;

        // Ensure we have at least 15 seconds of data before detecting anomalies
        // to establish a meaningful baseline
        if (elapsedTime < 15000) return;

        const avgVolPer5s = (totalVol / elapsedTime) * 5000;
        if (avgVolPer5s <= 0) return;

        const volSpikeRatio = recentVol / avgVolPer5s;

        // Very aggressive condition: Volume > 4x average, AND strong delta
        if (volSpikeRatio > 4.0) {
            const buyDominance = recentBuyVol / recentVol;
            const sellDominance = recentSellVol / recentVol;

            let direction = null;
            if (buyDominance > 0.8) direction = 'long';
            else if (sellDominance > 0.8) direction = 'short';

            if (direction && now - this._state.lastSetupMs > 10000) { // 10s cooldown
                this._state.lastSetupMs = now;

                const score = Math.min(100, 50 + (volSpikeRatio * 5));

                const setup = {
                    type: 'micro_scalp',
                    direction,
                    score,
                    entryZone: { low: currentPrice * 0.9995, high: currentPrice * 1.0005, center: currentPrice },
                    stopLoss: direction === 'long' ? currentPrice * 0.998 : currentPrice * 1.002,
                    targets: [direction === 'long' ? currentPrice * 1.002 : currentPrice * 0.998],
                    quality: score >= 85 ? 'S' : score >= 75 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D',
                    tier: score >= 85 ? 'S' : score >= 75 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D',
                    confirmations: ['volume_velocity_anomaly', `ratio_${volSpikeRatio.toFixed(1)}x`],
                    createdAt: now,
                    ttl: 3,
                    urgency: 'immediate'
                };

                EventBus.emit('SCALP_SETUP', {
                    setup,
                    eventSource: 'MARKET_TICK',
                    latencyMs: 1
                });
                console.log(`⚡ [FastPathEngine] Velocity Anomaly Detected: ${direction} (Ratio: ${volSpikeRatio.toFixed(1)}x)`);
            }
        }
    }
};

if (typeof window !== 'undefined') {
    window.FastPathEngine = FastPathEngine;

    document.addEventListener('DOMContentLoaded', () => {
        if (window.FastPathEngine.subscribe) {
            window.FastPathEngine.subscribe();
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FastPathEngine;
}
