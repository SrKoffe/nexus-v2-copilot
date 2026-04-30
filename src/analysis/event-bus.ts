/**
 * EventBus - Lightweight Pub/Sub System
 * High-performance event dispatcher for the Antigravity analysis pipeline.
 */
export class EventBusSystem {
    private listeners: Map<string, Function[]>;
    private history: any[];
    private maxHistory: number;
    public EVENTS: Record<string, string>;

    constructor() {
        this.listeners = new Map();
        this.history = [];
        this.maxHistory = 100;
        
        this.EVENTS = {
            CANDLE_CLOSE: 'CANDLE_CLOSE',
            MICRO_BOS: 'MICRO_BOS',
            MSS_DETECTED: 'MSS_DETECTED',
            REGIME_CHANGE: 'REGIME_CHANGE',
            LIQUIDITY_SWEEP: 'LIQUIDITY_SWEEP',
            OB_RETEST: 'OB_RETEST',
            HVN_REJECTION: 'HVN_REJECTION',
            FVG_FILL: 'FVG_FILL',
            DELTA_SPIKE: 'DELTA_SPIKE',
            ABSORPTION: 'ABSORPTION',
            MARKET_TICK: 'MARKET_TICK',
            AGG_TRADE: 'AGG_TRADE',
            BOOK_TICKER: 'BOOK_TICKER',
            SCALP_SETUP: 'SCALP_SETUP',
            ANALYSIS_SIGNAL: 'analysis:signal',
            EXECUTION_SIGNAL: 'EXECUTION_SIGNAL',
            EXECUTION_FILLED: 'EXECUTION_FILLED',
            SIMULATION_CANDLE: 'SIMULATION_CANDLE',
            SIMULATION_COMPLETE: 'SIMULATION_COMPLETE'
        };
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
