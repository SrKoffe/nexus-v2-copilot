import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export const OrderPanel: React.FC = () => {
    const [leverage, setLeverage] = useState(50);
    const [isOracle, setIsOracle] = useState(true);
    const [orderSize, setOrderSize] = useState("1000");
    const [takeProfit, setTakeProfit] = useState("2.0");
    const [stopLoss, setStopLoss] = useState("1.0");
    const [allowVolTrigger, setAllowVolTrigger] = useState(true);

    const toggleVolTrigger = async () => {
        const newVal = !allowVolTrigger;
        await invoke('set_vol_trigger', { allow: newVal });
        setAllowVolTrigger(newVal);
    };

    const toggleOracle = async () => {
        const newOracle = !isOracle;
        await invoke('toggle_oracle_mode', { enabled: newOracle });
        setIsOracle(newOracle);
    };

    const updateLeverage = async (val: number) => {
        setLeverage(val);
        await invoke('set_leverage', { leverage: val });
    };

    return (
        <div className="order-panel-inner" style={{ padding: '0px 8px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
            {/* Header controls */}
            <div className="flex justify-between align-center">
                <span className="text-secondary text-sm">Mode:</span>
                <button 
                    style={{
                        background: isOracle ? 'rgba(0, 153, 255, 0.15)' : 'rgba(255, 68, 68, 0.15)',
                        border: `1px solid ${isOracle ? '#0099ff' : '#ff4444'}`,
                        color: isOracle ? '#0099ff' : '#ff4444',
                        padding: '6px 14px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: '700',
                        fontSize: '12px',
                        letterSpacing: '1px'
                    }}
                    onClick={toggleOracle}
                >
                    {isOracle ? '🛡️ ORACLE' : '🔴 LIVE'}
                </button>
            </div>

            <div className="flex justify-between align-center">
                <span className="text-secondary text-sm">V-Spike:</span>
                <button 
                    style={{
                        background: allowVolTrigger ? 'rgba(0, 255, 136, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                        border: `1px solid ${allowVolTrigger ? '#00ff88' : '#444'}`,
                        color: allowVolTrigger ? '#00ff88' : '#888',
                        padding: '6px 14px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: '700',
                        fontSize: '10px',
                    }}
                    onClick={toggleVolTrigger}
                >
                    {allowVolTrigger ? 'ON' : 'OFF'}
                </button>
            </div>
            
            {/* Leverage Control */}
            <div style={{ padding: '0 4px' }}>
                <div className="flex justify-between align-center mb-10">
                    <span className="text-secondary text-sm">Leverage:</span>
                    <span className="text-blue mono" style={{ fontSize: '16px', fontWeight: 'bold', textShadow: '0 0 10px rgba(0, 153, 255, 0.4)' }}>{leverage}x</span>
                </div>
                
                {/* Range Slider */}
                <div style={{ marginBottom: '14px', position: 'relative' }}>
                    <input 
                        type="range" 
                        min="1" 
                        max="100" 
                        step="1"
                        value={leverage}
                        onChange={(e) => updateLeverage(parseInt(e.target.value))}
                        style={{
                            width: '100%',
                            appearance: 'none',
                            height: '4px',
                            background: `linear-gradient(to right, #0099ff ${(leverage - 1) / 99 * 100}%, rgba(255,255,255,0.1) 0%)`,
                            borderRadius: '2px',
                            outline: 'none',
                            cursor: 'pointer'
                        }}
                    />
                    <style>{`
                        input[type=range]::-webkit-slider-thumb {
                            appearance: none;
                            width: 14px;
                            height: 14px;
                            background: #fff;
                            border: 2px solid #0099ff;
                            border-radius: 50%;
                            cursor: pointer;
                            box-shadow: 0 0 10px rgba(0, 153, 255, 0.5);
                        }
                    `}</style>
                </div>

                {/* Preset Hub */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                    {[10, 20, 50, 100].map(l => (
                        <button 
                            key={l} 
                            style={{
                                background: leverage === l ? 'rgba(0, 153, 255, 0.3)' : 'rgba(0,0,0,0.3)',
                                border: `1px solid ${leverage === l ? '#0099ff' : 'rgba(255,255,255,0.08)'}`,
                                color: leverage === l ? '#fff' : '#888',
                                padding: '8px 0',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '11px',
                                fontWeight: leverage === l ? 'bold' : 'normal',
                                transition: 'all 0.2s ease'
                            }}
                            onClick={() => updateLeverage(l)}
                        >
                            {l}x
                        </button>
                    ))}
                </div>
            </div>

            {/* Trading Inputs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '6px', padding: '8px 12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="text-secondary text-xs mb-10">Order Size (USD)</div>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <span style={{ color: '#fff', fontSize: '16px', marginRight: '8px' }}>$</span>
                        <input 
                            type="number" 
                            value={orderSize}
                            onChange={(e) => setOrderSize(e.target.value)}
                            style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '18px', width: '100%', outline: 'none', fontFamily: 'JetBrains Mono' }}
                        />
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '6px', padding: '8px 12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div className="text-green text-xs mb-10" style={{ opacity: 0.8 }}>Target (%)</div>
                        <input 
                            type="number" 
                            value={takeProfit}
                            onChange={(e) => setTakeProfit(e.target.value)}
                            style={{ background: 'transparent', border: 'none', color: '#00ff88', fontSize: '16px', width: '100%', outline: 'none', fontFamily: 'JetBrains Mono' }}
                        />
                    </div>
                    <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '6px', padding: '8px 12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div className="text-red text-xs mb-10" style={{ opacity: 0.8 }}>Stop (%)</div>
                        <input 
                            type="number" 
                            value={stopLoss}
                            onChange={(e) => setStopLoss(e.target.value)}
                            style={{ background: 'transparent', border: 'none', color: '#ff4444', fontSize: '16px', width: '100%', outline: 'none', fontFamily: 'JetBrains Mono' }}
                        />
                    </div>
                </div>
            </div>
            
            {/* Execution Buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: 'auto', paddingBottom: '8px' }}>
                <button 
                    style={{ 
                        background: 'linear-gradient(135deg, rgba(0, 255, 136, 0.2) 0%, rgba(0, 255, 136, 0.05) 100%)', 
                        border: '1px solid #00ff88', 
                        color: '#00ff88', 
                        padding: '12px', 
                        borderRadius: '6px', 
                        cursor: 'pointer', 
                        fontWeight: 'bold',
                        fontSize: '14px',
                        letterSpacing: '1px',
                        boxShadow: '0 0 12px rgba(0,255,136,0.1)'
                    }}
                    onClick={() => console.log('Manual Long')}
                >
                    ⚡ LONG
                </button>
                <button 
                    style={{ 
                        background: 'linear-gradient(135deg, rgba(255, 68, 68, 0.2) 0%, rgba(255, 68, 68, 0.05) 100%)', 
                        border: '1px solid #ff4444', 
                        color: '#ff4444', 
                        padding: '12px', 
                        borderRadius: '6px', 
                        cursor: 'pointer', 
                        fontWeight: 'bold',
                        fontSize: '14px',
                        letterSpacing: '1px',
                        boxShadow: '0 0 12px rgba(255,68,68,0.1)'
                    }}
                    onClick={() => console.log('Manual Short')}
                >
                    ⚡ SHORT
                </button>
            </div>
        </div>
    );
};
