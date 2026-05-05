import React from 'react';
import { useNexusStore } from '../store';

export const SetupCard: React.FC = () => {
    const pendingSetup = useNexusStore(s => s.pendingSetup);
    const pipelineStatus = useNexusStore(s => s.pipelineStatus);
    const pipelineStage = useNexusStore(s => s.pipelineStage);
    
    if (pipelineStage < 4 || pipelineStatus !== 'passed' || !pendingSetup) {
        return (
            <div style={{ padding: '20px', textAlign: 'center', color: '#8892b0' }} className="mono text-sm">
                Pipeline executing... Waiting for setup.
            </div>
        );
    }

    const setup = pendingSetup.adjusted || pendingSetup.natural;
    if (!setup) return null;

    const isLong = setup.direction === 'bullish';
    const color = isLong ? '#00e1ff' : '#ff3366';

    return (
        <div style={{ background: 'rgba(10,15,25,0.6)', border: `1px solid ${color}50`, borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ color: color, fontWeight: 'bold', fontSize: '1.2rem' }}>
                    {isLong ? 'LONG' : 'SHORT'} {setup.symbol}
                </span>
                <span className="mono text-xs" style={{ background: `${color}20`, padding: '4px 8px', borderRadius: '4px', color }}>
                    CONFIDENCE: {(setup.confidence * 100).toFixed(0)}%
                </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '4px' }}>
                    <div className="text-secondary mono text-xs">ENTRY</div>
                    <div className="mono text-md" style={{ color: '#fff' }}>${setup.entryPrice.toFixed(1)}</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '4px' }}>
                    <div className="text-secondary mono text-xs">TARGET (AMT)</div>
                    <div className="mono text-md" style={{ color: '#00e1ff' }}>${setup.takeProfit1.toFixed(1)}</div>
                    <div className="mono text-xs" style={{ color: '#00e1ff' }}>+{setup.takeProfit1Pct.toFixed(2)}%</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '4px' }}>
                    <div className="text-secondary mono text-xs">STOP LOSS</div>
                    <div className="mono text-md" style={{ color: '#ff3366' }}>${setup.stopLoss.toFixed(1)}</div>
                    <div className="mono text-xs" style={{ color: '#ff3366' }}>-{setup.stopLossPct.toFixed(2)}%</div>
                </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px' }}>
                <div className="mono text-xs text-secondary">
                    EV / COSTS: <span style={{ color: '#ffb800' }}>{setup.feesMarginPct}%</span>
                </div>
                <div className="mono text-xs text-secondary">
                    LEVERAGE: <span style={{ color: '#fff' }}>{setup.leverage}x</span>
                </div>
                <div className="mono text-xs text-secondary">
                    REASON: <span style={{ color: '#fff' }}>{setup.reason}</span>
                </div>
            </div>
            
            <button style={{
                background: `${color}20`,
                color: color,
                border: `1px solid ${color}`,
                padding: '10px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold',
                fontFamily: 'JetBrains Mono',
                marginTop: '8px'
            }}>
                EXECUTE ORDER
            </button>
        </div>
    );
};
