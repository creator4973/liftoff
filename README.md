<div align="center">
  <img src="bridge/public/icons/liftoff-icon.png" width="104" alt="LiftOff logo">
  <h1>LiftOff</h1>
  <p><strong>Keep your Antigravity session within reach.</strong></p>
  <p>A private Windows bridge and Android companion for messaging, approvals, files, and conversation control from your phone.</p>

  <p>
    <a href="README.md"><strong>English</strong></a>
    &nbsp;|&nbsp;
    <a href="README.vi.md">Tiếng Việt</a>
  </p>

  <p>
    <a href="https://github.com/creator4973/liftoff/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/creator4973/liftoff?include_prereleases&sort=semver&style=flat-square"></a>
    <a href="https://github.com/creator4973/liftoff/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/creator4973/liftoff/ci.yml?branch=main&label=build&style=flat-square"></a>
    <img alt="Windows and Android" src="https://img.shields.io/badge/platform-Windows%20%2B%20Android-165c46?style=flat-square">
    <a href="LICENSE"><img alt="GPL-3.0-only license" src="https://img.shields.io/github/license/creator4973/liftoff?style=flat-square"></a>
  </p>
</div>

> [!IMPORTANT]
> LiftOff is an MVP preview. Antigravity's internal RPC and DOM surfaces are not stable public APIs, so an Antigravity update can require a LiftOff compatibility update.

## Your desk agent, within reach

LiftOff keeps the bridge on your Windows computer and gives you a focused Android companion. Use Wi-Fi discovery at home or connect through your own Tailscale network when away. LiftOff does not require a hosted LiftOff account.

<p align="center">
  <img src="docs/assets/screenshots/desktop-download.jpg" width="100%" alt="LiftOff desktop download and pairing page">
</p>

<table>
  <tr>
    <td width="42%" align="center"><img src="docs/assets/screenshots/android-pairing.jpg" width="100%" alt="LiftOff Android pairing screen"></td>
    <td width="58%" align="center"><img src="docs/assets/screenshots/android-chat-diffs.jpg" width="100%" alt="LiftOff Android conversation and file changes"></td>
  </tr>
  <tr>
    <td align="center"><strong>Pair on Wi-Fi, by QR, or through Tailscale</strong></td>
    <td align="center"><strong>Read conversations and inspect file changes</strong></td>
  </tr>
</table>

## What you can do

| From your phone | Built for private access |
| --- | --- |
| Send text and images | Local Windows bridge with password authentication |
| Start, switch, and stop conversations | Wi-Fi discovery and QR pairing |
| Choose available models | Direct Tailscale access without a public tunnel |
| Receive reply and approval notifications | Locally stored settings, snapshots, and credentials |
| Review changed files and unified diffs | Auditable Node.js, Flutter, and C# source |

The structured RPC path handles conversation reads and core text actions. A guarded compatibility layer still uses desktop automation for capabilities that have not completed their RPC migration.

## Install

### Install on Windows

1. Open the [latest release](https://github.com/creator4973/liftoff/releases).
2. Download the Windows ZIP and Android APK.
3. Compare each download with `SHA256SUMS.txt` from the same release.
4. Extract the Windows ZIP and open `LiftOff.exe`.

The tray launcher installs production Node.js dependencies when needed and
generates local authentication secrets on first launch. It displays the pairing
password once so you can save it in your password manager.

Requirements: Windows 10 or newer, Node.js 22 or newer, a signed-in Antigravity installation, and an Android phone.

> [!NOTE]
> A one-line WinGet-style install is planned after LiftOff has a signed Windows package. This first public release avoids piping an unsigned remote PowerShell script directly into the shell.

For manual setup, HTTPS certificates, development builds, and upgrades, read the [installation guide](docs/installation.md).

## How it works

```text
Android companion
       |
       | HTTPS and WebSocket on your private network
       v
LiftOff bridge on Windows
       |
       | Antigravity RPC plus guarded compatibility actions
       v
Antigravity desktop session
```

- On the same trusted Wi-Fi, the Android app can discover the bridge automatically.
- Away from home, enter the computer's Tailscale address and your LiftOff password.
- Windows sleep or hibernation suspends the bridge. Locking the screen is supported by the RPC-backed messaging path, subject to Windows and Antigravity behavior.

## Privacy and security

LiftOff is a high-trust remote-control tool. Keep it on networks and devices you control.

- The installer creates a private `.env` file locally. It is ignored by Git.
- TLS keys, passwords, logs, uploads, screenshots, and runtime state are excluded from the repository.
- Public tunnel support is optional and is not required for Tailscale users.
- Review [security](docs/security.md) and [privacy](docs/privacy.md) before exposing the bridge beyond your home network.

## Project status

The core companion workflow is usable, but this repository is still an MVP preview rather than a production support promise. See [known limitations](docs/support.md), [release notes](CHANGELOG.md), and the [issue tracker](https://github.com/creator4973/liftoff/issues).

## Support LiftOff

If LiftOff saves you time, you can support continued development. Donations are optional and do not unlock features or support priority.

<table>
  <tr>
    <td width="50%" align="center"><strong>PayPal</strong></td>
    <td width="50%" align="center"><strong>VietQR</strong></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/support/paypal-qr.jpg" width="240" alt="PayPal donation QR code"></td>
    <td align="center"><img src="docs/assets/support/vietqr.png" width="240" alt="VietQR donation code"></td>
  </tr>
</table>

## Contributing

Bug reports, compatibility notes, documentation fixes, and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and include the Antigravity version when reporting compatibility problems.

## Documentation

- [Installation and first run](docs/installation.md)
- [Architecture and data flow](docs/architecture.md)
- [Pairing, network access, and security](docs/security.md)
- [Privacy and local data](docs/privacy.md)
- [Development and verification](docs/development.md)
- [Known limitations and support boundaries](docs/support.md)

## License and attribution

LiftOff is licensed under GPL-3.0-only. Required copyright and license notices are recorded in [NOTICE.md](NOTICE.md).
