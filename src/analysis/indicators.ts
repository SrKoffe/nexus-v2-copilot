// @ts-nocheck

export const Indicators = {
    SMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((sum, val) => sum + val, 0) / period;
    },

    EMA(data, period) {
        if (data.length < period) return null;
        const multiplier = 2 / (period + 1);
        let ema = this.SMA(data.slice(0, period), period);
        for (let i = period; i < data.length; i++) {
            ema = (data[i] - ema) * multiplier + ema;
        }
        return ema;
    },

    RSI(data, period = 14) {
        if (data.length < period + 1) return { value: null, signal: 'neutral', score: 0 };
        let gains = [];
        let losses = [];
        for (let i = 1; i < data.length; i++) {
            const change = data[i] - data[i - 1];
            gains.push(change > 0 ? change : 0);
            losses.push(change < 0 ? Math.abs(change) : 0);
        }
        const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
        const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
        
        if (avgLoss === 0) return { value: 100, signal: 'sell', score: -100 };
        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));
        
        let signal = 'neutral';
        if (rsi < 30) signal = 'buy';
        else if (rsi > 70) signal = 'sell';
        
        // Continuous score: 50 -> 0, 30 -> 100, 70 -> -100
        const score = (50 - rsi) * 5; 
        
        return { value: Math.round(rsi * 100) / 100, signal, score: Math.round(score) };
    },

    MACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (data.length < slowPeriod + signalPeriod) return { macd: null, signal: null, histogram: null, tradingSignal: 'neutral', score: 0 };
        const macdValues = [];
        for (let i = slowPeriod; i <= data.length; i++) {
            const slice = data.slice(0, i);
            const fastEma = this.EMA(slice, fastPeriod);
            const slowEma = this.EMA(slice, slowPeriod);
            if (fastEma !== null && slowEma !== null) macdValues.push(fastEma - slowEma);
        }
        if (macdValues.length < signalPeriod) return { macd: null, signal: null, histogram: null, tradingSignal: 'neutral', score: 0 };
        const macdLine = macdValues[macdValues.length - 1];
        const signalLine = this.EMA(macdValues, signalPeriod);
        const histogram = macdLine - signalLine;
        const prevMacd = macdValues[macdValues.length - 2];
        const prevSignal = this.EMA(macdValues.slice(0, -1), signalPeriod);
        
        let tradingSignal = 'neutral';
        if (prevMacd !== undefined && prevSignal !== null) {
            if (prevMacd < prevSignal && macdLine > signalLine) tradingSignal = 'buy';
            else if (prevMacd > prevSignal && macdLine < signalLine) tradingSignal = 'sell';
            else if (macdLine > signalLine && histogram > 0) tradingSignal = 'buy';
            else if (macdLine < signalLine && histogram < 0) tradingSignal = 'sell';
        }

        // Score based on histogram intensity relative to signal line
        const score = (histogram / (Math.abs(signalLine) || 1)) * 100;

        return {
            macd: Math.round(macdLine * 10000) / 10000,
            signal: Math.round(signalLine * 10000) / 10000,
            histogram: Math.round(histogram * 10000) / 10000,
            tradingSignal,
            score: Math.max(-100, Math.min(100, Math.round(score)))
        };
    },

    BollingerBands(data, period = 20, stdDev = 2) {
        if (data.length < period) return { upper: null, middle: null, lower: null, bandwidth: null, percentB: null, signal: 'neutral', score: 0 };
        const slice = data.slice(-period);
        const middle = slice.reduce((sum, val) => sum + val, 0) / period;
        const squaredDiffs = slice.map(val => Math.pow(val - middle, 2));
        const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / period;
        const std = Math.sqrt(variance);
        const upper = middle + (stdDev * std);
        const lower = middle - (stdDev * std);
        const currentPrice = data[data.length - 1];
        const bandwidth = ((upper - lower) / middle) * 100;
        const percentB = (currentPrice - lower) / (upper - lower);
        
        let signal = 'neutral';
        if (currentPrice <= lower) signal = 'buy';
        else if (currentPrice >= upper) signal = 'sell';
        else if (percentB < 0.2) signal = 'buy';
        else if (percentB > 0.8) signal = 'sell';

        // Continuous score: 0.5 -> 0, 0 -> 100, 1.0 -> -100
        const score = (0.5 - percentB) * 200;

        return {
            upper: Math.round(upper * 100) / 100,
            middle: Math.round(middle * 100) / 100,
            lower: Math.round(lower * 100) / 100,
            bandwidth: Math.round(bandwidth * 100) / 100,
            percentB: Math.round(percentB * 100) / 100,
            signal,
            score: Math.max(-100, Math.min(100, Math.round(score)))
        };
    },

    FairValueGap(candles) {
        if (!candles || candles.length < 10) return { bullishFVGs: [], bearishFVGs: [], signal: 'neutral', nearestFVG: null };
        const bullishFVGs = [];
        const bearishFVGs = [];
        const lookback = Math.min(20, candles.length - 2);
        for (let i = candles.length - lookback; i < candles.length - 2; i++) {
            const c1 = candles[i], c2 = candles[i + 1], c3 = candles[i + 2];
            if (c1.high < c3.low) bullishFVGs.push({ top: c3.low, bottom: c1.high, time: c2.time });
            if (c1.low > c3.high) bearishFVGs.push({ top: c1.low, bottom: c3.high, time: c2.time });
        }
        const currentPrice = candles[candles.length - 1].close;
        let signal = 'neutral', nearestFVG = null, nearestDistance = Infinity;
        [...bullishFVGs.map(f => ({...f, type: 'bullish'})), ...bearishFVGs.map(f => ({...f, type: 'bearish'}))].forEach(fvg => {
            if (currentPrice >= fvg.bottom && currentPrice <= fvg.top) {
                signal = fvg.type === 'bullish' ? 'buy' : 'sell';
                const dist = Math.abs(currentPrice - (fvg.top + fvg.bottom)/2);
                if (dist < nearestDistance) { nearestDistance = dist; nearestFVG = fvg; }
            }
        });
        return { bullishFVGs: bullishFVGs.slice(-3), bearishFVGs: bearishFVGs.slice(-3), signal, nearestFVG };
    },

    ATR(candles, period = 14) {
        if (!candles || candles.length < period + 1) return { value: null, percent: null, regime: 'normal', signal: 'neutral' };
        const trValues = [];
        for (let i = 1; i < candles.length; i++) {
            trValues.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close)));
        }
        const atr = trValues.slice(-period).reduce((s, v) => s + v, 0) / period;
        const currentPrice = candles[candles.length - 1].close;
        return { value: Math.round(atr * 100) / 100, percent: Math.round((atr/currentPrice)*100*100)/100, regime: 'normal', signal: 'neutral' };
    },

    VWAP(candles) {
        if (!candles || candles.length < 1) return { value: null, signal: 'neutral', deviation: 0 };
        let sumTPV = 0, sumVol = 0;
        candles.forEach(c => {
            const tp = (c.high + c.low + c.close) / 3;
            sumTPV += tp * c.volume;
            sumVol += c.volume;
        });
        const vwap = sumVol > 0 ? sumTPV / sumVol : 0;
        const currentPrice = candles[candles.length - 1].close;
        const dev = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;
        return { value: Math.round(vwap * 100) / 100, deviation: Math.round(dev * 100) / 100, signal: Math.abs(dev) > 0.5 ? (dev > 0 ? 'sell' : 'buy') : 'neutral' };
    }
};
