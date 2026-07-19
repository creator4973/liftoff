# Architecture and data flow

```text
Flutter Android app -- HTTPS/WebSocket --> Node bridge
                                             |-- Connect RPC reads/mutations --> Antigravity Language Server
                                             `-- guarded CDP fallback ---------> Antigravity desktop
```

The bridge is the authentication, pairing, normalization, and compatibility
boundary. The phone receives sanitized snapshots and authenticated media/diff
fetches. The bridge connects to Antigravity’s Language Server over loopback and
uses guarded CDP only for capabilities that are not yet fully represented by
RPC.

Conversation data is normalized into a stable phone-facing contract. Mutations
are owner-pinned and bounded; CDP fallback is allowed only before an RPC
mutation begins. The Android client keeps an app-private cache and reconnects
through REST/WebSocket recovery.

Antigravity’s Connect RPC service and DOM selectors are internal,
compatibility-sensitive surfaces. They are not stable public APIs, and no
independent compatibility guarantee is made for them.
