import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ChartPanel } from './components/ChartPanel';
import { OrderPanel } from './components/OrderPanel';
import { LiveFeed } from './components/LiveFeed';
import { PositionTracker } from './components/PositionTracker';
import './App.css';
import { initAnalysisPipeline } from './analysis';

// Basic layout for the trading terminal HUD
function App() {
  const [livePrice, setLivePrice] = useState<number>(0);
  const [symbol] = useState("BTC-PERP");
  const [timeframe, setTimeframe] = useState('1m');

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    async function start() {
      // 🚀 Launch Institutional Analysis Pipeline
      cleanup = await initAnalysisPipeline();

      // Simple UI tick listener
      const unlisten = await listen<{ price: number; symbol: string }>('market-tick', (event) => {
        if (event.payload.price) {
          setLivePrice(event.payload.price);
        }
      });
      
      return unlisten;
    }

    const unlistenPromise = start();

    return () => {
      if (cleanup) cleanup();
      unlistenPromise.then(u => u());
    };
  }, []);

  return (
    <div className="hud-container">
      {/* HUD Header */}
      <header className="hud-topbar panel">
        <div className="brand">
          <span className="text-blue mono">▶</span> ANTIGRAVITY <span className="text-secondary text-sm">OS / V2</span>
        </div>
        <div className="global-ticker">
          <span className="mono text-secondary">{symbol}</span>
          <span className="mono text-xl" style={{ marginLeft: '12px' }}>
            ${livePrice > 0 ? livePrice.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '---.-'}
          </span>
        </div>
        <div className="status-indicators">
          <span className="status-pill text-green">● LIVE</span>
          <span className="status-pill text-blue">🛡️ ORACLE</span>
        </div>
      </header>

      {/* Main Trading Grid */}
      <main className="trading-grid">
        <section className="chart-area panel">
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Market Chart</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {['1m', '5m', '15m', '1H', '4H', '1D'].map(tf => (
                <button 
                  key={tf}
                  style={{
                    background: timeframe === tf ? 'rgba(0, 153, 255, 0.2)' : 'transparent',
                    border: `1px solid ${timeframe === tf ? '#0099ff' : 'transparent'}`,
                    color: timeframe === tf ? '#0099ff' : '#8892b0',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    cursor: 'pointer',
                    fontWeight: timeframe === tf ? 'bold' : 'normal',
                    fontFamily: 'JetBrains Mono, monospace'
                  }}
                  onClick={() => setTimeframe(tf)}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
          <div className="panel-content" style={{ padding: 0 }}>
            <ChartPanel timeframe={timeframe} />
          </div>
        </section>

        <section className="order-area panel">
          <div className="panel-header">Execution</div>
          <div className="panel-content">
            <OrderPanel />
          </div>
        </section>

        <section className="log-area panel">
          <div className="panel-header">Intelligence Feed</div>
          <div className="panel-content">
            <LiveFeed />
          </div>
        </section>
        
        <section className="position-area panel">
          <div className="panel-header">Active Operations</div>
          <div className="panel-content">
            <PositionTracker />
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
