import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useNexusStore, type MexcPosition } from '../store';

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
    const setOpenMexcPositions = useNexusStore(s => s.setOpenMexcPositions);

    useEffect(() => {
        let cancelled = false;
        let interval: ReturnType<typeof setInterval> | null = null;

        async function refresh() {
            // Balance + positions in parallel — single round-trip latency.
            const [balanceRes, positionsRes] = await Promise.allSettled([
                invoke<number>('get_mexc_balance'),
                invoke<MexcPosition[]>('get_mexc_positions'),
            ]);

            if (cancelled) return;

            if (balanceRes.status === 'fulfilled') {
                const b = balanceRes.value;
                if (typeof b === 'number' && b >= 0) {
                    setBalance(b);
                    setLastBalanceFetchAt(Date.now());
                }
            } else {
                console.warn('[useMexcAccount] balance fetch failed:', balanceRes.reason);
            }

            if (positionsRes.status === 'fulfilled') {
                const p = positionsRes.value;
                if (Array.isArray(p)) {
                    setOpenMexcPositions(p);
                }
            } else {
                console.warn('[useMexcAccount] positions fetch failed:', positionsRes.reason);
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
    }, [setBalance, setMexcConfigured, setLastBalanceFetchAt, setOpenMexcPositions]);
}
