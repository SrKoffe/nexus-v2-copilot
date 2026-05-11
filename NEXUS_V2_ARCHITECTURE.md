# NEXUS V2 — FULL ARCHITECTURAL WALKTHROUGH

## SECTION 1 — SYSTEM OVERVIEW

Nexus V2 is a "Co-Pilot" trading terminal specifically designed for MEXC perpetual futures. It is not an autonomous trading bot (which was abandoned after the "Churn Incident of 2026-03-29"); instead, it provides decision support by surfacing high-confluence setups, calculating risk, and leaving the final execution to a human operator (the "Oracle Mode").

### High-Level Architecture
- **Backend (Rust + Tauri):** Responsible for performance-critical I/O, maintaining the WebSocket connection to MEXC, managing SQLite database persistence, and providing native OS access (Tauri).
- **Frontend (React + Vite + TypeScript):** An institutional-grade dark-themed UI ("Bloomberg/Hyperliquid" style) utilizing lightweight-charts.
- **EventBus (Frontend):** A custom pub/sub system decoupled from React's rendering lifecycle, designed to throttle and handle high-frequency events (like market ticks) to prevent render storms.
- **State Management (Zustand):** State is decoupled into isolated stores (`useNexusStore`, `useScannerStore`) to localize re-renders.
- **Analysis Engines:** A suite of modular typescript engines (`ConfluenceEngine`, `MarketStateEngine`, `LiquidityEngine`, `ScalpEngine`, `FastPathEngine`) that process the real-time data flow.

### Communication Map
MEXC WebSocket -> Rust Backend (`MexcStream`) -> Tauri Emit (`market-tick`) -> React `listen()` (`useNexusEvents`) -> Internal `EventBus` -> Engines -> Zustand Store -> React UI

## SECTION 2 — BACKEND WALKTHROUGH

The Rust backend is built on Tokio for async execution, providing robust handling for WebSockets and Database operations.

- **Tauri Entry (`src-tauri/src/lib.rs`):** Initializes the `AppState`, Database, EventBus, ExecutionEngine (disabled for auto-trade), StateManager, RiskManager, and MexcPrivateClient. Handles IPC commands from the frontend.
- **WebSocket Flow (`MexcStream`, `UniverseScanner`):**
  - Uses `tokio-tungstenite` to connect to `wss://contract.mexc.com/edge`.
  - `MexcStream` listens to `sub.deal` for real-time tick data for the active symbol. Emits to the frontend via Tauri event `market-tick` (throttled to 150ms).
  - `UniverseScanner` listens to `sub.tickers` for all `_USDT` pairs. It calculates an `opportunity_score` based on momentum, volatility, and liquidity, sorts candidates, and throttles updates (200ms) to the frontend via `universe-scan-update`.
- **Database (`Database` via `rusqlite`):** Uses `tokio::task::spawn_blocking` to prevent blocking the async runtime. Stores config, trade history, and setup outcomes for the Evolutionary Memory System (adaptive learning).
- **Execution / Risk:** `ExecutionEngine` logic exists but auto-trading is permanently disabled ("Survival > Profit"). Risk management tracks PnL and can enforce cool-downs, but the frontend's `LeverageAdjustedRiskEngine` now primarily handles setup geometry (SL/TP sizing).

## SECTION 3 — FRONTEND WALKTHROUGH

The React frontend operates as a real-time terminal.

- **React Structure:** Minimal, non-intrusive component hierarchy. `useNexusEvents` acts as the bridge listener, setting up the `initAnalysisPipeline` and wiring Tauri events to the internal `EventBus`.
- **Zustand Systems:**
  - `useNexusStore`: Manages active leverage, pending/active setups, history, balance, pipeline stage, and mode. Includes an aggressive decoupling strategy.
  - `useScannerStore`: Manages the universe of active symbols and top candidates.
- **Rendering Systems:** React rendering is insulated from high-frequency tick data. Ticks are handled in the `EventBus` and `candleManager` (which batches ticks into 1m/5m OHLCV). Only significant events (e.g., `SCALP_SETUP` or throttled `ANALYSIS_SIGNAL` updates) trigger Zustand state mutations that cause React renders.
- **Engine Orchestration:** `maestro` (`MasterAnalysisEngine`) orchestrates the engines. It triggers `analyze()` on `TICK_UPDATE` (throttled by price movement) and `CANDLE_CLOSE`.

## SECTION 4 — ENGINE ANALYSIS

