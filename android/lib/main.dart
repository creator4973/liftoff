import 'package:flutter/material.dart';

import 'api.dart';
import 'app_theme.dart';
import 'background_notifications.dart';
import 'screens/home_screen.dart';
import 'screens/pairing_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppThemeController.initialize();
  await BackgroundActionNotifications.initialize();
  final config = await ServerConfig.load();
  runApp(AntigravityRemoteApp(initialConfig: config));
}

class AntigravityRemoteApp extends StatelessWidget {
  final ServerConfig? initialConfig;

  const AntigravityRemoteApp({super.key, this.initialConfig});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<AppThemeStyle>(
      valueListenable: AppThemeController.style,
      builder: (context, style, _) => MaterialApp(
        title: 'LiftOff',
        debugShowCheckedModeBanner: false,
        theme: AppThemeController.themeFor(style),
        home: initialConfig == null
            ? const PairingScreen()
            : HomeScreen(config: initialConfig!),
      ),
    );
  }
}
