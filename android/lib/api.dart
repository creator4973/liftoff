/// REST + WebSocket client for the LiftOff bridge.
///
/// The bridge serves HTTPS with a self-signed certificate, so both the HTTP
/// client and the WebSocket use a custom [HttpClient] that accepts it for the
/// paired host only. Devices on the same LAN are exempt from auth server-side;
/// tunnel access uses the password -> signed-cookie flow.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/io.dart';

import 'models.dart';

class ServerConfig {
  final String baseUrl; // e.g. https://<bridge-ip>:4747
  final String password;

  const ServerConfig({required this.baseUrl, this.password = ''});

  Uri get uri => Uri.parse(baseUrl);

  static Future<ServerConfig?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final url = prefs.getString('server_url');
    if (url == null || url.isEmpty) return null;
    return ServerConfig(
      baseUrl: url,
      password: prefs.getString('server_password') ?? '',
    );
  }

  Future<void> save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('server_url', baseUrl);
    await prefs.setString('server_password', password);
  }

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('server_url');
    await prefs.remove('server_password');
  }
}

class ApiException implements Exception {
  final String message;
  final int? status;
  ApiException(this.message, [this.status]);
  @override
  String toString() => message;
}

class SnapshotFetchResult {
  final Snapshot? snapshot;
  final bool notModified;

  const SnapshotFetchResult({this.snapshot, this.notModified = false});
}

class ConversationImage {
  final Uint8List bytes;
  final String name;
  final String mimeType;

  const ConversationImage({
    required this.bytes,
    required this.name,
    required this.mimeType,
  });
}

class ConversationFileChange {
  final String name;
  final String path;
  final String diff;
  final int additions;
  final int deletions;

  const ConversationFileChange({
    required this.name,
    required this.path,
    required this.diff,
    this.additions = 0,
    this.deletions = 0,
  });

  factory ConversationFileChange.fromJson(Map<String, dynamic> json) =>
      ConversationFileChange(
        name: (json['name'] ?? 'Changed file').toString(),
        path: (json['path'] ?? '').toString(),
        diff: (json['diff'] ?? '').toString(),
        additions: (json['additions'] as num?)?.toInt() ?? 0,
        deletions: (json['deletions'] as num?)?.toInt() ?? 0,
      );
}

String friendlyError(Object error) {
  if (error is SocketException ||
      error is HandshakeException ||
      error is TimeoutException ||
      error is http.ClientException) {
    return 'LiftOff is offline. Start the desktop bridge and check that this '
        'phone is connected through your LAN or Tailscale.';
  }
  if (error is ApiException) return error.message;
  return 'Something went wrong. Please try again.';
}

class ApiClient {
  final ServerConfig config;
  late final HttpClient _rawClient;
  late final IOClient _client;
  String? _cookie;

  ApiClient(this.config) {
    _rawClient = HttpClient()
      ..connectionTimeout = const Duration(seconds: 8)
      ..badCertificateCallback = (cert, host, port) =>
          host == config.uri.host; // trust paired host only
    _client = IOClient(_rawClient);
  }

  HttpClient get rawClient => _rawClient;
  String? get cookie => _cookie;

  Map<String, String> _headers({bool json = false}) => {
    'Accept': 'application/json',
    'ngrok-skip-browser-warning': 'true',
    if (json) 'Content-Type': 'application/json',
    'Cookie': ?_cookie,
  };

  Uri _u(String path) => config.uri.replace(path: path);

  Future<Map<String, dynamic>> _get(String path) async {
    final res = await _client.get(_u(path), headers: _headers());
    return _decode(res);
  }

  Future<Map<String, dynamic>> _post(
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    final res = await _client.post(
      _u(path),
      headers: _headers(json: true),
      body: jsonEncode(body ?? {}),
    );
    return _decode(res);
  }

  Future<Map<String, dynamic>> _decode(http.Response res) async {
    if (res.statusCode == 401) {
      // Try password login once, then signal caller to retry
      final ok = await login();
      if (!ok) throw ApiException('Unauthorized — check the app password', 401);
      throw ApiException('Re-authenticated, retry', 401);
    }
    if (res.statusCode >= 500) {
      throw ApiException('Server error ${res.statusCode}', res.statusCode);
    }
    try {
      return jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException('Unexpected response (${res.statusCode})');
    }
  }

