import React, { useState } from 'react';
import { EventBus } from '../analysis/event-bus';
import { useNexusStore } from '../store';
import type { NaturalSetup } from '../analysis/leverage-risk';
import { generateAndSaveWeeklyReport } from '../analysis/report';

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

type Scenario = 'long_clean' | 'short_clean' | 'long_borderline' | 'tight_sl' | 'low_rr' | 'low_conf' | 'long_liq_target' | 'short_no_liq';

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
    long_liq_target: {
        label: '📍 LONG + Liquidity Target (EQH, conf 0.80)',
        build: (price) => ({
            symbol: 'BTC_USDT',
            direction: 'long',
            entryPrice: price,
            naturalStopLoss: price * (1 - 0.012),
            naturalTakeProfit: price * (1 + 0.035),
            confidence: 0.75,
            reason: 'TEST: Liquidity sweep + EQH target above',
            liquidityStrength: 0.80,
            liquidityTargetPrice: price * (1 + 0.025),
            liquidityTargetSource: 'EQH',
            liquidityTargetConfidence: 0.80,
        }),
    },
    short_no_liq: {
        label: '📍 SHORT no liq node (margin-PnL fallback)',
        build: (price) => ({
            symbol: 'BTC_USDT',
            direction: 'short',
            entryPrice: price,
            naturalStopLoss: price * (1 + 0.012),
            naturalTakeProfit: price * (1 - 0.030),
            confidence: 0.72,
            reason: 'TEST: BOS + no liquidity pool below',
            // No liquidity hints — should use margin-PnL model
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                    <span style={{ color: '#888', fontSize: '10px' }}>Balance:</span>
                    <input
                        type="number"
                        value={balance}
                        onChange={(e) => setBalance(parseFloat(e.target.value) || 0)}
                        style={inputStyle}
                    />
                    <span style={{ color: '#888', fontSize: '10px' }}>USD</span>
                </div>

                <ScalpConfigPanel />

                <ReportPanel />
            </div>

            <div style={{ marginTop: '10px', color: '#555', fontSize: '9px', lineHeight: 1.4 }}>
                Setups use last live price.<br />
                TP/fee config aplicado em PRÓXIMOS setups injetados.
            </div>
        </div>
    );
};

// ─── Weekly report panel (F8c) ──────────────────────────────────────────────

const ReportPanel: React.FC = () => {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);

    // Default vault path — Roberto's Obsidian Leo-Brain. Can be overridden.
    const DEFAULT_VAULT = 'C:/Users/betok/Documents/Obsidian/Leo-Brain';
    const [vaultPath, setVaultPath] = useState(DEFAULT_VAULT);

    const onGenerate = async () => {
        setBusy(true);
        setResult(null);
        try {
            const r = await generateAndSaveWeeklyReport(vaultPath, new Date());
            setResult(`✅ ${r.outcomeCount} outcomes → ${r.path}`);
        } catch (e: any) {
            setResult(`❌ ${e?.toString() ?? 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{
            marginTop: '8px',
            paddingTop: '8px',
            borderTop: '1px dashed rgba(255,255,255,0.06)',
        }}>
            <div style={{ color: '#88ccff', fontSize: '9px', marginBottom: '6px', letterSpacing: '0.5px' }}>
                WEEKLY REPORT (F8)
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <span style={{ color: '#888', fontSize: '10px', width: '70px' }}>Vault:</span>
                <input
                    type="text"
                    value={vaultPath}
                    onChange={(e) => setVaultPath(e.target.value)}
                    style={{ ...inputStyle, width: '180px', fontSize: '9px' }}
                    title="Path absoluto pra raiz do vault Obsidian"
                />
            </div>

            <button
                onClick={onGenerate}
                disabled={busy}
                style={{
                    width: '100%',
                    background: busy ? 'rgba(255,255,255,0.04)' : 'rgba(136,204,255,0.12)',
                    border: '1px solid rgba(136,204,255,0.4)',
                    color: '#88ccff',
                    padding: '6px',
                    borderRadius: '4px',
                    cursor: busy ? 'wait' : 'pointer',
                    fontSize: '11px',
                    fontFamily: 'inherit',
                }}
            >
                {busy ? 'Gerando…' : '📊 Generate this week'}
            </button>

            {result && (
                <div style={{
                    marginTop: '6px',
                    fontSize: '9px',
                    color: result.startsWith('✅') ? '#00ff88' : '#ff7777',
                    wordBreak: 'break-all',
                }}>
                    {result}
                </div>
            )}
        </div>
    );
};

// ─── Scalp config (F7) ─────────────────────────────────────────────────────

const ScalpConfigPanel: React.FC = () => {
    const tp1 = useNexusStore(s => s.tp1NetTarget);
    const tp2 = useNexusStore(s => s.tp2NetTarget);
    const fee = useNexusStore(s => s.takerFeePct);
    const setRiskConfig = useNexusStore(s => s.setRiskConfig);

    return (
        <div style={{
            marginTop: '8px',
            paddingTop: '8px',
            borderTop: '1px dashed rgba(255,255,255,0.06)',
        }}>
            <div style={{ color: '#ffaa00', fontSize: '9px', marginBottom: '6px', letterSpacing: '0.5px' }}>
                SCALP TARGETS (% margin net)
            </div>

            <ConfigRow label="TP1 net" value={tp1} step={0.5} min={0.5} max={20}
                onChange={(v) => setRiskConfig({ tp1NetTarget: v })} suffix="%" />
            <ConfigRow label="TP2 net" value={tp2} step={0.5} min={0.5} max={50}
                onChange={(v) => setRiskConfig({ tp2NetTarget: v })} suffix="%" />
            <ConfigRow label="Taker fee" value={fee} step={0.005} min={0} max={0.2}
                onChange={(v) => setRiskConfig({ takerFeePct: v })} suffix="%" />
        </div>
    );
};

const ConfigRow: React.FC<{
    label: string;
    value: number;
    step: number;
    min: number;
    max: number;
    suffix: string;
    onChange: (v: number) => void;
}> = ({ label, value, step, min, max, suffix, onChange }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <span style={{ color: '#888', fontSize: '10px', width: '70px' }}>{label}:</span>
        <input
            type="number"
            value={value}
            step={step}
            min={min}
            max={max}
            onChange={(e) => {
                const n = parseFloat(e.target.value);
                if (isFinite(n)) onChange(n);
            }}
            style={{ ...inputStyle, width: '60px' }}
        />
        <span style={{ color: '#888', fontSize: '10px' }}>{suffix}</span>
    </div>
);

const inputStyle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.4)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: '#fff',
    padding: '3px 6px',
    borderRadius: '3px',
    fontFamily: 'inherit',
    fontSize: '11px',
    width: '80px',
};
