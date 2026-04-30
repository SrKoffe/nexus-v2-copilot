import React, { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { EventBus } from '../analysis/event-bus';

export const LiveFeed: React.FC = () => {
    const [logs, setLogs] = useState<{ id: number, text: string, type: string }[]>([
        { id: 2, text: "Hunting for institutional liquidity sweeps...", type: "sys" },
        { id: 1, text: "Antigravity OS v2 terminal initialized.", type: "sys" }
    ]);

    useEffect(() => {
        // 1. Listen for Frontend Analysis Signals
        const handleSignal = (signal: any) => {
            setLogs(prev => {
                const text = `${signal.source}: ${signal.direction.toUpperCase()} (${(signal.probability * 100).toFixed(0)}%)`;
                const newLogs = [{ 
                    id: Date.now(), 
                    text, 
                    type: signal.direction 
                }, ...prev];
                return newLogs.slice(0, 50);
            });
        };

        EventBus.on('ANALYSIS_SIGNAL', handleSignal);

        // 2. Listen for Backend Events
        const unlistenTauri = listen<any>('analysis-signal', (event) => {
            setLogs(prev => [{ id: Date.now(), text: event.payload.message || JSON.stringify(event.payload), type: 'info' }, ...prev].slice(0, 50));
        });

        return () => {
            EventBus.off('ANALYSIS_SIGNAL', handleSignal);
            unlistenTauri.then(f => f());
        };
    }, []);

    return (
        <div className="live-feed-inner mono text-xs" style={{ height: '100%', overflowY: 'auto', paddingRight: '8px' }}>
            {logs.map(log => {
                let color = '#8892b0';
                if (log.type === 'buy' || log.type === 'long') color = '#00ff88';
                if (log.type === 'sell' || log.type === 'short') color = '#ff4444';
                if (log.type === 'warn') color = '#ffd700';

                return (
                    <div key={log.id} style={{ marginBottom: '6px', borderLeft: `2px solid ${color}`, paddingLeft: '8px', background: 'rgba(255,255,255,0.02)' }}>
                        <span style={{ color: '#555' }}>[{new Date(log.id).toLocaleTimeString()}]</span>{' '}
                        <span style={{ color: '#0099ff' }}>[{log.type.toUpperCase()}]</span>{' '}
                        <span style={{ color }}>{log.text}</span>
                    </div>
                );
            })}
        </div>
    );
};