  /// Retries once after a transparent re-login on 401.
  Future<T> _withRetry<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } on ApiException catch (e) {
      if (e.status == 401 && _cookie != null) return await fn();
      rethrow;
    }
  }

  // ---- auth ----

  Future<bool> login() async {
    if (config.password.isEmpty) return false;
    final res = await _client.post(
      _u('/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'password': config.password}),
    );
    if (res.statusCode != 200) return false;
    final setCookie = res.headers['set-cookie'];
    if (setCookie != null) {
      _cookie = setCookie.split(';').first;
    }
    return true;
  }

  /// Cheap connectivity probe. Returns an error string, or null when OK.
  Future<String?> probe() async {
    try {
      final res = await _client.get(_u('/chat-status'), headers: _headers());
      if (res.statusCode == 401) {
        if (config.password.isEmpty) {
          return 'Server requires a password (are you connecting through a tunnel?)';
        }
        final ok = await login();
        return ok ? null : 'Wrong password';
      }
      if (res.statusCode == 200) return null;
      return 'Server answered with HTTP ${res.statusCode}';
    } on SocketException catch (error) {
      return friendlyError(error);
    } on HandshakeException catch (error) {
      return friendlyError(error);
    } on TimeoutException catch (error) {
      return friendlyError(error);
    } catch (e) {
      return friendlyError(e);
    }
  }

  // ---- chat ----

  Future<SnapshotFetchResult> getSnapshot({String revision = ''}) => _withRetry(
    () async {
      final headers = _headers();
      if (revision.isNotEmpty) headers['If-None-Match'] = '"$revision"';
      final res = await _client.get(_u('/snapshot'), headers: headers);
      if (res.statusCode == 304) {
        return const SnapshotFetchResult(notModified: true);
      }
      if (res.statusCode == 503) {
        return const SnapshotFetchResult(); // no chat open yet
      }
      final data = await _decode(res);
      final responseRevision = (data['revision'] ?? '').toString().isNotEmpty
          ? data['revision'].toString()
          : (res.headers['etag'] ?? '').replaceAll(RegExp(r'^(?:W/)?"|"$'), '');
      return SnapshotFetchResult(
        snapshot: Snapshot.fromJson({...data, 'revision': responseRevision}),
      );
    },
  );

  Future<List<Project>> getChatHistory() => _withRetry(() async {
    final data = await _get('/chat-history');
    return ((data['projects'] ?? []) as List)
        .map((p) => Project.fromJson(p as Map<String, dynamic>))
        .toList();
  });

  Future<void> selectChat(Conversation c) => _withRetry(() async {
    final data = await _post('/select-chat', {'title': c.title, 'id': c.id});
    if (data['success'] != true) {
      throw ApiException((data['error'] ?? 'Could not switch') as String);
    }
  });

  Future<String> newChat() => _withRetry(() async {
    final data = await _post('/new-chat');
    if (data['success'] != true) {
      throw ApiException((data['error'] ?? 'Could not start chat') as String);
    }
    return (data['conversationId'] ?? data['cascadeId'] ?? '').toString();
  });

  Future<void> send(String message) => _withRetry(() async {
    await _post('/send', {'message': message});
  });

  Future<void> stop() => _withRetry(() async {
    await _post('/stop');
  });

  Future<void> shutdownBridge() => _withRetry(() async {
    final res = await _client.post(
      _u('/api/desktop/stop'),
      headers: {..._headers(json: true), 'X-LiftOff-Password': config.password},
      body: '{}',
    );
    final data = await _decode(res);
    if (res.statusCode != 202 || data['success'] != true) {
      throw ApiException(
        (data['error'] ?? 'Could not stop the LiftOff bridge').toString(),
        res.statusCode,
      );
    }
  });

  /// Scrolls the desktop Antigravity window (0.0 = top, 1.0 = bottom) so the
  /// virtualized conversation loads content outside the current viewport.
  Future<void> remoteScroll(double percent) => _withRetry(() async {
    await _post('/remote-scroll', {'scrollPercent': percent});
  });

  Future<void> interactAction(String action, [String? selectedOption]) =>
      _withRetry(() async {
        final data = await _post('/api/interact-action', {
          'action': action,
          'selectedOption': selectedOption,
        });
        if (data['success'] != true) {
          throw ApiException((data['error'] ?? 'Action failed') as String);
        }
      });

  Future<AppState> getAppState() => _withRetry(() async {
    final data = await _get('/app-state');
    return AppState.fromJson(data);
  });

  Future<List<String>> getModels() => _withRetry(() async {
    final data = await _get('/api/models');
    if (data['success'] != true) {
      throw ApiException((data['error'] ?? 'Could not load models') as String);
    }
    return ((data['models'] ?? []) as List)
        .map((model) => model.toString())
        .where((model) => model.isNotEmpty)
        .toList();
  });

  Future<void> setModel(String model) => _withRetry(() async {
    final data = await _post('/set-model', {'model': model});
    if (data['success'] != true) {
      throw ApiException((data['error'] ?? 'Could not change model') as String);
    }
  });

  Future<void> uploadImage({
    required List<int> bytes,
    required String name,
    required String mimeType,
    String prompt = '',
  }) => _withRetry(() async {
    final data = await _post('/api/upload-image', {
      'data': base64Encode(bytes),
      'name': name,
      'mimeType': mimeType,
      'prompt': prompt,
      'inject': true,
    });
    if (data['success'] != true) {
      throw ApiException((data['error'] ?? 'Image upload failed') as String);
    }
    final injection = data['injection'];
    if (injection is Map && injection['ok'] == false) {
      throw ApiException(
        (injection['error'] ??
                injection['reason'] ??
                'Image was saved but not sent')
            .toString(),
      );
    }
  });

  Future<ConversationImage> getConversationImage({
    required String path,
    required String name,
    required String mimeType,
  }) => _withRetry(() async {
    final res = await _client.get(_u(path), headers: _headers());
    if (res.statusCode == 401) {
      await _decode(res);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      var message = 'Could not load the conversation image';
      try {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        message = (data['error'] ?? message).toString();
      } catch (_) {}
      throw ApiException(message, res.statusCode);
    }
    final responseMimeType =
        res.headers['content-type']?.split(';').first.trim() ?? '';
    return ConversationImage(
      bytes: res.bodyBytes,
      name: name,
      mimeType: responseMimeType.startsWith('image/')
          ? responseMimeType
          : mimeType,
    );
  });

  Future<List<ConversationFileChange>> getConversationChanges(String path) =>
      _withRetry(() async {
        final data = await _get(path);
        if (data['error'] != null) {
          throw ApiException(data['error'].toString());
        }
        return ((data['files'] ?? []) as List)
            .map(
              (file) =>
                  ConversationFileChange.fromJson(file as Map<String, dynamic>),
            )
            .toList(growable: false);
      });

  Future<List<QuickCommand>> getQuickCommands() => _withRetry(() async {
    final data = await _get('/api/quick-commands');
    return ((data['commands'] ?? []) as List)
        .map((c) => QuickCommand.fromJson(c as Map<String, dynamic>))
        .toList();
  });

  void close() {
    _client.close();
  }
}

