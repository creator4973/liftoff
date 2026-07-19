import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter/widgets.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'models.dart';

const _listenerChannelId = 'antigravity_listener';
const _actionChannelId = 'antigravity_actions';
const _listenerNotificationId = 47471;
const _actionNotificationId = 47472;
const _replyNotificationId = 47473;
const _pendingActionKey = 'pending_action_notification';
const _lastActionSignatureKey = 'last_action_notification_signature';
const _lastActionTimeKey = 'last_action_notification_time';
const _lastReplySignatureKey = 'last_reply_notification_signature';

const _notificationSettings = InitializationSettings(
  android: AndroidInitializationSettings('@mipmap/ic_launcher'),
  iOS: DarwinInitializationSettings(
    requestAlertPermission: false,
    requestBadgePermission: false,
    requestSoundPermission: false,
  ),
);

@pragma('vm:entry-point')
Future<bool> actionNotificationIosBackground(ServiceInstance service) async {
  WidgetsFlutterBinding.ensureInitialized();
  DartPluginRegistrant.ensureInitialized();
  return true;
}

@pragma('vm:entry-point')
void actionNotificationServiceStart(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();

  final notifications = FlutterLocalNotificationsPlugin();
  await notifications.initialize(settings: _notificationSettings);

  if (service is AndroidServiceInstance) {
    await service.setAsForegroundService();
    await service.setForegroundNotificationInfo(
      title: 'LiftOff is connected',
      content: 'Background monitoring is on - no action needed',
    );
  }

  ApiClient? api;
  WsClient? ws;
  StreamSubscription<Map<String, dynamic>>? messageSubscription;
  var stopping = false;

  Future<void> stop() async {
    if (stopping) return;
    stopping = true;
    await messageSubscription?.cancel();
    ws?.close();
    api?.close();
    await service.stopSelf();
  }

  service.on('stopService').listen((_) => unawaited(stop()));

  final config = await ServerConfig.load();
  if (config == null) {
    await stop();
    return;
  }

  api = ApiClient(config);
  try {
    if (config.password.isNotEmpty) await api.login();
  } catch (_) {
    await stop();
    return;
  }

  ws = WsClient(api);
  messageSubscription = ws.messages.listen((data) async {
    if (data['type'] != 'notification') {
      return;
    }

    if (data['event'] == 'action_cleared') {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_pendingActionKey);
      await prefs.remove(_lastActionSignatureKey);
      await prefs.remove(_lastActionTimeKey);
      await notifications.cancel(id: _actionNotificationId);
      return;
    }
    if (data['event'] == 'reply_ready') {
      final message = (data['message'] ?? 'Antigravity finished replying.')
          .toString();
      final timestamp = (data['timestamp'] ?? '').toString();
      final signature = '$timestamp:$message';
      final prefs = await SharedPreferences.getInstance();
      await prefs.reload();
      if (prefs.getString(_lastReplySignatureKey) == signature) return;
      await prefs.setString(_lastReplySignatureKey, signature);
      await notifications.show(
        id: _replyNotificationId,
        title: 'Antigravity replied',
        body: message,
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            _listenerChannelId,
            'Background connection',
            channelDescription: 'Replies from Antigravity.',
            importance: Importance.defaultImportance,
            priority: Priority.defaultPriority,
            autoCancel: true,
          ),
          iOS: const DarwinNotificationDetails(
            presentAlert: true,
            presentBadge: true,
            presentSound: false,
          ),
        ),
        payload: 'reply_ready',
      );
      return;
    }
    if (data['event'] != 'action_required') return;

    final message = (data['message'] ?? 'Action required').toString();
    final context = (data['context'] ?? '').toString();
    final options = ((data['options'] ?? const <dynamic>[]) as List)
        .map((option) => option.toString())
        .toList();
    final signature = jsonEncode([message, context, options]);
    final now = DateTime.now();
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload();

    final previousSignature = prefs.getString(_lastActionSignatureKey);
    final previousTime = DateTime.tryParse(
      prefs.getString(_lastActionTimeKey) ?? '',
    );
    final recentlyNotified =
        previousSignature == signature &&
        previousTime != null &&
        now.difference(previousTime) < const Duration(minutes: 5);
    if (recentlyNotified) return;

    await prefs.setString(
      _pendingActionKey,
      jsonEncode({
        'receivedAt': now.toIso8601String(),
        'message': message,
        'context': context,
        'options': options,
      }),
    );
    await prefs.setString(_lastActionSignatureKey, signature);
    await prefs.setString(_lastActionTimeKey, now.toIso8601String());

    final body = context.trim().isEmpty ? message : '$message\n$context';
    await notifications.show(
      id: _actionNotificationId,
      title: 'Antigravity needs your approval',
      body: body,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _actionChannelId,
          'Approval requests',
          channelDescription:
              'Alerts when Antigravity is waiting for your approval.',
          importance: Importance.max,
          priority: Priority.high,
          category: AndroidNotificationCategory.reminder,
          visibility: NotificationVisibility.public,
          autoCancel: true,
          styleInformation: BigTextStyleInformation(body),
        ),
        iOS: const DarwinNotificationDetails(
          presentAlert: true,
          presentBadge: true,
          presentSound: true,
        ),
      ),
      payload: 'action_required',
    );
  });
  unawaited(ws.connect());
}

