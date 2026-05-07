import React from 'react';
import { useScannerStore } from '../store';

export const OpportunityScannerPanel: React.FC = () => {
    const topCandidates = useScannerStore(s => s.topCandidates);
    const activeSymbol = useScannerStore(s => s.activeSymbol);
    const setActiveSymbol = useScannerStore(s => s.setActiveSymbol);

    if (topCandidates.length === 0) {
        return (
            <div className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div className="panel-header">🔥 TOP OPPORTUNITIES</div>
                <div className="panel-content" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="text-secondary text-sm">Scanning market...</span>
                </div>
            </div>
        );
    }

    const getRegimeColor = (regime: string) => {
        switch (regime) {
            case 'TREND_UP': return '#00ff88';
            case 'TREND_DOWN': return '#ff3366';
            case 'CHAOTIC': return '#ffb800';
            case 'RANGE': return '#00e1ff';
            default: return '#8892b0';
        }
    };

    const formatNumber = (num: number) => {
        if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
        return num.toFixed(2);
    };

    return (
        <div className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>🔥 TOP OPPORTUNITIES</span>
                <span className="text-xs text-secondary">{topCandidates.length} assets</span>
            </div>
            
            <div className="panel-content" style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px 8px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                    {topCandidates.map((candidate, idx) => {
                        const isActive = candidate.symbol === activeSymbol;
                        
                        return (
                            <div 
                                key={candidate.symbol}
                                onClick={() => setActiveSymbol(candidate.symbol)}
                                style={{
                                    padding: '10px',
                                    borderRadius: '6px',
                                    background: isActive ? 'rgba(0, 225, 255, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                                    border: `1px solid ${isActive ? 'rgba(0, 225, 255, 0.3)' : 'rgba(255, 255, 255, 0.05)'}`,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '6px',
                                    transition: 'all 0.2s ease',
                                    boxShadow: isActive ? '0 0 10px rgba(0, 225, 255, 0.1)' : 'none'
                                }}
                            >
                                {/* Top Row */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span style={{ fontSize: '12px', color: '#8892b0', fontWeight: 600 }}>#{idx + 1}</span>
                                        <span className="mono" style={{ fontWeight: 600, fontSize: '14px', color: isActive ? '#fff' : '#ccd6f6' }}>
                                            {candidate.symbol.replace('_USDT', '')}
                                        </span>
                                    </div>
                                    <div style={{ 
                                        fontSize: '10px', 
                                        fontWeight: 600, 
                                        padding: '2px 6px', 
                                        borderRadius: '4px',
                                        background: `${getRegimeColor(candidate.regime)}20`,
                                        color: getRegimeColor(candidate.regime)
                                    }}>
                                        {candidate.regime}
                                    </div>
                                </div>

                                {/* Middle Row */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                                    <span className="mono" style={{ color: candidate.rise_fall_rate >= 0 ? '#00ff88' : '#ff3366' }}>
                                        {candidate.rise_fall_rate > 0 ? '+' : ''}{(candidate.rise_fall_rate * 100).toFixed(2)}%
                                    </span>
                                    <span className="mono text-secondary">
                                        Vol: {(candidate.volatility * 100).toFixed(1)}%
                                    </span>
                                </div>

                                {/* Bottom Row */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px' }}>
                                    <span className="text-secondary">Turnover: ${formatNumber(candidate.amount_24h)}</span>
                                    <span style={{ color: '#00e1ff', fontWeight: 600 }}>
                                        Score: {candidate.opportunity_score.toFixed(1)}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};
