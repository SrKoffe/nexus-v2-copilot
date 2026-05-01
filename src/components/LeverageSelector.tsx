import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useNexusStore } from '../store';
import { LeverageAdjustedRiskEngine } from '../analysis/leverage-risk';

const PRESETS = [10, 25, 50, 100, 200, 500];

/**
 * LeverageSelector — slider + presets in the header.
 * Syncs with Tauri `set_leverage` and the Zustand store. Shows the
 * recommended max SL% for the chosen leverage so Roberto immediately sees
 * the safety profile.
 */
export const LeverageSelector: React.FC = () => {
    const leverage = useNexusStore(s => s.leverage);
    const setLeverage = useNexusStore(s => s.setLeverage);

    const updateLeverage = async (val: number) => {
        const clamped = Math.max(1, Math.min(500, val));
        setLeverage(clamped);
        try {
            await invoke('set_leverage', { leverage: clamped });
        } catch (e) {
            console.warn('[LeverageSelector] set_leverage Tauri call failed:', e);
        }
    };

    const slPct = LeverageAdjustedRiskEngine.targetSlPctForLeverage(leverage);

    // Color shifts as leverage grows — green/cyan/yellow/orange/red
    const accent =
        leverage <= 25 ? '#00ff88' :
        leverage <= 50 ? '#0099ff' :
        leverage <= 100 ? '#ffaa00' :
        leverage <= 200 ? '#ff7700' :
        '#ff4444';

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '0 14px',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            borderRight: '1px solid rgba(255,255,255,0.08)',
        }}>
            <span className="text-secondary text-sm" style={{ letterSpacing: '0.5px' }}>LEV</span>

            <input
                type="range"
                min="1"
                max="500"
                step="1"
                value={leverage}
                onChange={(e) => updateLeverage(parseInt(e.target.value))}
                style={{
                    width: '120px',
                    appearance: 'none',
                    height: '4px',
                    background: `linear-gradient(to right, ${accent} ${(leverage - 1) / 499 * 100}%, rgba(255,255,255,0.1) 0%)`,
                    borderRadius: '2px',
                    outline: 'none',
                    cursor: 'pointer',
                }}
            />

            <span className="mono" style={{
                color: accent,
                fontWeight: 'bold',
                fontSize: '15px',
                minWidth: '54px',
                textAlign: 'right',
                textShadow: `0 0 8px ${accent}40`,
            }}>
                {leverage}x
            </span>

            <div style={{ display: 'flex', gap: '4px' }}>
                {PRESETS.map(l => (
                    <button
                        key={l}
                        onClick={() => updateLeverage(l)}
                        style={{
                            background: leverage === l ? `${accent}22` : 'transparent',
                            border: `1px solid ${leverage === l ? accent : 'rgba(255,255,255,0.1)'}`,
                            color: leverage === l ? accent : '#666',
                            padding: '3px 8px',
                            borderRadius: '4px',
                            fontSize: '10px',
                            cursor: 'pointer',
                            fontFamily: 'JetBrains Mono, monospace',
                            fontWeight: leverage === l ? 'bold' : 'normal',
                            transition: 'all 0.15s',
                        }}
                    >
                        {l}
                    </button>
                ))}
            </div>

            <span className="mono text-xs text-secondary" title="Max SL% recommended for this leverage">
                SL ≤ {slPct}%
            </span>
        </div>
    );
};
