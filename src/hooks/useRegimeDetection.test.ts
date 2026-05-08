import { test, expect, describe, mock, beforeEach, spyOn } from "bun:test";
import * as React from "react";
import { useRegimeDetection } from "./useRegimeDetection";
import { EventBus } from "../analysis/event-bus";
import { candleManager } from "../analysis/candle-manager";
import { RegimeEngine } from "../analysis/regime-engine";
import * as store from "../store";

describe("useRegimeDetection", () => {
    let mockSetRegime: any;
    let effectCallback: any;
    let cleanupCallback: any;
    let mockEventBusOn: any;
    let mockEventBusOff: any;
    let mockEvaluate: any;
    let mockSetInterval: any;
    let mockClearInterval: any;

    beforeEach(() => {
        mockSetRegime = mock();
        spyOn(store, "useNexusStore").mockImplementation((selector: any) => {
            return selector({ setRegime: mockSetRegime });
        });

        // Mock React.useEffect to capture the callback
        spyOn(React, "useEffect").mockImplementation((cb: any, deps: any) => {
            effectCallback = cb;
        });

        mockEventBusOn = spyOn(EventBus, "on").mockImplementation(() => {});
        mockEventBusOff = spyOn(EventBus, "off").mockImplementation(() => {});

        mockEvaluate = spyOn(RegimeEngine, "evaluate").mockImplementation(() => ({
            regime: "trend_up",
            confidence: 0.8,
            reasons: [],
            factors: {}
        } as any));

        candleManager.candles1m = [] as any;

        mockSetInterval = spyOn(globalThis, "setInterval").mockImplementation(() => 123 as any);
        mockClearInterval = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    });

    test("setup and teardown logic", () => {
        // Run the hook
        useRegimeDetection();

        // Ensure useEffect was called
        expect(effectCallback).toBeDefined();

        // Run the captured effect callback
        cleanupCallback = effectCallback();

        // 1. Initial evaluation
        expect(mockEvaluate).toHaveBeenCalledTimes(1);
        expect(mockEvaluate).toHaveBeenCalledWith(candleManager.candles1m);

        // 2. Event listeners registered
        expect(mockEventBusOn).toHaveBeenCalledWith('REGIME_DETECTED', expect.any(Function));
        expect(mockEventBusOn).toHaveBeenCalledWith('CANDLE_CLOSE', expect.any(Function));

        // 3. Fallback interval created
        expect(mockSetInterval).toHaveBeenCalledWith(expect.any(Function), 30000);

        // --- Run event listener tests ---

        // Test REGIME_DETECTED listener
        const onRegimeDetected = mockEventBusOn.mock.calls.find((call: any) => call[0] === 'REGIME_DETECTED')?.[1];
        expect(onRegimeDetected).toBeDefined();

        const dummyResult = { regime: "range", confidence: 0.9 };
        onRegimeDetected(dummyResult);
        expect(mockSetRegime).toHaveBeenCalledWith(dummyResult);

        // Test CANDLE_CLOSE listener
        const onCandleClose = mockEventBusOn.mock.calls.find((call: any) => call[0] === 'CANDLE_CLOSE')?.[1];
        expect(onCandleClose).toBeDefined();

        onCandleClose();
        expect(mockEvaluate).toHaveBeenCalledTimes(2);

        // Test fallback interval callback
        const fallbackCb = mockSetInterval.mock.calls[0][0];
        expect(fallbackCb).toBeDefined();

        fallbackCb();
        expect(mockEvaluate).toHaveBeenCalledTimes(3);

        // --- Test Cleanup ---
        expect(cleanupCallback).toBeDefined();
        cleanupCallback();

        expect(mockEventBusOff).toHaveBeenCalledWith('REGIME_DETECTED', onRegimeDetected);
        expect(mockEventBusOff).toHaveBeenCalledWith('CANDLE_CLOSE', onCandleClose);
        expect(mockClearInterval).toHaveBeenCalledWith(123);
    });
});
