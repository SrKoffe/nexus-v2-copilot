import { describe, expect, test } from 'bun:test';
import { renderWeeklyReport, isoWeekRange, type SetupOutcome } from './report';

describe('isoWeekRange', () => {
    test('aligns correctly to Monday UTC', () => {
        // Wednesday, May 10th, 2023 12:00 UTC
        const wednesday = new Date(Date.UTC(2023, 4, 10, 12, 0, 0));
        const { start, end, isoLabel } = isoWeekRange(wednesday);

        // Should align to Monday, May 8th, 2023 00:00 UTC
        expect(start.getUTCDay()).toBe(1); // Monday
        expect(start.getTime()).toBe(Date.UTC(2023, 4, 8));

        // End should be exactly 7 days later
        expect(end.getTime()).toBe(start.getTime() + 7 * 86400000);

        // Week number check (approximate check based on string format)
        expect(isoLabel).toMatch(/^2023-W\d{2}$/);
        expect(isoLabel).toBe('2023-W19');
    });

    test('handles Sunday correctly', () => {
        // Sunday, May 14th, 2023
        const sunday = new Date(Date.UTC(2023, 4, 14, 10, 0, 0));
        const { start, isoLabel } = isoWeekRange(sunday);

        // Still belongs to the same week starting on Monday, May 8th
        expect(start.getTime()).toBe(Date.UTC(2023, 4, 8));
        expect(isoLabel).toBe('2023-W19');
    });
});

describe('renderWeeklyReport', () => {
    const range = {
        start: new Date(Date.UTC(2023, 4, 8)),
        end: new Date(Date.UTC(2023, 4, 15)),
        isoLabel: '2023-W19'
    };

    const mockOutcome = (overrides?: Partial<SetupOutcome>): SetupOutcome => ({
        id: 1,
        setup_id: 'test_setup',
        symbol: 'BTCUSDT',
        direction: 'long',
        leverage: 10,
        confidence: 0.8,
        classification: 'A+',
        entry_price: 25000,
        stop_loss: 24000,
        take_profit_1: 26000,
        take_profit_2: 27000,
        outcome_label: 'tp1_hit',
        pnl_pct: 5.5,
        detected_at_ms: range.start.getTime() + 1000,
        closed_at_ms: range.start.getTime() + 5000,
        ...overrides
    });

    test('returns correct message for empty outcomes', () => {
        const result = renderWeeklyReport([], range);

        expect(result).toContain('# 📊 Nexus V2 — Weekly Report 2023-W19');
        expect(result).toContain('Nenhum trade marcado nesta janela. Sem dados pra agregar.');
    });

    test('renders stats and profitable message correctly', () => {
        const outcomes: SetupOutcome[] = [
            mockOutcome({ pnl_pct: 10, outcome_label: 'tp2_hit' }),
            mockOutcome({ pnl_pct: 5, outcome_label: 'tp1_hit' }),
            mockOutcome({ pnl_pct: -2, outcome_label: 'sl_hit' })
        ];

        const result = renderWeeklyReport(outcomes, range);

        expect(result).toContain('**3** trades marcados');
        expect(result).toContain('**67%** win rate'); // 2 wins, 1 loss
        expect(result).toContain('+13.00%** PnL margem total'); // 10 + 5 - 2

        // Verify insights has profitable string
        expect(result).toContain('Semana **lucrativa** (+13.00% margem).');

        // Make sure table renders for outcomes
        expect(result).toContain('| tp2 hit |');
        expect(result).toContain('| tp1 hit |');
        expect(result).toContain('| sl hit |');
    });

    test('renders losing message correctly', () => {
        const outcomes: SetupOutcome[] = [
            mockOutcome({ pnl_pct: -5, outcome_label: 'sl_hit' }),
            mockOutcome({ pnl_pct: -10, outcome_label: 'sl_hit' }),
            mockOutcome({ pnl_pct: 2, outcome_label: 'manual_exit' })
        ];

        const result = renderWeeklyReport(outcomes, range);

        expect(result).toContain('**33%** win rate'); // 1 win, 2 loss
        expect(result).toContain('-13.00%** PnL margem total');

        // Verify insights has losing string
        expect(result).toContain('Semana **perdedora** (-13.00% margem).');
    });

    test('renders flat week message when pnl is exactly 0', () => {
        const outcomes: SetupOutcome[] = [
            mockOutcome({ pnl_pct: 5, outcome_label: 'tp1_hit' }),
            mockOutcome({ pnl_pct: -5, outcome_label: 'sl_hit' }),
        ];

        const result = renderWeeklyReport(outcomes, range);

        expect(result).toContain('Semana flat — sem PnL líquido relevante.');
    });

    test('renders multiple groups correctly', () => {
        const outcomes: SetupOutcome[] = [
            mockOutcome({ leverage: 5, classification: 'A+', pnl_pct: 5, symbol: 'BTCUSDT' }),
            mockOutcome({ leverage: 50, classification: 'B', pnl_pct: -2, symbol: 'ETHUSDT' }),
            mockOutcome({ leverage: 150, classification: 'C', pnl_pct: 10, symbol: 'SOLUSDT' }),
        ];

        const result = renderWeeklyReport(outcomes, range);

        // Leverage buckets
        expect(result).toContain('| x1-x10 |');
        expect(result).toContain('| x26-x50 |');
        expect(result).toContain('| x101-x200 |');

        // Classifications
        expect(result).toContain('| A+ |');
        expect(result).toContain('| B |');
        expect(result).toContain('| C |');

        // Symbols
        expect(result).toContain('| BTCUSDT |');
        expect(result).toContain('| ETHUSDT |');
        expect(result).toContain('| SOLUSDT |');
    });

    test('renders insights alerts correctly', () => {
        const outcomes: SetupOutcome[] = [
            mockOutcome({ classification: 'A+', pnl_pct: -1, outcome_label: 'sl_hit' }),
            mockOutcome({ classification: 'A+', pnl_pct: -1, outcome_label: 'sl_hit' }),
            mockOutcome({ classification: 'A+', pnl_pct: 2, outcome_label: 'tp1_hit' }),
            mockOutcome({ classification: 'B', pnl_pct: -1, outcome_label: 'sl_hit' }),
            mockOutcome({ classification: 'C', pnl_pct: -1, outcome_label: 'sl_hit' }),
        ];

        const result = renderWeeklyReport(outcomes, range);

        // 1 win / 3 total for A+ (33%) -> under 60%
        expect(result).toContain('sinal de overconfidence no engine');

        // 4 SL hits / 5 total -> >40%
        expect(result).toContain('Taxa de SL hit alta');
    });
});
