@echo off
REM ─────────────────────────────────────────────────────────────────
REM  Nexus V2 Co-Pilot — Launcher
REM  Inicia o app em modo dev (Tauri + Vite + Rust hot-reload).
REM  Uso: duplo-clique neste arquivo OU no atalho do Desktop.
REM ─────────────────────────────────────────────────────────────────

cd /d "%~dp0"
title Nexus V2 Co-Pilot

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   NEXUS V2 — MEXC TRADING CO-PILOT          ║
echo  ║   Starting dev server...                     ║
echo  ╚══════════════════════════════════════════════╝
echo.

REM Verifica se node_modules existe
if not exist "node_modules\" (
    echo  [setup] node_modules nao encontrado. Rodando npm install...
    call npm install
    if errorlevel 1 (
        echo.
        echo  [erro] npm install falhou. Verifique Node.js e internet.
        pause
        exit /b 1
    )
)

REM Inicia Tauri dev (compila Rust + Vite + abre janela)
call npm run tauri dev

REM Se cair aqui, algo terminou. Pausa pra ver mensagem.
echo.
echo  [fim] Nexus encerrou. Pressione qualquer tecla pra fechar.
pause >nul
