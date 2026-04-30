# Nexus V2 — MEXC Trading Co-Pilot

> **Decision-support trading terminal for manual perpetuals trading on MEXC.**
> The system surfaces high-confluence setups with leverage-adjusted SL/TP. The human executes manually.

---

## What this is

A desktop app that watches MEXC futures in real time, detects institutional setups, and presents them as actionable cards: entry zone, stop-loss, take-profit (1 and 2), risk-to-reward, confidence score, and reasoning. Roberto looks at it, decides, and executes manually on MEXC. **The system never places orders.**

---

## Why "co-pilot" and not "bot"

Previous iterations (`Project-Nexus`, `mexc-trading-platform`) were autonomous bots. The Churn Incident of 2026-03-29 demonstrated why that's risky on noisy 1m signals: ~$41 of $42 account burned in fees from a runaway loop. Co-pilot mode keeps the analytical brain (8-dimension Confluence Engine, MarketState, Liquidity, Probability) but puts the human in the loop. The trader sees what the system sees, weighs it, decides.

---

## Stack

- **UI**: Tauri 2 + React 19 + Vite 7 + TypeScript + Zustand
- **Charts**: lightweight-charts v5
- **Backend**: Rust (tokio, tokio-tungstenite, rusqlite, reqwest)
- **Database**: SQLite (local, in `%APPDATA%/nexus-v2-copilot/`)
- **Exchange**: MEXC perpetual futures (`contract.mexc.com`)

---

## Architecture (high level)

```
MEXC WS (futures) ──► Rust backend (tokio) ──► Tauri events ──► React frontend
                                                                       │
                                                                       ▼
                                            ┌─────────────────────────────────────┐
                                            │  ConfluenceEngine 2.0 (8 dims)      │
                                            │  MarketStateEngine (BOS/MSS/regime) │
                                            │  LiquidityEngine (sweeps/OBs/PD)    │
                                            │  ProbabilityEngine (2-axis)         │
                                            │  ScalpEngine                        │
                                            │  VolumeProfile                      │
                                            └──────────────────┬──────────────────┘
                                                               │
                                                               ▼
                                            LeverageAdjustedRiskEngine
                                            (recalcula SL/TP por leverage)
                                                               │
                                                               ▼
                                            <SetupCard /> com classification A+/A/B/C
                                                               │
                                                               ▼
                                            Roberto vê, decide, executa na MEXC
                                                               │
                                                               ▼
                                            Marca outcome (TP1/TP2/SL/manual)
                                                               │
                                                               ▼
                                            SQLite + adaptive learning feedback
```

---

## Origem deste código

- **Base** (95% do código): `antigravity-v2/` (Tauri+React+Rust HUD profissional)
- **Adições**: parser MEXC WebSocket portado do `mexc-trading-platform/`
- **Descartado**: ExecutionEngine, modos auto, integração Hyperliquid/Binance live

Auditoria completa em `Topics/projects/Nexus-V2-Code-Audit.md` no Leo-Brain vault.

---

## Status

- [x] F0 — Audit + consolidação base
- [ ] F1 — MEXC WebSocket Rust (substituir Binance stream)
- [ ] F2 — LeverageAdjustedRiskEngine + SetupCard + LeverageSelector
- [ ] F3 — Outcome marker + Oracle mode permanente
- [ ] MVP usável (3-4 sessões)

---

## Princípios não-negociáveis

1. **Survival > Profit.** Em dúvida, recusa o trade.
2. **Roberto sempre executa.** O sistema nunca faz POST de ordem. Oracle mode permanente.
3. **Honestidade sobre incerteza.** Confidence < 60% = "weak". Sem inventar setup.
4. **Transparência total.** Cada sugestão vem com reasoning legível.
5. **Reaproveitar o que existe.** V1 tem 4 fases prontas — V2 é evolução, não rewrite.

---

## Setup (dev)

```bash
npm install
npm run tauri dev
```

Pré-requisitos: Node 20+, Rust toolchain (stable), Visual Studio Build Tools (Windows).

---

## Rodando builds

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/`

---

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