- **MasterAnalysisEngine (`maestro`):** The orchestrator. Coordinates `MarketStateEngine`, `LiquidityEngine`, `VolumeProfile`, calculates indicators, and feeds them into `ConfluenceEngine`. Emits `ANALYSIS_SIGNAL`. If confidence meets thresholds, it generates an auto-order signal (which is now just presented to the user).
- **MarketStateEngine:** Analyzes swings, Break of Structure (BOS), and Market Structure Shift (MSS) using ATR-filtered detection. Classifies market regimes (trending_up, trending_down, range, transition).
- **LiquidityEngine:** Tracks Equal Highs/Lows (EQH/EQL), detects liquidity sweeps (wicks beyond EQH/EQL that close inside), Displacements, Order Blocks (OBs), and Fair Value Gaps (FVGs).
- **ConfluenceEngine (v2.0):** The adaptive multi-dimensional probabilistic scoring engine. It blends 7 dimensions (Structure, Liquidity, Volume, TimeContext, Indicators, Futures, Volatility). Uses adaptive weighting based on regime (e.g., in a range, indicators and liquidity are weighted higher; in a trend, structure holds weight). Incorporates a non-linear sigmoid boost for rare alignments.
- **LeverageAdjustedRiskEngine:** The gatekeeper. Takes a "Natural Setup" from the engines and applies leverage mathematics. Calculates a margin-based Stop Loss and TP. Features a strict Expected Value (EV) gate (`minConfidence`, `evMultiplier`) that rejects setups if they do not cover fees and slippage with a positive EV ratio.
- **ScalpEngine:** High-performance engine dedicated to scalping. Manages `activeSetups`, applies velocity controls (trades per minute mode: swing_scalp -> hybrid -> micro_scalp), and tracks performance by setup type (liquidity_sweep_reversal, order_block_retest, etc.).
- **FastPathEngine:** Microstructure detection. Operates on a trailing 60-second tick queue. Looks for volume spikes > 4x average with strong delta dominance to instantly emit a `SCALP_SETUP` for immediate opportunities.
- **ProbabilityModel:** Provides hit probability estimation based on entry, target, stop, direction, and regime alignment. Used by LeverageRiskEngine for EV gating.

## SECTION 5 — EVENT FLOW MAPS

1. **Market Tick Flow:**
   MEXC WS -> `push.deal` -> Rust `MexcStream` -> Broadcast `SystemEvent::MarketTick` -> Tauri `emit("market-tick")` (150ms throttle) -> React `useNexusEvents` -> `EventBus.emit("MARKET_TICK")` -> `candleManager.addTick` / `FastPathEngine._processTick` -> `maestro.analyze` (if price moved > 0.05%).
2. **Setup Generation Flow (Standard):**
   `EventBus("CANDLE_CLOSE")` -> `maestro.analyze()` -> Runs `MarketStateEngine`, `LiquidityEngine` -> Feeds `ConfluenceEngine.calculate()` -> `maestro` emits `ANALYSIS_SIGNAL`. If probability >= threshold, triggers auto order logic (intercepted).
   Alternatively, `ScalpEngine.handleEvent()` triggers on `CANDLE_CLOSE` or `LIQUIDITY_SWEEP`. It runs targeted scanners (e.g., `_scanLiquiditySweepReversal`). If score > threshold, it emits `SCALP_SETUP`.
3. **Setup Presentation Flow:**
   `EventBus("SCALP_SETUP")` -> `useNexusEvents` intercepts -> calls `LeverageAdjustedRiskEngine.adjust()` -> updates `useNexusStore` (`pendingSetup`) -> `SetupCard` renders.

## SECTION 6 — SETUP GENERATION FLOW

1. **Spawning:** `ScalpEngine` or `FastPathEngine` detects a pattern (e.g., OB Retest). It creates a "Natural Setup" with directional bias, raw score, entry zone, and natural SL/TP based on ATR or structure.
2. **Confluence/Confidence Calculation:** `ConfluenceEngine` assigns a confidence score by weighting structural alignment, liquidity sweeps, etc., against the current market regime.
3. **Risk & EV Validation:** The setup is passed to `LeverageAdjustedRiskEngine.adjust()`.
   - **Survival Check:** Ensures the SL is not too close to the liquidation price.
   - **Structure Tolerance:** Ensures the leverage-adjusted SL doesn't violate the natural structure SL.
   - **Expected Value (EV) Gate:** Calculates net PnL after maker/taker fees and slippage. If `EV < (fees + slippage) * evMultiplier`, the setup is REJECTED.
4. **Rejection:** If any gate fails (e.g., "SL_TOO_TIGHT_FOR_STRUCTURE", "EV_NOT_POSITIVE", "CONFIDENCE_TOO_LOW"), the setup becomes a `RejectedSetup` and is displayed as such in the UI.
5. **Acceptance:** If passed, it is stored in `useNexusStore` as `pendingSetup`. The user sees it and must manually click "I'M TAKING THIS TRADE" to move it to `activeSetup` and log the velocity emission.

## SECTION 7 — PERFORMANCE ANALYSIS

