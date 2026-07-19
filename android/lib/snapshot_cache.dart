import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

typedef SnapshotCacheDirectoryProvider = Future<Directory> Function();

class SnapshotCache {
  static const _cacheDirectoryName = 'liftoff_transcripts_v2';
  static const _indexFileName = 'index.json';
  static const _legacyEntryPrefix = 'rpc_snapshot_v1_';
  static const _legacyIndexPrefix = 'rpc_snapshot_index_v1_';

  SnapshotCache({SnapshotCacheDirectoryProvider? directoryProvider})
    : _directoryProvider =
          directoryProvider ?? _defaultApplicationSupportDirectory;

  final SnapshotCacheDirectoryProvider _directoryProvider;
  Future<void> _writeTail = Future<void>.value();

  static Future<Directory> _defaultApplicationSupportDirectory() =>
      getApplicationSupportDirectory();

  String _token(String value) =>
      base64Url.encode(utf8.encode(value)).replaceAll('=', '');

  String _join(String left, String right) =>
      '$left${Platform.pathSeparator}$right';

  Future<Directory> _serverDirectory(String serverUrl) async {
    final root = await _directoryProvider();
    return Directory(
      _join(_join(root.path, _cacheDirectoryName), _token(serverUrl)),
    );
  }

  File _snapshotFile(Directory directory, String conversationId) =>
      File(_join(directory.path, '${_token(conversationId)}.json'));

  File _indexFile(Directory directory) =>
      File(_join(directory.path, _indexFileName));

  Future<List<String>> _readIndex(Directory directory) async {
    try {
      final decoded = jsonDecode(await _indexFile(directory).readAsString());
      return (decoded as List)
          .map((value) => value.toString())
          .where((value) => value.isNotEmpty)
          .toList(growable: false);
    } catch (_) {
      return const [];
    }
  }

  Future<Snapshot?> _readSnapshot(
    Directory directory,
    String conversationId,
  ) async {
    try {
      return _decode(
        await _snapshotFile(directory, conversationId).readAsString(),
        expectedConversationId: conversationId,
      );
    } catch (_) {
      return null;
    }
  }

  Future<Snapshot?> loadLatest(String serverUrl) async {
    await _writeTail;
    final directory = await _serverDirectory(serverUrl);
    for (final id in await _readIndex(directory)) {
      final snapshot = await _readSnapshot(directory, id);
      if (snapshot != null) return snapshot;
    }

    final legacy = await _loadLegacyLatest(serverUrl);
    if (legacy != null) await save(serverUrl, legacy);
    return legacy;
  }

  Future<Snapshot?> loadConversation(
    String serverUrl,
    String conversationId,
  ) async {
    await _writeTail;
    final directory = await _serverDirectory(serverUrl);
    final snapshot = await _readSnapshot(directory, conversationId);
    if (snapshot != null) return snapshot;

    final legacy = await _loadLegacyConversation(serverUrl, conversationId);
    if (legacy != null) await save(serverUrl, legacy);
    return legacy;
  }

  Future<void> save(String serverUrl, Snapshot snapshot) {
    if (snapshot.source != 'language-server-rpc' ||
        snapshot.conversationId.isEmpty ||
        snapshot.revision.isEmpty ||
        snapshot.html.isEmpty) {
      return Future<void>.value();
    }
    return _enqueue(() => _saveNow(serverUrl, snapshot));
  }

  Future<void> _saveNow(String serverUrl, Snapshot snapshot) async {
    final directory = await _serverDirectory(serverUrl);
    await directory.create(recursive: true);
    await _snapshotFile(
      directory,
      snapshot.conversationId,
    ).writeAsString(jsonEncode(snapshot.toJson()), flush: true);

    final current = await _readIndex(directory);
    final next = <String>[
      snapshot.conversationId,
      ...current.where((id) => id != snapshot.conversationId),
    ];
    await _indexFile(directory).writeAsString(jsonEncode(next), flush: true);
  }

  Future<int> sizeBytes(String serverUrl) async {
    await _writeTail;
    final directory = await _serverDirectory(serverUrl);
    if (!await directory.exists()) return 0;
    var total = 0;
    await for (final entity in directory.list(recursive: true)) {
      if (entity is File) total += await entity.length();
    }
    return total;
  }

  Future<void> _enqueue(Future<void> Function() action) {
    final completer = Completer<void>();
    _writeTail = _writeTail.then((_) async {
      try {
        await action();
        completer.complete();
      } catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  String _legacyEntryKey(String serverUrl, String conversationId) =>
      '$_legacyEntryPrefix${_token('$serverUrl|$conversationId')}';

  String _legacyIndexKey(String serverUrl) =>
      '$_legacyIndexPrefix${_token(serverUrl)}';

  Future<Snapshot?> _loadLegacyLatest(String serverUrl) async {
    final prefs = await SharedPreferences.getInstance();
    final ids = prefs.getStringList(_legacyIndexKey(serverUrl)) ?? const [];
    for (final id in ids) {
      final snapshot = _decode(
        prefs.getString(_legacyEntryKey(serverUrl, id)),
        expectedConversationId: id,
      );
      if (snapshot != null) return snapshot;
    }
    return null;
  }

  Future<Snapshot?> _loadLegacyConversation(
    String serverUrl,
    String conversationId,
  ) async {
    final prefs = await SharedPreferences.getInstance();
    return _decode(
      prefs.getString(_legacyEntryKey(serverUrl, conversationId)),
      expectedConversationId: conversationId,
    );
  }

  Snapshot? _decode(String? encoded, {required String expectedConversationId}) {
    if (encoded == null || encoded.isEmpty) return null;
    try {
      final snapshot = Snapshot.fromJson(
        jsonDecode(encoded) as Map<String, dynamic>,
      );
      if (snapshot.source != 'language-server-rpc' ||
          snapshot.conversationId != expectedConversationId ||
          snapshot.revision.isEmpty ||
          snapshot.html.isEmpty) {
        return null;
      }
      return snapshot;
    } catch (_) {
      return null;
    }
  }
}
