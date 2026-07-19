# Development and verification

Bridge checks:

```powershell
cd bridge
npm.cmd install
npm.cmd run test:unit
npm.cmd test
```

Flutter checks:

```powershell
cd android
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

The release APK build is optional when Flutter or Android SDK tooling is not
installed. Never use tests that send prompts, images, approvals, or commands to
an active user-owned Antigravity session. Integration checks must use an
isolated port and explicit fixtures.

CI runs Node tests, Flutter analysis/tests, and a practical secret scan. Local
verification does not constitute real-device acceptance or production readiness.