/// WebSocket wrapper with automatic reconnect and a broadcast stream of
/// decoded JSON messages.
class WsClient {
  final ApiClient api;
  final _controller = StreamController<Map<String, dynamic>>.broadcast();
  final _statusController = StreamController<bool>.broadcast();
  IOWebSocketChannel? _channel;
  Timer? _reconnectTimer;
  bool _closed = false;
  bool _connecting = false;
  int _generation = 0;
  int _retryMs = 1500;

  WsClient(this.api);

  Stream<Map<String, dynamic>> get messages => _controller.stream;
  Stream<bool> get connected => _statusController.stream;

  Future<void> connect() async {
    if (_closed || _connecting || _channel != null) return;
    _connecting = true;
    final generation = ++_generation;
    final uri = api.config.uri;
    final wsUri = uri.replace(scheme: uri.scheme == 'https' ? 'wss' : 'ws');
    try {
      final socket = await WebSocket.connect(
        wsUri.toString(),
        customClient: api.rawClient,
        headers: {if (api.cookie != null) 'Cookie': api.cookie!},
      ).timeout(const Duration(seconds: 8));
      if (_closed || generation != _generation) {
        await socket.close();
        return;
      }
      socket.pingInterval = const Duration(seconds: 25);
      _channel = IOWebSocketChannel(socket);
      _reconnectTimer?.cancel();
      _reconnectTimer = null;
      _retryMs = 1500;
      _statusController.add(true);
      _channel!.stream.listen(
        (data) {
          try {
            final decoded = jsonDecode(data as String);
            if (decoded is Map<String, dynamic>) _controller.add(decoded);
          } catch (_) {}
        },
        onDone: () => _scheduleReconnect(generation),
        onError: (_) => _scheduleReconnect(generation),
      );
    } catch (_) {
      _scheduleReconnect(generation);
    } finally {
      if (generation == _generation) _connecting = false;
    }
  }

  void _scheduleReconnect(int generation) {
    if (_closed || generation != _generation) return;
    _channel = null;
    _statusController.add(false);
    if (_reconnectTimer?.isActive ?? false) return;
    _reconnectTimer = Timer(Duration(milliseconds: _retryMs), () {
      _reconnectTimer = null;
      unawaited(connect());
    });
    _retryMs = (_retryMs * 2).clamp(1500, 8000);
  }

  Future<void> reconnectNow() async {
    if (_closed) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _generation++;
    _connecting = false;
    final oldChannel = _channel;
    _channel = null;
    _statusController.add(false);
    await oldChannel?.sink.close();
    await connect();
  }

  void close() {
    _closed = true;
    _generation++;
    _reconnectTimer?.cancel();
    _channel?.sink.close();
    _controller.close();
    _statusController.close();
  }
}
