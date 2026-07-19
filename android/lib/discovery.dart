import 'dart:async';
import 'dart:convert';
import 'dart:io';

const _discoveryPort = 4748;
const _discoveryMagic = 'ANTIGRAVITY_REMOTE_DISCOVER_V1';

class DiscoveredServer {
  final String name;
  final String url;
  final String version;

  const DiscoveredServer({
    required this.name,
    required this.url,
    this.version = '',
  });
}

class LanDiscovery {
  static Future<List<DiscoveredServer>> find({
    Duration timeout = const Duration(seconds: 3),
  }) async {
    final socket = await RawDatagramSocket.bind(
      InternetAddress.anyIPv4,
      0,
      reuseAddress: true,
    );
    final found = <String, DiscoveredServer>{};
    StreamSubscription<RawSocketEvent>? subscription;

    try {
      socket.broadcastEnabled = true;
      subscription = socket.listen((event) {
        if (event != RawSocketEvent.read) return;
        Datagram? datagram;
        while ((datagram = socket.receive()) != null) {
          try {
            final data = jsonDecode(utf8.decode(datagram!.data));
            if (data is! Map || data['service'] != 'antigravity-remote') {
              continue;
            }
            final url = data['url']?.toString() ?? '';
            final uri = Uri.tryParse(url);
            if (uri == null ||
                !uri.hasAuthority ||
                (uri.scheme != 'http' && uri.scheme != 'https')) {
              continue;
            }
            found[url] = DiscoveredServer(
              name: data['name']?.toString() ?? uri.host,
              url: url.replaceAll(RegExp(r'/+$'), ''),
              version: data['version']?.toString() ?? '',
            );
          } catch (_) {
            // Ignore unrelated or malformed LAN datagrams.
          }
        }
      });

      final query = utf8.encode(_discoveryMagic);
      void sendQuery() {
        socket.send(query, InternetAddress('255.255.255.255'), _discoveryPort);
      }

      sendQuery();
      await Future.delayed(const Duration(milliseconds: 450));
      sendQuery();
      final remaining = timeout - const Duration(milliseconds: 450);
      if (remaining > Duration.zero) await Future.delayed(remaining);
    } finally {
      await subscription?.cancel();
      socket.close();
    }

    final servers = found.values.toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return servers;
  }
}
