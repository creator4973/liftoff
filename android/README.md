# LiftOff Android Companion

This Flutter application is the interactive mobile client for LiftOff. It
connects to a LiftOff bridge running beside Antigravity on a Windows computer.

The app supports LAN discovery, manual LAN or Tailscale addresses, QR pairing,
project and conversation switching, text and image messages, model switching,
quota status, permission responses, and action-required notifications.

RPC-backed conversations render every available user/final-answer turn plus
Antigravity's newest retained compacted **Earlier context**. You can scroll
upward without moving the Antigravity desktop viewport, and long-press rendered
user or assistant text to select and copy it.

For faster startup, the app keeps every RPC conversation you open as a
separate app-private file per paired bridge. The latest or selected cached
conversation can render before login and network refresh. LiftOff then sends
its saved revision to the bridge; an unchanged conversation returns
`304 Not Modified` instead of downloading and rebuilding the complete
transcript. Partial CDP viewport snapshots and conversation image bytes are not
cached. Android backup is disabled so this local transcript cache is not
included in normal app backup.

Typical transcript files are tens to hundreds of kilobytes. The sampled
conversations were about 17 KB and 121 KB, so dozens of cached conversations
normally consume only a few megabytes; unusually large histories may reach the
low tens of megabytes.

The project/conversation drawer has a separate small app-private cache. It
paints immediately after startup or a bridge restart, then refreshes quietly in
the background. New Conversation displays a progress banner and uses the
RPC-returned conversation ID as soon as creation completes.

RPC image attachments stay lightweight until tapped. Tapping an attachment
offers **Open**, which downloads the original image into a zoomable viewer, or
**Reply with image**, which downloads it into the composer attachment preview.

File-change cards are also lazy. Tapping a card loads only that change set,
shows its files in a native sheet, and opens the selected unified diff in a
full-screen selectable viewer.

## Verify

```powershell
flutter analyze
flutter test
flutter build apk --release
```

Public builds use the Android application ID `io.github.creator4973.liftoff`.
The visible product name and launcher artwork are LiftOff.

Publish the verified APK from the bridge directory with:

```powershell
npm.cmd run publish:mobile
```

See the bridge `README.md`, `LICENSE`, and `NOTICE.md` for architecture,
security, licensing, and upstream attribution.
