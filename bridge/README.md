# LiftOff

LiftOff is a private Windows-to-Android companion for Antigravity. A small Node
bridge runs on the computer that owns the Antigravity session, while the
Flutter Android app provides the remote chat interface.

The browser is intentionally **not** a second chat client. Visiting the bridge
opens the LiftOff setup page, Android release details, APK QR code, and a small
password-protected control panel for the Windows bridge.

## Architecture

```text
LiftOff Android app -- HTTPS + WebSocket -- LiftOff bridge -- Connect RPC -- Antigravity Language Server
                                                |
                                                +-- CDP capability fallback during migration
```

The bridge keeps the phone-facing API stable while structured Antigravity RPC
replaces the older DOM-control path capability by capability. Text sending,
conversation creation, cancellation, conversation discovery, transcript reads,
response polling, and quota reads already prefer RPC. Unsupported actions still
use guarded CDP fallback.

RPC snapshots carry a stable revision derived from conversation summary
metadata. Android clients may send that revision in `If-None-Match`; `/snapshot`
returns `304 Not Modified` before loading the full trajectory when the selected
conversation has not changed. This supports immediate local-cache rendering
without repeatedly transferring or rebuilding an unchanged transcript.

Large trajectories use a bounded 30-second read budget. This prevents long
histories from timing out after five seconds and silently degrading to the
currently mounted CDP viewport. A selected RPC conversation stays on the RPC
path while it loads.

Pending replies use a lightweight one-second Language Server summary/status
probe. The bridge loads the full trajectory only after the final idle revision
changes, then reuses that rendered snapshot for Android's immediate fetch.

Image bytes are not embedded in snapshot HTML. The semantic renderer emits
stable media references, and authenticated clients fetch an original image on
demand from `/api/conversations/:id/media/:stepIndex/:mediaIndex`.

When Antigravity compacts old turns, LiftOff renders the newest retained
`CONVERSATION_HISTORY` block as **Earlier context**, followed by every available
user input and final planner response. Code-action results are summarized as
lightweight file-change cards. Full unified diffs are fetched only on demand
from `/api/conversations/:id/changes/:stepIndex`; raw diffs are not embedded in
snapshot HTML.

Agent error, quota, rate-limit, and completion notifications are classified
from the newest assistant response created after the current send. Historical
messages in the transcript cannot re-trigger a stale notification.

RPC text sends inherit the conversation's latest valid Antigravity model and
planner type through `cascadeConfig`. If that configuration cannot be read,
the bridge falls back before mutation instead of submitting a model-less
request that Antigravity would terminate.

`/new-chat` calls `StartCascade` and selects the returned conversation ID;
`/stop` calls `CancelCascadeInvocation` for the active conversation. Both paths
preflight the exact Language Server transport, issue one mutation attempt, and
allow CDP fallback only before a mutation begins. The Android API contract is
unchanged.

Because a new empty cascade may not appear in trajectory summaries immediately,
the bridge temporarily retains its confirmed Language Server owner, transport,
and model configuration. The first message and immediate Stop use that pinned
RPC context; they never fall back into whichever conversation is visible in the
Antigravity desktop window.

After RPC creation and text sends, the bridge makes a short non-blocking CDP
attempt to select the same conversation ID in the visible desktop sidebar. This
best-effort UI synchronization never changes RPC success or blocks minimized and
locked-screen operation.

## Quick Start on Windows

Requirements:

- Windows 10 or newer
- Node.js 22 or newer
- Antigravity installed and signed in
- Android phone on the same LAN or Tailscale tailnet

Start with either method:

1. Double-click `LiftOff.exe`. It installs production Node dependencies when
   `node_modules` is absent, starts the bridge without a terminal window, and
   remains available from the Windows notification area. Its menu can open the
   setup page, start, restart, or stop the bridge, open logs, and enable Start
   with Windows. Closing the setup page does not stop the bridge.
2. Run `npm.cmd install`, then `npm.cmd start` from this directory.

If a terminal-started bridge already owns port `4747`, the tray app reports
`running outside tray` and does not start a duplicate. Stop the terminal bridge
once, then choose **Start bridge** from the LiftOff tray menu to move control to
the tray app.

Open the printed LAN or Tailscale address on the phone, or scan the QR code on
the setup page. The direct current APK endpoint is `/liftoff.apk`; the old
`/antigravity-remote.apk` URL remains as a compatibility alias.

LiftOff prefers active physical Wi-Fi and Ethernet adapters when choosing the
LAN address advertised by the terminal, QR code, setup page, and UDP discovery.
Virtual VMware, Hyper-V, WSL, Docker, and tunnel adapters are deprioritized so
their private addresses do not replace the reachable Wi-Fi address.

## Bridge Controls

The setup page shows safe status without authentication. Enter the configured
LiftOff bridge password to unlock recent logs, restart, stop, and Start with
Windows controls. Machine actions require the password even from localhost or
the LAN and are available only when the bridge was started by `LiftOff.exe`.

Stopping the bridge also takes its webpage offline, so it cannot provide its
own Start button while stopped. Start it again from the LiftOff tray icon. Tray
logs and non-secret state are stored under `%LOCALAPPDATA%\LiftOff`.

The Android app menu provides **Exit LiftOff** to disconnect only that phone,
and **Shut down bridge & exit** to send an authenticated stop request to the
Windows tray app before closing. Both actions stop the Android foreground
service and remove its ongoing connection notification. Swiping LiftOff away
from Android Recents also stops that service; ordinary backgrounding keeps
approval monitoring active.

## Development

```powershell
npm.cmd install
npm.cmd run test:unit
npm.cmd test
npm.cmd run build:launcher:win
```

When the tray-managed bridge is already using port `4747`, run integration
checks on an isolated port instead of competing with the live bridge:

```powershell
$env:PORT = '4753'
npm.cmd test
Remove-Item Env:PORT
```

Android source lives in the sibling `../antigravity_remote` directory:

```powershell
flutter analyze
flutter test
flutter build apk --release
npm.cmd run publish:mobile
```

`publish:mobile` copies the verified release to `public/liftoff.apk`, refreshes
`public/mobile-app.json`, writes a versioned artifact under `outputs/`, and
maintains the legacy APK alias.

## Security

- Treat the bridge password, pairing payload, TLS private key, cookies, and
  Antigravity daemon metadata as secrets.
- Do not commit `.env`, `certs/`, `data/`, uploads, logs, generated APKs,
  signing keys, or machine-specific paths.
- Prefer LAN or Tailscale. Do not expose port `4747` directly to the public
  internet.
- The bridge connects to Antigravity's Language Server only through loopback
  and does not expose its CSRF token or internal port to the phone.
- Desktop control routes accept only fixed tray commands; they do not expose an
  arbitrary process or shell execution endpoint.

## License and Attribution

LiftOff is licensed under GPL-3.0-only. See `LICENSE` and `NOTICE.md` for
required upstream copyright and license notices.
