import fs from 'fs';
import { timingSafeEqual } from 'crypto';

export const TRAY_COMMAND_PREFIX = 'LIFTOFF_TRAY_COMMAND:';

/**
 * Compare the desktop-control password without leaking a useful timing signal.
 * @param {unknown} candidate
 * @param {string} expected
 */
export function isDesktopPasswordValid(candidate, expected) {
    const supplied = Buffer.from(String(candidate || ''), 'utf8');
    const configured = Buffer.from(String(expected || ''), 'utf8');
    return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

/** @returns {boolean} */
export function isTrayManaged() {
    return process.env.LIFTOFF_TRAY === '1';
}

/**
 * Read non-secret tray state. Malformed or absent state is treated as disabled.
 * @param {string} [statePath]
 * @returns {{autostart: boolean, managed: boolean, updatedAt: string | null}}
 */
export function readTrayState(statePath = process.env.LIFTOFF_TRAY_STATE_PATH || '') {
    if (!statePath) {
        return { autostart: false, managed: isTrayManaged(), updatedAt: null };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        return {
            autostart: parsed?.autostart === true,
            managed: isTrayManaged(),
            updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null
        };
    } catch (_) {
        return { autostart: false, managed: isTrayManaged(), updatedAt: null };
    }
}

/**
 * Emit a fixed command for the tray supervisor to consume from stdout.
 * @param {'restart' | 'stop' | 'autostart:on' | 'autostart:off'} command
 */
export function emitTrayCommand(command) {
    const allowed = new Set(['restart', 'stop', 'autostart:on', 'autostart:off']);
    if (!allowed.has(command)) {
        throw new Error('Unsupported tray command');
    }
    process.stdout.write(`${TRAY_COMMAND_PREFIX}${command}\n`);
}
