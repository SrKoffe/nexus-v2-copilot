// @ts-nocheck
import { EventBus } from './event-bus';

export class CandleManager {
    constructor() {
        this.candles1m = [];
        this.candles5m = [];
        this.current1m = null;
        this.symbol = 'BTCUSDT';
    }

    addTick(tick) {
        const price = parseFloat(tick.price);
        const quantity = parseFloat(tick.quantity);
        const timestamp = parseInt(tick.timestamp || tick.T || Date.now());
        
        if (isNaN(price) || isNaN(quantity)) return;

        const minute = Math.floor(timestamp / 60000) * 60000;

        if (!this.current1m || this.current1m.time !== minute) {
            if (this.current1m) {
                this._closeCandle(this.current1m);
            }
            this.current1m = {
                time: minute,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: quantity,
                isClosed: false
            };
        } else {
            this.current1m.high = Math.max(this.current1m.high, price);
            this.current1m.low = Math.min(this.current1m.low, price);
            this.current1m.close = price;
            this.current1m.volume += quantity;
        }

        EventBus.emit('TICK_UPDATE', { price, candle: this.current1m });
    }

    _closeCandle(candle) {
        candle.isClosed = true;
        this.candles1m.push({...candle});
        if (this.candles1m.length > 500) this.candles1m.shift();

        // Build 5m candle
        const minute5 = Math.floor(candle.time / 300000) * 300000;
        this._update5m(candle, minute5);

        EventBus.emit('CANDLE_CLOSE', { 
            interval: '1m', 
            candle, 
            candles1m: this.candles1m, 
            candles5m: this.candles5m 
        });
    }

    setHistory(candles) {
        if (!candles || candles.length === 0) return;
        this.candles1m = candles.map(c => ({
            time: c.open_time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            isClosed: true
        }));

        // Basic 5m aggregation from history
        for (let i = 0; i < this.candles1m.length; i++) {
            const c = this.candles1m[i];
            const minute5 = Math.floor(c.time / 300000) * 300000;
            this._update5m(c, minute5);
        }
        
        console.log(`📊 [Candles] Loaded ${this.candles1m.length} 1m candles from history.`);
    }

    _update5m(candle1m, minute5) {
        let last5m = this.candles5m[this.candles5m.length - 1];
        
        if (!last5m || last5m.time !== minute5) {
            last5m = {
                time: minute5,
                open: candle1m.open,
                high: candle1m.high,
                low: candle1m.low,
                close: candle1m.close,
                volume: candle1m.volume,
                isClosed: false
            };
            this.candles5m.push(last5m);
        } else {
            last5m.high = Math.max(last5m.high, candle1m.high);
            last5m.low = Math.min(last5m.low, candle1m.low);
            last5m.close = candle1m.close;
            last5m.volume += candle1m.volume;
            
            // A 5m candle is closed if the next 1m candle belongs to a new 5m period
            // This logic is slightly simplified; in production, we check if minute5 is complete.
            if ((candle1m.time + 60000) % 300000 === 0) {
                last5m.isClosed = true;
            }
        }
        
        if (this.candles5m.length > 200) this.candles5m.shift();
    }

    getCandles(interval = '1m') {
        return interval === '5m' ? this.candles5m : this.candles1m;
    }
}

export const candleManager = new CandleManager();
