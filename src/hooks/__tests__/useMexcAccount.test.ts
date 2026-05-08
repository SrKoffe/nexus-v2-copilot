import { test, expect, describe, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useMexcAccount } from "../useMexcAccount";
import { useNexusStore } from "../../store";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = invoke as import("bun:test").Mock<typeof invoke>;

describe("useMexcAccount", () => {
    beforeEach(() => {
        // Reset the store before each test
        useNexusStore.setState({
            balanceUsd: 1000,
            mexcConfigured: null,
            lastBalanceFetchAt: 0,
            openMexcPositions: [],
        });

        // Reset mocks
        mockInvoke.mockReset();

        // Spy on console to avoid cluttering test output with expected warnings
        spyOn(console, 'warn').mockImplementation(() => {});
        spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
    });

    test("should set configured to false and not fetch when keys are missing", async () => {
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'mexc_keys_configured') return false;
            return null;
        });

        renderHook(() => useMexcAccount());

        await waitFor(() => {
            const state = useNexusStore.getState();
            expect(state.mexcConfigured).toBe(false);
        });

        // Ensure balance remains default
        expect(useNexusStore.getState().balanceUsd).toBe(1000);
        // Ensure no other invoke calls were made
        expect(mockInvoke.mock.calls.length).toBe(1);
    });

    test("should fetch balance and positions when configured", async () => {
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'mexc_keys_configured') return true;
            if (cmd === 'get_mexc_balance') return 1234.56;
            if (cmd === 'get_mexc_positions') return [{ symbol: 'BTC_USDT', size: 1 }];
            return null;
        });

        renderHook(() => useMexcAccount());

        await waitFor(() => {
            const state = useNexusStore.getState();
            expect(state.mexcConfigured).toBe(true);
            expect(state.balanceUsd).toBe(1234.56);
            expect(state.openMexcPositions).toEqual([{ symbol: 'BTC_USDT', size: 1 }] as any);
            expect(state.lastBalanceFetchAt).toBeGreaterThan(0);
        });

        expect(mockInvoke.mock.calls.length).toBe(3);
    });

    test("should handle failures gracefully without crashing", async () => {
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'mexc_keys_configured') return true;
            if (cmd === 'get_mexc_balance') throw new Error("Network error");
            if (cmd === 'get_mexc_positions') throw new Error("API error");
            return null;
        });

        renderHook(() => useMexcAccount());

        await waitFor(() => {
            const state = useNexusStore.getState();
            // Store should still indicate it's configured, but retain defaults
            expect(state.mexcConfigured).toBe(true);
            expect(state.balanceUsd).toBe(1000);
            expect(state.openMexcPositions).toEqual([]);
        });

        // Wait briefly to ensure it processed the promises (it would log warnings)
        expect(console.warn).toHaveBeenCalledTimes(2);
    });
});
