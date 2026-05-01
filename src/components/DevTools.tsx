import React, { useState } from 'react';
import { EventBus } from '../analysis/event-bus';
import { useNexusStore } from '../store';
import type { NaturalSetup } from '../analysis/leverage-risk';

/**
 * DevTools — visible only in dev (`import.meta.env.DEV === true`).
 *
 * Lets Roberto inject synthetic setups to validate the full pipeline without
 * waiting for the market to actually trigger one. The injected setup goes
 * through the same path as a real Maestro emission:
 *   EventBus.emit('SETUP_DETECTED', natural)
 *      → App.tsx listener calls LeverageAdjustedRiskEngine.adjust()
 *      → store.pendingSetup updated
 *      → SetupCard renders accepted/rejected
 *      → user can mark as taken → PositionTracker → outcome buttons
 */

type Scenario = 'long_clean' | 'short_clean' | 'long_borderline' | 'tight_sl' | 'low_rr' | 'low_conf';

const SCENARIOS: Record<Scenario, { label: string; build: (price: number) => NaturalSetup }> = {
    long_clean: {
        label: '↑ LONG clean (1.2% SL, 3% TP, conf 0.78)',
        build: (price) => ({
            symbol: 'BTC_USDT',
            direction: 'long',
            entryPrice: price,
            naturalStopLoss: price * (1 - 0.012),
            naturalTakeProfit: price * (1 + 0.030),
            confidence: 0.78,
            reason: 'TEST: Liquidity sweep + bullish OB retest',
        }),
    },
    short_clean: {
        label: '↓ SHORT clean (1.2% SL, 3% TP, conf 0.72)',
        build: (price) => ({
            symbol: 'BTC_USDT',
            direction: 'short',
            entryPrice: price,
            naturalStopLoss: price * (1 + 0.012),
            naturalTakeProfit: price * (1 - 0.030),
            confidence: 0.72,
            reason: 'TEST: BOS + premium zone rejection',
        }),
    },
    long_borderline: {
        label: '↑ LONG borderline (0.6% SL — testar leverage adjust)',
        build: (price) => ({
            symbol: 'BTC_USDT',
            direction: 'long',
            entryPrice: price,
            naturalStopLoss: price * (1 - 0.006),
            naturalTakeProfit: price * (1 + 0.012),
            confidence: 0.65,
            reason: 'TEST: tight structure',
        }),
    },
    tight_sl: {
        label: '⚠ Tight SL (deve REJECT em x100+)',
        build: (price) => ({
            symbol: 'BTC_USDT',
            direction: 'long',
            entryPrice: price,
            naturalStopLoss: price * (1 - 0.025),  // 2.5% — large natural SL
            naturalTakeProfit: price * (1 + 0.05),
            confidence: 0.70,
            reason: 'TEST: structure SL too wide for high leverage',
        }),
    },
    low_rr: {
        label: '✗ Low RR (deve REJECT)',
        build: (price) => ({
            symbol: 'BTC_USDT',
            direction: 'long',
            entryPrice: price,
            naturalStopLoss: price * (1 - 0.010),
            naturalTakeProfit: price * (1 + 0.012),  // RR ~1.2 < 1.5 mínimo
            confidence: 0.70,
            reason: 'TEST: insufficient reward',
        }),
    },
    low_conf: {
        label: '✗ Low confidence (deve REJECT)',
        build: (price) => ({
            symbol: 'BTC_USDT',
            direction: 'long',
            entryPrice: price,
            naturalStopLoss: price * (1 - 0.012),
            naturalTakeProfit: price * (1 + 0.030),
            confidence: 0.40,  // < 0.55 mínimo
            reason: 'TEST: weak signal',
        }),
    },
};

export const DevTools: React.FC = () => {
    if (!import.meta.env.DEV) return null;

    const [open, setOpen] = useState(false);
    const balance = useNexusStore(s => s.balanceUsd);
    const setBalance = useNexusStore(s => s.setBalance);

    const inject = (scenario: Scenario) => {
        // Use last live price if available; fallback to 65000
        const lastPrice =
            (window as any).__lastLivePrice ??
            65000;
        const natural = SCENARIOS[scenario].build(lastPrice);
        EventBus.emit('SETUP_DETECTED', natural);
        console.log('[DevTools] Injected setup:', scenario, natural);
    };

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                style={{
                    position: 'fixed',
                    bottom: '12px',
                    right: '12px',
                    background: 'rgba(255, 170, 0, 0.15)',
                    border: '1px solid #ffaa00',
                    color: '#ffaa00',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    fontSize: '10px',
                    fontFamily: 'JetBrains Mono, monospace',
                    cursor: 'pointer',
                    zIndex: 9999,
                    letterSpacing: '0.5px',
                }}
                title="Dev-only: inject synthetic setups for E2E testing"
            >
                🧪 DEV
            </button>
        );
    }

    return (
        <div
            style={{
                position: 'fixed',
                bottom: '12px',
                right: '12px',
                width: '300px',
                background: 'rgba(15, 18, 28, 0.97)',
                border: '1px solid rgba(255, 170, 0, 0.4)',
                borderRadius: '8px',
                padding: '12px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                zIndex: 9999,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '11px',
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <span style={{ color: '#ffaa00', fontWeight: 'bold', letterSpacing: '0.5px' }}>🧪 DEV TOOLS</span>
                <button
                    onClick={() => setOpen(false)}
                    style={{ background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', fontSize: '14px' }}
                >×</button>
            </div>

            <div style={{ marginBottom: '8px', color: '#888', fontSize: '10px' }}>
                Inject synthetic setup → goes through full pipeline:
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {(Object.keys(SCENARIOS) as Scenario[]).map((s) => (
                    <button
                        key={s}
                        onClick={() => inject(s)}
                        style={{
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            color: '#ddd',
                            padding: '6px 8px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '10px',
                            textAlign: 'left',
                            fontFamily: 'inherit',
                        }}
                    >
                        {SCENARIOS[s].label}
                    </button>
                ))}
            </div>

            <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: '#888', fontSize: '10px' }}>Balance:</span>
                    <input
                        type="number"
                        value={balance}
                        onChange={(e) => setBalance(parseFloat(e.target.value) || 0)}
                        style={{
                            background: 'rgba(0,0,0,0.4)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            color: '#fff',
                            padding: '3px 6px',
                            borderRadius: '3px',
                            fontFamily: 'inherit',
                            fontSize: '11px',
                            width: '80px',
                        }}
                    />
                    <span style={{ color: '#888', fontSize: '10px' }}>USD</span>
                </div>
            </div>

            <div style={{ marginTop: '10px', color: '#555', fontSize: '9px', lineHeight: 1.4 }}>
                Setups use last live price.<br />
                Borderline tests show how leverage tightens SL.
            </div>
        </div>
    );
};
