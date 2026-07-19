import 'dart:io';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../api.dart';
import '../discovery.dart';
import 'home_screen.dart';

class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key});

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _urlController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _connecting = false;
  bool _discovering = false;
  String? _error;

  @override
  void dispose() {
    _urlController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    var url = _urlController.text.trim();
    if (url.isEmpty) {
      setState(() => _error = 'Enter the server address');
      return;
    }
    if (!url.startsWith('http')) url = 'https://$url';
    url = url.replaceAll(RegExp(r'/+$'), '');

    setState(() {
      _connecting = true;
      _error = null;
    });

    final config = ServerConfig(
      baseUrl: url,
      password: _passwordController.text.trim(),
    );
    final api = ApiClient(config);
    final problem = await api.probe();
    api.close();

    if (!mounted) return;
    if (problem != null) {
      setState(() {
        _connecting = false;
        _error = problem;
      });
      return;
    }

    await config.save();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => HomeScreen(config: config)),
    );
  }

  Future<void> _findOnWifi() async {
    if (_discovering || _connecting) return;
    setState(() {
      _discovering = true;
      _error = null;
    });
    try {
      final servers = await LanDiscovery.find();
      if (!mounted) return;
      if (servers.isEmpty) {
        setState(
          () => _error =
              'No bridge found. Check that both devices are on the same Wi-Fi.',
        );
        return;
      }

      DiscoveredServer? selected;
      if (servers.length == 1) {
        selected = servers.first;
      } else {
        selected = await showDialog<DiscoveredServer>(
          context: context,
          builder: (context) => SimpleDialog(
            title: const Text('Choose your computer'),
            children: [
              for (final server in servers)
                SimpleDialogOption(
                  onPressed: () => Navigator.of(context).pop(server),
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.computer_rounded),
                    title: Text(server.name),
                    subtitle: Text(server.url),
                  ),
                ),
            ],
          ),
        );
      }
      if (selected == null || !mounted) return;
      _urlController.text = selected.url;
      await _connect();
    } on SocketException catch (error) {
      if (mounted) {
        setState(() => _error = 'Wi-Fi discovery failed: ${error.message}');
      }
    } catch (error) {
      if (mounted) setState(() => _error = 'Wi-Fi discovery failed: $error');
    } finally {
      if (mounted) setState(() => _discovering = false);
    }
  }

  Future<void> _scanQr() async {
    if (_connecting) return;
    try {
      final value = await Navigator.of(context).push<String>(
        MaterialPageRoute(builder: (_) => const _QrScannerScreen()),
      );
      if (value == null || !mounted) return;
      final uri = Uri.tryParse(value);
      final url = uri?.queryParameters['url'] ?? '';
      final serverUri = Uri.tryParse(url);
      if (uri?.scheme != 'antigravity-remote' ||
          uri?.host != 'pair' ||
          serverUri == null ||
          !serverUri.hasAuthority ||
          (serverUri.scheme != 'http' && serverUri.scheme != 'https')) {
        setState(() => _error = 'That is not a LiftOff pairing code.');
        return;
      }
      _urlController.text = url.replaceAll(RegExp(r'/+$'), '');
      _passwordController.text = uri?.queryParameters['password'] ?? '';
      await _connect();
    } catch (error) {
      if (mounted) setState(() => _error = 'Could not scan QR code: $error');
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(
                    Icons.rocket_launch_rounded,
                    size: 64,
                    color: scheme.primary,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'LiftOff',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Connect to the bridge running on your computer.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 28),
                  Row(
                    children: [
                      Expanded(
                        child: FilledButton.tonalIcon(
                          onPressed: _discovering ? null : _findOnWifi,
                          icon: _discovering
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.wifi_find_rounded),
                          label: Text(
                            _discovering ? 'Finding...' : 'Find on Wi-Fi',
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _scanQr,
                          icon: const Icon(Icons.qr_code_scanner_rounded),
                          label: const Text('Scan QR'),
                        ),
                      ),
                    ],
                  ),
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 20),
                    child: Row(
                      children: [
                        Expanded(child: Divider()),
                        Padding(
                          padding: EdgeInsets.symmetric(horizontal: 12),
                          child: Text('or enter manually'),
                        ),
                        Expanded(child: Divider()),
                      ],
                    ),
                  ),
                  TextField(
                    controller: _urlController,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Server address',
                      hintText: 'https://100.x.x.x:4747',
                      border: OutlineInputBorder(),
                      prefixIcon: Icon(Icons.dns_rounded),
                    ),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _passwordController,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'Password (needed over Tailscale)',
                      border: OutlineInputBorder(),
                      prefixIcon: Icon(Icons.key_rounded),
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: TextStyle(color: scheme.error),
                    ),
                  ],
                  const SizedBox(height: 22),
                  FilledButton.icon(
                    onPressed: _connecting ? null : _connect,
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                    icon: _connecting
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.link_rounded),
                    label: Text(_connecting ? 'Connecting...' : 'Connect'),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'Wi-Fi discovery works on the same network. Away from home, '
                    'enter this PC\'s Tailscale 100.x address and password.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _QrScannerScreen extends StatefulWidget {
  const _QrScannerScreen();

  @override
  State<_QrScannerScreen> createState() => _QrScannerScreenState();
}

class _QrScannerScreenState extends State<_QrScannerScreen> {
  bool _handled = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan pairing code')),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            onDetect: (capture) {
              if (_handled) return;
              final value = capture.barcodes
                  .map((barcode) => barcode.rawValue)
                  .whereType<String>()
                  .firstOrNull;
              if (value == null) return;
              _handled = true;
              Navigator.of(context).pop(value);
            },
          ),
          IgnorePointer(
            child: Center(
              child: Container(
                width: 250,
                height: 250,
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.white, width: 3),
                  borderRadius: BorderRadius.circular(24),
                ),
              ),
            ),
          ),
          const Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              minimum: EdgeInsets.all(24),
              child: Text(
                'Scan the QR code printed by npm start on your computer.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
