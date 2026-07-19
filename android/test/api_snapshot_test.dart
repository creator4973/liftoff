import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:liftoff/api.dart';

void main() {
  test('getSnapshot reuses a matching server revision', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    late String? requestedRevision;
    server.listen((request) async {
      requestedRevision = request.headers.value('if-none-match');
      request.response.statusCode = HttpStatus.notModified;
      await request.response.close();
    });

    final api = ApiClient(
      ServerConfig(baseUrl: 'http://127.0.0.1:${server.port}'),
    );
    final result = await api.getSnapshot(revision: 'revision-1');

    expect(requestedRevision, '"revision-1"');
    expect(result.notModified, isTrue);
    expect(result.snapshot, isNull);

    api.close();
    await server.close(force: true);
  });

  test('getSnapshot preserves RPC cache metadata', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = ContentType.json
        ..headers.set(HttpHeaders.etagHeader, '"revision-2"')
        ..write(
          jsonEncode({
            'html': '<p>Complete RPC transcript</p>',
            'css': '',
            'conversationId': 'conversation-2',
            'source': 'language-server-rpc',
          }),
        );
      await request.response.close();
    });

    final api = ApiClient(
      ServerConfig(baseUrl: 'http://127.0.0.1:${server.port}'),
    );
    final result = await api.getSnapshot();

    expect(result.notModified, isFalse);
    expect(result.snapshot?.revision, 'revision-2');
    expect(result.snapshot?.conversationId, 'conversation-2');
    expect(result.snapshot?.source, 'language-server-rpc');

    api.close();
    await server.close(force: true);
  });

  test('getConversationImage downloads authenticated binary media', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    late String requestedPath;
    server.listen((request) async {
      requestedPath = request.uri.path;
      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = ContentType('image', 'png')
        ..add([1, 2, 3, 4]);
      await request.response.close();
    });

    final api = ApiClient(
      ServerConfig(baseUrl: 'http://127.0.0.1:${server.port}'),
    );
    final image = await api.getConversationImage(
      path: '/api/conversations/id/media/4/0',
      name: 'Image 1',
      mimeType: 'image/jpeg',
    );

    expect(requestedPath, '/api/conversations/id/media/4/0');
    expect(image.bytes, [1, 2, 3, 4]);
    expect(image.name, 'Image 1');
    expect(image.mimeType, 'image/png');

    api.close();
    await server.close(force: true);
  });

  test('newChat returns the RPC-created conversation id', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({'success': true, 'conversationId': 'new-id'}));
      await request.response.close();
    });
    final api = ApiClient(
      ServerConfig(baseUrl: 'http://127.0.0.1:${server.port}'),
    );

    expect(await api.newChat(), 'new-id');

    api.close();
    await server.close(force: true);
  });

  test('getConversationChanges loads structured per-file diffs', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = ContentType.json
        ..write(
          jsonEncode({
            'files': [
              {
                'name': 'app.dart',
                'path': 'lib/app.dart',
                'diff': '+new line',
                'additions': 1,
                'deletions': 0,
              },
            ],
          }),
        );
      await request.response.close();
    });
    final api = ApiClient(
      ServerConfig(baseUrl: 'http://127.0.0.1:${server.port}'),
    );

    final files = await api.getConversationChanges(
      '/api/conversations/id/changes/4',
    );

    expect(files.single.name, 'app.dart');
    expect(files.single.diff, '+new line');
    expect(files.single.additions, 1);

    api.close();
    await server.close(force: true);
  });
}