- **Bottlenecks:**
  - `ScalpEngine._fastScan` and `LiquidityEngine._fullProcess`: Heavy array iterations (e.g., deep loops over historical candles to find EQH/EQL clusters).
  - The EventBus has a trailing-edge throttle mechanism to prevent handler execution storms, but deep object cloning in React components or Zustand store updates (`useNexusStore`) on every tick can cause severe UI latency.
- **Websocket Throughput:**
  - `MexcStream` processes all trades. In high volatility, `sub.deal` sends hundreds of messages per second.
  - Rust throttles the Tauri emit to 150ms. However, `UniverseScanner` handles *all* pairs and throttles to 200ms.
- **Rerender Chains:** If components subscribe to `useNexusStore` properties that update frequently (like `velocityState` or `pipelineStage`), they may re-render too often. `LiveSignalPanel` uses a localized 1.5s interval to pull from `StateCache` instead of Zustand to mitigate this.

## SECTION 8 — UI/UX ANALYSIS

- **Strengths:** Highly professional, dark-themed, "institutional" aesthetic. The separation of `SetupCard`, `LiveSignalPanel`, and `SetupChecklist` provides a dense, information-rich HUD without visual clutter.
- **Weaknesses:**
  - The terminal can feel "idle" if EV filters are too strict. The `ActiveIdleView` was added to show scanner pulse, but users might still feel disconnected if setups are constantly rejected.
  - Information density in the `SetupChecklist` is high, but the exact mathematical thresholds (e.g., why EV failed by 0.01%) are sometimes abstracted behind "warning/fail" labels.
- **Visual Latency:** Minimal, due to throttling at the Rust layer and EventBus layer.

## SECTION 9 — DEAD CODE / TECH DEBT

- **Obsolete Systems:**
  - Autonomous Execution logic in `src-tauri/src/execution/` and `src-tauri/src/risk/`. Since auto-trading is permanently disabled, much of the order routing, retry logic, and autonomous risk management is dead code or vestigial.
  - `toggle_live_trading` commands were removed, but the `ExecutionEngine` still exists as an abstraction layer.
- **Tech Debt:**
  - Extensive use of `@ts-nocheck` in `src/analysis/confluence.ts`, `src/analysis/scalp-engine.ts`, and `src/analysis/liquidity.ts`. This hides potential type mismatches, especially when refactoring complex objects.
  - `EventBus` history array growth (`maxHistory: 100`) is managed, but memory leaks can occur if React components do not properly call `EventBus.off()` in `useEffect` cleanup.
  - Mix of object-oriented and functional patterns in engines (e.g., `ScalpEngine` uses internal `_state` mutation heavily).

## SECTION 10 — CRITICAL FAILURES

- **Why setups are not appearing (Over-filtering):**
  - The `LeverageAdjustedRiskEngine` is ruthless. The EV calculation factors in `feesMarginPct` (taker fee * 2 * leverage) and `slippageMarginPct`. At high leverage, friction is massive. If the system demands a positive EV (with an `evMultiplier` of 1.2), almost all standard 1m scalps will fail mathematically because the target net profit doesn't cover the friction.
  - `minConfidence` thresholds. If the `AggressionMode` is "conservative" (0.65 threshold) and market regime is "chaotic" (penalizes confidence), scores rarely pass the filter.
  - **Why the pipeline feels slow:** `maestro.analyze` is gated by a price movement optimization (`Math.abs(currentPrice - this.lastAnalysisPrice) / this.lastAnalysisPrice < 0.0005`). In tight ranges, the system literally stops analyzing until a 0.05% move occurs.

## SECTION 11 — REFACTOR ROADMAP

1. **Phase 1: Type Safety & Cleanup (Immediate)**
   - Remove `@ts-nocheck` from core engines (`ConfluenceEngine`, `ScalpEngine`, `LiquidityEngine`). Use proper TypeScript interfaces.
   - Clean up dead backend execution code. If Oracle mode is permanent, remove the `ExecutionEngine` entirely and simplify to just a REST client for balance/positions.
2. **Phase 2: Performance Optimization (Short-term)**
   - Optimize `LiquidityEngine` loops (e.g., `_clusterSwings`). Use more efficient data structures (e.g., spatial indexing or simple binary search) instead of nested loops.
   - Review `EventBus` throttling limits. Ensure UI sync events don't block the main thread.
3. **Phase 3: EV Model Tuning (Medium-term)**
   - The EV gate is mathematically sound but practically starves the user of setups. Implement a "Dynamic Maker/Taker Assumption" where limit orders (maker fees) are modeled for targets instead of assuming taker fees for both entry and exit.
   - Improve the `ProbabilityModel`'s heuristic calibration.
4. **Phase 4: Architecture Evolution (Long-term)**
   - Move heavy analysis (Confluence, Liquidity mapping) into the Rust backend. The current architecture passes ticks to React, doing heavy CPU work in the V8 JS engine on the UI thread. Rust should emit fully-formed `Setup` objects, leaving the frontend to purely render state.

---
*End of Document*
