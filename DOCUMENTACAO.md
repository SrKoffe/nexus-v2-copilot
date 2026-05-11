# Documentação da Arquitetura e Estrutura: Nexus V2 — MEXC Trading Co-Pilot

O **Nexus V2** é um terminal de negociação de suporte a decisões de alto nível para operações manuais de contratos perpétuos na MEXC. Ele **não** opera de forma autônoma; seu papel é assistir e apresentar potenciais configurações de trade (setups de confluência), calcular riscos, enquanto mantém o humano na tomada final de decisão.

---

## 1. Princípios Essenciais (Core Principles)

- **Manual-Only (Oracle Mode):** O sistema apenas sugere os setups. A decisão e execução do post das ordens são de responsabilidade do trader (humano). O sistema nunca realiza ordens de forma autônoma.
- **Sobrevivência > Lucro:** Em situações de incerteza do mercado ou de setups fracos (Confiança < 60%), o sistema omite ou rejeita ativamente a entrada.
- **Transparência:** Todos os setups gerados vêm com um *reasoning* (raciocínio explicativo legível), clareza no gerenciamento de risco e nas variáveis de análise.

---

## 2. Visão Geral da Arquitetura

O sistema é construído utilizando uma arquitetura multicamada, dividida primeiramente no **Backend (Rust)** focado em performance, I/O e conexão segura, e no **Frontend (React)**, responsável por exibir os visuais institucionais e orquestrar a lógica de análise de mercado (*Engines*).

**Fluxo Básico de Informação:**
```
MEXC WS (Futures) -> Rust Backend (Tokio) -> Eventos do Tauri -> React Frontend (EventBus) -> Engines de Análise -> UI (Setup Card)
```

### 2.1 Backend (Rust + Tauri)

A base tecnológica primária é o **Tauri v2**, servindo a interface web utilizando **Rust** para processar o trabalho pesado e o sistema operacional.

- **`src-tauri/src/lib.rs`**: O ponto de entrada que inicializa os plugins, instâncias de banco de dados, motores de execução e fluxos do websocket.
- **`market_data/`**: Contém lógicas relacionadas ao feed de dados.
    - **WebSocket Streams**: Inicializa clientes `tokio-tungstenite` para conexões via WebSocket com a MEXC.
    - **Scanner de Universo**: Gerencia a busca de múltiplos ativos simultaneamente.
- **`core/`**: Aborda conexões de infraestrutura essenciais.
    - **Database (`rusqlite`)**: Interações assíncronas encapsuladas dentro do `tokio::task::spawn_blocking` para interagir com o SQLite (salvo na pasta `%APPDATA%`), persistindo logs de execução, trade feedbacks, etc.
    - **EventBus**: Utilitário em Rust que retransmite mensagens do websocket diretamente para o Webview do Tauri via os mecanismos de payload.
- **`risk/` & `execution/`**: Onde outrora ocorria a execução autônoma do bot. Agora desativada e redirecionada para apenas validação e comunicação de saldos com contas usando REST API (`reqwest`).

### 2.2 Frontend (React + Vite + TypeScript)

Toda a análise dos dados e renderização da UI institucional é construída com **React 19**, **Vite** e gerenciada localmente por **Zustand**.

#### Interface de Usuário Institucional (UI)
- **Painéis**: Dividida em 3 colunas (estilo Terminal Bloomberg/Hyperliquid). Tema escuro, com mínima utilização de animações visuais poluentes.
- **Gráficos**: Uso de `lightweight-charts` nativo.
- **EventBus Front-End (`src/analysis/event-bus.ts`)**: Ouve os eventos disparados nativamente do Tauri (`listen()`) para isolar o React de renders excessivos causados pelo WebSocket de alta frequência. Funciona por namespaces (`SCANNER_EVENTS`, `ANALYSIS_EVENTS`).

#### Motores Analíticos (Engines)
O cérebro do Nexus habita no front-end em `src/analysis/`, operando de forma reativa:

1. **`ConfluenceEngine` / `ScalpEngine`**: Operações otimizadas para alto-desempenho; são encarregados por processar todas as variáveis, evitar loopings lentos, combinando em um "Setup Final".
2. **`MarketStateEngine`**: Identifica estruturas de mercado em tempo real (BOS, ChoCH) e determina o Regime atual do mercado.
3. **`LiquidityEngine`**: Focado no mapeamento e "sweeps" de liquidez (order blocks).
4. **`LeverageRiskEngine`**: Recebe o Setup preliminar e recalcula pontos técnicos de Stop Loss (SL) e Take Profit (TP) com base no balanço da conta e na alavancagem pré-definida.
5. **Classificação (Tiers)**: Os setups gerados e validados pelos cálculos de risco de recompensa (Risk-Reward), recebem notas baseados em uma *Aggression Logic* (Tiers: A+, A, B, C).

#### Gerenciamento de Estado (Zustand)
As variáveis de sessão são delegadas rigidamente em **múltiplas stores independentes**, prevenindo renders globais pesados:
- `useScannerStore`: Ativos monitorados e dados ao vivo.
- `useAnalysisStore`: Estado atual dos motores de confluência.
- `useExecutionStore`: Configurações do modo alavancagem e posição aberta.
- `useUiStore` / `useMetricsStore`: Feedback de UI e métricas locais do app.

---

## 3. Fluxo de Operação Típico

1. **Recepção de Dados**:
   - Rust escuta o canal `contract.mexc.com` para o WebSocket do ativo ativo.
   - Rust envia um evento Tauri (ex: `"mexc-trade"`) para a janela.
2. **Processamento Frontend**:
   - O React (`src/analysis/index.ts`) escuta e envia para os motores de análise via `EventBus`.
   - O candelabro de 1m (1-min) fecha, disparando o `RegimeEngine` via o React Hook (`useRegimeDetection`).
3. **Geração do Setup**:
   - Os módulos `Liquidity`, `Probability` e `MarketState` geram seus vetores internos.
   - O `ConfluenceEngine` consolida esses vetores. Se o *confidence* > 60%, ele gera um alerta/setup.
   - O `LeverageRiskEngine` atua ajustando as saídas e limitando o SL para salvar capital.
4. **Decisão Humana**:
   - O UI exibe um `<SetupCard />` (mostrando pontos de TP1, TP2, R:R).
   - O humano entra manualmente no MEXC web.
   - Após o trade, o usuário interage com o `<TradeFeedbackPanel />` para retroalimentar o resultado (TP/SL/Manual) que é armazenado em SQLite, refinando futuros modelos no app.

---

## 4. Notas de Desenvolvimento

- **Testes**: `bun test` focado no ecossistema (usa `@testing-library/react` em `happy-dom` devido ao Vite). Testes de banco de dados do Backend exigem `cargo test` no diretório `src-tauri`.
- **Segurança Backend**: Todos os requests HTTP de Rust para API usam padrões builder (`reqwest::Url` ao invés de `format!`) para evitar SSRF. Operações com o SQLite requerem escapes ao usar dinâmicas de buscas (`LIKE`).
- **Prevenção de Renderização Storm**: No React, foi aplicado hooks como `useNexusEvents` em vez de carregar lógica de listeners na UI principal, para blindar o ambiente institucional.