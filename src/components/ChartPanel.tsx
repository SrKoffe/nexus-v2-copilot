import React, { useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, ColorType, CandlestickSeries } from 'lightweight-charts';

export const ChartPanel: React.FC<{ timeframe: string, symbol?: string }> = ({ timeframe, symbol = "BTCUSDT" }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // 1) Initialize Chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b92a5',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.03)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderVisible: false,
      },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
    });

    let candleSeries: any;
    try {
      if ('addCandlestickSeries' in chart) {
        candleSeries = (chart as any).addCandlestickSeries({
          upColor: '#00ff88', downColor: '#ff4444', borderVisible: false, wickUpColor: '#00ff88', wickDownColor: '#ff4444'
        });
      } else if ('addSeries' in chart && CandlestickSeries) {
        candleSeries = (chart as any).addSeries(CandlestickSeries, {
          upColor: '#00ff88', downColor: '#ff4444', borderVisible: false, wickUpColor: '#00ff88', wickDownColor: '#ff4444'
        });
      }
    } catch(e) { console.error(e); }

    chartRef.current = chart;
    seriesRef.current = candleSeries;

    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // 2) Fetch History & Poll Live Candle
  useEffect(() => {
    if (!seriesRef.current) return;

    // Normalize timeframe for Binance API (1m, 5m, 15m, 1h, 4h, 1d)
    let interval = timeframe;
    if (interval.endsWith('H')) interval = interval.replace('H', 'h');
    if (interval.endsWith('D')) interval = interval.replace('D', 'd');

    let isMounted = true;

    // Fetch initial historical load
    fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=150`)
      .then(r => r.json())
      .then(data => {
        if (!isMounted) return;
        const formatted = data.map((d: any) => ({
          time: (d[0] / 1000) as any,
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4])
        }));
        seriesRef.current?.setData(formatted);
      })
      .catch(console.error);

    // Poll latest candle to keep chart moving live
    const pollInterval = setInterval(() => {
        fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=2`)
        .then(r => r.json())
        .then(data => {
            if (!isMounted) return;
            if (data.length > 0) {
                 const last = data[data.length - 1];
                 seriesRef.current?.update({
                    time: (last[0] / 1000) as any,
                    open: parseFloat(last[1]),
                    high: parseFloat(last[2]),
                    low: parseFloat(last[3]),
                    close: parseFloat(last[4])
                 });
            }
        }).catch(() => {});
    }, 1500);

    return () => {
        isMounted = false;
        clearInterval(pollInterval);
    };
  }, [timeframe, symbol]);

  return <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />;
};
