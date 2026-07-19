# Changelog

LiftOff follows semantic versioning while the project is in preview. Internal
Antigravity interfaces may still require compatibility fixes between releases.

## 0.8.1 - 2026-07-18

- Parse Antigravity file changes represented as structured unified-diff lines.
- Invalidate older transcript caches so newly recognized file-change cards are
  rendered after upgrading.
- Notify the Android companion when an RPC-backed reply finishes.
- Rename remaining legacy runtime identifiers and use a public application ID.

## 0.8.0 - 2026-07-18

- Add retained earlier-context rendering for long conversations.
- Add lazy file-change cards and on-demand per-file diff viewing.
- Cache the project drawer for faster startup.
- Add new-conversation progress and best-effort desktop conversation focus.
