import React, { useState, useEffect } from 'react';
import { useNexusStore } from '../store';
import { EventBus } from '../analysis/event-bus';
import { StateCache } from '../analysis/state-cache';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * SETUP STRENGTH METER — Quick visual quality indicator (0-100).
 * ═══════════════════════════════════════════════════════════════════════
 */

function getStrength(): { score: number; label: string; color: string } {
    const pending = useNexusStore.getState().pendingSetup;
    if (!pending?.adjusted?.accepted) {
        return { score: 0, label: 'NO SETUP', color: '#555' };
    }

    const adj = pending.adjusted as any;
    const confidence = adj.confidence || 0;
    const survival = adj.survivalScore || 0;
    const edge = confidence - (adj.breakEvenWinRate || 0);

    // Weighted composite score
    const score = Math.round(
        Math.min(100, Math.max(0,
            (confidence * 40) +           // 40% weight: confidence
            (survival * 30) +             // 30% weight: survival
            (Math.max(0, edge) * 200) +   // 30% weight: statistical edge
            0
        ))
    );

    let label = 'Weak';
    let color = '#ff3366';
    if (score >= 70) { label = 'Strong'; color = '#00ff88'; }
    else if (score >= 45) { label = 'Moderate'; color = '#ffb800'; }

    return { score, label, color };
}

export const SetupStrengthMeter: React.FC = () => {
    const [strength, setStrength] = useState(getStrength);
    const pending = useNexusStore(s => s.pendingSetup);

    useEffect(() => {
        setStrength(getStrength());
    }, [pending]);

    useEffect(() => {
        const refresh = () => setStrength(getStrength());
        EventBus.on('SCALP_SETUP', refresh);
        const interval = setInterval(refresh, 2000);
        return () => {
            EventBus.off('SCALP_SETUP', refresh);
            clearInterval(interval);
        };
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {/* Label + score */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: '10px', fontWeight: 700, color: strength.color, letterSpacing: '0.5px' }}>
                    {strength.label.toUpperCase()}
                </span>
                <span className="mono" style={{ fontSize: '18px', fontWeight: 700, color: strength.color }}>
                    {strength.score}
                </span>
            </div>

            {/* Progress bar */}
            <div style={{
                height: '6px', borderRadius: '3px',
                background: 'rgba(255,255,255,0.06)',
                overflow: 'hidden',
            }}>
                <div style={{
                    width: `${strength.score}%`,
                    height: '100%',
                    borderRadius: '3px',
                    background: `linear-gradient(90deg, ${strength.color}88, ${strength.color})`,
                    transition: 'width 0.4s ease, background 0.4s ease',
                    boxShadow: `0 0 8px ${strength.color}44`,
                }} />
            </div>
        </div>
    );
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * MARKET DIFFICULTY INDICATOR — How hard is it to trade right now?
 * ═══════════════════════════════════════════════════════════════════════
 */

function getDifficulty(): { mode: string; color: string; explanation: string } {
    const regime = StateCache.get('currentRegime', 'unknown');
    const regimeConf = StateCache.get('regimeConfidence', 50);
    const volScore = StateCache.get('lastVolatilityScore', 0);

    // Check for conflicting signals
    const obi = StateCache.get('aggressiveImbalance', null);
    const book = StateCache.get('bookImbalance', null);
    let hasConflict = false;
    if (obi?.detected && book?.detected) {
        const tradeDir = obi.direction === 'buy_aggression' ? 'buy' : 'sell';
        const bookDir = book.direction === 'buy_heavy' ? 'buy' : 'sell';
        hasConflict = tradeDir !== bookDir;
    }

    // Scoring: lower = harder
    let diffScore = 50; // baseline

    // Regime clarity
    if (regime?.includes('trending') && regimeConf > 70) diffScore += 25;
    else if (regime === 'range' && regimeConf > 60) diffScore += 10;
    else if (regime === 'choppy') diffScore -= 20;
    else diffScore -= 10;

    // Volatility: too low or too high = harder
    if (volScore > 20 && volScore < 60) diffScore += 10;
    else if (volScore > 80) diffScore -= 15;
    else if (volScore < 5) diffScore -= 10;

    // Conflicts
    if (hasConflict) diffScore -= 20;

    // Map to labels
    if (diffScore >= 65) {
        return {
            mode: 'EASY MODE',
            color: '#00ff88',
            explanation: 'Clean trend, aligned signals — favorable conditions',
        };
    } else if (diffScore >= 40) {
        return {
            mode: 'NORMAL',
            color: '#ffb800',
            explanation: 'Mixed signals — standard risk management',
        };
    } else {
        return {
            mode: 'HARD MODE',
            color: '#ff3366',
            explanation: `Chop${hasConflict ? ' + conflicting signals' : ''} — reduce size or sit out`,
        };
    }
}

export const MarketDifficultyIndicator: React.FC = () => {
    const [diff, setDiff] = useState(getDifficulty);

    useEffect(() => {
        const refresh = () => setDiff(getDifficulty());
        EventBus.on('ANALYSIS_SIGNAL', refresh);
        EventBus.on('MARKET_TICK', refresh);
        const interval = setInterval(refresh, 3000);
        return () => {
            EventBus.off('ANALYSIS_SIGNAL', refresh);
            EventBus.off('MARKET_TICK', refresh);
            clearInterval(interval);
        };
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
                <span style={{ fontSize: '10px', color: '#8892b0', fontWeight: 600 }}>DIFFICULTY</span>
                <span className="mono" style={{
                    fontSize: '12px', fontWeight: 700, color: diff.color,
                    padding: '1px 6px', borderRadius: '3px',
                    background: `${diff.color}15`, border: `1px solid ${diff.color}30`,
                }}>
                    {diff.mode}
                </span>
            </div>
            <div style={{ fontSize: '10px', color: '#777', lineHeight: '1.3' }}>
                {diff.explanation}
            </div>
        </div>
    );
};
