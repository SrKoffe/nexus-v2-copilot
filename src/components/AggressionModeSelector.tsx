import React from 'react';
import { useNexusStore } from '../store';

/**
 * AggressionModeSelector (v6.1) — single user-controlled lever for the entire
 * EV/confidence gate. Modulates how aggressive the system is when accepting
 * setups, without changing engine code.
 *
 *   🛡 CONSERVATIVE  — strong edge required (evMul 1.5, minConf 65%)
 *   ⚖ BALANCED      — default (evMul 1.2, minConf 55%)
 *   ⚡ AGGRESSIVE    — cover friction only (evMul 1.0, minConf 45%)
 *   🎯 HUNTER        — accept thin edge (evMul 0.8, minConf 35%)
 */

const MODES = [
    { id: 'conservative', label: 'CONS', icon: '🛡', color: '#88ccdd', desc: 'Strict edge · 1.5× EV gate · 65% conf' },
    { id: 'balanced',     label: 'BAL',  icon: '⚖',  color: '#00e1ff', desc: 'Default · 1.2× EV gate · 55% conf' },
    { id: 'aggressive',   label: 'AGGR', icon: '⚡', color: '#ffb800', desc: 'Cover friction · 1.0× EV gate · 45% conf' },
    { id: 'hunter',       label: 'HUNT', icon: '🎯', color: '#ff7799', desc: 'Thin edge · 0.8× EV gate · 35% conf' },
] as const;

export const AggressionModeSelector: React.FC = () => {
    const mode = useNexusStore(s => s.aggressionMode);
    const setMode = useNexusStore(s => s.setAggressionMode);

    return (
        <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '0 12px',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            borderRight: '1px solid rgba(255,255,255,0.08)',
        }}>
            <span className="text-secondary text-sm" style={{ letterSpacing: '0.5px', marginRight: '4px' }}>
                MODE
            </span>
            {MODES.map(m => (
                <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    title={m.desc}
                    style={{
                        background: mode === m.id ? `${m.color}22` : 'transparent',
                        border: `1px solid ${mode === m.id ? m.color : 'rgba(255,255,255,0.08)'}`,
                        color: mode === m.id ? m.color : '#666',
                        padding: '3px 8px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        cursor: 'pointer',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontWeight: mode === m.id ? 700 : 400,
                        letterSpacing: '0.3px',
                        transition: 'all 0.15s',
                    }}
                >
                    <span style={{ marginRight: '3px' }}>{m.icon}</span>
                    {m.label}
                </button>
            ))}
        </div>
    );
};

/**
 * Helper: returns the EV / confidence modifiers for a given mode.
 * Pure function — used by App.tsx handleSetup to build LeverageRiskConfig.
 */
export function aggressionModifiers(mode: 'conservative' | 'balanced' | 'aggressive' | 'hunter') {
    switch (mode) {
        case 'conservative': return { evMultiplier: 1.5, minConfidence: 0.65, regimeThresholdMul: 1.4 };
        case 'balanced':     return { evMultiplier: 1.2, minConfidence: 0.55, regimeThresholdMul: 1.0 };
        case 'aggressive':   return { evMultiplier: 1.0, minConfidence: 0.45, regimeThresholdMul: 0.7 };
        case 'hunter':       return { evMultiplier: 0.8, minConfidence: 0.35, regimeThresholdMul: 0.4 };
    }
}
