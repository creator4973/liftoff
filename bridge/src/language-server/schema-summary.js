// @ts-check

const SAFE_VALUE_KEYS = new Set(['type', 'status']);
const REDACTED_KEYS = new Set([
  'csrfToken',
  'token',
  'commandLine',
  'absolutePathUri',
  'absoluteUri',
  'workspaceFolderAbsoluteUri',
  'gitRootAbsoluteUri',
  'workspaceUrisToRelativePaths',
]);

function isDynamicSensitiveKey(key) {
  return (
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(key) ||
    key.includes('/') ||
    key.includes('\\') ||
    key.startsWith('file:') ||
    key.length > 100
  );
}

function signature(value) {
  return JSON.stringify(value);
}

export function summarizeSchema(value, key = '', depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (depth >= 7) return Array.isArray(value) ? 'array' : typeof value;

  if (typeof value === 'string') {
    return SAFE_VALUE_KEYS.has(key) ? { type: 'string', value } : 'string';
  }
  if (typeof value !== 'object') return typeof value;

  if (Array.isArray(value)) {
    const items = [];
    const seen = new Set();
    for (const item of value.slice(0, 12)) {
      const itemSchema = summarizeSchema(item, '', depth + 1);
      const itemSignature = signature(itemSchema);
      if (seen.has(itemSignature)) continue;
      seen.add(itemSignature);
      items.push(itemSchema);
    }
    return { type: 'array', length: value.length, items };
  }

  const fields = {};
  const dynamicValues = [];
  const dynamicSignatures = new Set();
  let dynamicKeyCount = 0;
  for (const field of Object.keys(value).sort().slice(0, 80)) {
    if (isDynamicSensitiveKey(field)) {
      dynamicKeyCount += 1;
      const itemSchema = summarizeSchema(value[field], '', depth + 1);
      const itemSignature = signature(itemSchema);
      if (!dynamicSignatures.has(itemSignature)) {
        dynamicSignatures.add(itemSignature);
        dynamicValues.push(itemSchema);
      }
      continue;
    }
    fields[field] = REDACTED_KEYS.has(field)
      ? 'redacted'
      : summarizeSchema(value[field], field, depth + 1);
  }
  return {
    type: 'object',
    ...(dynamicKeyCount ? { dynamicKeyCount, dynamicValues } : {}),
    fields,
  };
}
