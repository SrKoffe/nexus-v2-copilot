import { expect, test } from "bun:test";
import { computeRejectionCounts } from "./store";
import type { SetupHistoryEntry } from "./store";

test("computeRejectionCounts - empty history", () => {
    const history: SetupHistoryEntry[] = [];
    const result = computeRejectionCounts(history);
    expect(result).toEqual({});
});

test("computeRejectionCounts - only accepted setups", () => {
    const history: SetupHistoryEntry[] = [
        {
            natural: {} as any,
            adjusted: { accepted: true } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        }
    ];
    const result = computeRejectionCounts(history);
    expect(result).toEqual({});
});

test("computeRejectionCounts - only rejected setups", () => {
    const history: SetupHistoryEntry[] = [
        {
            natural: {} as any,
            adjusted: { accepted: false, code: 'EV_NOT_POSITIVE' } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        },
        {
            natural: {} as any,
            adjusted: { accepted: false, code: 'SL_TOO_TIGHT_FOR_STRUCTURE' } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        }
    ];
    const result = computeRejectionCounts(history);
    expect(result).toEqual({
        'EV_NOT_POSITIVE': 1,
        'SL_TOO_TIGHT_FOR_STRUCTURE': 1
    });
});

test("computeRejectionCounts - multiple rejections with same code", () => {
    const history: SetupHistoryEntry[] = [
        {
            natural: {} as any,
            adjusted: { accepted: false, code: 'EV_NOT_POSITIVE' } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        },
        {
            natural: {} as any,
            adjusted: { accepted: false, code: 'EV_NOT_POSITIVE' } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        }
    ];
    const result = computeRejectionCounts(history);
    expect(result).toEqual({
        'EV_NOT_POSITIVE': 2
    });
});

test("computeRejectionCounts - mixed history", () => {
    const history: SetupHistoryEntry[] = [
        {
            natural: {} as any,
            adjusted: { accepted: true } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        },
        {
            natural: {} as any,
            adjusted: { accepted: false, code: 'EV_NOT_POSITIVE' } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        },
        {
            natural: {} as any,
            adjusted: { accepted: false, code: 'CONFIDENCE_TOO_LOW' } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        },
        {
            natural: {} as any,
            adjusted: { accepted: false, code: 'EV_NOT_POSITIVE' } as any,
            detectedAt: Date.now(),
            outcome: null,
            pnlPct: null
        }
    ];
    const result = computeRejectionCounts(history);
    expect(result).toEqual({
        'EV_NOT_POSITIVE': 2,
        'CONFIDENCE_TOO_LOW': 1
    });
});
