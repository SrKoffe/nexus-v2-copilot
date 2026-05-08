import { useEffect } from 'react';
import { EventBus } from '../analysis/event-bus';
import { candleManager } from '../analysis/candle-manager';
import { RegimeEngine, type RegimeResult } from '../analysis/regime-engine';
import { useNexusStore } from '../store';

/**
 * useRegimeDetection — runs RegimeEngine after every CANDLE_CLOSE.
 *
 * The engine itself emits REGIME_DETECTED on the EventBus; this hook just
 * mounts the loop, listens for the result, and pushes it into the Zustand
 * store so all UI components (MarketStateBadge, HUD, ScalpingControlPanel)
 * see consistent state.
 *
 * Falls back to a 30s polling interval in case CANDLE_CLOSE doesn't fire
 * (e.g. early in the session before history loads).
 */
export function useRegimeDetection() {
    const setRegime = useNexusStore(s => s.setRegime);

    useEffect(() => {
        const evaluate = () => {
            const candles = (candleManager as any).candles1m;
            const result = RegimeEngine.evaluate(candles);
            // RegimeEngine already emitted REGIME_DETECTED if result was non-null;
            // listener below catches that. We don't push directly here to keep
            // a single source of truth.
            return result;
        };

        const onRegimeDetected = (result: RegimeResult) => {
            setRegime(result);
        };

        EventBus.on('REGIME_DETECTED', onRegimeDetected);

        // Re-evaluate on every candle close
        const onCandleClose = () => evaluate();
        EventBus.on('CANDLE_CLOSE', onCandleClose);

        // Initial evaluation (in case history is already loaded)
        evaluate();

        // Fallback: re-evaluate every 30s even if no candle close fires
        const fallback = setInterval(evaluate, 30_000);

        return () => {
            EventBus.off?.('REGIME_DETECTED', onRegimeDetected);
            EventBus.off?.('CANDLE_CLOSE', onCandleClose);
            clearInterval(fallback);
        };
    }, [setRegime]);
}
