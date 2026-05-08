/**
 * Institutional Volume Profile Engine (VPE)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Professional-grade volume profile intelligence:
 *   - Incremental price binning with rolling buffer
 *   - Point of Control (POC) with shift detection
 *   - Value Area (VAH/VAL) with width analysis
 *   - High Volume Nodes (HVN) — S/R magnets
 *   - Low Volume Nodes (LVN) — acceleration/rejection zones
 *   - Session Profiles (Asia/London/NY)
 *   - Anchored Profiles (from BOS/MSS/swing via MSE)
 *   - Volume Shape Classification (D/P/b/Trend)
 *   - Delta Divergence detection
 *
 * Architecture position:
 *   MSE → ILL → VPE → Pattern Engine → Indicators → Signals
 *
 * Performance: O(B) per candle where B = bins touched (~3–5).
 *              Rolling buffer caps at configurable window (default 200).
 *              No full-history recalculation after bootstrap.
 */

// @ts-nocheck
import { EventBus } from './event-bus';
import { StateCache } from './state-cache';

export const VolumeProfile = {

    // ═══════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════

    config: {
        // --- Binning ---
        maxBins: 100,                  // Max bins in profile
        minBins: 30,                   // Min bins in profile
        binWidthATRFraction: 0.10,     // Bin width = ATR × 0.10
        binWidthFloorPct: 0.0001,      // Floor: 0.01% of price
        binWidthCeilingPct: 0.005,     // Ceiling: 0.5% of price

        // --- Rolling buffer ---
        rollingWindow: 200,            // Default candle window
        maxRollingWindow: 500,         // Absolute max

        // --- Value Area ---
        valueAreaPct: 0.70,            // 70% of volume

        // --- Node detection ---
        hvnThreshold: 1.5,             // HVN = bins > 1.5× avg vol
        lvnThreshold: 0.4,             // LVN = bins < 0.4× avg vol
        maxHVN: 5,                     // Top N HVN zones
        maxLVN: 5,                     // Top N LVN zones
        nodeClusterBins: 2,            // Adjacent bins merge distance

        // --- Session hours (UTC) ---
        sessions: {
            asia: { start: 0, end: 8 },
            london: { start: 8, end: 16 },
            newyork: { start: 16, end: 24 }
        },

        // --- Volume guards ---
        maxCandleContribution: 5.0,    // Cap single candle at 5× volumeMA
        minCandlesForProfile: 10,      // Min candles to produce profile
        atrPeriod: 14,                 // ATR period for bin sizing
        volumeMAPeriod: 20,            // Volume MA period

        // --- POC shift ---
        pocShiftThreshold: 2           // POC must move > N bins to flag shift
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL STATE
    // ═══════════════════════════════════════════════════════════════════════

    _state: {
        bins: new Map(),               // Map<binKey, VolumeNode>
        candleBuffer: [],              // Rolling deque of processed candles
        binWidth: 0,                   // Current bin width
        rangeHigh: 0,                  // Current price range
        rangeLow: Infinity,
        totalVolume: 0,
        atr: 0,
        volumeMA: 0,
        pocBinKey: null,               // Current POC bin key
        prevPocBinKey: null,           // Previous POC for shift detection
        lastCandleCount: 0,
        lastRegime: null,
        bootstrapped: false,

        // Session state
        sessionProfiles: {
            asia: null,
            london: null,
            newyork: null
        },

        // Anchored state
        anchoredProfile: null,
        anchorIndex: -1,
        anchorType: null
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Compute volume profile. First call bootstraps; subsequent calls update incrementally.
     *
     * @param {Array} candles - OHLCV candles
     * @param {object} [marketState] - MSE output (optional, enables session/anchored profiles)
     * @returns {object} Full volume profile result
     */
    compute(candles, marketState) {
        if (!candles || candles.length < this.config.minCandlesForProfile) {
            return this._emptyResult();
        }

        // Update cached indicators
        this._updateATR(candles);
        this._updateVolumeMA(candles);
        this._updateBinWidth(candles);

        const regime = marketState?.regime?.current || 'unknown';
        const isNewData = candles.length !== this._state.lastCandleCount;
        const regimeChanged = regime !== this._state.lastRegime;

        if (!this._state.bootstrapped || regimeChanged) {
            this._fullCompute(candles, marketState);
        } else {
            // Incremental: process new candle OR update current open candle
            this._incrementalUpdate(candles, marketState);
        }

        this._state.lastCandleCount = candles.length;
        this._state.lastRegime = regime;

        return this._buildResult(candles, marketState);
    },

    /**
     * Compact summary for UI and confluence integration.
     * Preserves backward-compatible shape + new fields.
     */
    getSummary(vpData) {
        if (!vpData || !vpData.profile || vpData.totalVolume === 0) {
            return { signal: 'hold', confidence: 0, active: false };
        }

        let score = 0;
        let factors = 0;

        const currentPrice = vpData.currentPrice || vpData.poc;

        // --- POC relationship ---
        if (currentPrice < vpData.poc) {
            score += 25; // Below POC → undervalued by volume consensus
            factors++;
        } else if (currentPrice > vpData.poc) {
            score -= 25;
            factors++;
        }

        // --- Value Area location ---
        if (currentPrice < vpData.val) {
            score += 35; // Below VA → strong buy zone
            factors++;
        } else if (currentPrice > vpData.vah) {
            score -= 35; // Above VA → sell zone
            factors++;
        }

        // --- Delta divergence ---
        if (vpData.deltaDivergence && vpData.deltaDivergence.detected) {
            const divScore = vpData.deltaDivergence.type === 'bullish' ? 30 : -30;
            score += divScore;
            factors++;
        }

        // --- Profile shape ---
        if (vpData.shape) {
            if (vpData.shape === 'P') { score += 15; factors++; }
            else if (vpData.shape === 'b') { score -= 15; factors++; }
        }

        // --- LVN interaction ---
        if (vpData.lvnInteraction) {
            // In LVN = expect acceleration in current direction
            factors++;
        }

        // --- POC shift ---
        if (vpData.pocShifted) {
            factors++; // Instability signal
        }

        const avgScore = factors > 0 ? score / factors : 0;
        const signal = avgScore > 10 ? 'buy' : avgScore < -10 ? 'sell' : 'hold';
        const confidence = Math.min(100, Math.abs(Math.round(avgScore)));

        return {
            signal,
            confidence,
            active: true,
            poc: vpData.poc,
            vah: vpData.vah,
            val: vpData.val,
            hvnCount: vpData.nodes?.hvn?.length || 0,
            lvnCount: vpData.nodes?.lvn?.length || 0,
            deltaDivergence: vpData.deltaDivergence?.type || null,
            // New enhanced fields
            shape: vpData.shape || null,
            pocShifted: vpData.pocShifted || false,
            lvnInteraction: vpData.lvnInteraction || false,
            vaWidth: vpData.vaWidth || 0,
            sessionPocs: vpData.sessionProfiles ? {
                asia: vpData.sessionProfiles.asia?.poc || null,
                london: vpData.sessionProfiles.london?.poc || null,
                newyork: vpData.sessionProfiles.newyork?.poc || null
            } : null,
            anchoredPoc: vpData.anchoredProfile?.poc || null,
            hvnLevels: (vpData.nodes?.hvn || []).map(h => h.price),
            lvnLevels: (vpData.nodes?.lvn || []).map(l => l.price)
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // FULL COMPUTE (Bootstrap / Regime Change)
    // ═══════════════════════════════════════════════════════════════════════

    _fullCompute(candles, marketState) {
        // Reset state
        this._state.bins = new Map();
        this._state.totalVolume = 0;
        this._state.pocBinKey = null;
        this._state.prevPocBinKey = null;
        this._state.rangeHigh = -Infinity;
        this._state.rangeLow = Infinity;

        // Use rolling window
        const windowSize = Math.min(candles.length, this.config.rollingWindow);
        const windowCandles = candles.slice(-windowSize);
        this._state.candleBuffer = [];

        // Determine range
        for (const c of windowCandles) {
            if (c.high > this._state.rangeHigh) this._state.rangeHigh = c.high;
            if (c.low < this._state.rangeLow) this._state.rangeLow = c.low;
        }

        // Distribute all candles into bins
        for (const c of windowCandles) {
            this._addCandle(c);
            this._state.candleBuffer.push(c);
        }

        // Update POC
        this._updatePOC();

        // Session profiles
        this._computeSessionProfiles(windowCandles, marketState);

        // Anchored profile
        this._computeAnchoredProfile(candles, marketState);

        this._state.bootstrapped = true;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INCREMENTAL UPDATE
    // ═══════════════════════════════════════════════════════════════════════

    _incrementalUpdate(candles, marketState) {
        const latest = candles[candles.length - 1];
        const lastInState = this._state.candleBuffer[this._state.candleBuffer.length - 1];

        // ⚡ LIVE UPDATE: Se a vela já foi adicionada mas ainda está aberta, removemos a versão anterior
        if (lastInState && (latest.time === lastInState.time || latest.openTime === lastInState.openTime)) {
            this._removeCandle(lastInState);
            this._state.candleBuffer.pop();
        }

        // Expand range if needed
        if (latest.high > this._state.rangeHigh) this._state.rangeHigh = latest.high;
        if (latest.low < this._state.rangeLow) this._state.rangeLow = latest.low;

        // Add new candle (or updated version)
        this._addCandle(latest);
        this._state.candleBuffer.push(latest);

        // Remove oldest if beyond rolling window
        while (this._state.candleBuffer.length > this.config.rollingWindow) {
            const oldest = this._state.candleBuffer.shift();
            this._removeCandle(oldest);
        }

        // Update POC (check for shift)
        this._state.prevPocBinKey = this._state.pocBinKey;
        this._updatePOC();

        // Update session profiles with latest candle
        this._updateSessionWithCandle(latest, marketState);

        // Update anchored profile
        this._updateAnchoredProfile(candles, marketState);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BIN OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════

    _processCandleVolume(candle, binWidth) {
        if (binWidth <= 0 || candle.high - candle.low <= 0) return null;

        const vol = candle.volume || 0;
        if (vol <= 0) return null;

        // Cap extreme volume
        const cappedVol = this._state.volumeMA > 0
            ? Math.min(vol, this._state.volumeMA * this.config.maxCandleContribution)
            : vol;

        const candleRange = candle.high - candle.low;
        const isBull = candle.close >= candle.open;
        const closePosition = candleRange > 0 ? (candle.close - candle.low) / candleRange : 0.5;
        const buyRatio = isBull ? (0.5 + closePosition * 0.3) : (0.2 + closePosition * 0.3);

        const lowBin = Math.floor(candle.low / binWidth);
        const highBin = Math.floor(candle.high / binWidth);

        return { cappedVol, candleRange, buyRatio, lowBin, highBin };
    },

    /**
     * Add a candle's volume to bins. O(B) where B = bins touched.
     */
    _addCandle(candle) {
        const binWidth = this._state.binWidth;

        const processResult = this._processCandleVolume(candle, binWidth);
        if (!processResult) return;

        const { cappedVol, candleRange, buyRatio, lowBin, highBin } = processResult;

        for (let b = lowBin; b <= highBin; b++) {
            const binLow = b * binWidth;
            const binHigh = (b + 1) * binWidth;

            // Overlap fraction
            const overlapLow = Math.max(candle.low, binLow);
            const overlapHigh = Math.min(candle.high, binHigh);
            const overlap = Math.max(0, overlapHigh - overlapLow);
            const fraction = overlap / candleRange;

            const allocated = cappedVol * fraction;
            if (allocated <= 0) continue;

            const key = b;
            let node = this._state.bins.get(key);
            if (!node) {
                node = {
                    priceLevel: binLow + binWidth * 0.5,
                    priceLow: binLow,
                    priceHigh: binHigh,
                    volume: 0,
                    buyVolume: 0,
                    sellVolume: 0,
                    delta: 0
                };
                this._state.bins.set(key, node);
            }

            node.volume += allocated;
            node.buyVolume += allocated * buyRatio;
            node.sellVolume += allocated * (1 - buyRatio);
            node.delta = node.buyVolume - node.sellVolume;

            this._state.totalVolume += allocated;
        }
    },

    /**
     * Remove a candle's volume from bins (for rolling window eviction).
     */
    _removeCandle(candle) {
        const binWidth = this._state.binWidth;

        const processResult = this._processCandleVolume(candle, binWidth);
        if (!processResult) return;

        const { cappedVol, candleRange, buyRatio, lowBin, highBin } = processResult;

        for (let b = lowBin; b <= highBin; b++) {
            const binLow = b * binWidth;
            const binHigh = (b + 1) * binWidth;

            const overlapLow = Math.max(candle.low, binLow);
            const overlapHigh = Math.min(candle.high, binHigh);
            const overlap = Math.max(0, overlapHigh - overlapLow);
            const fraction = overlap / candleRange;

            const allocated = cappedVol * fraction;
            if (allocated <= 0) continue;

            const key = b;
            const node = this._state.bins.get(key);
            if (!node) continue;

            node.volume = Math.max(0, node.volume - allocated);
            node.buyVolume = Math.max(0, node.buyVolume - allocated * buyRatio);
            node.sellVolume = Math.max(0, node.sellVolume - allocated * (1 - buyRatio));
            node.delta = node.buyVolume - node.sellVolume;

            this._state.totalVolume = Math.max(0, this._state.totalVolume - allocated);

            // Clean up empty bins
            if (node.volume < 0.001) {
                this._state.bins.delete(key);
            }
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // POC DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    _updatePOC() {
        let maxVol = 0;
        let pocKey = null;

        for (const [key, node] of this._state.bins) {
            if (node.volume > maxVol) {
                maxVol = node.volume;
                pocKey = key;
            }
        }

        this._state.pocBinKey = pocKey;
    },

    _getPOCPrice() {
        if (this._state.pocBinKey === null) return 0;
        const node = this._state.bins.get(this._state.pocBinKey);
        return node ? node.priceLevel : 0;
    },

    _isPOCShifted() {
        if (this._state.prevPocBinKey === null || this._state.pocBinKey === null) return false;
        return Math.abs(this._state.pocBinKey - this._state.prevPocBinKey) >= this.config.pocShiftThreshold;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // VALUE AREA (VAH / VAL)
    // ═══════════════════════════════════════════════════════════════════════

    _calcValueArea() {
        if (this._state.bins.size === 0 || this._state.totalVolume === 0) {
            return { high: 0, low: 0, volumePct: 0 };
        }

        const targetVolume = this._state.totalVolume * this.config.valueAreaPct;

        // Create sorted bin array for expansion
        const sortedBins = Array.from(this._state.bins.entries())
            .sort((a, b) => a[0] - b[0]);

        if (sortedBins.length === 0) return { high: 0, low: 0, volumePct: 0 };

        // Find POC index in sorted array
        let pocIdx = 0;
        for (let i = 0; i < sortedBins.length; i++) {
            if (sortedBins[i][0] === this._state.pocBinKey) {
                pocIdx = i;
                break;
            }
        }

        // Expand from POC
        let currentVolume = sortedBins[pocIdx][1].volume;
        let upper = pocIdx;
        let lower = pocIdx;

        while (currentVolume < targetVolume && (upper < sortedBins.length - 1 || lower > 0)) {
            const upperVol = upper < sortedBins.length - 1 ? sortedBins[upper + 1][1].volume : 0;
            const lowerVol = lower > 0 ? sortedBins[lower - 1][1].volume : 0;

            if (upperVol >= lowerVol && upper < sortedBins.length - 1) {
                upper++;
                currentVolume += sortedBins[upper][1].volume;
            } else if (lower > 0) {
                lower--;
                currentVolume += sortedBins[lower][1].volume;
            } else if (upper < sortedBins.length - 1) {
                upper++;
                currentVolume += sortedBins[upper][1].volume;
            } else {
                break;
            }
        }

        return {
            high: sortedBins[upper][1].priceHigh,
            low: sortedBins[lower][1].priceLow,
            volumePct: (currentVolume / this._state.totalVolume) * 100
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // HVN / LVN DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    _detectNodes() {
        if (this._state.bins.size === 0 || this._state.totalVolume === 0) {
            return { hvn: [], lvn: [] };
        }

        const avgVolume = this._state.totalVolume / this._state.bins.size;
        const hvnThreshold = avgVolume * this.config.hvnThreshold;
        const lvnThreshold = avgVolume * this.config.lvnThreshold;

        const rawHVN = [];
        const rawLVN = [];

        for (const [key, node] of this._state.bins) {
            if (node.volume > hvnThreshold) {
                rawHVN.push({
                    key, price: node.priceLevel, volume: node.volume,
                    priceLow: node.priceLow, priceHigh: node.priceHigh
                });
            } else if (node.volume < lvnThreshold && node.volume > 0) {
                rawLVN.push({
                    key, price: node.priceLevel, volume: node.volume,
                    priceLow: node.priceLow, priceHigh: node.priceHigh
                });
            }
        }

        // Merge adjacent HVN bins into zones
        const hvn = this._mergeAdjacentNodes(rawHVN);
        const lvn = this._mergeAdjacentNodes(rawLVN);

        // Sort HVN by volume desc, cap
        hvn.sort((a, b) => b.volume - a.volume);
        const cappedHVN = hvn.slice(0, this.config.maxHVN);

        // Sort LVN by price, cap
        lvn.sort((a, b) => a.price - b.price);
        const cappedLVN = lvn.slice(0, this.config.maxLVN);

        return { hvn: cappedHVN, lvn: cappedLVN };
    },

    _mergeAdjacentNodes(nodes) {
        if (nodes.length === 0) return [];

        nodes.sort((a, b) => a.key - b.key);
        const merged = [];
        let current = { ...nodes[0] };

        for (let i = 1; i < nodes.length; i++) {
            if (nodes[i].key - current.key <= this.config.nodeClusterBins) {
                // Merge
                current.volume += nodes[i].volume;
                current.priceHigh = nodes[i].priceHigh;
                current.price = (current.priceLow + nodes[i].priceHigh) / 2;
                current.key = nodes[i].key; // Track furthest key
            } else {
                merged.push(current);
                current = { ...nodes[i] };
            }
        }
        merged.push(current);

        return merged;
    },

    /**
     * Check if current price is inside an LVN zone.
     */
    _checkLVNInteraction(price, nodes) {
        for (const lvn of nodes.lvn) {
            if (price >= lvn.priceLow && price <= lvn.priceHigh) {
                return {
                    active: true,
                    type: 'LVN_INTERACTION',
                    price: lvn.price,
                    strength: Math.round(100 - (lvn.volume / (this._state.totalVolume / this._state.bins.size || 1)) * 100)
                };
            }
        }
        return { active: false };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SESSION PROFILES
    // ═══════════════════════════════════════════════════════════════════════

    _computeSessionProfiles(candles, marketState) {
        const sessions = { asia: [], london: [], newyork: [] };

        for (const c of candles) {
            const session = this._classifySession(c);
            if (session) sessions[session].push(c);
        }

        for (const [name, sessionCandles] of Object.entries(sessions)) {
            this._state.sessionProfiles[name] = this._computeMiniProfile(sessionCandles, name);
        }
    },

    _updateSessionWithCandle(candle, marketState) {
        const session = this._classifySession(candle);
        if (!session) return;

        // Rebuild this session's profile from buffer candles in that session
        const sessionCandles = this._state.candleBuffer.filter(c =>
            this._classifySession(c) === session
        );
        this._state.sessionProfiles[session] = this._computeMiniProfile(sessionCandles, session);
    },

    _classifySession(candle) {
        if (!candle.timestamp && !candle.time && !candle.openTime) return null;

        const ts = candle.timestamp || candle.time || candle.openTime;
        let hour;

        if (typeof ts === 'number') {
            // Unix timestamp (ms or s)
            const d = new Date(ts > 1e12 ? ts : ts * 1000);
            hour = d.getUTCHours();
        } else if (typeof ts === 'string') {
            const d = new Date(ts);
            hour = d.getUTCHours();
        } else {
            return null;
        }

        const s = this.config.sessions;
        if (hour >= s.asia.start && hour < s.asia.end) return 'asia';
        if (hour >= s.london.start && hour < s.london.end) return 'london';
        if (hour >= s.newyork.start || hour < s.newyork.start) return 'newyork';
        return null;
    },

    /**
     * Compute a mini volume profile for a subset of candles (session or anchored).
     */
    _computeMiniProfile(candles, name) {
        if (!candles || candles.length < 3) return null;

        let maxPrice = -Infinity, minPrice = Infinity, totalVol = 0;
        for (const c of candles) {
            if (c.high > maxPrice) maxPrice = c.high;
            if (c.low < minPrice) minPrice = c.low;
            totalVol += (c.volume || 0);
        }

        const range = maxPrice - minPrice;
        if (range === 0 || totalVol === 0) return null;

        // Use fewer bins for mini profiles
        const numBins = Math.min(30, Math.max(10, Math.round(range / (this._state.binWidth || range / 20))));
        const binWidth = range / numBins;

        const bins = new Array(numBins).fill(0);
        for (const c of candles) {
            const vol = c.volume || 0;
            if (vol <= 0 || c.high - c.low <= 0) continue;
            const candleRange = c.high - c.low;

            const lowBin = Math.max(0, Math.floor((c.low - minPrice) / binWidth));
            const highBin = Math.min(numBins - 1, Math.floor((c.high - minPrice) / binWidth));

            for (let b = lowBin; b <= highBin; b++) {
                const overlapLow = Math.max(c.low, minPrice + b * binWidth);
                const overlapHigh = Math.min(c.high, minPrice + (b + 1) * binWidth);
                const fraction = Math.max(0, overlapHigh - overlapLow) / candleRange;
                bins[b] += vol * fraction;
            }
        }

        // Find POC
        let pocIdx = 0;
        for (let i = 1; i < numBins; i++) {
            if (bins[i] > bins[pocIdx]) pocIdx = i;
        }

        const poc = minPrice + (pocIdx + 0.5) * binWidth;

        // Value area
        const targetVol = totalVol * this.config.valueAreaPct;
        let currentVol = bins[pocIdx];
        let upper = pocIdx, lower = pocIdx;

        while (currentVol < targetVol && (upper < numBins - 1 || lower > 0)) {
            const uv = upper < numBins - 1 ? bins[upper + 1] : 0;
            const lv = lower > 0 ? bins[lower - 1] : 0;
            if (uv >= lv && upper < numBins - 1) { upper++; currentVol += bins[upper]; }
            else if (lower > 0) { lower--; currentVol += bins[lower]; }
            else { upper++; currentVol += bins[upper]; }
        }

        return {
            sessionName: name,
            poc,
            vah: minPrice + (upper + 1) * binWidth,
            val: minPrice + lower * binWidth,
            totalVolume: totalVol,
            candleCount: candles.length
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ANCHORED VOLUME PROFILE
    // ═══════════════════════════════════════════════════════════════════════

    _computeAnchoredProfile(candles, marketState) {
        if (!marketState) {
            this._state.anchoredProfile = null;
            return;
        }

        // Find best anchor point: MSS > BOS > major swing
        const lastMSS = marketState.structure?.lastMSS;
        const lastBOS = marketState.structure?.lastBOS;
        const seq = marketState.sequence || [];

        let anchorIndex = -1;
        let anchorType = null;

        if (lastMSS && lastMSS.index >= 0) {
            anchorIndex = lastMSS.index;
            anchorType = 'MSS';
        } else if (lastBOS && lastBOS.index >= 0) {
            anchorIndex = lastBOS.index;
            anchorType = 'BOS';
        } else if (seq.length > 0) {
            // Use most recent significant swing
            const lastSwing = seq[seq.length - 1];
            if (lastSwing && lastSwing.index >= 0) {
                anchorIndex = lastSwing.index;
                anchorType = 'SWING';
            }
        }

        if (anchorIndex < 0 || anchorIndex >= candles.length) {
            this._state.anchoredProfile = null;
            return;
        }

        // Only recompute if anchor changed
        if (anchorIndex === this._state.anchorIndex && this._state.anchoredProfile) {
            // Incremental: add latest candle to existing anchored profile
            // (simplified: recompute from anchor since it's typically a small window)
            const anchoredCandles = candles.slice(anchorIndex);
            this._state.anchoredProfile = this._computeMiniProfile(anchoredCandles, 'anchored');
            if (this._state.anchoredProfile) {
                this._state.anchoredProfile.anchorIndex = anchorIndex;
                this._state.anchoredProfile.anchorType = anchorType;
            }
            return;
        }

        this._state.anchorIndex = anchorIndex;
        this._state.anchorType = anchorType;

        const anchoredCandles = candles.slice(anchorIndex);
        this._state.anchoredProfile = this._computeMiniProfile(anchoredCandles, 'anchored');
        if (this._state.anchoredProfile) {
            this._state.anchoredProfile.anchorIndex = anchorIndex;
            this._state.anchoredProfile.anchorType = anchorType;
        }
    },

    _updateAnchoredProfile(candles, marketState) {
        // Re-evaluate anchor on each update
        this._computeAnchoredProfile(candles, marketState);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // VOLUME SHAPE CLASSIFICATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Classify volume distribution shape:
     *   D — balanced (bell curve, rotation/consolidation)
     *   P — top-heavy (short covering, bullish acceptance)
     *   b — bottom-heavy (long liquidation, bearish acceptance)
     *   Trend — spread/flat (directional flow)
     */
    _classifyShape() {
        if (this._state.bins.size < 5) return 'unknown';

        const sortedBins = Array.from(this._state.bins.values())
            .sort((a, b) => a.priceLow - b.priceLow);

        const total = sortedBins.length;
        const third = Math.floor(total / 3);

        // Volume in each third
        let lowerThird = 0, middleThird = 0, upperThird = 0;
        for (let i = 0; i < total; i++) {
            if (i < third) lowerThird += sortedBins[i].volume;
            else if (i < third * 2) middleThird += sortedBins[i].volume;
            else upperThird += sortedBins[i].volume;
        }

        const totalVol = lowerThird + middleThird + upperThird;
        if (totalVol === 0) return 'unknown';

        const lPct = lowerThird / totalVol;
        const mPct = middleThird / totalVol;
        const uPct = upperThird / totalVol;

        // Classification thresholds
        if (mPct > 0.45) return 'D';         // Middle-heavy = balanced bell
        if (uPct > 0.45 && lPct < 0.25) return 'P'; // Top-heavy = short covering
        if (lPct > 0.45 && uPct < 0.25) return 'b'; // Bottom-heavy = long liquidation

        // Check if distribution is relatively flat (trend)
        const maxPct = Math.max(lPct, mPct, uPct);
        const minPct = Math.min(lPct, mPct, uPct);
        if (maxPct - minPct < 0.15) return 'Trend'; // Flat = directional

        return 'D'; // Default to balanced
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DELTA DIVERGENCE
    // ═══════════════════════════════════════════════════════════════════════

    _detectDeltaDivergence(candles) {
        if (candles.length < 10) {
            return { detected: false, type: null, confidence: 0 };
        }

        const mid = Math.floor(candles.length / 2);
        const firstHalf = candles.slice(0, mid);
        const secondHalf = candles.slice(mid);

        const firstAvgClose = firstHalf.reduce((s, c) => s + c.close, 0) / firstHalf.length;
        const secondAvgClose = secondHalf.reduce((s, c) => s + c.close, 0) / secondHalf.length;
        const priceDirection = secondAvgClose > firstAvgClose ? 'up' : 'down';

        const calcDelta = (half) => half.reduce((s, c) => {
            const isBull = c.close >= c.open;
            return s + (isBull ? c.volume : -c.volume) * 0.3;
        }, 0);

        const firstDelta = calcDelta(firstHalf);
        const secondDelta = calcDelta(secondHalf);
        const deltaDirection = secondDelta > firstDelta ? 'up' : 'down';

        if (priceDirection !== deltaDirection) {
            const type = priceDirection === 'down' ? 'bullish' : 'bearish';
            const priceMagnitude = Math.abs(secondAvgClose - firstAvgClose) / firstAvgClose;
            const confidence = Math.min(85, 40 + priceMagnitude * 2000);

            return { detected: true, type, confidence: Math.round(confidence) };
        }

        return { detected: false, type: null, confidence: 0 };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INDICATOR HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    _updateATR(candles) {
        const period = this.config.atrPeriod;
        if (candles.length < period + 1) { this._state.atr = 0; return; }
        let sum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            sum += Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i - 1].close),
                Math.abs(candles[i].low - candles[i - 1].close)
            );
        }
        this._state.atr = sum / period;
    },

    _updateVolumeMA(candles) {
        const period = this.config.volumeMAPeriod;
        if (candles.length < period) { this._state.volumeMA = 0; return; }
        let sum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            sum += (candles[i].volume || 0);
        }
        this._state.volumeMA = sum / period;
    },

    _updateBinWidth(candles) {
        const atr = this._state.atr;
        if (atr <= 0) {
            // Fallback: use 0.1% of current price
            const price = candles[candles.length - 1]?.close || 1;
            this._state.binWidth = price * 0.001;
            return;
        }

        const price = candles[candles.length - 1]?.close || 1;
        let binWidth = atr * this.config.binWidthATRFraction;

        // Apply floor/ceiling
        const floor = price * this.config.binWidthFloorPct;
        const ceiling = price * this.config.binWidthCeilingPct;
        binWidth = Math.max(floor, Math.min(ceiling, binWidth));

        // Only update if significantly different (>20% change) to avoid full recompute
        if (this._state.binWidth > 0) {
            const change = Math.abs(binWidth - this._state.binWidth) / this._state.binWidth;
            if (change < 0.20) return; // Keep current bin width
        }

        this._state.binWidth = binWidth;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // OUTPUT / RESULT BUILDING
    // ═══════════════════════════════════════════════════════════════════════

    _buildResult(candles, marketState) {
        const poc = this._getPOCPrice();
        const va = this._calcValueArea();
        const nodes = this._detectNodes();
        const shape = this._classifyShape();
        const currentPrice = candles[candles.length - 1]?.close || poc;
        const pocShifted = this._isPOCShifted();
        const lvnInteraction = this._checkLVNInteraction(currentPrice, nodes);

        // Build sorted profile array for backward compatibility
        const profile = Array.from(this._state.bins.values())
            .sort((a, b) => a.priceLow - b.priceLow);

        // Delta divergence from buffer
        const deltaDivergence = this._detectDeltaDivergence(this._state.candleBuffer);

        const output = {
            profile,
            poc,
            vah: va.high,
            val: va.low,
            vaWidth: va.high - va.low,
            nodes,
            deltaDivergence,
            totalVolume: this._state.totalVolume,
            binSize: this._state.binWidth,
            priceRange: {
                high: this._state.rangeHigh,
                low: this._state.rangeLow
            },
            currentPrice,
            // New enhanced fields
            shape,
            pocShifted,
            lvnInteraction: lvnInteraction.active ? lvnInteraction : null,
            sessionProfiles: { ...this._state.sessionProfiles },
            anchoredProfile: this._state.anchoredProfile
        };

        // EVENT DRIVEN ADDITION START
        // Safely emit to EventBus and update StateCache
        if (typeof StateCache !== 'undefined') {
            StateCache.set('poc', output.poc);
            StateCache.set('vah', output.vah);
            StateCache.set('val', output.val);
            StateCache.set('volumeShape', output.shape);
        }

        if (typeof EventBus !== 'undefined' && EventBus.EVENTS) {
            const E = EventBus.EVENTS;

            // Check for POC shift event
            if (output.pocShifted && (!this._state.lastEmittedPoc || this._state.lastEmittedPoc !== output.poc)) {
                EventBus.emit(E.POC_SHIFT || 'POC_SHIFT', {
                    oldPoc: this._state.lastEmittedPoc,
                    newPoc: output.poc,
                    shape: output.shape
                });
                this._state.lastEmittedPoc = output.poc;
            }

            // Check for LVN interaction event
            if (output.lvnInteraction && (!this._state.lastEmittedLVN || this._state.lastEmittedLVN !== output.lvnInteraction.price)) {
                EventBus.emit(E.LVN_INTERACTION || 'LVN_INTERACTION', {
                    price: output.lvnInteraction.price,
                    type: output.lvnInteraction.type,
                    strength: output.lvnInteraction.strength
                });
                this._state.lastEmittedLVN = output.lvnInteraction.price;
            } else if (!output.lvnInteraction) {
                this._state.lastEmittedLVN = null; // Reset when not interacting
            }
        }
        // EVENT DRIVEN ADDITION END

        return output;
    },

    _emptyResult() {
        return {
            profile: [],
            poc: 0,
            vah: 0,
            val: 0,
            vaWidth: 0,
            nodes: { hvn: [], lvn: [] },
            deltaDivergence: { detected: false, type: null, confidence: 0 },
            totalVolume: 0,
            binSize: 0,
            priceRange: { high: 0, low: 0 },
            currentPrice: 0,
            shape: null,
            pocShifted: false,
            lvnInteraction: null,
            sessionProfiles: { asia: null, london: null, newyork: null },
            anchoredProfile: null
        };
    },

    /**
     * Reset all internal state. Used for symbol change or testing.
     */
    reset() {
        this._state = {
            bins: new Map(),
            candleBuffer: [],
            binWidth: 0,
            rangeHigh: -Infinity,
            rangeLow: Infinity,
            totalVolume: 0,
            atr: 0,
            volumeMA: 0,
            pocBinKey: null,
            prevPocBinKey: null,
            lastCandleCount: 0,
            lastRegime: null,
            bootstrapped: false,
            sessionProfiles: { asia: null, london: null, newyork: null },
            anchoredProfile: null,
            anchorIndex: -1,
            anchorType: null
        };
    }
};

// --- FINAL DO ARQUIVO volume-profile.js ---

// Exposição global para o ecossistema Antigravity OS
if (typeof window !== 'undefined') {
    window.VolumeProfile = VolumeProfile;
    console.log('[Antigravity OS] VPE (Volume Profile Engine) calibrado e ativo.');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VolumeProfile;
}
