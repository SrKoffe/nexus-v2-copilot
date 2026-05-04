import { invoke } from '@tauri-apps/api/core';

/**
 * F8 — Weekly report generator.
 *
 * Mirrors the Rust `SetupOutcome` struct. Field names use snake_case because
 * Tauri serializes Rust structs without renaming.
 */
export interface SetupOutcome {
    id: number;
    setup_id: string;
    symbol: string;
    direction: 'long' | 'short';
    leverage: number;
    confidence: number;
    classification: string;
    entry_price: number;
    stop_loss: number;
    take_profit_1: number;
    take_profit_2: number;
    outcome_label: 'tp1_hit' | 'tp2_hit' | 'sl_hit' | 'manual_exit';
    pnl_pct: number;
    detected_at_ms: number;
    closed_at_ms: number;
}

/** ISO week boundaries (Monday 00:00 UTC → next Monday 00:00 UTC). */
export function isoWeekRange(date: Date = new Date()): { start: Date; end: Date; isoLabel: string } {
    // Copy and normalize to Monday 00:00 UTC of the same ISO week
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;          // 1..7 with Mon=1
    if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));

    const start = d;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    // ISO week number
    const tmp = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);

    const isoLabel = `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    return { start, end, isoLabel };
}

/** Group helper: bucket items by a key fn. */
function groupBy<T, K extends string | number>(items: T[], keyFn: (t: T) => K): Map<K, T[]> {
    const m = new Map<K, T[]>();
    for (const it of items) {
        const k = keyFn(it);
        const arr = m.get(k) ?? [];
        arr.push(it);
        m.set(k, arr);
    }
    return m;
}

interface GroupStats {
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    avgPnl: number;
    sumPnl: number;
}

function statsOf(outs: SetupOutcome[]): GroupStats {
    const wins = outs.filter(o => o.pnl_pct > 0).length;
    const losses = outs.length - wins;
    const sumPnl = outs.reduce((s, o) => s + o.pnl_pct, 0);
    return {
        total: outs.length,
        wins,
        losses,
        winRate: outs.length > 0 ? wins / outs.length : 0,
        avgPnl: outs.length > 0 ? sumPnl / outs.length : 0,
        sumPnl,
    };
}

/**
 * Render the weekly report markdown. Pure function — easy to test.
 */
export function renderWeeklyReport(
    outcomes: SetupOutcome[],
    range: { start: Date; end: Date; isoLabel: string },
): string {
    const lines: string[] = [];
    const overall = statsOf(outcomes);

    lines.push(`# 📊 Nexus V2 — Weekly Report ${range.isoLabel}`);
    lines.push('');
    lines.push(`> Window: ${range.start.toISOString()} → ${range.end.toISOString()}`);
    lines.push(`> Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // ─── TL;DR ───
    lines.push('## TL;DR');
    lines.push('');
    if (overall.total === 0) {
        lines.push('Nenhum trade marcado nesta janela. Sem dados pra agregar.');
        return lines.join('\n');
    }
    lines.push(`- **${overall.total}** trades marcados`);
    lines.push(`- **${(overall.winRate * 100).toFixed(0)}%** win rate (${overall.wins}W / ${overall.losses}L)`);
    lines.push(`- **${overall.sumPnl >= 0 ? '+' : ''}${overall.sumPnl.toFixed(2)}%** PnL margem total`);
    lines.push(`- **${overall.avgPnl >= 0 ? '+' : ''}${overall.avgPnl.toFixed(2)}%** PnL margem médio por trade`);
    lines.push('');

    // ─── By outcome label ───
    lines.push('## Por outcome');
    lines.push('');
    lines.push('| Outcome | Count | % | Avg PnL margem |');
    lines.push('|---|---:|---:|---:|');
    const byLabel = groupBy(outcomes, o => o.outcome_label);
    const labelOrder: SetupOutcome['outcome_label'][] = ['tp2_hit', 'tp1_hit', 'manual_exit', 'sl_hit'];
    for (const label of labelOrder) {
        const arr = byLabel.get(label) ?? [];
        if (arr.length === 0) continue;
        const s = statsOf(arr);
        lines.push(
            `| ${label.replace(/_/g, ' ')} | ${s.total} | ${((s.total / overall.total) * 100).toFixed(0)}% | ${s.avgPnl >= 0 ? '+' : ''}${s.avgPnl.toFixed(2)}% |`
        );
    }
    lines.push('');

    // ─── By leverage bucket ───
    lines.push('## Por leverage');
    lines.push('');
    lines.push('| Leverage | Trades | Win rate | PnL total | PnL médio |');
    lines.push('|---|---:|---:|---:|---:|');
    const byLev = groupBy(outcomes, o => leverageBucket(o.leverage));
    const levOrder = ['x1-x10', 'x11-x25', 'x26-x50', 'x51-x100', 'x101-x200', 'x201+'];
    for (const lev of levOrder) {
        const arr = byLev.get(lev) ?? [];
        if (arr.length === 0) continue;
        const s = statsOf(arr);
        lines.push(
            `| ${lev} | ${s.total} | ${(s.winRate * 100).toFixed(0)}% | ${s.sumPnl >= 0 ? '+' : ''}${s.sumPnl.toFixed(2)}% | ${s.avgPnl >= 0 ? '+' : ''}${s.avgPnl.toFixed(2)}% |`
        );
    }
    lines.push('');

    // ─── By classification ───
    lines.push('## Por classification (A+/A/B/C)');
    lines.push('');
    lines.push('| Grade | Trades | Win rate | PnL médio |');
    lines.push('|---|---:|---:|---:|');
    const byClass = groupBy(outcomes, o => o.classification);
    for (const grade of ['A+', 'A', 'B', 'C']) {
        const arr = byClass.get(grade) ?? [];
        if (arr.length === 0) continue;
        const s = statsOf(arr);
        lines.push(
            `| ${grade} | ${s.total} | ${(s.winRate * 100).toFixed(0)}% | ${s.avgPnl >= 0 ? '+' : ''}${s.avgPnl.toFixed(2)}% |`
        );
    }
    lines.push('');

    // ─── By hour-of-day (UTC) ───
    lines.push('## Por hora do dia (UTC)');
    lines.push('');
    lines.push('| Hora | Trades | Win rate | PnL médio |');
    lines.push('|---:|---:|---:|---:|');
    const byHour = groupBy(outcomes, o => new Date(o.closed_at_ms).getUTCHours());
    const hours = Array.from(byHour.keys()).sort((a, b) => a - b);
    for (const h of hours) {
        const arr = byHour.get(h)!;
        const s = statsOf(arr);
        lines.push(
            `| ${String(h).padStart(2, '0')}:00 | ${s.total} | ${(s.winRate * 100).toFixed(0)}% | ${s.avgPnl >= 0 ? '+' : ''}${s.avgPnl.toFixed(2)}% |`
        );
    }
    lines.push('');

    // ─── By symbol ───
    const symbols = [...new Set(outcomes.map(o => o.symbol))];
    if (symbols.length > 1) {
        lines.push('## Por symbol');
        lines.push('');
        lines.push('| Symbol | Trades | Win rate | PnL total |');
        lines.push('|---|---:|---:|---:|');
        const bySym = groupBy(outcomes, o => o.symbol);
        for (const sym of symbols) {
            const s = statsOf(bySym.get(sym) ?? []);
            lines.push(
                `| ${sym} | ${s.total} | ${(s.winRate * 100).toFixed(0)}% | ${s.sumPnl >= 0 ? '+' : ''}${s.sumPnl.toFixed(2)}% |`
            );
        }
        lines.push('');
    }

    // ─── Insights ───
    lines.push('## Insights');
    lines.push('');
    insights(outcomes, overall, byLev, byClass).forEach(line => lines.push(`- ${line}`));
    lines.push('');

    // ─── Trade list (collapsible-like — just last 30) ───
    lines.push('## Trades (latest 30)');
    lines.push('');
    lines.push('| When (UTC) | Symbol | Dir | Lev | Class | Conf | Outcome | PnL margem |');
    lines.push('|---|---|---|---:|---|---:|---|---:|');
    const recent = [...outcomes].slice(-30).reverse();
    for (const o of recent) {
        const dt = new Date(o.closed_at_ms).toISOString().replace('T', ' ').slice(0, 16);
        lines.push(
            `| ${dt} | ${o.symbol} | ${o.direction} | ${o.leverage}x | ${o.classification} | ${(o.confidence * 100).toFixed(0)}% | ${o.outcome_label.replace('_', ' ')} | ${o.pnl_pct >= 0 ? '+' : ''}${o.pnl_pct.toFixed(2)}% |`
        );
    }
    lines.push('');

    lines.push('---');
    lines.push('');
    lines.push(`*Gerado por Nexus V2 Co-Pilot. Persistência: ${outcomes.length} outcomes.*`);

    return lines.join('\n');
}

function leverageBucket(lev: number): string {
    if (lev <= 10) return 'x1-x10';
    if (lev <= 25) return 'x11-x25';
    if (lev <= 50) return 'x26-x50';
    if (lev <= 100) return 'x51-x100';
    if (lev <= 200) return 'x101-x200';
    return 'x201+';
}

function insights(
    outcomes: SetupOutcome[],
    overall: GroupStats,
    byLev: Map<string, SetupOutcome[]>,
    byClass: Map<string, SetupOutcome[]>,
): string[] {
    const out: string[] = [];

    // Overall direction of the week
    if (overall.sumPnl > 0) {
        out.push(`Semana **lucrativa** (+${overall.sumPnl.toFixed(2)}% margem).`);
    } else if (overall.sumPnl < 0) {
        out.push(`Semana **perdedora** (${overall.sumPnl.toFixed(2)}% margem). Revisar setups por classification e leverage.`);
    } else {
        out.push('Semana flat — sem PnL líquido relevante.');
    }

    // Best/worst leverage bucket
    let bestLev: { name: string; pnl: number } | null = null;
    let worstLev: { name: string; pnl: number } | null = null;
    byLev.forEach((arr, name) => {
        const s = statsOf(arr);
        if (s.total < 2) return;  // skip noise
        if (bestLev === null || s.avgPnl > bestLev.pnl) bestLev = { name, pnl: s.avgPnl };
        if (worstLev === null || s.avgPnl < worstLev.pnl) worstLev = { name, pnl: s.avgPnl };
    });
    if (bestLev !== null) out.push(`Melhor faixa de leverage: **${(bestLev as any).name}** (avg ${(bestLev as any).pnl >= 0 ? '+' : ''}${(bestLev as any).pnl.toFixed(2)}%).`);
    if (worstLev !== null && (worstLev as any).name !== (bestLev as any)?.name) {
        out.push(`Pior faixa: **${(worstLev as any).name}** (avg ${(worstLev as any).pnl >= 0 ? '+' : ''}${(worstLev as any).pnl.toFixed(2)}%).`);
    }

    // Classification edge sanity
    const aPlus = byClass.get('A+');
    if (aPlus && aPlus.length >= 3) {
        const s = statsOf(aPlus);
        if (s.winRate < 0.6) {
            out.push(`⚠ A+ setups com win rate baixo (${(s.winRate * 100).toFixed(0)}%) — sinal de overconfidence no engine. Considerar tightening dos critérios A+.`);
        }
    }

    // SL hit rate vs configured SL
    const slHits = outcomes.filter(o => o.outcome_label === 'sl_hit').length;
    if (slHits / Math.max(outcomes.length, 1) > 0.4) {
        out.push(`⚠ Taxa de SL hit alta (${((slHits / outcomes.length) * 100).toFixed(0)}%) — SL pode estar muito apertado vs estrutura ou confidence calibrada errado.`);
    }

    return out;
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Generate this week's report and write to the user's vault path.
 * Returns the absolute path written.
 */
export async function generateAndSaveWeeklyReport(
    vaultRoot: string,
    weekDate: Date = new Date(),
): Promise<{ path: string; outcomeCount: number; markdown: string }> {
    const range = isoWeekRange(weekDate);

    const outcomes = await invoke<SetupOutcome[]>('query_setup_outcomes', {
        startMs: range.start.getTime(),
        endMs: range.end.getTime(),
    });

    const markdown = renderWeeklyReport(outcomes, range);

    // Path: <vaultRoot>/Trading-Reports/<isoWeek>.md
    // Use forward slashes — Rust's PathBuf handles both on Windows.
    const fileName = `${range.isoLabel}.md`;
    const path = `${vaultRoot}/Trading-Reports/${fileName}`;

    const written = await invoke<string>('write_report_to_vault', { path, content: markdown });

    return { path: written, outcomeCount: outcomes.length, markdown };
}
