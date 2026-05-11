import React, { useEffect, useState } from 'react';
import { EventBus } from '../analysis/event-bus';

export const MarketEnergy: React.FC = () => {
    const [energy, setEnergy] = useState({
        level: 'NORMAL',
        pressure: 'BALANCED',
        activeIgnitions: 0,
        sweepClusters: 0
    });

    useEffect(() => {
        let ignitions = 0;
        let sweeps = 0;
        let buyTicks = 0;
        let sellTicks = 0;
        let tickCount = 0;

        const handleSetup = (payload: any) => {
            if (payload?.setup?.type === 'micro_scalp' || payload?.setup?.confirmations?.includes('momentum_ignition')) {
                ignitions++;
            }
        };

        const handleSweep = () => sweeps++;

        const handleTick = (tick: any) => {
            tickCount++;
            if (!tick.is_buyer_maker) buyTicks++;
            else sellTicks++;
        };

        EventBus.on('SCALP_SETUP', handleSetup);
        EventBus.on('LIQUIDITY_SWEEP', handleSweep);
        EventBus.on('MARKET_TICK', handleTick);

        const interval = setInterval(() => {
            // Determine Scanner Pressure based on tick velocity and delta imbalance
            let pressure = 'BALANCED';
            if (tickCount > 100) {
                if (buyTicks > sellTicks * 1.5) pressure = 'EXTREME_BUY';
                else if (sellTicks > buyTicks * 1.5) pressure = 'EXTREME_SELL';
                else pressure = 'HIGH_VOLUME';
            }

            // Determine Market Energy Level
            let level = 'NORMAL';
            if (ignitions > 5 || sweeps > 3) level = 'HIGH';
            if (ignitions > 10 || sweeps > 6) level = 'EXTREME';
            if (tickCount < 10) level = 'LOW';

            setEnergy({
                level,
                pressure,
                activeIgnitions: ignitions,
                sweepClusters: sweeps
            });

            // Decay counters instead of full reset to smooth out the UI
            ignitions = Math.floor(ignitions * 0.5);
            sweeps = Math.floor(sweeps * 0.5);
            tickCount = 0;
            buyTicks = 0;
            sellTicks = 0;
        }, 1000); // 1-second batch updates

        return () => {
            EventBus.off('SCALP_SETUP', handleSetup);
            EventBus.off('LIQUIDITY_SWEEP', handleSweep);
            EventBus.off('MARKET_TICK', handleTick);
            clearInterval(interval);
        };
    }, []);

    const energyColor = energy.level === 'EXTREME' ? '#ff3366' : energy.level === 'HIGH' ? '#ffb800' : energy.level === 'LOW' ? '#666' : '#00e1ff';
    const pressureColor = energy.pressure.includes('BUY') ? '#00ff88' : energy.pressure.includes('SELL') ? '#ff3333' : energy.pressure.includes('HIGH') ? '#ffb800' : '#888';

    return (
        <div style={{ padding: '12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#888', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Global Market Energy
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: '#ccc' }}>Market Energy:</span>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: energyColor }}>{energy.level}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: '#ccc' }}>Scanner Pressure:</span>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: pressureColor }}>{energy.pressure}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: '#ccc' }}>Active Ignitions:</span>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: energy.activeIgnitions > 0 ? '#ffb800' : '#888' }}>{energy.activeIgnitions}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: '#ccc' }}>Sweep Clusters:</span>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: energy.sweepClusters > 0 ? '#ff3366' : '#888' }}>{energy.sweepClusters}</span>
            </div>
        </div>
    );
};
