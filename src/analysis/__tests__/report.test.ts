import { expect, test, describe } from 'bun:test';
import { isoWeekRange } from '../report';

describe('isoWeekRange', () => {
    test('handles middle of the week (Wednesday)', () => {
        // Wednesday, May 15, 2024
        const date = new Date('2024-05-15T12:00:00Z');
        const range = isoWeekRange(date);

        // Should start on Monday, May 13, 2024, 00:00:00Z
        expect(range.start.toISOString()).toBe('2024-05-13T00:00:00.000Z');
        // Should end on Monday, May 20, 2024, 00:00:00Z
        expect(range.end.toISOString()).toBe('2024-05-20T00:00:00.000Z');
        expect(range.isoLabel).toBe('2024-W20');
    });

    test('handles start of the week (Monday)', () => {
        // Monday, May 13, 2024
        const date = new Date('2024-05-13T00:00:00Z');
        const range = isoWeekRange(date);

        expect(range.start.toISOString()).toBe('2024-05-13T00:00:00.000Z');
        expect(range.end.toISOString()).toBe('2024-05-20T00:00:00.000Z');
        expect(range.isoLabel).toBe('2024-W20');
    });

    test('handles end of the week (Sunday)', () => {
        // Sunday, May 19, 2024
        const date = new Date('2024-05-19T23:59:59Z');
        const range = isoWeekRange(date);

        expect(range.start.toISOString()).toBe('2024-05-13T00:00:00.000Z');
        expect(range.end.toISOString()).toBe('2024-05-20T00:00:00.000Z');
        expect(range.isoLabel).toBe('2024-W20');
    });

    test('handles crossing year boundaries', () => {
        // Friday, January 1, 2021
        // The ISO week should be 2020-W53 because the week started in 2020 (Dec 28)
        const date = new Date('2021-01-01T12:00:00Z');
        const range = isoWeekRange(date);

        expect(range.start.toISOString()).toBe('2020-12-28T00:00:00.000Z');
        expect(range.end.toISOString()).toBe('2021-01-04T00:00:00.000Z');
        expect(range.isoLabel).toBe('2020-W53');
    });

    test('handles start of year that belongs to week 1 of the new year', () => {
        // Monday, January 1, 2024
        // The week starts on Jan 1st, so it's week 1 of 2024
        const date = new Date('2024-01-01T12:00:00Z');
        const range = isoWeekRange(date);

        expect(range.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        expect(range.end.toISOString()).toBe('2024-01-08T00:00:00.000Z');
        expect(range.isoLabel).toBe('2024-W01');
    });

    test('handles leap year (Feb 29)', () => {
        // Thursday, February 29, 2024
        const date = new Date('2024-02-29T12:00:00Z');
        const range = isoWeekRange(date);

        // Should start on Monday, Feb 26
        expect(range.start.toISOString()).toBe('2024-02-26T00:00:00.000Z');
        // Should end on Monday, Mar 4
        expect(range.end.toISOString()).toBe('2024-03-04T00:00:00.000Z');
        expect(range.isoLabel).toBe('2024-W09');
    });
});
