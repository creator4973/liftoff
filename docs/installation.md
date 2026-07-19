# Installation and first run

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

The Android app can be installed from a locally built APK. This repository does
not publish or include an APK. From `android/`, run `flutter pub get` and
`flutter build apk --release`.
