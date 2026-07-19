import { describe, expect, it } from 'vitest';
import { findSubmitButton } from '../../src/utils/submit-button.js';

function fakeButton({
    ariaLabel = '',
    title = '',
    tooltip = '',
    icon = '',
    disabled = false,
    visible = true
} = {}) {
    const attributes = {
        'aria-label': ariaLabel,
        title,
        'data-tooltip-id': tooltip
    };

    return {
        disabled,
        offsetParent: visible ? {} : null,
        getAttribute: (name) => attributes[name] || null,
        querySelector: (selector) => icon && selector.includes(`svg.${icon}`) ? {} : null
    };
}

function fakeRoot(buttons) {
    return { querySelectorAll: () => buttons };
}

describe('findSubmitButton', () => {
    it('rejects Antigravity voice recording even with its misleading send tooltip', () => {
        const record = fakeButton({
            ariaLabel: 'Record voice memo',
            tooltip: 'input-send-button-send-tooltip'
        });

        expect(findSubmitButton(fakeRoot([record]))).toBeNull();
    });

    it('selects the separate send control beside the recorder', () => {
        const record = fakeButton({
            ariaLabel: 'Record voice memo',
            tooltip: 'input-send-button-send-tooltip'
        });
        const send = fakeButton({
            ariaLabel: 'Send message',
            tooltip: 'input-send-button-send-tooltip'
        });

        expect(findSubmitButton(fakeRoot([record, send]))).toBe(send);
    });

    it('accepts the known arrow and send SVG controls', () => {
        const arrow = fakeButton({ icon: 'lucide-arrow-up' });

        expect(findSubmitButton(fakeRoot([arrow]))).toBe(arrow);
    });

    it('ignores hidden, disabled, stop, and microphone controls', () => {
        const valid = fakeButton({ ariaLabel: 'Send' });
        const candidates = [
            fakeButton({ ariaLabel: 'Send', visible: false }),
            fakeButton({ ariaLabel: 'Send', disabled: true }),
            fakeButton({ ariaLabel: 'Stop generation' }),
            fakeButton({ title: 'Microphone', tooltip: 'send' }),
            valid
        ];

        expect(findSubmitButton(fakeRoot(candidates))).toBe(valid);
    });
});
