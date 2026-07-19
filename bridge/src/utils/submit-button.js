/**
 * Finds Antigravity's real submit control after the composer has content.
 * Antigravity currently gives its voice recorder a send-related tooltip, so
 * accessibility labels must veto voice controls before tooltip matching.
 *
 * This function is serialized and evaluated in the Antigravity renderer.
 * Keep it self-contained and limited to browser APIs.
 *
 * @param {{querySelectorAll: (selector: string) => ArrayLike<HTMLButtonElement>}} root
 * @returns {HTMLButtonElement | null}
 */
export function findSubmitButton(root) {
    const candidates = Array.from(root.querySelectorAll('button'));
    return candidates.find(button => {
        if (button.disabled || button.offsetParent === null) return false;

        const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
        const title = (button.getAttribute('title') || '').toLowerCase();
        const tooltip = (button.getAttribute('data-tooltip-id') || '').toLowerCase();
        const accessibleLabel = `${ariaLabel} ${title}`;
        const allLabels = `${accessibleLabel} ${tooltip}`;

        if (/\b(cancel|stop|record|voice|microphone|mic)\b/.test(accessibleLabel)) {
            return false;
        }

        const hasSendIcon = !!button.querySelector(
            'svg.lucide-arrow-up, svg.lucide-arrow-right, svg.lucide-send'
        );
        return hasSendIcon || /(^|[-_ ])send($|[-_ ])/i.test(allLabels);
    }) || null;
}

export const FIND_SUBMIT_BUTTON_SOURCE = findSubmitButton.toString();
