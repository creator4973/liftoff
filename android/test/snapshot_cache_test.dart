import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:liftoff/models.dart';
import 'package:liftoff/snapshot_cache.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  const serverUrl = 'https://198.51.100.1:4747';
  late Directory directory;
  late SnapshotCache cache;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    directory = await Directory.systemTemp.createTemp('liftoff-cache-test-');
    cache = SnapshotCache(directoryProvider: () async => directory);
  });

  tearDown(() async {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  });

  test('stores and restores the latest RPC conversation snapshot', () async {
    const snapshot = Snapshot(
      html: '<p>Hello from cache</p>',
      revision: 'revision-1',
      conversationId: 'conversation-1',
      source: 'language-server-rpc',
    );

    await cache.save(serverUrl, snapshot);

    expect((await cache.loadLatest(serverUrl))?.html, snapshot.html);
    expect(
      (await cache.loadConversation(
        serverUrl,
        snapshot.conversationId,
      ))?.revision,
      snapshot.revision,
    );
    expect(await cache.sizeBytes(serverUrl), greaterThan(snapshot.html.length));
  });

  test('does not persist viewport-based CDP snapshots', () async {
    await cache.save(
      serverUrl,
      const Snapshot(
        html: '<p>Partial viewport</p>',
        revision: 'revision-cdp',
        conversationId: 'conversation-cdp',
        source: 'cdp',
      ),
    );

    expect(await cache.loadLatest(serverUrl), isNull);
    expect(await cache.sizeBytes(serverUrl), 0);
  });

  test('retains every conversation that has been opened', () async {
    for (var index = 0; index < 20; index++) {
      await cache.save(
        serverUrl,
        Snapshot(
          html: '<p>Conversation $index</p>',
          revision: 'revision-$index',
          conversationId: 'conversation-$index',
          source: 'language-server-rpc',
        ),
      );
    }

    expect(
      (await cache.loadConversation(
        serverUrl,
        'conversation-0',
      ))?.conversationId,
      'conversation-0',
    );
    expect(
      (await cache.loadLatest(serverUrl))?.conversationId,
      'conversation-19',
    );
  });
}
