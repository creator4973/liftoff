import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:liftoff/api.dart';

void main() {
  test('shutdownBridge authenticates the fixed desktop stop route', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    late HttpRequest captured;
    server.listen((request) async {
      captured = request;
      await utf8.decoder.bind(request).join();
      request.response
        ..statusCode = HttpStatus.accepted
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({'success': true}));
      await request.response.close();
    });

    final api = ApiClient(
      ServerConfig(
        baseUrl: 'http://127.0.0.1:${server.port}',
        password: 'bridge-secret',
      ),
    );
    await api.shutdownBridge();

    expect(captured.method, 'POST');
    expect(captured.uri.path, '/api/desktop/stop');
    expect(captured.headers.value('x-liftoff-password'), 'bridge-secret');

    api.close();
    await server.close(force: true);
  });

  test('shutdownBridge preserves a tray-management error', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      await request.drain<void>();
      request.response
        ..statusCode = HttpStatus.conflict
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({'error': 'Bridge is not tray managed'}));
      await request.response.close();
    });

    final api = ApiClient(
      ServerConfig(baseUrl: 'http://127.0.0.1:${server.port}'),
    );

    await expectLater(
      api.shutdownBridge(),
      throwsA(
        isA<ApiException>()
            .having((error) => error.status, 'status', HttpStatus.conflict)
            .having(
              (error) => error.message,
              'message',
              'Bridge is not tray managed',
            ),
      ),
    );

    api.close();
    await server.close(force: true);
  });
}
