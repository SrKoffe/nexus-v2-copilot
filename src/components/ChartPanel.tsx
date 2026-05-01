import React, { useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, ColorType, CandlestickSeries } from 'lightweight-charts';
import { invoke } from '@tauri-apps/api/core';

/**
 * ChartPanel — candlestick chart fed by MEXC futures (via Tauri command).
 *
 * Initial load: invokes `fetch_historical_candles` (Rust → MEXC contract REST).
 * Live update: polls the last 2 candles every 3s and series.update()s.
 *
 * Symbol uses MEXC contract format with underscore (e.g. "BTC_USDT").
 * Timeframe accepts UI labels ("1m", "5m", "15m", "1H", "4H", "1D") and is
 * normalized to MEXC's labels ("Min1", "Min5", "Min15", "Min60", "Hour4", "Day1").
 */

interface RustKline {
    open_time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    close_time: number;
}

function uiToMexcInterval(tf: string): string {
    switch (tf) {
        case '1m':  return 'Min1';
        case '5m':  return 'Min5';
        case '15m': return 'Min15';
        case '30m': return 'Min30';
        case '1H':  return 'Min60';
        case '4H':  return 'Hour4';
        case '1D':  return 'Day1';
        default:    return 'Min1';
    }
}

export const ChartPanel: React.FC<{ timeframe: string, symbol?: string }> = ({
    timeframe,
    symbol = 'BTC_USDT',
}) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

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
                    upColor: '#00ff88', downColor: '#ff4444', borderVisible: false,
                    wickUpColor: '#00ff88', wickDownColor: '#ff4444',
                });
            } else if ('addSeries' in chart && CandlestickSeries) {
                candleSeries = (chart as any).addSeries(CandlestickSeries, {
                    upColor: '#00ff88', downColor: '#ff4444', borderVisible: false,
                    wickUpColor: '#00ff88', wickDownColor: '#ff4444',
                });
            }
        } catch (e) {
            console.error('[ChartPanel] failed to create candle series', e);
        }

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

    // 2) Fetch History from MEXC (via Tauri) + poll latest
    useEffect(() => {
        if (!seriesRef.current) return;

        const interval = uiToMexcInterval(timeframe);
        let isMounted = true;

        // Initial historical load
        invoke<RustKline[]>('fetch_historical_candles', {
            symbol,
            interval,
            limit: 200,
        })
            .then((klines) => {
                if (!isMounted || !klines) return;
                const formatted = klines.map((k) => ({
                    time: (k.open_time / 1000) as any,  // ms → s for lightweight-charts
                    open: k.open,
                    high: k.high,
                    low: k.low,
                    close: k.close,
                }));
                seriesRef.current?.setData(formatted);
            })
            .catch((e) => console.error('[ChartPanel] history fetch failed:', e));

        // Poll latest candle every 3s — MEXC rate-limits are generous; 20 req/min is safe.
        const pollInterval = setInterval(() => {
            invoke<RustKline[]>('fetch_historical_candles', {
                symbol,
                interval,
                limit: 2,
            })
                .then((klines) => {
                    if (!isMounted || !klines || klines.length === 0) return;
                    const last = klines[klines.length - 1];
                    seriesRef.current?.update({
                        time: (last.open_time / 1000) as any,
                        open: last.open,
                        high: last.high,
                        low: last.low,
                        close: last.close,
                    });
                })
                .catch(() => {
                    // Silent: poll errors are usually transient (network blip, rate limit)
                });
        }, 3000);

        return () => {
            isMounted = false;
            clearInterval(pollInterval);
        };
    }, [timeframe, symbol]);

    return <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />;
};
