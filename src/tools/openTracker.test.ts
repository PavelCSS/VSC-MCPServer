import { describe, it, expect, beforeEach } from 'vitest';
import { noteOpened, takeFreshlyOpened, resetOpenTracker } from './openTracker';

describe('openTracker', () => {
    beforeEach(() => {
        resetOpenTracker();
    });

    it('flags the first open by a tool as fresh', () => {
        noteOpened('file:///a.ts', true);
        expect(takeFreshlyOpened('file:///a.ts')).toBe(true);
    });

    it('does not flag the first open by warm-up as fresh', () => {
        noteOpened('file:///a.ts', false);
        expect(takeFreshlyOpened('file:///a.ts')).toBe(false);
    });

    it('does not flag a repeat open by a tool as fresh', () => {
        noteOpened('file:///a.ts', false);
        noteOpened('file:///a.ts', true);
        expect(takeFreshlyOpened('file:///a.ts')).toBe(false);
    });

    it('consumes the fresh flag once', () => {
        noteOpened('file:///a.ts', true);
        expect(takeFreshlyOpened('file:///a.ts')).toBe(true);
        expect(takeFreshlyOpened('file:///a.ts')).toBe(false);
    });
});
