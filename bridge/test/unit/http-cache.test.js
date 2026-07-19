import { describe, expect, it } from 'vitest';
import {
  formatEntityTag,
  normalizeEntityTag,
} from '../../src/utils/http-cache.js';

describe('HTTP cache helpers', () => {
  it('normalizes strong and weak entity tags', () => {
    expect(normalizeEntityTag('"revision-1"')).toBe('revision-1');
    expect(normalizeEntityTag('W/"revision-1"')).toBe('revision-1');
    expect(normalizeEntityTag('')).toBe('');
  });

  it('formats safe strong entity tags', () => {
    expect(formatEntityTag('revision-1')).toBe('"revision-1"');
    expect(formatEntityTag('')).toBe('');
  });
});
