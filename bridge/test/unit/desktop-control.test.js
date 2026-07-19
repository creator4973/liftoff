import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isDesktopPasswordValid,
    isTrayManaged,
    readTrayState
} from '../../src/utils/desktop-control.js';

const originalTray = process.env.LIFTOFF_TRAY;

afterEach(() => {
    if (originalTray === undefined) delete process.env.LIFTOFF_TRAY;
    else process.env.LIFTOFF_TRAY = originalTray;
});

describe('desktop control helpers', () => {
    it('accepts only the exact configured password', () => {
        expect(isDesktopPasswordValid('correct horse', 'correct horse')).toBe(true);
        expect(isDesktopPasswordValid('correct', 'correct horse')).toBe(false);
        expect(isDesktopPasswordValid('', 'correct horse')).toBe(false);
    });

    it('reports whether the bridge was started by the tray', () => {
        process.env.LIFTOFF_TRAY = '1';
        expect(isTrayManaged()).toBe(true);
        process.env.LIFTOFF_TRAY = '0';
        expect(isTrayManaged()).toBe(false);
    });

    it('reads only safe tray state and tolerates malformed files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-tray-'));
        const statePath = path.join(root, 'state.json');
        process.env.LIFTOFF_TRAY = '1';
        fs.writeFileSync(statePath, JSON.stringify({
            autostart: true,
            updatedAt: '2026-07-15T00:00:00.000Z',
            secret: 'must-not-be-returned'
        }));

        expect(readTrayState(statePath)).toEqual({
            autostart: true,
            managed: true,
            updatedAt: '2026-07-15T00:00:00.000Z'
        });

        fs.writeFileSync(statePath, '{broken');
        expect(readTrayState(statePath)).toEqual({
            autostart: false,
            managed: true,
            updatedAt: null
        });
        fs.rmSync(root, { recursive: true, force: true });
    });
});
