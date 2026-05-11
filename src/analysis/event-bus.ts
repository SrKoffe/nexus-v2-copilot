/**
 * EventBus - Lightweight Pub/Sub System
 * High-performance event dispatcher for the Antigravity analysis pipeline.
 */

// 1. Defined namespaces as requested
export const SCANNER_EVENTS = {
    UNIVERSE_UPDATE: 'scanner:universe_update',
    TOP_CANDIDATES: 'scanner:top_candidates',
    SYMBOL_PROMOTED: 'scanner:symbol_promoted',
};

export const ANALYSIS_EVENTS = {
    CANDLE_CLOSE: 'CANDLE_CLOSE',
    MICRO_BOS: 'MICRO_BOS',
    MSS_DETECTED: 'MSS_DETECTED',
    REGIME_CHANGE: 'REGIME_CHANGE',
    REGIME_DETECTED: 'REGIME_DETECTED',
    LIQUIDITY_SWEEP: 'LIQUIDITY_SWEEP',
    OB_RETEST: 'OB_RETEST',
    HVN_REJECTION: 'HVN_REJECTION',
    FVG_FILL: 'FVG_FILL',
    DELTA_SPIKE: 'DELTA_SPIKE',
    ABSORPTION: 'ABSORPTION',
    MARKET_TICK: 'MARKET_TICK',
    TICK_UPDATE: 'TICK_UPDATE',
    AGG_TRADE: 'AGG_TRADE',
    BOOK_TICKER: 'BOOK_TICKER',
    SCALP_SETUP: 'SCALP_SETUP',
    ANALYSIS_SIGNAL: 'ANALYSIS_SIGNAL',
    LEVEL_1_PASSED: 'LEVEL_1_PASSED',
    LEVEL_2_PASSED: 'LEVEL_2_PASSED',
    POC_SHIFT: 'POC_SHIFT',
    LVN_INTERACTION: 'LVN_INTERACTION',
};

export const EXECUTION_EVENTS = {
    SETUP_DETECTED: 'SETUP_DETECTED',
    EXECUTION_SIGNAL: 'EXECUTION_SIGNAL',
    EXECUTION_FILLED: 'EXECUTION_FILLED',
    ORDER_FILLED: 'ORDER_FILLED',
    TRADE_CLOSED: 'TRADE_CLOSED',
};

export const UI_EVENTS = {
    SYMBOL_CHANGED: 'SYMBOL_CHANGED',
};

export const METRICS_EVENTS = {
    SIMULATION_CANDLE: 'SIMULATION_CANDLE',
    SIMULATION_COMPLETE: 'SIMULATION_COMPLETE',
};

export class EventBusSystem {
    private listeners: Map<string, Function[]>;
    private history: any[];
    private maxHistory: number;
    private throttleTimers: Map<string, number>;
    private throttleLimits: Map<string, number>;
    private trailingTimeouts: Map<string, any>;
    public EVENTS: Record<string, string>;

    constructor() {
        this.listeners = new Map();
        this.history = [];
        this.maxHistory = 100;
        this.throttleTimers = new Map();
        this.throttleLimits = new Map();
        this.trailingTimeouts = new Map();
        
        // Backward compatibility
        this.EVENTS = {
            ...SCANNER_EVENTS,
            ...ANALYSIS_EVENTS,
            ...EXECUTION_EVENTS,
            ...UI_EVENTS,
            ...METRICS_EVENTS,
        };

        // Define throttle limits for high frequency events (ms)
        this.throttleLimits.set('MARKET_TICK', 50); // Max 20fps
        this.throttleLimits.set('TICK_UPDATE', 50);
        this.throttleLimits.set('ANALYSIS_SIGNAL', 50); // UI sync
        this.throttleLimits.set('SCALP_SETUP', 50);
    }

    on(event: string, handler: Function) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)?.push(handler);
    }

    off(event: string, handler: Function) {
        if (!this.listeners.has(event)) return;
        const currentHandlers = this.listeners.get(event) || [];
        const filteredHandlers = currentHandlers.filter(h => h !== handler);
        if (filteredHandlers.length === 0) {
            this.listeners.delete(event);
        } else {
            this.listeners.set(event, filteredHandlers);
        }
    }

    emit(event: string, payload: any = {}) {
        const now = performance.now();

        // Leading-edge + trailing-edge throttling logic
        const limit = this.throttleLimits.get(event);
        if (limit) {
            const lastTime = this.throttleTimers.get(event) || 0;
            if (now - lastTime < limit) {
                // If there's an existing trailing timeout, clear it to replace with this newer payload
                const existingTimeout = this.trailingTimeouts.get(event);
                if (existingTimeout) clearTimeout(existingTimeout);

                // Schedule this event to run at the trailing edge
                const trailing = setTimeout(() => {
                    this.throttleTimers.set(event, performance.now());
                    this._dispatch(event, payload, performance.now());
                }, limit - (now - lastTime));

                this.trailingTimeouts.set(event, trailing);
                return; // Suppress the immediate leading edge
            }
            this.throttleTimers.set(event, now);
        }

        this._dispatch(event, payload, now);
    }

    private _dispatch(event: string, payload: any, now: number) {

        const eventRecord = {
            event,
            payload,
            timestamp: Date.now(),
            dispatchTimeMs: now
        };

        this.history.push(eventRecord);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        const handlers = this.listeners.get(event);
        if (!handlers) return;

        for (const handler of handlers) {
            try {
                handler(payload);
            } catch (err) {
                console.error(`[EventBus] Error in handler for event: ${event}`, err);
            }
        }
    }

    getHistory() {
        return this.history;
    }
}

export const EventBus = new EventBusSystem();
