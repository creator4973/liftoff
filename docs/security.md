# Security model

The bridge password protects phone login and tray controls. Pairing data,
session cookies, TLS private keys, Antigravity daemon metadata, and any local
supervisor credentials are secrets. Store them only in ignored local files or
the operating system’s protected application data locations.

The bridge should be reachable only over a trusted LAN or private overlay
network. Do not expose its HTTPS port directly to the public internet. The
Language Server connection is loopback-only. Desktop controls are fixed,
allowlisted operations; they are not a general shell or process-execution API.

Treat the Android APK and phone as holders of access: revoke or rotate the
bridge password if a device is lost. TLS certificate trust is host-scoped.
