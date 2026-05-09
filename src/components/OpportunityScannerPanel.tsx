import React, { useState } from 'react';
import { useScannerStore } from '../store';

export const OpportunityScannerPanel: React.FC = () => {
    const universe = useScannerStore(s => s.universe);
    const topCandidates = useScannerStore(s => s.topCandidates);
    const favorites = useScannerStore(s => s.favorites);
    const activeSymbol = useScannerStore(s => s.activeSymbol);
    const setActiveSymbol = useScannerStore(s => s.setActiveSymbol);
    const toggleFavorite = useScannerStore(s => s.toggleFavorite);

    const [activeTab, setActiveTab] = useState<'TOP' | 'FAVORITES' | 'SEARCH'>('TOP');
    const [searchQuery, setSearchQuery] = useState('');

    if (topCandidates.length === 0) {
        return (
            <div className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div className="panel-content" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="text-secondary text-sm">Hunting for opportunities...</span>
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

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.toUpperCase();
        setSearchQuery(val);
        if (val.trim() !== '') {
            setActiveTab('SEARCH');
        } else if (activeTab === 'SEARCH') {
            setActiveTab('TOP');
        }
    };

    let displayCandidates = topCandidates;
    if (activeTab === 'FAVORITES') {
        displayCandidates = universe.filter(c => favorites.includes(c.symbol));
        // Sort favorites by score descending, similar to topCandidates
        displayCandidates.sort((a, b) => b.opportunity_score - a.opportunity_score);
    } else if (activeTab === 'SEARCH' && searchQuery.trim() !== '') {
        displayCandidates = universe
            .filter(c => c.symbol.includes(searchQuery.trim()))
            .sort((a, b) => b.opportunity_score - a.opportunity_score);
    }

    return (
        <div className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="panel-header" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 4px' }}>
                {/* Search Bar */}
                <input 
                    type="text" 
                    placeholder="🔍 Search symbols..." 
                    value={searchQuery}
                    onChange={handleSearchChange}
                    style={{
                        width: '100%',
                        padding: '6px 10px',
                        background: 'rgba(0,0,0,0.4)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '4px',
                        color: '#fff',
                        fontSize: '12px',
                        fontFamily: 'var(--font-sans)',
                        outline: 'none'
                    }}
                />
                
                {/* Tabs */}
                <div style={{ display: 'flex', gap: '4px', width: '100%' }}>
                    <button 
                        onClick={() => { setActiveTab('TOP'); setSearchQuery(''); }}
                        style={{
                            flex: 1,
                            padding: '4px',
                            background: activeTab === 'TOP' ? 'rgba(0, 225, 255, 0.15)' : 'transparent',
                            border: `1px solid ${activeTab === 'TOP' ? 'rgba(0, 225, 255, 0.4)' : 'transparent'}`,
                            color: activeTab === 'TOP' ? '#00e1ff' : '#8892b0',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '10px',
                            fontWeight: 600,
                            textTransform: 'uppercase'
                        }}
                    >
                        🔥 Top 10
                    </button>
                    <button 
                        onClick={() => { setActiveTab('FAVORITES'); setSearchQuery(''); }}
                        style={{
                            flex: 1,
                            padding: '4px',
                            background: activeTab === 'FAVORITES' ? 'rgba(255, 184, 0, 0.15)' : 'transparent',
                            border: `1px solid ${activeTab === 'FAVORITES' ? 'rgba(255, 184, 0, 0.4)' : 'transparent'}`,
                            color: activeTab === 'FAVORITES' ? '#ffb800' : '#8892b0',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '10px',
                            fontWeight: 600,
                            textTransform: 'uppercase'
                        }}
                    >
                        ⭐ Favs ({favorites.length})
                    </button>
                </div>
            </div>
            
            <div className="panel-content" style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px 8px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                    {displayCandidates.length === 0 && (
                        <div style={{ textAlign: 'center', color: '#8892b0', fontSize: '12px', marginTop: '20px' }}>
                            {activeTab === 'FAVORITES' ? 'No favorites yet.' : 'No symbols found.'}
                        </div>
                    )}
                    
                    {displayCandidates.map((candidate, idx) => {
                        const isActive = candidate.symbol === activeSymbol;
                        const isFav = favorites.includes(candidate.symbol);
                        
                        return (
                            <div 
                                key={candidate.symbol}
                                onClick={() => setActiveSymbol(candidate.symbol)}
                                style={{
                                    padding: '8px 4px',
                                    borderRadius: '2px',
                                    background: isActive ? 'rgba(0, 225, 255, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '6px',
                                    transition: 'all 0.2s ease',
                                    boxShadow: 'none'
                                }}
                            >
                                {/* Top Row */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span style={{ fontSize: '12px', color: '#8892b0', fontWeight: 600 }}>
                                            {activeTab === 'TOP' ? `#${idx + 1}` : '•'}
                                        </span>
                                        <span className="mono" style={{ fontWeight: 600, fontSize: '14px', color: isActive ? '#fff' : '#ccd6f6' }}>
                                            {candidate.symbol.replace('_USDT', '')}
                                        </span>
                                        {/* Favorite Toggle Button */}
                                        <div 
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                toggleFavorite(candidate.symbol);
                                            }}
                                            style={{
                                                fontSize: '12px',
                                                cursor: 'pointer',
                                                opacity: isFav ? 1 : 0.3,
                                                filter: isFav ? 'drop-shadow(0 0 4px rgba(255, 184, 0, 0.5))' : 'none',
                                                transition: 'all 0.2s ease'
                                            }}
                                            title={isFav ? "Remove from Favorites" : "Add to Favorites"}
                                        >
                                            ⭐
                                        </div>
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
