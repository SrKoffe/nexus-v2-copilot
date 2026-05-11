import React, { useEffect, useState } from 'react';
import { useNexusStore } from '../store';
import { RejectionMetrics, PipelineMetrics } from '../analysis/metrics/rejection-metrics';

export const PipelineFlow: React.FC = () => {
    const { pipelineStage, pipelineStatus, pipelineDirection, pipelineReason } = useNexusStore();
    const [metrics, setMetrics] = useState<PipelineMetrics>(RejectionMetrics.getMetrics());

    useEffect(() => {
        const interval = setInterval(() => {
            setMetrics(RejectionMetrics.getMetrics());
        }, 500); // 500ms batched UI update to avoid render storms
        return () => clearInterval(interval);
    }, []);

    return (
        <div style={{ padding: '12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: '6px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '11px', color: '#888', borderBottom: '1px solid #222', paddingBottom: '8px' }}>
                <span style={{ color: '#00e1ff', fontWeight: 'bold' }}>THROUGHPUT</span>
                <span style={{ display: 'flex', gap: '12px' }}>
                    <span>{metrics.analysisPerSec} ops/sec</span>
                    <span>{(metrics.qualified / Math.max(1, metrics.scanned) * 100).toFixed(2)}% Qual Rate</span>
                    <span>{metrics.setupsPerMin} setups/min</span>
                </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
                    <span style={{ color: '#fff', fontWeight: 'bold' }}>SCAN</span>
                    <span style={{ color: '#00e1ff' }}>{metrics.scanned}</span>
                </div>

                <div style={{ paddingLeft: '12px', borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666' }}>
                        <span>↳ MICROSTRUCTURE REJECTED</span>
                        <span style={{ color: '#ff3366' }}>{metrics.microstructureRejected}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666' }}>
                        <span>↳ CONFIDENCE REJECTED</span>
                        <span style={{ color: '#ff3366' }}>{metrics.confidenceRejected}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666' }}>
                        <span>↳ LIQUIDITY REJECTED</span>
                        <span style={{ color: '#ff3366' }}>{metrics.liquidityRejected}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666' }}>
                        <span>↳ EV REJECTED</span>
                        <span style={{ color: '#ff3366' }}>{metrics.evRejected}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666' }}>
                        <span>↳ SURVIVAL RISK REJECTED</span>
                        <span style={{ color: '#ff3366' }}>{metrics.riskRejected}</span>
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', marginTop: '4px', paddingTop: '8px', borderTop: '1px solid #222' }}>
                    <span style={{ color: '#00ff88', fontWeight: 'bold' }}>QUALIFIED</span>
                    <span style={{ color: '#00ff88', fontWeight: 'bold' }}>{metrics.qualified}</span>
                </div>
            </div>

            {pipelineReason && (
                <div style={{ marginTop: '12px', padding: '8px', background: pipelineStatus === 'rejected' ? '#ff33331a' : '#00e1ff1a', borderRadius: '4px', fontSize: '11px', color: pipelineStatus === 'rejected' ? '#ff3333' : '#00e1ff', border: `1px solid ${pipelineStatus === 'rejected' ? '#ff333333' : '#00e1ff33'}` }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '2px' }}>LATEST PIPELINE EVENT</div>
                    {pipelineDirection && <span style={{ textTransform: 'uppercase', marginRight: '4px' }}>[{pipelineDirection}]</span>}
                    {pipelineReason}
                </div>
            )}
        </div>
    );
};
