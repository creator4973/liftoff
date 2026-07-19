# Privacy and local data

LiftOff is designed for local/private use. Conversation text, selected media,
and Antigravity responses pass through the bridge to the paired phone. The
Android app may retain opened RPC transcripts in its app-private cache; the
bridge may retain local operational state and logs while running. These are
ignored by Git and are not part of this repository.

The repository intentionally excludes conversations, screenshots, uploads,
attachments, logs, cookies, certificates, credentials, generated binaries, and
machine metadata. Before sharing a patch, inspect both tracked files and the
diff for private content.

No telemetry or hosted data service is promised by this project. Network
behavior is limited to the bridge, the paired device, Antigravity, and any
explicitly configured local development dependency.
