import React from 'react';
import { useNexusStore } from '../store';
import './HUD.css'; // Optional: if you want separate css, or inline it

export const HUD: React.FC = () => {
    const pipelineStage = useNexusStore(s => s.pipelineStage);
    const pipelineStatus = useNexusStore(s => s.pipelineStatus);
    const pipelineDirection = useNexusStore(s => s.pipelineDirection);
    const pipelineReason = useNexusStore(s => s.pipelineReason);

    // Color logic
    const getLedColor = (stageNum: number) => {
        if (pipelineStage < stageNum) return 'rgba(255, 255, 255, 0.1)'; // off
        if (pipelineStage === stageNum) {
            if (pipelineStatus === 'evaluating') return '#ffb800'; // yellow blinking
            if (pipelineStatus === 'rejected') return '#ff3366'; // red
            if (pipelineStatus === 'passed') return '#00e1ff'; // cyan
        }
        if (pipelineStage > stageNum) return '#00e1ff'; // passed previously
        return 'rgba(255, 255, 255, 0.1)';
    };

    const getLedClass = (stageNum: number) => {
        if (pipelineStage === stageNum && pipelineStatus === 'evaluating') return 'led-evaluating';
        if (pipelineStage === stageNum && pipelineStatus === 'rejected') return 'led-rejected';
        if (pipelineStage >= stageNum && pipelineStatus !== 'rejected') return 'led-passed';
        return '';
    };

    const stages = [
        { num: 1, label: 'L1: Gatekeeper' },
        { num: 2, label: 'L2: Confluence' },
        { num: 3, label: 'L3: Scalp (Profit)' },
        { num: 4, label: 'L4: Execution (Vel)' }
    ];

    const dirColor = pipelineDirection === 'long' ? '#00e1ff' : pipelineDirection === 'short' ? '#ff3366' : '#8892b0';

    return (
        <div className="hud-pipeline-visualizer">
            <div className="hud-header">
                <span className="mono text-sm" style={{ fontWeight: 600, letterSpacing: '1px' }}>
                    DECISION PIPELINE
                </span>
                {pipelineDirection && (
                    <span className="mono text-xs" style={{ color: dirColor, padding: '2px 6px', background: `${dirColor}20`, borderRadius: '4px' }}>
                        {pipelineDirection.toUpperCase()}
                    </span>
                )}
            </div>

            <div className="led-container">
                {stages.map(stage => (
                    <div key={stage.num} className="led-step">
                        <div 
                            className={`led-bulb ${getLedClass(stage.num)}`} 
                            style={{ backgroundColor: getLedColor(stage.num), boxShadow: `0 0 10px ${getLedColor(stage.num)}50` }} 
                        />
                        <span className="mono text-xs text-secondary">{stage.label}</span>
                    </div>
                ))}
            </div>

            <div className="hud-status-text mono text-xs">
                {pipelineReason ? (
                    <span style={{ color: pipelineStatus === 'rejected' ? '#ff3366' : '#8892b0' }}>
                        {pipelineStatus === 'rejected' ? '❌ ' : pipelineStatus === 'passed' ? '✅ ' : '⏳ '} 
                        {pipelineReason}
                    </span>
                ) : (
                    <span className="text-secondary">Waiting for volatility spike...</span>
                )}
            </div>
        </div>
    );
};
