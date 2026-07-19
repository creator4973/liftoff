import { describe, expect, it } from 'vitest';
import {
    classifyCurrentAgentNotification,
    isCancellationMessage
} from '../../src/utils/agent-state.js';

describe('isCancellationMessage', () => {
    it('recognizes Antigravity cancellation responses', () => {
        expect(isCancellationMessage('User cancelled agent execution.')).toBe(true);
        expect(isCancellationMessage('User canceled agent execution')).toBe(true);
        expect(isCancellationMessage('Cancelled the agent execution')).toBe(true);
    });

    it('does not treat ordinary assistant text as cancellation', () => {
        expect(isCancellationMessage('The task completed successfully.')).toBe(false);
        expect(isCancellationMessage('You can cancel this later.')).toBe(false);
    });
});

describe('classifyCurrentAgentNotification', () => {
    const currentResponse = {
        baselineSignature: 'before-send',
        startedAt: 12345
    };

    it('ignores an old assistant error that was already visible before sending', () => {
        expect(classifyCurrentAgentNotification({
            probe: {
                latestRole: 'assistant',
                latestText: 'Agent execution terminated due to error.',
                signature: 'before-send'
            },
            responseWatch: currentResponse
        })).toBeNull();
    });

    it('ignores matching words in user input or unrelated current replies', () => {
        expect(classifyCurrentAgentNotification({
            probe: {
                latestRole: 'user',
                latestText: 'Please investigate terminated due to error.',
                signature: 'new-user-input'
            },
            responseWatch: currentResponse
        })).toBeNull();
        expect(classifyCurrentAgentNotification({
            probe: {
                latestRole: 'assistant',
                latestText: 'I am working on the request now.',
                signature: 'new-assistant-response'
            },
            responseWatch: currentResponse
        })).toBeNull();
    });

    it('classifies a new termination once per response watch', () => {
        expect(classifyCurrentAgentNotification({
            probe: {
                latestRole: 'assistant',
                latestText: 'Error: Unknown: Agent execution terminated due to error.',
                signature: 'new-error'
            },
            responseWatch: currentResponse
        })).toEqual({
            event: 'agent_error',
            message: 'Agent Terminated or Blocked!',
            key: '12345:agent_error'
        });
    });

    it.each([
        ['Model quota reached', 'quota_error', 'Model Quota Exceeded!'],
        ['Too many requests: rate limit', 'rate_limit', 'Rate Limit Hit!'],
        [
            'Task completed. I have completed the task.',
            'task_completed',
            'Task Completed Successfully!'
        ]
    ])('classifies a new current response: %s', (latestText, event, message) => {
        expect(classifyCurrentAgentNotification({
            probe: {
                latestRole: 'assistant',
                latestText,
                signature: `signature-${event}`
            },
            responseWatch: currentResponse
        })).toEqual({
            event,
            message,
            key: `12345:${event}`
        });
    });
});
