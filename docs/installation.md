# Installation and first run

## Release install

Download the Windows ZIP, Android APK, and `SHA256SUMS.txt` from the same GitHub
release. Verify the downloads, extract the Windows ZIP, and open `LiftOff.exe`.
The tray launcher installs production dependencies when needed. On first launch
it creates a private `.env` with random local authentication secrets and shows
the pairing password once.

Exit an existing LiftOff tray process before replacing an installed release.
Preserve its private `.env` and `certs/` directory during a manual upgrade.
Android APKs are attached to each GitHub release.

## Requirements

- Windows 10 or newer
- Node.js 22 or newer
- A signed-in Antigravity installation
- An Android device on a trusted reachable network
- Flutter SDK only for Android development or APK builds

Copy `bridge/.env.example` to `bridge/.env` and set a strong local bridge
password. Generate a local certificate with `npm.cmd run setup:ssl`; generated
certificates belong in the ignored `bridge/certs/` directory.

Install and start the bridge:

```powershell
cd bridge
npm.cmd install
npm.cmd start
```

For tray use, build `bridge/windows/LiftOffLauncher.cs` with the provided
`build-launcher.ps1`. Do not commit the resulting executable.

The Android app can also be built locally. From `android/`, run
`flutter pub get` and `flutter build apk --release`.