class BackgroundActionNotifications {
  BackgroundActionNotifications._();

  static final FlutterBackgroundService _service = FlutterBackgroundService();
  static final FlutterLocalNotificationsPlugin _notifications =
      FlutterLocalNotificationsPlugin();

  static Future<void> initialize() async {
    await _notifications.initialize(settings: _notificationSettings);
    await _notifications.cancel(id: _actionNotificationId);

    if (!Platform.isAndroid) return;

    final android = _notifications
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    await android?.createNotificationChannel(
      const AndroidNotificationChannel(
        _listenerChannelId,
        'Background connection',
        description: 'Keeps Antigravity approval monitoring active.',
        importance: Importance.low,
        playSound: false,
        showBadge: false,
      ),
    );
    await android?.createNotificationChannel(
      const AndroidNotificationChannel(
        _actionChannelId,
        'Approval requests',
        description: 'Alerts when Antigravity is waiting for your approval.',
        importance: Importance.max,
      ),
    );

    await _service.configure(
      iosConfiguration: IosConfiguration(
        autoStart: false,
        onForeground: actionNotificationServiceStart,
        onBackground: actionNotificationIosBackground,
      ),
      androidConfiguration: AndroidConfiguration(
        onStart: actionNotificationServiceStart,
        autoStart: false,
        autoStartOnBoot: false,
        isForegroundMode: true,
        notificationChannelId: _listenerChannelId,
        initialNotificationTitle: 'LiftOff is connected',
        initialNotificationContent:
            'Background monitoring is on - no action needed',
        foregroundServiceNotificationId: _listenerNotificationId,
      ),
    );
  }

  static Future<void> requestPermission() async {
    if (Platform.isAndroid) {
      await _notifications
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.requestNotificationsPermission();
      return;
    }
    if (Platform.isIOS) {
      await _notifications
          .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin
          >()
          ?.requestPermissions(alert: true, badge: true, sound: true);
    }
  }

  static Future<void> start() async {
    if (!Platform.isAndroid || await _service.isRunning()) return;
    await _service.startService();
  }

  static Future<void> stop({bool clearNotifications = false}) async {
    if (Platform.isAndroid && await _service.isRunning()) {
      _service.invoke('stopService');
      final deadline = DateTime.now().add(const Duration(seconds: 3));
      while (await _service.isRunning() && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    }
    if (clearNotifications) {
      await _notifications.cancel(id: _listenerNotificationId);
      await _notifications.cancel(id: _actionNotificationId);
      await _notifications.cancel(id: _replyNotificationId);
      await clearPendingAction();
    }
  }

  static Future<void> shutdown() => stop(clearNotifications: true);

  static Future<PendingAction?> consumePendingAction() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload();
    final encoded = prefs.getString(_pendingActionKey);
    await prefs.remove(_pendingActionKey);
    if (encoded == null) return null;

    try {
      final data = jsonDecode(encoded) as Map<String, dynamic>;
      final receivedAt = DateTime.tryParse(
        data['receivedAt']?.toString() ?? '',
      );
      if (receivedAt == null ||
          DateTime.now().difference(receivedAt) > const Duration(minutes: 5)) {
        return null;
      }
      return PendingAction(
        message: (data['message'] ?? 'Action required').toString(),
        context: (data['context'] ?? '').toString(),
        options: ((data['options'] ?? const <dynamic>[]) as List)
            .map((option) => option.toString())
            .toList(),
      );
    } catch (_) {
      return null;
    }
  }

  static Future<void> clearPendingAction() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_pendingActionKey);
    await prefs.remove(_lastActionSignatureKey);
    await prefs.remove(_lastActionTimeKey);
    await _notifications.cancel(id: _actionNotificationId);
  }
}
