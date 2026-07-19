import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum AppThemeStyle { antigravity, hermes }

class AppThemeController {
  AppThemeController._();

  static const _preferenceKey = 'app_theme_style';
  static final ValueNotifier<AppThemeStyle> style = ValueNotifier(
    AppThemeStyle.antigravity,
  );

  static Future<void> initialize() async {
    final prefs = await SharedPreferences.getInstance();
    style.value = switch (prefs.getString(_preferenceKey)) {
      'hermes' => AppThemeStyle.hermes,
      _ => AppThemeStyle.antigravity,
    };
  }

  static Future<void> setStyle(AppThemeStyle value) async {
    if (style.value == value) return;
    style.value = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_preferenceKey, value.name);
  }

  static ThemeData themeFor(AppThemeStyle value) => switch (value) {
    AppThemeStyle.antigravity => _antigravityTheme(),
    AppThemeStyle.hermes => _hermesTheme(),
  };

  static ThemeData _antigravityTheme() {
    const seed = Color(0xFF7C6CF0);
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: ColorScheme.fromSeed(
        seedColor: seed,
        brightness: Brightness.dark,
        surface: const Color(0xFF12121A),
      ),
      scaffoldBackgroundColor: const Color(0xFF0C0C12),
      snackBarTheme: const SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  static ThemeData _hermesTheme() {
    const gold = Color(0xFFF0D85A);
    const background = Color(0xFF090906);
    const surface = Color(0xFF121109);
    const outline = Color(0xFF655D28);
    const scheme = ColorScheme.dark(
      primary: gold,
      onPrimary: Color(0xFF161300),
      primaryContainer: Color(0xFF201D0D),
      onPrimaryContainer: Color(0xFFF3EFCF),
      secondary: Color(0xFFCBB94C),
      onSecondary: Color(0xFF161300),
      secondaryContainer: Color(0xFF29250F),
      onSecondaryContainer: Color(0xFFF3EFCF),
      surface: surface,
      onSurface: Color(0xFFF3EFCF),
      onSurfaceVariant: Color(0xFFB8AF7B),
      outline: outline,
      outlineVariant: Color(0xFF39351C),
      error: Color(0xFFFF8B72),
      errorContainer: Color(0xFF4A1D17),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: scheme,
      fontFamily: 'monospace',
      scaffoldBackgroundColor: background,
      appBarTheme: const AppBarTheme(
        backgroundColor: Color(0xFF0D0C07),
        foregroundColor: Color(0xFFF3EFCF),
        surfaceTintColor: Colors.transparent,
        shape: Border(bottom: BorderSide(color: outline)),
      ),
      drawerTheme: const DrawerThemeData(
        backgroundColor: Color(0xFF0D0C07),
        surfaceTintColor: Colors.transparent,
      ),
      cardTheme: const CardThemeData(
        color: surface,
        surfaceTintColor: Colors.transparent,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFF17150A),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: gold, width: 1.4),
        ),
      ),
      dividerColor: const Color(0xFF39351C),
      snackBarTheme: const SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: Color(0xFF201D0D),
        contentTextStyle: TextStyle(color: Color(0xFFF3EFCF)),
      ),
    );
  }
}
