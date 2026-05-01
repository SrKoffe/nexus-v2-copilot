import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useNexusStore } from '../store';

/**
 * useMexcAccount — polls MEXC private API for balance updates.
 *
 * On mount:
 *   1. Asks the Rust backend whether API keys are configured (`mexc_keys_configured`).
 *   2. If yes, fetches USDT equity once, then every 30s.
 *   3. If keys are missing or any call fails, the hook stays quiet — store keeps
 *      the default $1000 fallback so the rest of the UI keeps working.
 *
 * Polling is intentionally slow (30s). Faster would burn MEXC rate limits and
 * isn't useful — balance changes only after a manual trade closes anyway.
 */
const POLL_INTERVAL_MS = 30_000;

export function useMexcAccount() {
    const setBalance = useNexusStore(s => s.setBalance);
    const setMexcConfigured = useNexusStore(s => s.setMexcConfigured);
    const setLastBalanceFetchAt = useNexusStore(s => s.setLastBalanceFetchAt);

    useEffect(() => {
        let cancelled = false;
        let interval: ReturnType<typeof setInterval> | null = null;

        async function refresh() {
            try {
                const balance = await invoke<number>('get_mexc_balance');
                if (cancelled) return;
                if (typeof balance === 'number' && balance >= 0) {
                    setBalance(balance);
                    setLastBalanceFetchAt(Date.now());
                }
            } catch (e) {
                // Common cases: network blip, MEXC rate limit, key permissions wrong.
                // Don't spam the console — log once and let next poll retry.
                console.warn('[useMexcAccount] balance fetch failed:', e);
            }
        }

        async function init() {
            try {
                const configured = await invoke<boolean>('mexc_keys_configured');
                if (cancelled) return;
                setMexcConfigured(configured);
                if (!configured) {
                    console.info(
                        '[useMexcAccount] MEXC API keys not configured. ' +
                        'Add MEXC_API_KEY/MEXC_API_SECRET to .env to enable real balance.'
                    );
                    return;
                }

                await refresh();
                interval = setInterval(refresh, POLL_INTERVAL_MS);
            } catch (e) {
                console.warn('[useMexcAccount] init failed:', e);
                setMexcConfigured(false);
            }
        }

        init();

        return () => {
            cancelled = true;
            if (interval) clearInterval(interval);
        };
    }, [setBalance, setMexcConfigured, setLastBalanceFetchAt]);
}
