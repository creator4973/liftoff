# LiftOff

LiftOff is a Windows-to-Android companion for an Antigravity session. This
repository is an MVP preview / pre-release, not a production-ready service or
an accepted stable release.

The repository contains two parts:

- `bridge/`: a Node.js HTTPS/WebSocket bridge, Windows tray-launcher source,
  tests, and safe setup-page assets.
- `android/`: the Flutter companion source and tests.

## First run

Read [Installation](docs/installation.md), copy `bridge/.env.example` to
`bridge/.env`, and replace only the placeholders with local values. Never commit
that file. The bridge expects Node.js 22 or newer; Flutter tooling is required
only to build or test the Android companion.

```powershell
cd bridge
npm.cmd install
npm.cmd start
```

Use the printed HTTPS pairing address from a phone on the same trusted network.
The Windows tray executable is intentionally not included; build it from the
auditable C# source when required.

## Documentation

- [Architecture and data flow](docs/architecture.md)
- [Pairing, network access, and security](docs/security.md)
- [Privacy and local data](docs/privacy.md)
- [Development and verification](docs/development.md)
- [Known limitations and support boundaries](docs/support.md)
- [Contribution guidelines](CONTRIBUTING.md)
- [Release notes](CHANGELOG.md)

Antigravity's internal RPC and DOM surfaces are compatibility-sensitive
implementation details, not stable public APIs. They may change without notice;
LiftOff's compatibility layer can therefore break between Antigravity versions.

## License and attribution

LiftOff retains the inherited GPL-3.0-only license. Required upstream copyright
and license notices are recorded in [NOTICE.md](NOTICE.md).
