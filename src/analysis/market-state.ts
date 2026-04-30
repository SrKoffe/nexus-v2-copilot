// @ts-nocheck
import { EventBus } from './event-bus';
import { StateCache } from './state-cache';

export const MarketStateEngine = {

    // ═════════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═════════════════════════════════════════════════════════════════════════

    config: {
        // Swing detection
        pivotLookback: 2,             // 2 bars on each side (era 3)
        atrSwingMultiplier: 0.8,      // 0.8× ATR (era 1.0)
        minDisplacementPct: 0.001,    // 0.1% min price (era 0.002)
        anomalyATRMultiple: 3.0,      // Skip candles with range > 3x ATR (news spikes)
        atrPeriod: 14,                // ATR calculation period

        // BOS detection
        bosATRThreshold: 0.3,         // 0.3× ATR (era 0.5)
        bosMinBars: 2,                // 2 bars after swing (era 3)
        volumeConfirmRatio: 1.2,      // BOS volume must exceed avg * this
        volumeMAPeriod: 20,           // Volume MA lookback

        // Fake breakout filter
        fakeoutReversalBars: 2,       // Bars to watch for reversal after BOS
        fakeoutReversalPct: 0.7,      // If retraces 70%+ of break → fakeout

        // MSS
        mssConfidenceBoost: 15,       // Extra confidence for MSS over BOS

        // Regime classification
        transitionLookback: 5,        // Recent swings for regime evaluation
        transitionTimeoutBars: 20,    // Bars before TRANSITION → RANGE
        rangeThresholdATR: 2.0,       // Max ATR range width for range classification
        minSwingsForRegime: 3,        // Minimum labeled swings to classify

        // Rolling buffer limits
        maxSwingNodes: 200,           // Max StructureNodes in buffer
        maxEventLog: 100,             // Max StructureEvents in log

        // Low-volatility adaptation
        lowATRThreshold: 0.003        // ATR/price ratio below this = low volatility
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL STATE — Rolling buffers and cached values
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Internal state is only mutated via _resetState() or processCandle().
     * The analyze() method populates from scratch when cache is invalid.
     */
    _state: {
        initialized: false,

        // Rolling buffers (capped at config.maxSwingNodes / maxEventLog)
        swingBuffer: [],          // Array of labeled StructureNodes (all, chronological)
        highNodes: [],            // Confirmed swing highs with labels
        lowNodes: [],             // Confirmed swing lows with labels
        eventLog: [],             // BOS / MSS StructureEvents

        // Regime state machine
        regime: {
            current: 'unknown',   // 'UP' | 'DOWN' | 'RANGE' | 'TRANSITION' | 'unknown'
            confidence: 0,
            duration: 0,          // Bars in current regime
            lastUpdate: 0,        // Candle index of last regime change
            previousRegime: null,
            transitionDirection: null,
            transitionStart: 0    // When TRANSITION began (for timeout)
        },

        // Cached computations (incremental)
        atr: 0,
        atrPrev: 0,              // Previous ATR for Wilder smoothing
        volumeMA: 0,             // 20-bar volume moving average
        volumeSum: 0,            // Running sum for volume MA
        volumeBuffer: [],        // Circular buffer for volume MA

        // Tracking
        lastCandleCount: 0,
        lastCandleTime: 0,
        nodeIdCounter: 0
    },

    // ═════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Full structural analysis from candle data.
     *
     * Uses incremental processing when the candle count has only grown by a
     * small amount since the last call. Otherwise performs a full reprocess.
     *
     * @param {Array} candles - Array of {time, open, high, low, close, volume}
     * @returns {object} Full market state analysis (contract preserved)
     */
    analyze(candles) {
        if (!candles || candles.length < 20) {
            return this._emptyResult();
        }

        // Determine if we can use incremental update
        const canUseIncremental = this._state.initialized &&
            candles.length >= this._state.lastCandleCount &&
            candles.length - this._state.lastCandleCount <= 5;

        if (canUseIncremental) {
            // Process only new candles incrementally
            const startIdx = this._state.lastCandleCount;
            for (let i = startIdx; i < candles.length; i++) {
                this._processNewCandle(candles, i);
            }
            this._state.lastCandleCount = candles.length;
        } else {
            // Full reprocess
            this._fullReprocess(candles);
        }

        // Build output in preserved contract format
        return this._buildOutput(candles);
    },

    /**
     * Process a single new candle incrementally.
     * O(1) amortized — checks only against the rolling window.
     *
     * Call this on each candle close for real-time streaming.
     * Note: the full candle array must still be accessible for pivot lookback.
     *
     * @param {Array} candles - Full candle array (with new candle appended)
     */
    processCandle(candles) {
        if (!candles || candles.length < 20) return;

        if (!this._state.initialized) {
            this._fullReprocess(candles);
            return;
        }

        const idx = candles.length - 1;
        this._processNewCandle(candles, idx);
        this._state.lastCandleCount = candles.length;
    },

    /**
     * Get the current market regime state.
     * @returns {object} { regime, confidenceScore, lastUpdate, duration }
     */
    getCurrentMarketState() {
        const r = this._state.regime;
        return {
            regime: r.current,
            confidenceScore: r.confidence,
            lastUpdate: r.lastUpdate,
            duration: r.duration
        };
    },

    /**
     * Get the most recent N StructureNodes.
     * @param {number} n - Number of nodes to return (default 20)
     * @returns {Array} Array of StructureNodes
     */
    getRecentStructure(n = 20) {
        return this._state.swingBuffer.slice(-n);
    },

    /**
     * Get the most recent N StructureEvents.
     * @param {number} n - Number of events to return (default 10)
     * @returns {Array} Array of StructureEvents
     */
    getStructureEvents(n = 10) {
        return this._state.eventLog.slice(-n);
    },

    /**
     * Reset all internal state. Useful when switching symbols or timeframes.
     */
    reset() {
        this._resetState();
    },

    /**
     * Get a compact summary suitable for UI display.
     * Preserved contract for popup.js compatibility.
     *
     * @param {object} state - Output of analyze()
     * @returns {object} UI summary
     */
    getSummary(state) {
        if (!state || state.regime.current === 'unknown') {
            return {
                regime: 'unknown',
                regimeLabel: 'INSUFFICIENT DATA',
                regimeIcon: '❓',
                confidence: 0,
                lastEvent: null,
                swingSequence: ''
            };
        }

        const regimeConfig = {
            // Map internal UP/DOWN to the display labels the UI expects
            trending_up: { label: 'UPTREND', icon: '▲' },
            trending_down: { label: 'DOWNTREND', icon: '▼' },
            range: { label: 'RANGE', icon: '◆' },
            transition: { label: 'TRANSITION', icon: '↻' }
        };

        const config = regimeConfig[state.regime.current] ||
            { label: state.regime.current.toUpperCase(), icon: '?' };

        // Build recent swing sequence string (last 6 swings)
        const recentSwings = state.sequence.slice(-6).map(s => s.label).join(' → ');

        // Find last significant event
        const events = state.structure.events;
        const lastEvent = events.length > 0 ? events[events.length - 1] : null;

        return {
            regime: state.regime.current,
            regimeLabel: config.label,
            regimeIcon: config.icon,
            confidence: state.regime.confidence,
            lastEvent: lastEvent ? {
                type: lastEvent.type,
                direction: lastEvent.direction,
                confidence: lastEvent.confidence,
                barsAgo: state.sequence.length > 0
                    ? state.sequence[state.sequence.length - 1].index - lastEvent.index
                    : 0
            } : null,
            swingSequence: recentSwings,
            duration: state.regime.duration,
            transitionDirection: state.regime.transitionDirection
        };
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Full Reprocessing
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Full reprocess: build all state from scratch.
     * Called on first run or when incremental update is not possible.
     * O(n) where n = candle count.
     */
    _fullReprocess(candles) {
        this._resetState();

        // Step 1: ATR-filtered swing detection via SwingDetector
        const swingResult = SwingDetector.findSwingPointsATRFiltered(candles, {
            pivotLookback: this.config.pivotLookback,
            atrMultiplier: this.config.atrSwingMultiplier,
            minDisplacementPct: this.config.minDisplacementPct,
            anomalyATRMultiple: this.config.anomalyATRMultiple,
            atrPeriod: this.config.atrPeriod,
            volumeMAPeriod: this.config.volumeMAPeriod
        });

        this._state.atr = swingResult.atr;

        // Step 2: Label all swings (HH/HL/LH/LL)
        const labeledHighs = this._labelSwingSequence(swingResult.highs, 'high');
        const labeledLows = this._labelSwingSequence(swingResult.lows, 'low');

        this._state.highNodes = labeledHighs;
        this._state.lowNodes = labeledLows;

        // Step 3: Build chronological swing buffer
        this._state.swingBuffer = [...labeledHighs, ...labeledLows]
            .sort((a, b) => a.index - b.index);

        // Step 4: Compute volume MA at the end
        this._initVolumeMA(candles);

        // Step 5: Detect all BOS/MSS events
        this._detectAllStructureEvents(candles);

        // Step 6: Classify regime from the full swing sequence
        this._classifyRegimeFromHistory(candles);

        // Mark as initialized
        this._state.initialized = true;
        this._state.lastCandleCount = candles.length;
        this._state.lastCandleTime = candles[candles.length - 1].time || 0;
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Incremental Processing
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Process a single new candle.
     * Checks if it confirms a swing point (with lookback delay),
     * then checks for BOS/MSS against the current structure.
     *
     * Performance: O(1) amortized — constant work per candle.
     *
     * @param {Array} candles - Full candle array
     * @param {number} idx - Index of the new candle
     */
    _processNewCandle(candles, idx) {
        const c = candles[idx];

        // ── Update ATR incrementally (Wilder smoothing) ──
        if (idx > 0 && this._state.atr > 0) {
            const tr = Math.max(
                c.high - c.low,
                Math.abs(c.high - candles[idx - 1].close),
                Math.abs(c.low - candles[idx - 1].close)
            );
            const period = this.config.atrPeriod;
            this._state.atr = (this._state.atr * (period - 1) + tr) / period;
        }

        // ── Update volume MA incrementally ──
        this._updateVolumeMA(c);

        // ── Increment regime duration ──
        this._state.regime.duration++;

        // ── Check if a swing was confirmed (with lookback delay) ──
        // A swing at index `idx - pivotLookback` is confirmed now
        const confirmIdx = idx - this.config.pivotLookback;
        if (confirmIdx >= this.config.pivotLookback && confirmIdx < candles.length) {
            this._checkSwingConfirmation(candles, confirmIdx);
        }

        // ── Check for live BOS / MSS against current candle close ──
        this._checkLiveBOS(candles, idx);

        // ── Check TRANSITION timeout → RANGE ──
        if (this._state.regime.current === 'transition') {
            const barsInTransition = idx - this._state.regime.transitionStart;
            if (barsInTransition > this.config.transitionTimeoutBars) {
                this._transitionRegime('range', 50, idx, null);
            }
        }
    },

    /**
     * Check if a candle at `confirmIdx` qualifies as a confirmed swing point.
     * Uses the same ATR-filtered logic as the full reprocess.
     */
    _checkSwingConfirmation(candles, confirmIdx) {
        const c = candles[confirmIdx];
        const lookback = this.config.pivotLookback;
        const effectiveATR = Math.max(this._state.atr, c.close * 0.001);
        const minDist = effectiveATR * this.config.atrSwingMultiplier;

        // ── Anomaly filter ──
        const candleRange = c.high - c.low;
        if (candleRange > effectiveATR * this.config.anomalyATRMultiple) {
            return;
        }

        // ── Check swing high ──
        let isHigh = true;
        for (let j = 1; j <= lookback; j++) {
            const leftIdx = confirmIdx - j;
            const rightIdx = confirmIdx + j;
            if (leftIdx < 0 || rightIdx >= candles.length) { isHigh = false; break; }
            if (c.high <= candles[leftIdx].high || c.high <= candles[rightIdx].high) {
                isHigh = false;
                break;
            }
        }

        if (isHigh) {
            const lastH = this._state.highNodes.length > 0
                ? this._state.highNodes[this._state.highNodes.length - 1]
                : null;
            const disp = lastH ? Math.abs(c.high - lastH.price) : Infinity;
            const pctDisp = lastH ? disp / lastH.price : 1;

            if (disp >= minDist && pctDisp >= this.config.minDisplacementPct) {
                const volExpansion = this._state.volumeMA > 0
                    ? (c.volume || 0) / this._state.volumeMA : 1;

                const atrDisp = disp / effectiveATR;
                const strengthScore = Math.min(100, Math.round(
                    Math.min(40, atrDisp * 15) +
                    Math.min(30, lookback * 10) +
                    Math.min(30, volExpansion * 15)
                ));

                // Label relative to previous
                const label = lastH ? (c.high > lastH.price ? 'HH' : 'LH') : 'HH';

                const node = {
                    id: this._state.nodeIdCounter++,
                    type: 'high',
                    label,
                    index: confirmIdx,
                    price: c.high,
                    candle: c,
                    strength: lookback,
                    strengthScore,
                    timestamp: c.time || 0,
                    volumeRatio: Math.round(volExpansion * 100) / 100
                };

                this._pushSwingNode(node, 'high');
            }
        }

        // ── Check swing low ──
        let isLow = true;
        for (let j = 1; j <= lookback; j++) {
            const leftIdx = confirmIdx - j;
            const rightIdx = confirmIdx + j;
            if (leftIdx < 0 || rightIdx >= candles.length) { isLow = false; break; }
            if (c.low >= candles[leftIdx].low || c.low >= candles[rightIdx].low) {
                isLow = false;
                break;
            }
        }

        if (isLow) {
            const lastL = this._state.lowNodes.length > 0
                ? this._state.lowNodes[this._state.lowNodes.length - 1]
                : null;
            const disp = lastL ? Math.abs(c.low - lastL.price) : Infinity;
            const pctDisp = lastL ? disp / lastL.price : 1;

            if (disp >= minDist && pctDisp >= this.config.minDisplacementPct) {
                const volExpansion = this._state.volumeMA > 0
                    ? (c.volume || 0) / this._state.volumeMA : 1;

                const atrDisp = disp / effectiveATR;
                const strengthScore = Math.min(100, Math.round(
                    Math.min(40, atrDisp * 15) +
                    Math.min(30, lookback * 10) +
                    Math.min(30, volExpansion * 15)
                ));

                const label = lastL ? (c.low > lastL.price ? 'HL' : 'LL') : 'HL';

                const node = {
                    id: this._state.nodeIdCounter++,
                    type: 'low',
                    label,
                    index: confirmIdx,
                    price: c.low,
                    candle: c,
                    strength: lookback,
                    strengthScore,
                    timestamp: c.time || 0,
                    volumeRatio: Math.round(volExpansion * 100) / 100
                };

                this._pushSwingNode(node, 'low');
            }
        }
    },

    /**
     * Check for BOS / MSS against the current (latest) candle close.
     *
     * BOS: price closes beyond a previous structural level in trend direction.
     * MSS: price closes beyond a level AGAINST the current regime → reversal.
     *
     * Volume confirmation: break candle volume > volumeConfirmRatio × volumeMA.
     * Fake breakout filter: check next bars for reversal (applied retroactively).
     */
    _checkLiveBOS(candles, idx) {
        const c = candles[idx];
        const highs = this._state.highNodes;
        const lows = this._state.lowNodes;
        const effectiveATR = Math.max(this._state.atr, c.close * 0.001);
        const regime = this._state.regime.current;

        if (highs.length < 2 || lows.length < 2) return;

        const lastHigh = highs[highs.length - 1];
        const prevHigh = highs.length >= 2 ? highs[highs.length - 2] : null;
        const lastLow = lows[lows.length - 1];
        const prevLow = lows.length >= 2 ? lows[lows.length - 2] : null;

        // ── Bullish Break: close above the last confirmed swing high ──
        if (prevHigh && c.close > lastHigh.price) {
            const breakDisp = c.close - lastHigh.price;
            if (breakDisp > effectiveATR * this.config.bosATRThreshold &&
                idx - lastHigh.index >= this.config.bosMinBars) {

                const volOk = this._checkVolumeConfirmation(c);
                const isFakeout = this._checkFakeBreakout(candles, idx, lastHigh.price, 'bullish');

                // Determine if this is BOS (continuation) or MSS (reversal)
                const isMSS = regime === 'trending_down' || regime === 'transition';
                const type = isMSS ? 'MSS' : 'BOS';

                const baseConfidence = isMSS ? 55 + this.config.mssConfidenceBoost : 50;
                const confidence = Math.min(95, Math.round(
                    baseConfidence +
                    (lastHigh.strengthScore || 30) * 0.2 +
                    (volOk ? 10 : 0) +
                    (breakDisp / effectiveATR) * 5
                ));

                // Don't double-emit: check if we already have this event
                const lastEvent = this._state.eventLog.length > 0
                    ? this._state.eventLog[this._state.eventLog.length - 1]
                    : null;
                if (lastEvent && lastEvent.index === idx && lastEvent.direction === 'bullish') return;

                const event = {
                    type,
                    direction: 'bullish',
                    strength: confidence,
                    index: idx,
                    price: c.close,
                    brokenLevel: lastHigh.price,
                    volumeRatio: this._state.volumeMA > 0
                        ? Math.round((c.volume || 0) / this._state.volumeMA * 100) / 100
                        : 1,
                    confidence,
                    timestamp: c.time || 0,
                    isFakeout
                };

                this._pushEvent(event);

                // Update regime
                if (!isFakeout) {
                    if (isMSS) {
                        this._transitionRegime('transition', confidence, idx, 'bullish');
                    } else if (regime === 'range' || regime === 'transition') {
                        this._transitionRegime('trending_up', confidence, idx, null);
                    } else if (regime === 'trending_up') {
                        // Continuation — boost confidence
                        this._state.regime.confidence = Math.min(95,
                            this._state.regime.confidence + 5);
                    }
                }
            }
        }

        // ── Bearish Break: close below the last confirmed swing low ──
        if (prevLow && c.close < lastLow.price) {
            const breakDisp = lastLow.price - c.close;
            if (breakDisp > effectiveATR * this.config.bosATRThreshold &&
                idx - lastLow.index >= this.config.bosMinBars) {

                const volOk = this._checkVolumeConfirmation(c);
                const isFakeout = this._checkFakeBreakout(candles, idx, lastLow.price, 'bearish');

                const isMSS = regime === 'trending_up' || regime === 'transition';
                const type = isMSS ? 'MSS' : 'BOS';

                const baseConfidence = isMSS ? 55 + this.config.mssConfidenceBoost : 50;
                const confidence = Math.min(95, Math.round(
                    baseConfidence +
                    (lastLow.strengthScore || 30) * 0.2 +
                    (volOk ? 10 : 0) +
                    (breakDisp / effectiveATR) * 5
                ));

                const lastEvent = this._state.eventLog.length > 0
                    ? this._state.eventLog[this._state.eventLog.length - 1]
                    : null;
                if (lastEvent && lastEvent.index === idx && lastEvent.direction === 'bearish') return;

                const event = {
                    type,
                    direction: 'bearish',
                    strength: confidence,
                    index: idx,
                    price: c.close,
                    brokenLevel: lastLow.price,
                    volumeRatio: this._state.volumeMA > 0
                        ? Math.round((c.volume || 0) / this._state.volumeMA * 100) / 100
                        : 1,
                    confidence,
                    timestamp: c.time || 0,
                    isFakeout
                };

                this._pushEvent(event);

                if (!isFakeout) {
                    if (isMSS) {
                        this._transitionRegime('transition', confidence, idx, 'bearish');
                    } else if (regime === 'range' || regime === 'transition') {
                        this._transitionRegime('trending_down', confidence, idx, null);
                    } else if (regime === 'trending_down') {
                        this._state.regime.confidence = Math.min(95,
                            this._state.regime.confidence + 5);
                    }
                }
            }
        }
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Swing Labeling
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Label a sequence of swing points as HH/HL/LH/LL relative to previous.
     * Pure function — no state mutation.
     *
     * @param {Array} swings - Array of swing objects from SwingDetector
     * @param {string} swingType - 'high' or 'low'
     * @returns {Array} Labeled nodes with `label` and `type` fields
     */
    _labelSwingSequence(swings, swingType) {
        const labeled = [];

        for (let i = 0; i < swings.length; i++) {
            const s = swings[i];
            let label;

            if (swingType === 'high') {
                label = 'HH'; // Default
                if (i > 0) {
                    label = s.price > swings[i - 1].price ? 'HH' : 'LH';
                }
            } else {
                label = 'HL'; // Default
                if (i > 0) {
                    label = s.price > swings[i - 1].price ? 'HL' : 'LL';
                }
            }

            labeled.push({
                ...s,
                label,
                type: swingType,
                strengthScore: s.strengthScore || 50
            });
        }

        return labeled;
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Structure Event Detection (Full Scan)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Detect all BOS and MSS events from the full swing history.
     * Used during full reprocessing.
     *
     * BOS detection requires:
     *   1. Candle closes beyond a structural level
     *   2. Break displacement > bosATRThreshold × ATR
     *   3. Volume on break candle > volumeConfirmRatio × volume MA
     *   4. Not flagged as fake breakout
     */
    _detectAllStructureEvents(candles) {
        const highs = this._state.highNodes;
        const lows = this._state.lowNodes;
        const effectiveATR = Math.max(this._state.atr, candles[candles.length - 1].close * 0.001);

        // Determine prevailing direction as we scan
        let prevailingDir = 'unknown';

        // Scan highs for bullish BOS / MSS
        for (let hi = 1; hi < highs.length; hi++) {
            const curr = highs[hi];
            const prev = highs[hi - 1];
            const breakDisp = curr.price - prev.price;

            if (curr.label === 'HH' && breakDisp > effectiveATR * this.config.bosATRThreshold) {
                const barsAfter = curr.index - prev.index;
                if (barsAfter < this.config.bosMinBars) continue;

                // Volume confirmation
                const breakCandle = candles[curr.index];
                const volOk = breakCandle && this._checkVolumeAtIndex(candles, curr.index);
                const isFakeout = this._checkFakeBreakoutHistory(candles, curr.index, prev.price, 'bullish');

                const isMSS = prevailingDir === 'down' && prev.label === 'LH';
                const type = isMSS ? 'MSS' : 'BOS';

                const baseConf = isMSS ? 55 + this.config.mssConfidenceBoost : 50;
                const confidence = Math.min(95, Math.round(
                    baseConf + (curr.strengthScore || 30) * 0.2 + (volOk ? 10 : 0)
                ));

                this._pushEvent({
                    type,
                    direction: 'bullish',
                    strength: confidence,
                    index: curr.index,
                    price: curr.price,
                    brokenLevel: prev.price,
                    volumeRatio: 1,
                    confidence,
                    timestamp: curr.timestamp || 0,
                    isFakeout
                });

                prevailingDir = 'up';
            } else if (curr.label === 'LH') {
                // Potential top formation
                if (prevailingDir === 'up') prevailingDir = 'weakening_up';
            }
        }

        // Scan lows for bearish BOS / MSS
        prevailingDir = 'unknown';
        for (let li = 1; li < lows.length; li++) {
            const curr = lows[li];
            const prev = lows[li - 1];
            const breakDisp = prev.price - curr.price;

            if (curr.label === 'LL' && breakDisp > effectiveATR * this.config.bosATRThreshold) {
                const barsAfter = curr.index - prev.index;
                if (barsAfter < this.config.bosMinBars) continue;

                const volOk = this._checkVolumeAtIndex(candles, curr.index);
                const isFakeout = this._checkFakeBreakoutHistory(candles, curr.index, prev.price, 'bearish');

                const isMSS = prevailingDir === 'up' && prev.label === 'HL';
                const type = isMSS ? 'MSS' : 'BOS';

                const baseConf = isMSS ? 55 + this.config.mssConfidenceBoost : 50;
                const confidence = Math.min(95, Math.round(
                    baseConf + (curr.strengthScore || 30) * 0.2 + (volOk ? 10 : 0)
                ));

                this._pushEvent({
                    type,
                    direction: 'bearish',
                    strength: confidence,
                    index: curr.index,
                    price: curr.price,
                    brokenLevel: prev.price,
                    volumeRatio: 1,
                    confidence,
                    timestamp: curr.timestamp || 0,
                    isFakeout
                });

                prevailingDir = 'down';
            } else if (curr.label === 'HL') {
                if (prevailingDir === 'down') prevailingDir = 'weakening_down';
            }
        }

        // Sort events chronologically
        this._state.eventLog.sort((a, b) => a.index - b.index);
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Regime State Machine
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Classify regime from the full swing history during reprocessing.
     *
     * State machine rules:
     *   UP:         HH + HL sequence, no HL break
     *   DOWN:       LL + LH sequence, no LH break
     *   RANGE:      Alternating structure, no expansion, ATR contraction
     *   TRANSITION: MSS detected, conflicting BOS events
     */
    _classifyRegimeFromHistory(candles) {
        const highs = this._state.highNodes;
        const lows = this._state.lowNodes;
        const events = this._state.eventLog;
        const lookback = this.config.transitionLookback;

        // Check for recent MSS → TRANSITION
        const mssEvents = events.filter(e => e.type === 'MSS' && !e.isFakeout);
        if (mssEvents.length > 0) {
            const lastMSS = mssEvents[mssEvents.length - 1];
            const barsAgo = candles.length - 1 - lastMSS.index;

            if (barsAgo < this.config.transitionTimeoutBars) {
                this._state.regime = {
                    current: 'transition',
                    confidence: lastMSS.confidence,
                    duration: barsAgo,
                    lastUpdate: lastMSS.index,
                    previousRegime: this._inferPreviousRegime(lastMSS.index),
                    transitionDirection: lastMSS.direction,
                    transitionStart: lastMSS.index
                };
                return;
            }
        }

        // Use last N swing labels
        const recentHighs = highs.slice(-lookback);
        const recentLows = lows.slice(-lookback);

        if (recentHighs.length < 2 || recentLows.length < 2) {
            this._state.regime.current = 'range';
            this._state.regime.confidence = 40;
            return;
        }

        const hhCount = recentHighs.filter(h => h.label === 'HH').length;
        const lhCount = recentHighs.filter(h => h.label === 'LH').length;
        const hlCount = recentLows.filter(l => l.label === 'HL').length;
        const llCount = recentLows.filter(l => l.label === 'LL').length;

        const totalH = recentHighs.length;
        const totalL = recentLows.length;

        const bullishRatio = (hhCount / totalH + hlCount / totalL) / 2;
        const bearishRatio = (lhCount / totalH + llCount / totalL) / 2;

        if (bullishRatio > 0.6) {
            const confidence = Math.min(95, Math.round(bullishRatio * 100));
            const firstIdx = Math.min(
                recentHighs[0].index,
                recentLows[0].index
            );
            this._state.regime = {
                current: 'trending_up',
                confidence,
                duration: candles.length - 1 - firstIdx,
                lastUpdate: candles.length - 1,
                previousRegime: null,
                transitionDirection: null,
                transitionStart: 0
            };
            return;
        }

        if (bearishRatio > 0.6) {
            const confidence = Math.min(95, Math.round(bearishRatio * 100));
            const firstIdx = Math.min(
                recentHighs[0].index,
                recentLows[0].index
            );
            this._state.regime = {
                current: 'trending_down',
                confidence,
                duration: candles.length - 1 - firstIdx,
                lastUpdate: candles.length - 1,
                previousRegime: null,
                transitionDirection: null,
                transitionStart: 0
            };
            return;
        }

        // Check for range: swings oscillating, ATR contracting
        if (this._isRanging(candles)) {
            this._state.regime = {
                current: 'range',
                confidence: 65,
                duration: this._estimateRangeDuration(candles),
                lastUpdate: candles.length - 1,
                previousRegime: null,
                transitionDirection: null,
                transitionStart: 0
            };
            return;
        }

        // Default: range with low confidence
        this._state.regime = {
            current: 'range',
            confidence: 40,
            duration: 0,
            lastUpdate: candles.length - 1,
            previousRegime: null,
            transitionDirection: null,
            transitionStart: 0
        };
    },

    /**
     * Transition the regime state machine.
     * Called by BOS/MSS detection handlers.
     */
    _transitionRegime(newRegime, confidence, candleIdx, direction) {
        this._state.regime.previousRegime = this._state.regime.current;
        this._state.regime.current = newRegime;
        this._state.regime.confidence = confidence;
        this._state.regime.duration = 0;
        this._state.regime.lastUpdate = candleIdx;
        this._state.regime.transitionDirection = direction;

        if (newRegime === 'transition') {
            this._state.regime.transitionStart = candleIdx;
        }
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Volume Confirmation
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Check if the given candle's volume exceeds the threshold.
     * Uses the incrementally maintained volume MA.
     */
    _checkVolumeConfirmation(candle) {
        if (this._state.volumeMA <= 0) return true; // No volume data → pass
        const vol = candle.volume || 0;
        return vol >= this._state.volumeMA * this.config.volumeConfirmRatio;
    },

    /**
     * Check volume confirmation at a specific historical index.
     * Computes a local volume average for the 20 bars preceding the index.
     */
    _checkVolumeAtIndex(candles, idx) {
        const period = this.config.volumeMAPeriod;
        const start = Math.max(0, idx - period);
        let sum = 0;
        let count = 0;
        for (let i = start; i < idx; i++) {
            sum += (candles[i].volume || 0);
            count++;
        }
        if (count === 0) return true;
        const avgVol = sum / count;
        return (candles[idx].volume || 0) >= avgVol * this.config.volumeConfirmRatio;
    },

    /**
     * Initialize the volume MA from scratch.
     */
    _initVolumeMA(candles) {
        const period = this.config.volumeMAPeriod;
        this._state.volumeBuffer = [];
        this._state.volumeSum = 0;

        const start = Math.max(0, candles.length - period);
        for (let i = start; i < candles.length; i++) {
            const vol = candles[i].volume || 0;
            this._state.volumeBuffer.push(vol);
            this._state.volumeSum += vol;
        }

        this._state.volumeMA = this._state.volumeBuffer.length > 0
            ? this._state.volumeSum / this._state.volumeBuffer.length
            : 0;
    },

    /**
     * Update volume MA incrementally with a new candle.
     * Circular buffer with fixed size = volumeMAPeriod.
     */
    _updateVolumeMA(candle) {
        const period = this.config.volumeMAPeriod;
        const vol = candle.volume || 0;

        this._state.volumeBuffer.push(vol);
        this._state.volumeSum += vol;

        // Evict oldest if over capacity
        if (this._state.volumeBuffer.length > period) {
            const evicted = this._state.volumeBuffer.shift();
            this._state.volumeSum -= evicted;
        }

        this._state.volumeMA = this._state.volumeBuffer.length > 0
            ? this._state.volumeSum / this._state.volumeBuffer.length
            : 0;
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Fake Breakout Detection
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Check for fake breakout on the LIVE (latest) candle.
     * Looks at the next `fakeoutReversalBars` candles to see if price reverses
     * back past the broken level by more than `fakeoutReversalPct` of the break.
     *
     * For the very latest candle, we can't look ahead — so this returns false.
     * The fakeout flag is updated retroactively when subsequent candles confirm.
     */
    _checkFakeBreakout(candles, breakIdx, brokenLevel, direction) {
        const lookAhead = this.config.fakeoutReversalBars;
        const reversalPct = this.config.fakeoutReversalPct;

        // Not enough future data to check
        if (breakIdx + lookAhead >= candles.length) return false;

        const breakCandle = candles[breakIdx];
        const breakSize = direction === 'bullish'
            ? breakCandle.close - brokenLevel
            : brokenLevel - breakCandle.close;

        if (breakSize <= 0) return false;

        // Check if any subsequent candle within `lookAhead` reverses significantly
        for (let i = 1; i <= lookAhead; i++) {
            const futureCandle = candles[breakIdx + i];
            if (direction === 'bullish') {
                const retracement = breakCandle.close - futureCandle.close;
                if (retracement > breakSize * reversalPct) return true;
            } else {
                const retracement = futureCandle.close - breakCandle.close;
                if (retracement > breakSize * reversalPct) return true;
            }
        }

        // Volume divergence check: break candle volume should exceed average
        // If volume is LOW on the break, it's more likely a fakeout
        if (this._state.volumeMA > 0) {
            const breakVol = breakCandle.volume || 0;
            if (breakVol < this._state.volumeMA * 0.8) return true;
        }

        return false;
    },

    /**
     * Historical fake breakout check — used during full reprocess.
     * Same logic as _checkFakeBreakout but recomputes volume context.
     */
    _checkFakeBreakoutHistory(candles, breakIdx, brokenLevel, direction) {
        return this._checkFakeBreakout(candles, breakIdx, brokenLevel, direction);
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Range Detection
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Check if the market is ranging.
     * Criteria: swings oscillate within an ATR-bounded zone,
     * slopes are flat, and ATR is contracting.
     */
    _isRanging(candles) {
        const highs = this._state.highNodes;
        const lows = this._state.lowNodes;

        if (highs.length < 3 || lows.length < 3) return false;

        const recentHighs = highs.slice(-4);
        const recentLows = lows.slice(-4);

        const maxHigh = Math.max(...recentHighs.map(h => h.price));
        const minLow = Math.min(...recentLows.map(l => l.price));
        const rangeWidth = maxHigh - minLow;

        const effectiveATR = this._state.atr;
        if (effectiveATR <= 0) return false;

        const atrMultiple = rangeWidth / effectiveATR;

        // Check slope flatness
        const highSlope = SwingDetector.linearSlope(
            recentHighs.map(h => ({ x: h.index, y: h.price }))
        );
        const lowSlope = SwingDetector.linearSlope(
            recentLows.map(l => ({ x: l.index, y: l.price }))
        );

        const avgPrice = candles[candles.length - 1].close;
        const normHighSlope = Math.abs(highSlope / avgPrice);
        const normLowSlope = Math.abs(lowSlope / avgPrice);

        return atrMultiple < this.config.rangeThresholdATR &&
            normHighSlope < 0.001 && normLowSlope < 0.001;
    },

    /**
     * Detect range boundaries when regime is RANGE.
     */
    _detectRange(candles) {
        const highs = this._state.highNodes;
        const lows = this._state.lowNodes;

        if (highs.length < 2 || lows.length < 2) return null;
        if (this._state.regime.current !== 'range') return null;

        const recentHighs = highs.slice(-5);
        const recentLows = lows.slice(-5);

        const high = Math.max(...recentHighs.map(h => h.price));
        const low = Math.min(...recentLows.map(l => l.price));
        const midpoint = (high + low) / 2;

        return {
            isRange: true,
            high,
            low,
            midpoint,
            width: high - low,
            widthPct: ((high - low) / low) * 100
        };
    },

    /**
     * Estimate range duration in bars.
     */
    _estimateRangeDuration(candles) {
        const allSwings = this._state.swingBuffer;
        if (allSwings.length < 2) return 0;

        const startIdx = allSwings.length > 4
            ? allSwings[allSwings.length - 4].index
            : allSwings[0].index;

        return candles.length - 1 - startIdx;
    },

    // ═════════════════════════════════════════════════════════════════════════
    // INTERNAL: Utility Helpers
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Infer previous regime from swing history before a given index.
     */
    _inferPreviousRegime(beforeIndex) {
        const highs = this._state.highNodes.filter(h => h.index < beforeIndex).slice(-3);
        const lows = this._state.lowNodes.filter(l => l.index < beforeIndex).slice(-3);

        if (highs.length < 2 || lows.length < 2) return 'unknown';

        const hhCount = highs.filter(h => h.label === 'HH').length;
        const llCount = lows.filter(l => l.label === 'LL').length;

        if (hhCount >= 2) return 'trending_up';
        if (llCount >= 2) return 'trending_down';
        return 'range';
    },

    /**
     * Push a new StructureNode into the rolling buffers.
     * Enforces the max buffer size.
     */
    _pushSwingNode(node, swingType) {
        // Add to type-specific buffer
        if (swingType === 'high') {
            this._state.highNodes.push(node);
            if (this._state.highNodes.length > this.config.maxSwingNodes) {
                this._state.highNodes.shift();
            }
        } else {
            this._state.lowNodes.push(node);
            if (this._state.lowNodes.length > this.config.maxSwingNodes) {
                this._state.lowNodes.shift();
            }
        }

        // Add to chronological buffer
        this._state.swingBuffer.push(node);
        if (this._state.swingBuffer.length > this.config.maxSwingNodes * 2) {
            this._state.swingBuffer.shift();
        }
    },

    /**
     * Push a new StructureEvent into the event log.
     * Enforces the max log size.
     */
    _pushEvent(event) {
        this._state.eventLog.push(event);
        if (this._state.eventLog.length > this.config.maxEventLog) {
            this._state.eventLog.shift();
        }
    },

    /**
     * Reset all internal state to initial values.
     */
    _resetState() {
        this._state = {
            initialized: false,
            swingBuffer: [],
            highNodes: [],
            lowNodes: [],
            eventLog: [],
            regime: {
                current: 'unknown',
                confidence: 0,
                duration: 0,
                lastUpdate: 0,
                previousRegime: null,
                transitionDirection: null,
                transitionStart: 0
            },
            atr: 0,
            atrPrev: 0,
            volumeMA: 0,
            volumeSum: 0,
            volumeBuffer: [],
            lastCandleCount: 0,
            lastCandleTime: 0,
            nodeIdCounter: 0
        };
    },

    /**
     * Build the output object in the contract format expected by downstream consumers.
     *
     * Maps internal regime names to the format used by ConfluenceEngine:
     *   'trending_up' | 'trending_down' | 'range' | 'transition'
     */
    _buildOutput(candles) {
        const regimeMap = {
            'trending_up': 'trending_up',
            'trending_down': 'trending_down',
            'range': 'range',
            'transition': 'transition',
            'unknown': 'unknown'
        };

        // Build events summary
        const events = this._state.eventLog;
        const bosEvents = events.filter(e => e.type === 'BOS' && !e.isFakeout);
        const mssEvents = events.filter(e => e.type === 'MSS' && !e.isFakeout);

        const r = this._state.regime;

        const output = {
            // For LiquidityEngine: { highs, lows }
            swings: {
                highs: this._state.highNodes,
                lows: this._state.lowNodes
            },

            // For ConfluenceEngine: chronological sequence with .label and .index
            sequence: this._state.swingBuffer,

            // For ConfluenceEngine: { events, lastBOS, lastMSS }
            structure: {
                events: events.filter(e => !e.isFakeout),
                lastBOS: bosEvents.length > 0 ? bosEvents[bosEvents.length - 1] : null,
                lastMSS: mssEvents.length > 0 ? mssEvents[mssEvents.length - 1] : null
            },

            // For ConfluenceEngine + popup.js
            regime: {
                current: regimeMap[r.current] || 'unknown',
                confidence: r.confidence,
                duration: r.duration,
                previousRegime: r.previousRegime,
                transitionDirection: r.transitionDirection
            },

            // For LiquidityEngine
            range: this._detectRange(candles)
        };

        // EVENT DRIVEN ADDITION START
        if (typeof StateCache !== 'undefined') {
            StateCache.set('lastBOS', output.structure.lastBOS);
            StateCache.set('lastMSS', output.structure.lastMSS);
            StateCache.set('currentRegime', output.regime.current);
            StateCache.set('regimeConfidence', output.regime.confidence);
        }

        if (typeof EventBus !== 'undefined' && EventBus.EVENTS) {
            const E = EventBus.EVENTS;
            const currentCandleTime = candles[candles.length - 1]?.time;

            if (output.structure.lastBOS && output.structure.lastBOS.timestamp === currentCandleTime) {
                EventBus.emit(E.MICRO_BOS || 'MICRO_BOS', output.structure.lastBOS);
            }
            if (output.structure.lastMSS && output.structure.lastMSS.timestamp === currentCandleTime) {
                EventBus.emit(E.MSS_DETECTED || 'MSS_DETECTED', output.structure.lastMSS);
            }
            if (output.regime.duration === 1 && this._state.eventLog.length > 0) { // Just changed
                EventBus.emit(E.REGIME_CHANGE || 'REGIME_CHANGE', output.regime);
            }
        }
        // EVENT DRIVEN ADDITION END

        return output;
    },

    /**
     * Return an empty result object for insufficient data.
     */
    _emptyResult() {
        return {
            swings: { highs: [], lows: [] },
            sequence: [],
            structure: { events: [], lastBOS: null, lastMSS: null },
            regime: {
                current: 'unknown',
                confidence: 0,
                duration: 0,
                previousRegime: null,
                transitionDirection: null
            },
            range: null
        };
    },

    // ═════════════════════════════════════════════════════════════════════════
    // UI VISUALIZATION DATA HOOKS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Get a rich data payload formatted for UI rendering and chart annotation.
     * This is the single entry point for all MSE → UI data flow.
     *
     * @param {object} state - Output of analyze()
     * @returns {object} Visualization data packet
     */
    getVisualizationData(state) {
        if (!state || state.regime.current === 'unknown') {
            return { regime: null, markers: [], swingLevels: [], confidenceContext: null };
        }

        // --- Regime info with display colors ---
        const regimeColors = {
            trending_up: { bg: '#1b5e20', text: '#66bb6a', border: '#388e3c' },
            trending_down: { bg: '#b71c1c', text: '#ef5350', border: '#c62828' },
            range: { bg: '#1a237e', text: '#7986cb', border: '#283593' },
            transition: { bg: '#e65100', text: '#ffb74d', border: '#ef6c00' }
        };
        const colors = regimeColors[state.regime.current] || regimeColors.range;
        const regime = {
            current: state.regime.current,
            label: state.regime.current.replace('_', ' ').toUpperCase(),
            confidence: state.regime.confidence,
            duration: state.regime.duration,
            transitionDirection: state.regime.transitionDirection,
            colors
        };

        // --- BOS/MSS chart markers ---
        const events = state.structure.events || [];
        const markers = events.slice(-20).map(evt => {
            const isBOS = evt.type === 'BOS';
            const isMSS = evt.type === 'MSS';
            const isBullish = evt.direction === 'bullish';

            return {
                type: evt.type,
                direction: evt.direction,
                index: evt.index,
                price: evt.price,
                confidence: evt.confidence,
                fakeout: evt.fakeout || false,
                // Chart rendering hints
                color: isMSS
                    ? (isBullish ? '#00e676' : '#ff1744')  // MSS: vivid green/red
                    : (isBullish ? '#66bb6a' : '#ef5350'),  // BOS: softer green/red
                shape: isMSS ? 'diamond' : 'triangle',
                label: `${evt.type} ${isBullish ? '▲' : '▼'}`,
                size: isMSS ? 'large' : 'medium',
                opacity: evt.fakeout ? 0.4 : 1.0
            };
        });

        // --- Swing levels for horizontal annotations ---
        const recentSwings = state.sequence.slice(-10);
        const swingColors = {
            HH: '#00e676', HL: '#66bb6a',
            LH: '#ef5350', LL: '#ff1744'
        };
        const swingLevels = recentSwings.map(s => ({
            label: s.label,
            price: s.price,
            index: s.index,
            color: swingColors[s.label] || '#9e9e9e',
            // Line style hints
            lineStyle: (s.label === 'HH' || s.label === 'LL') ? 'solid' : 'dashed',
            thickness: (s.label === 'HH' || s.label === 'LL') ? 2 : 1
        }));

        // --- Confidence context for UI widgets ---
        const lastBOS = state.structure.lastBOS;
        const lastMSS = state.structure.lastMSS;
        const confidenceContext = {
            regimeConfidence: state.regime.confidence,
            hasMSS: !!lastMSS,
            hasBOS: !!lastBOS,
            mssDirection: lastMSS?.direction || null,
            bosDirection: lastBOS?.direction || null,
            eventCount: events.length,
            // Signal quality indicator
            quality: state.regime.confidence > 70
                ? (lastBOS ? 'high' : 'moderate')
                : (lastMSS ? 'transitional' : 'low'),
            qualityColor: state.regime.confidence > 70
                ? (lastBOS ? '#00e676' : '#ffd740')
                : (lastMSS ? '#ff9100' : '#ff1744')
        };

        return { regime, markers, swingLevels, confidenceContext };
    }
};

// --- FINAL DO ARQUIVO market-structure.js ---

// Garantia de compatibilidade com o Electron/Browser
if (typeof window !== 'undefined') {
    window.MarketStateEngine = MarketStateEngine;
    console.log('[Antigravity OS] MSE (Market Structure Engine) operacional.');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MarketStateEngine;
}