import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export const PositionTracker: React.FC = () => {
    const [position, setPosition] = useState<any>(null);

    useEffect(() => {
        const fetchPos = async () => {
            try {
                const pos = await invoke('get_active_position');
                setPosition(pos);
            } catch (e) {
                console.error("Failed to fetch position", e);
            }
        };
        
        fetchPos();
        const interval = setInterval(fetchPos, 1000);
        return () => clearInterval(interval);
    }, []);

    if (!position) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#555' }}>
                <p className="text-sm">No active operations</p>
            </div>
        );
    }

    const isLong = position.direction === 'Long';
    const colorClass = isLong ? '#00ff88' : '#ff4444';

    return (
        <div className="position-tracker-inner" style={{ padding: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <span className="mono text-lg" style={{ color: colorClass, fontWeight: 'bold' }}>
                    {position.symbol} {isLong ? 'LONG' : 'SHORT'} <span style={{ fontSize: '12px', color: '#888' }}>{position.leverage}x</span>
                </span>
                <span style={{ 
                    background: position.pnl_pct >= 0 ? 'rgba(0, 255, 136, 0.2)' : 'rgba(255, 68, 68, 0.2)',
                    color: position.pnl_pct >= 0 ? '#00ff88' : '#ff4444',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontWeight: 'bold',
                    fontFamily: 'monospace'
                }}>
                    {position.pnl_pct >= 0 ? '+' : ''}{position.pnl_pct.toFixed(2)}%
                </span>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontFamily: 'monospace', fontSize: '13px' }}>
                <div>
                    <span style={{ color: '#888' }}>Entry: </span>
                    <span style={{ color: '#fff' }}>${position.entry_price.toFixed(1)}</span>
                </div>
                <div>
                    <span style={{ color: '#888' }}>Qty: </span>
                    <span style={{ color: '#fff' }}>{position.quantity}</span>
                </div>
                <div>
                    <span style={{ color: '#888' }}>Target: </span>
                    <span style={{ color: '#00ff88' }}>${position.take_profit?.toFixed(1) || 'None'}</span>
                </div>
                <div>
                    <span style={{ color: '#888' }}>Stop: </span>
                    <span style={{ color: '#ff4444' }}>${position.stop_loss?.toFixed(1) || 'None'}</span>
                </div>
            </div>
            
            <div style={{ marginTop: '20px', textAlign: 'center' }}>
                <button style={{ 
                    background: 'transparent', 
                    border: '1px solid #888', 
                    color: '#888', 
                    padding: '8px 24px', 
                    borderRadius: '4px', 
                    cursor: 'pointer',
                    width: '100%',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    fontSize: '12px'
                }}>
                    Panic Close Output
                </button>
            </div>
        </div>
    );
};
