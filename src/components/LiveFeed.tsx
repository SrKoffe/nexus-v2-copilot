import React, { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { EventBus } from '../analysis/event-bus';

export const LiveFeed: React.FC = () => {
    const [logs, setLogs] = useState<{ id: number, text: string, type: string }[]>([
        { id: 2, text: "Hunting for real-time market micro-opportunities...", type: "sys" },
        { id: 1, text: "Terminal initialized.", type: "sys" }
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
        <div className="live-feed-inner mono text-xs" style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {logs.map(log => {
                let color = '#8892b0';
                if (log.type === 'buy' || log.type === 'long') color = '#00ff88';
                if (log.type === 'sell' || log.type === 'short') color = '#ff4444';
                if (log.type === 'warn') color = '#ffd700';

                return (
                    <div key={log.id} style={{
                        display: 'flex',
                        gap: '12px',
                        padding: '4px 8px',
                        borderBottom: '1px solid rgba(255,255,255,0.02)',
                        transition: 'background 0.1s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                        <span style={{ color: '#555', flexShrink: 0, width: '70px' }}>
                            {new Date(log.id).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span style={{ color: color, flexShrink: 0, width: '40px', fontWeight: 600 }}>
                            {log.type.toUpperCase().substring(0, 4)}
                        </span>
                        <span style={{ color: '#ccc', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {log.text}
                        </span>
                    </div>
                );
            })}
        </div>
    );
};
