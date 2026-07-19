import { describe, expect, it, vi } from 'vitest';
import { SessionStats } from '../../src/session-stats.js';

describe('SessionStats', () => {
  it('starts with zeroed metrics and a reset reason', () => {
    const stats = new SessionStats();
    const summary = stats.getSummary();

    expect(summary.resetReason).toBe('startup');
    expect(summary.metrics.messagesSent).toBe(0);
    expect(summary.metrics.errorsDetected).toBe(0);
  });

  it('increments counters and exposes them in the summary', () => {
    const stats = new SessionStats();
    stats.increment('messagesSent');
    stats.increment('actionsApproved', 2);

    const summary = stats.getSummary();
    expect(summary.metrics.messagesSent).toBe(1);
    expect(summary.metrics.actionsApproved).toBe(2);
  });

  it('logs errors and increments the global error counter', () => {
    const stats = new SessionStats();
    const entry = stats.logError('quota', 'Quota warning hit');
    const summary = stats.getSummary();

    expect(entry.type).toBe('quota');
    expect(summary.metrics.errorsDetected).toBe(1);
    expect(summary.lastErrors[0].message).toBe('Quota warning hit');
  });

  it('keeps the error log capped at 50 entries', () => {
    const stats = new SessionStats();
    for (let index = 0; index < 60; index += 1) {
      stats.logError('error', `Issue ${index}`);
    }

    expect(stats.errorLog).toHaveLength(50);
    expect(stats.errorLog[0].message).toBe('Issue 10');
  });

  it('keeps the action log capped at 100 entries', () => {
    const stats = new SessionStats();
    for (let index = 0; index < 120; index += 1) {
      stats.logAction('action', { index });
    }

    expect(stats.actionLog).toHaveLength(100);
    expect(stats.actionLog[0].details).toEqual({ index: 20 });
  });

  it('calculates approval rate from approved and rejected actions', () => {
    const stats = new SessionStats();
    stats.increment('actionsApproved', 3);
    stats.increment('actionsRejected', 1);

    expect(stats.getSummary().approvalRate).toBe('75%');
  });

  it('notifies subscribers on updates and stops after unsubscribe', () => {
    const stats = new SessionStats();
    const listener = vi.fn();
    const unsubscribe = stats.subscribe(listener);

    stats.increment('messagesSent');
    unsubscribe();
    stats.increment('messagesSent');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('updated', expect.any(Object));
  });

  it('resets the session state for a new chat', () => {
    const stats = new SessionStats();
    stats.increment('messagesSent', 4);
    stats.reset('new-chat');

    const summary = stats.getSummary();
    expect(summary.resetReason).toBe('new-chat');
    expect(summary.metrics.messagesSent).toBe(0);
  });
});
