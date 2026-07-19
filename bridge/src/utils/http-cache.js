export function normalizeEntityTag(value) {
  return String(value || '')
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"|"$/g, '');
}

export function formatEntityTag(value) {
  const normalized = normalizeEntityTag(value);
  return normalized ? `"${normalized}"` : '';
}
