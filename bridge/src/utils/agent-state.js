/**
 * Detects Antigravity's terminal response after a generation is stopped.
 * Accept both American and British spelling because UI copy can vary.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isCancellationMessage(text) {
    return /\b(?:user\s+)?cancel(?:l)?ed\s+(?:the\s+)?agent\s+execution\b/i.test(
        String(text || '')
    );
}

/**
 * Classifies noteworthy text only when it belongs to the newest assistant
 * response created after the current send. Historical transcript text must
 * never produce a fresh notification.
 *
 * @param {{
 *   probe?: {
 *     latestRole?: string,
 *     latestText?: string,
 *     signature?: string
 *   } | null,
 *   responseWatch?: {
 *     baselineSignature?: string,
 *     startedAt?: number
 *   } | null
 * }} input
 * @returns {{event: string, message: string, key: string} | null}
 */
export function classifyCurrentAgentNotification({
    probe = null,
    responseWatch = null
} = {}) {
    const startedAt = Number(responseWatch?.startedAt || 0);
    const signature = String(probe?.signature || '');
    const baselineSignature = String(responseWatch?.baselineSignature || '');
    if (
        startedAt <= 0 ||
        probe?.latestRole !== 'assistant' ||
        !signature ||
        signature === baselineSignature
    ) {
        return null;
    }

    const text = String(probe?.latestText || '').toLowerCase();
    let event = '';
    let message = '';
    if (
        text.includes('model quota reached') ||
        text.includes('usage limit') ||
        text.includes('quota exhausted')
    ) {
        event = 'quota_error';
        message = 'Model Quota Exceeded!';
    } else if (
        text.includes('agent terminated') ||
        text.includes('agent stopped') ||
        text.includes('terminated due to error')
    ) {
        event = 'agent_error';
        message = 'Agent Terminated or Blocked!';
    } else if (
        text.includes('rate limit') ||
        text.includes('too many requests')
    ) {
        event = 'rate_limit';
        message = 'Rate Limit Hit!';
    } else if (
        text.includes('task completed') &&
        text.includes('i have completed the task')
    ) {
        event = 'task_completed';
        message = 'Task Completed Successfully!';
    }

    return event
        ? { event, message, key: `${startedAt}:${event}` }
        : null;
}
