import { describe, expect, it } from 'vitest';
import { summarizeSchema } from '../../src/language-server/schema-summary.js';

describe('Language Server schema summaries', () => {
  it('keeps safe enums while redacting content and sensitive fields', () => {
    const result = summarizeSchema({
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      title: 'private conversation',
      csrfToken: 'secret',
      nested: {
        commandLine: 'private command',
        items: [{ text: 'private message' }],
      },
    });

    expect(result.fields.type).toEqual({
      type: 'string',
      value: 'CORTEX_STEP_TYPE_USER_INPUT',
    });
    expect(result.fields.status).toEqual({
      type: 'string',
      value: 'CORTEX_STEP_STATUS_DONE',
    });
    expect(result.fields.title).toBe('string');
    expect(result.fields.csrfToken).toBe('redacted');
    expect(result.fields.nested.fields.commandLine).toBe('redacted');
    expect(result.fields.nested.fields.items.items[0].fields.text).toBe('string');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('collapses UUID and path-like map keys without exposing identifiers', () => {
    const result = summarizeSchema({
      '14c36558-6a6c-4a68-85a7-2ece64822e00': { title: 'private' },
      'file:///C:/private/workspace': { status: 'IDLE' },
    });
    const serialized = JSON.stringify(result);

    expect(result.dynamicKeyCount).toBe(2);
    expect(serialized).not.toContain('14c36558');
    expect(serialized).not.toContain('C:/private');
    expect(serialized).not.toContain('private');
  });
});
