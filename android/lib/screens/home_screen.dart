import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_widget_from_html/flutter_widget_from_html.dart';
import 'package:image_picker/image_picker.dart' as picker;

import '../api.dart';
import '../app_theme.dart';
import '../background_notifications.dart';
import '../models.dart';
import '../project_cache.dart';
import '../snapshot_cache.dart';
import 'pairing_screen.dart';

final _svgPattern = RegExp(r'<svg[\s\S]*?</svg>', caseSensitive: false);
const _appControl = MethodChannel('liftoff/app_control');

/// The mirror HTML comes from Antigravity's DOM. Inline SVG icons render as
/// giant black shapes in the HTML widget, so drop them entirely.
String sanitizeSnapshotHtml(String html) => html.replaceAll(_svgPattern, '');

class _PendingImage {
  const _PendingImage({
    required this.bytes,
    required this.name,
    required this.mimeType,
  });

  final Uint8List bytes;
  final String name;
  final String mimeType;
}

enum _ConversationImageAction { open, reply }

class HomeScreen extends StatefulWidget {
  final ServerConfig config;

  const HomeScreen({super.key, required this.config});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  late final ApiClient _api;
  late final WsClient _ws;
  final _composer = TextEditingController();
  final _composerFocus = FocusNode();
  final _scroll = ScrollController();
  final _snapshotCache = SnapshotCache();
  final _projectCache = ProjectCache();

  StreamSubscription? _wsSub;
  StreamSubscription? _wsStatusSub;
  Timer? _snapshotDebounce;
  Timer? _recoveryPoll;
  Timer? _statePoll;
  Timer? _scrollSyncDebounce;
  bool _userDragging = false;
  bool _appIsActive = true;
  bool _snapshotLoading = false;
  bool _webSocketReady = false;
  bool _stickToBottom = true;
  bool _forceBottomOnNextSnapshot = false;
  double _lastSyncedPercent = 1.0;

  String _html = '';
  String _snapshotRevision = '';
  String _snapshotSource = '';
  String _conversationId = '';
  String? _connectionError;
  bool _hasChat = true;
  bool _wsConnected = false;
  bool _sending = false;
  AppState _appState = const AppState();
  List<QuickCommand> _quickCommands = [];
  List<Project> _projects = [];
  bool _projectsLoading = false;
  bool _actionDialogOpen = false;
  bool _modelsLoading = false;
  bool _uploading = false;
  bool _switchingConversation = false;
  bool _startingConversation = false;
  bool _waitingForReply = false;
  bool _intentionalExit = false;
  bool _exiting = false;
  String _agentStatus = '';
  _PendingImage? _pendingImage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _api = ApiClient(widget.config);
    _ws = WsClient(_api);
    unawaited(_bootstrap());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(BackgroundActionNotifications.requestPermission());
      unawaited(_resumeNotificationListener(reconnect: false));
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_intentionalExit) {
      _appIsActive = false;
      unawaited(BackgroundActionNotifications.shutdown());
      return;
    }
    switch (state) {
      case AppLifecycleState.resumed:
        _appIsActive = true;
        unawaited(_resumeNotificationListener());
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
        _appIsActive = false;
        unawaited(BackgroundActionNotifications.start());
      case AppLifecycleState.detached:
        _appIsActive = false;
        unawaited(BackgroundActionNotifications.shutdown());
      case AppLifecycleState.inactive:
        break;
    }
  }

  Future<void> _resumeNotificationListener({bool reconnect = true}) async {
    await BackgroundActionNotifications.stop();
    if (!mounted) return;
    if (reconnect && _webSocketReady) {
      await _ws.reconnectNow();
      unawaited(_refreshAll());
    }
    final action = await BackgroundActionNotifications.consumePendingAction();
    if (action != null && mounted) await _showActionDialog(action);
  }

  Future<void> _bootstrap() async {
    await Future.wait([_restoreCachedSnapshot(), _restoreCachedProjects()]);
    if (widget.config.password.isNotEmpty) {
      await _api.login();
    }
    _wsSub = _ws.messages.listen(_onWsMessage);
    _wsStatusSub = _ws.connected.listen((up) {
      if (mounted) setState(() => _wsConnected = up);
      if (up) _refreshAll();
    });
    _webSocketReady = true;
    unawaited(_ws.connect());
    unawaited(_refreshAll());
    _recoveryPoll = Timer.periodic(const Duration(seconds: 60), (_) {
      if (_appIsActive) unawaited(_loadSnapshot());
    });
    _statePoll = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!_appIsActive) return;
      unawaited(_loadAppState());
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _wsSub?.cancel();
    _wsStatusSub?.cancel();
    _snapshotDebounce?.cancel();
    _recoveryPoll?.cancel();
    _statePoll?.cancel();
    _scrollSyncDebounce?.cancel();
    _ws.close();
    _api.close();
    _composer.dispose();
    _composerFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  // ---- data loading ----

  Future<void> _refreshAll() async {
    await Future.wait([_loadSnapshot(), _loadAppState(), _loadQuickCommands()]);
  }

  Future<void> _restoreCachedSnapshot({String conversationId = ''}) async {
    final cached = conversationId.isEmpty
        ? await _snapshotCache.loadLatest(widget.config.baseUrl)
        : await _snapshotCache.loadConversation(
            widget.config.baseUrl,
            conversationId,
          );
    if (!mounted || cached == null) return;
    _applySnapshot(cached, forceBottom: true);
  }

  void _applySnapshot(Snapshot snapshot, {bool forceBottom = false}) {
    final sanitized = sanitizeSnapshotHtml(snapshot.html);
    final atBottom =
        !_scroll.hasClients ||
        _scroll.position.pixels > _scroll.position.maxScrollExtent - 160;
    final conversationChanged =
        snapshot.conversationId.isNotEmpty &&
        snapshot.conversationId != _conversationId;
    final shouldScrollToBottom =
        forceBottom ||
        conversationChanged ||
        _forceBottomOnNextSnapshot ||
        atBottom;

    if (sanitized != _html ||
        snapshot.revision != _snapshotRevision ||
        snapshot.source != _snapshotSource) {
      setState(() {
        _html = sanitized;
        _snapshotRevision = snapshot.revision;
        _snapshotSource = snapshot.source;
        if (snapshot.conversationId.isNotEmpty) {
          _conversationId = snapshot.conversationId;
        }
        _hasChat = true;
      });
    }
    if (shouldScrollToBottom) _scrollToBottom(force: true);
    _forceBottomOnNextSnapshot = false;
  }

  Future<void> _loadSnapshot({bool forceBottom = false}) async {
    if (_snapshotLoading) return;
    _snapshotLoading = true;
    try {
      final result = await _api.getSnapshot(revision: _snapshotRevision);
      if (!mounted) return;
      if (_connectionError != null) setState(() => _connectionError = null);
      if (result.notModified) {
        if (_html.isNotEmpty && !_hasChat) setState(() => _hasChat = true);
        return;
      }
      final snapshot = result.snapshot;
      if (snapshot == null) {
        if (_html.isEmpty && !_switchingConversation) {
          setState(() => _hasChat = false);
        }
        return;
      }
      _applySnapshot(snapshot, forceBottom: forceBottom);
      unawaited(_snapshotCache.save(widget.config.baseUrl, snapshot));
    } catch (error) {
      if (mounted) {
        final message = friendlyError(error);
        if (_connectionError != message) {
          setState(() => _connectionError = message);
        }
      }
    } finally {
      _snapshotLoading = false;
    }
  }

  Future<void> _loadAppState() async {
    try {
      final s = await _api.getAppState();
      if (mounted) setState(() => _appState = s);
    } catch (_) {}
  }

  Future<void> _loadQuickCommands() async {
    try {
      final commands = await _api.getQuickCommands();
      if (mounted) setState(() => _quickCommands = commands);
    } catch (_) {}
  }

  Future<void> _loadProjects() async {
    if (_projectsLoading) return;
    if (mounted) setState(() => _projectsLoading = true);
    try {
      final projects = await _api.getChatHistory();
      if (mounted) setState(() => _projects = projects);
      unawaited(_projectCache.save(widget.config.baseUrl, projects));
    } catch (e) {
      _toast(friendlyError(e), error: true);
    } finally {
      if (mounted) setState(() => _projectsLoading = false);
    }
  }

  Future<void> _restoreCachedProjects() async {
    final projects = await _projectCache.load(widget.config.baseUrl);
    if (mounted && projects.isNotEmpty && _projects.isEmpty) {
      setState(() => _projects = projects);
    }
  }

  void _scrollToBottom({bool force = false}) {
    if (!force && !_stickToBottom) return;
    _stickToBottom = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
    Future.delayed(const Duration(milliseconds: 180), () {
      if (!mounted || !_scroll.hasClients || !_stickToBottom) return;
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  // ---- websocket ----

  void _onWsMessage(Map<String, dynamic> data) {
    switch (data['type']) {
      case 'snapshot_update':
        _snapshotDebounce?.cancel();
        _snapshotDebounce = Timer(
          const Duration(milliseconds: 350),
          _loadSnapshot,
        );
        break;
      case 'agent_state':
        final status = (data['status'] ?? '').toString();
        final working =
            status == 'preparing' ||
            status == 'responding' ||
            status == 'permission_required';
        if (mounted) {
          setState(() {
            _agentStatus = status;
            _waitingForReply = working;
            if (status == 'complete') {
              _forceBottomOnNextSnapshot = true;
              _stickToBottom = true;
            }
          });
        }
        if (status == 'complete') {
          unawaited(_loadSnapshot(forceBottom: true));
        }
        break;
      case 'notification':
        if (data['event'] == 'action_required') {
          _showActionDialog(
            PendingAction(
              message: (data['message'] ?? 'Action required') as String,
              options: ((data['options'] ?? []) as List)
                  .map((o) => o.toString())
                  .toList(),
              context: (data['context'] ?? '') as String,
            ),
          );
        } else if (data['event'] == 'action_cleared') {
          unawaited(BackgroundActionNotifications.clearPendingAction());
        } else if (data['message'] is String) {
          _toast(
            data['message'] as String,
            error: (data['event'] ?? '').toString().contains('error'),
          );
        }
        break;
      case 'quick_commands_updated':
        _loadQuickCommands();
        break;
      default:
        break;
    }
  }

  // ---- actions ----

  Future<void> _send() async {
    final text = _composer.text.trim();
    final pendingImage = _pendingImage;
    if ((text.isEmpty && pendingImage == null) ||
        _sending ||
        _startingConversation) {
      return;
    }
    setState(() {
      _sending = true;
      _waitingForReply = true;
      _agentStatus = 'preparing';
      _stickToBottom = true;
    });
    try {
      if (!_hasChat) {
        final conversationId = await _api.newChat();
        if (conversationId.isNotEmpty && mounted) {
          setState(() => _conversationId = conversationId);
        }
        await Future.delayed(const Duration(milliseconds: 800));
      }
      if (pendingImage != null) {
        await _api.uploadImage(
          bytes: pendingImage.bytes,
          name: pendingImage.name,
          mimeType: pendingImage.mimeType,
          prompt: text,
        );
      } else {
        await _api.send(text);
      }
      _composer.clear();
      if (mounted) setState(() => _pendingImage = null);
      _scrollToBottom(force: true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _waitingForReply = false;
          _agentStatus = '';
        });
      }
      _toast(friendlyError(e), error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _newChat() async {
    if (_startingConversation) return;
    setState(() => _startingConversation = true);
    try {
      final conversationId = await _api.newChat();
      if (!mounted) return;
      setState(() {
        _conversationId = conversationId;
        _html = '';
        _snapshotRevision = '';
        _snapshotSource = 'language-server-rpc';
        _hasChat = true;
        _stickToBottom = true;
      });
      _toast('New conversation started');
      unawaited(_loadProjects());
      await Future.delayed(const Duration(milliseconds: 300));
      await _loadSnapshot(forceBottom: true);
    } catch (e) {
      _toast(friendlyError(e), error: true);
    } finally {
      if (mounted) setState(() => _startingConversation = false);
    }
  }

  Future<void> _stopAgent() async {
    try {
      await _api.stop();
      _toast('Stop signal sent');
    } catch (e) {
      _toast(friendlyError(e), error: true);
    }
  }

  Future<void> _showModelPicker() async {
    if (_modelsLoading) return;
    setState(() => _modelsLoading = true);
    try {
      final models = await _api.getModels();
      if (!mounted) return;
      final selected = await showModalBottomSheet<String>(
        context: context,
        showDragHandle: true,
        builder: (context) => SafeArea(
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.only(bottom: 12),
            children: [
              const ListTile(
                title: Text(
                  'Select model',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                subtitle: Text('Models currently available in Antigravity'),
              ),
              for (final model in models)
                ListTile(
                  title: Text(model),
                  trailing: model == _appState.model
                      ? const Icon(Icons.check_rounded)
                      : null,
                  onTap: () => Navigator.of(context).pop(model),
                ),
            ],
          ),
        ),
      );
      if (selected == null || selected == _appState.model) return;
      await _api.setModel(selected);
      if (!mounted) return;
      setState(
        () => _appState = AppState(mode: _appState.mode, model: selected),
      );
      _toast('Model changed to $selected');
      Future.delayed(const Duration(milliseconds: 500), _loadAppState);
    } catch (e) {
      _toast(friendlyError(e), error: true);
    } finally {
      if (mounted) setState(() => _modelsLoading = false);
    }
  }

  Future<void> _showThemePicker() async {
    final selected = await showModalBottomSheet<AppThemeStyle>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const ListTile(
              title: Text(
                'Choose theme',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              subtitle: Text('Theme changes are saved on this phone.'),
            ),
            ListTile(
              leading: const Icon(Icons.auto_awesome_outlined),
              title: const Text('Antigravity'),
              subtitle: const Text('Original violet dark theme'),
              trailing:
                  AppThemeController.style.value == AppThemeStyle.antigravity
                  ? const Icon(Icons.check_rounded)
                  : null,
              onTap: () => Navigator.of(context).pop(AppThemeStyle.antigravity),
            ),
            ListTile(
              leading: const Icon(Icons.terminal_rounded),
              title: const Text('Hermes terminal'),
              subtitle: const Text('Warm yellow, black and monospace'),
              trailing: AppThemeController.style.value == AppThemeStyle.hermes
                  ? const Icon(Icons.check_rounded)
                  : null,
              onTap: () => Navigator.of(context).pop(AppThemeStyle.hermes),
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
    if (selected != null) {
      await AppThemeController.setStyle(selected);
      if (mounted) setState(() {});
    }
  }

  Future<void> _pickAndUploadImage() async {
    if (_uploading || _sending) return;
    final image = await picker.ImagePicker().pickImage(
      source: picker.ImageSource.gallery,
      maxWidth: 2048,
      imageQuality: 85,
    );
    if (image == null || !mounted) return;

    setState(() => _uploading = true);
    try {
      final bytes = await image.readAsBytes();
      if (!mounted) return;
      setState(() {
        _pendingImage = _PendingImage(
          bytes: bytes,
          name: image.name,
          mimeType: _imageMimeType(image.name),
        );
      });
    } catch (e) {
      _toast(friendlyError(e), error: true);
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  static String _imageMimeType(String name) {
    final lower = name.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }

  Future<void> _showConversationImageActions({
    required String name,
    required String mimeType,
    String path = '',
    ConversationImage? loadedImage,
  }) async {
    final action = await showModalBottomSheet<_ConversationImageAction>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.open_in_full_rounded),
              title: const Text('Open'),
              subtitle: const Text('View and zoom the full-size image'),
              onTap: () =>
                  Navigator.of(context).pop(_ConversationImageAction.open),
            ),
            ListTile(
              leading: const Icon(Icons.reply_rounded),
              title: const Text('Reply with image'),
              subtitle: const Text('Attach this image to your next message'),
              onTap: () =>
                  Navigator.of(context).pop(_ConversationImageAction.reply),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;

    ConversationImage image;
    try {
      _toast('Loading full-size image...');
      image =
          loadedImage ??
          await _api.getConversationImage(
            path: path,
            name: name,
            mimeType: mimeType,
          );
    } catch (error) {
      _toast(friendlyError(error), error: true);
      return;
    }
    if (!mounted) return;

    if (action == _ConversationImageAction.open) {
      await _openConversationImage(image);
      return;
    }
    setState(() {
      _pendingImage = _PendingImage(
        bytes: image.bytes,
        name: image.name,
        mimeType: image.mimeType,
      );
    });
    _composerFocus.requestFocus();
    _scrollToBottom(force: true);
  }

  Future<void> _openConversationImage(ConversationImage image) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (context) => Scaffold(
          backgroundColor: Colors.black,
          appBar: AppBar(
            backgroundColor: Colors.black,
            foregroundColor: Colors.white,
            title: Text(
              image.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          body: SafeArea(
            child: InteractiveViewer(
              minScale: 0.5,
              maxScale: 6,
              boundaryMargin: const EdgeInsets.all(80),
              child: Center(
                child: Image.memory(
                  image.bytes,
                  fit: BoxFit.contain,
                  gaplessPlayback: true,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _showConversationChanges(String path) async {
    List<ConversationFileChange> files;
    try {
      _toast('Loading file changes...');
      files = await _api.getConversationChanges(path);
    } catch (error) {
      _toast(friendlyError(error), error: true);
      return;
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.72,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                child: Text(
                  '${files.length} ${files.length == 1 ? 'file' : 'files'} changed',
                  style: Theme.of(
                    sheetContext,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                ),
              ),
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: files.length,
                  separatorBuilder: (_, index) => const Divider(height: 1),
                  itemBuilder: (_, index) {
                    final file = files[index];
                    return ListTile(
                      leading: const Icon(Icons.difference_outlined),
                      title: Text(file.name),
                      subtitle: Text(
                        [
                          if (file.path.isNotEmpty) file.path,
                          '+${file.additions}  -${file.deletions}',
                        ].join('\n'),
                      ),
                      trailing: const Icon(Icons.chevron_right_rounded),
                      onTap: () {
                        Navigator.of(sheetContext).pop();
                        unawaited(_openConversationDiff(file));
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _openConversationDiff(ConversationFileChange file) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (context) => Scaffold(
          appBar: AppBar(
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(file.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                Text(
                  '+${file.additions}  -${file.deletions}',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ],
            ),
          ),
          body: SafeArea(
            child: SelectionArea(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(14),
                child: Text(
                  file.diff,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12.5,
                    height: 1.4,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _handleHtmlImageTap(ImageMetadata metadata) {
    if (metadata.sources.isEmpty) return;
    final source = metadata.sources.first.url;
    final name = metadata.alt?.trim().isNotEmpty == true
        ? metadata.alt!.trim()
        : 'conversation-image';
    final dataMatch = RegExp(
      r'^data:(image/[^;]+);base64,(.+)$',
      caseSensitive: false,
    ).firstMatch(source);
    if (dataMatch != null) {
      try {
        final image = ConversationImage(
          bytes: base64Decode(dataMatch.group(2)!),
          name: name,
          mimeType: dataMatch.group(1)!,
        );
        unawaited(
          _showConversationImageActions(
            name: name,
            mimeType: image.mimeType,
            loadedImage: image,
          ),
        );
      } catch (_) {
        _toast('This conversation image could not be opened', error: true);
      }
      return;
    }
    final uri = Uri.tryParse(source);
    if (uri != null && uri.path.startsWith('/')) {
      unawaited(
        _showConversationImageActions(
          name: name,
          mimeType: 'image/png',
          path: uri.path,
        ),
      );
    }
  }

  Future<void> _openConversation(Conversation c) async {
    Navigator.of(context).pop(); // close drawer
    setState(() {
      _switchingConversation = true;
      _html = '';
      _conversationId = c.id;
      _snapshotRevision = '';
      _snapshotSource = '';
      _hasChat = true;
    });
    try {
      await _restoreCachedSnapshot(conversationId: c.id);
      await _api.selectChat(c);
      _toast('Opening "${c.title}"');
      await _loadSnapshot(forceBottom: true);
      for (final delay in const [250, 600]) {
        if (_html.trim().isNotEmpty) break;
        await Future.delayed(Duration(milliseconds: delay));
        await _loadSnapshot(forceBottom: true);
      }
      if (_snapshotSource != 'language-server-rpc') {
        await _api.remoteScroll(1.0);
        _lastSyncedPercent = 1.0;
        await Future.delayed(const Duration(milliseconds: 350));
        await _loadSnapshot(forceBottom: true);
      }
      _scrollToBottom(force: true);
    } catch (e) {
      _toast(friendlyError(e), error: true);
    } finally {
      if (mounted) setState(() => _switchingConversation = false);
    }
  }

  Future<void> _switchServer() async {
    await BackgroundActionNotifications.stop();
    await ServerConfig.clear();
    if (!mounted) return;
    Navigator.of(
      context,
    ).pushReplacement(MaterialPageRoute(builder: (_) => const PairingScreen()));
  }

  Future<void> _exitLiftOff({required bool stopBridge}) async {
    if (_exiting || !mounted) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(stopBridge ? 'Shut down LiftOff?' : 'Exit LiftOff?'),
        content: Text(
          stopBridge
              ? 'This will stop the Windows bridge, disconnect every phone, '
                    'remove the ongoing notification, and close this app.'
              : 'This will disconnect this phone, remove the ongoing '
                    'notification, and close the app. The Windows bridge will '
                    'keep running.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(stopBridge ? 'Shut down' : 'Exit'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    _exiting = true;
    if (stopBridge) {
      try {
        await _api.shutdownBridge();
      } catch (error) {
        _exiting = false;
        _toast(friendlyError(error), error: true);
        return;
      }
    }

    _intentionalExit = true;
    await BackgroundActionNotifications.shutdown();
    try {
      await _appControl.invokeMethod<void>('exitApp');
    } on MissingPluginException {
      await SystemNavigator.pop();
    }
  }

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: error
            ? Theme.of(context).colorScheme.errorContainer
            : null,
      ),
    );
  }

  // ---- permission dialog ----

  Future<void> _showActionDialog(PendingAction action) async {
    if (_actionDialogOpen || !mounted) return;
    _actionDialogOpen = true;
    String? selected = action.options.isNotEmpty ? action.options.first : null;

    try {
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (context) => StatefulBuilder(
          builder: (context, setDialogState) => AlertDialog(
            title: const Text('Action Required'),
            content: SizedBox(
              width: double.maxFinite,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(action.message),
                    if (action.context.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.35),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          action.context,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 8),
                    RadioGroup<String>(
                      groupValue: selected,
                      onChanged: (v) => setDialogState(() => selected = v),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: action.options
                            .map(
                              (opt) => RadioListTile<String>(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                title: Text(
                                  opt,
                                  style: const TextStyle(fontSize: 14),
                                ),
                                value: opt,
                              ),
                            )
                            .toList(),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(
                style: TextButton.styleFrom(
                  foregroundColor: Theme.of(context).colorScheme.error,
                ),
                onPressed: () async {
                  Navigator.of(context).pop();
                  try {
                    await _api.interactAction('reject');
                    await BackgroundActionNotifications.clearPendingAction();
                    _toast('Rejected');
                  } catch (e) {
                    _toast(friendlyError(e), error: true);
                  }
                },
                child: const Text('Reject'),
              ),
              FilledButton(
                onPressed: () async {
                  Navigator.of(context).pop();
                  try {
                    await _api.interactAction('accept', selected);
                    await BackgroundActionNotifications.clearPendingAction();
                    _toast('Approved');
                  } catch (e) {
                    _toast(friendlyError(e), error: true);
                  }
                },
                child: const Text('Submit'),
              ),
            ],
          ),
        ),
      );
    } finally {
      _actionDialogOpen = false;
    }
  }

  // ---- UI ----

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(
          children: [
            const SizedBox(width: 4),
            Icon(
              Icons.circle,
              size: 10,
              color: _wsConnected ? Colors.greenAccent : scheme.error,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Antigravity',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                  ),
                  Text(
                    '${_appState.mode} · ${_appState.model}',
                    style: TextStyle(
                      fontSize: 12,
                      color: scheme.onSurfaceVariant,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Change model',
            icon: _modelsLoading
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.model_training_rounded),
            onPressed: _modelsLoading ? null : _showModelPicker,
          ),
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _refreshAll,
          ),
          PopupMenuButton<String>(
            onSelected: (v) {
              switch (v) {
                case 'new':
                  _newChat();
                case 'stop':
                  _stopAgent();
                case 'theme':
                  _showThemePicker();
                case 'server':
                  _switchServer();
                case 'exit':
                  unawaited(_exitLiftOff(stopBridge: false));
                case 'shutdown':
                  unawaited(_exitLiftOff(stopBridge: true));
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'new', child: Text('New conversation')),
              PopupMenuItem(value: 'stop', child: Text('Stop agent')),
              PopupMenuItem(value: 'theme', child: Text('Theme')),
              PopupMenuDivider(),
              PopupMenuItem(value: 'exit', child: Text('Exit LiftOff')),
              PopupMenuItem(
                value: 'shutdown',
                child: Text('Shut down bridge & exit'),
              ),
              PopupMenuItem(value: 'server', child: Text('Switch server…')),
            ],
          ),
        ],
      ),
      drawer: _buildDrawer(scheme),
      onDrawerChanged: (open) {
        if (open) _loadProjects();
      },
      body: SafeArea(
        child: Column(
          children: [
            if (_connectionError != null && _html.isNotEmpty)
              _buildConnectionBanner(scheme),
            if (_startingConversation) _buildStartingConversationStatus(scheme),
            Expanded(child: _buildChatView(scheme)),
            if (_quickCommands.isNotEmpty) _buildQuickCommands(),
            if (_waitingForReply) _buildAgentStatus(scheme),
            _buildComposer(scheme),
          ],
        ),
      ),
    );
  }

  Widget _buildChatView(ColorScheme scheme) {
    if (_switchingConversation && _html.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_connectionError != null && _html.isEmpty) {
      return _buildOfflineState(scheme);
    }
    if (!_hasChat && _html.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.forum_outlined,
              size: 56,
              color: scheme.onSurfaceVariant,
            ),
            const SizedBox(height: 12),
            const Text('No conversation open'),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _startingConversation ? null : _newChat,
              icon: const Icon(Icons.add_rounded),
              label: const Text('Start new chat'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () => Scaffold.of(context).openDrawer(),
              icon: const Icon(Icons.folder_outlined),
              label: const Text('Projects & conversations'),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refreshAll,
      child: NotificationListener<ScrollNotification>(
        onNotification: _onScrollNotification,
        child: SingleChildScrollView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
          child: SelectionArea(
            child: HtmlWidget(
              _html,
              key: ValueKey(
                '${AppThemeController.style.value}:$_snapshotRevision',
              ),
              enableCaching: true,
              textStyle: const TextStyle(fontSize: 14.5, height: 1.45),
              customStylesBuilder: (element) =>
                  _snapshotStyles(element, scheme),
              customWidgetBuilder: (element) =>
                  _buildSnapshotWidget(element, scheme),
              onTapImage: _handleHtmlImageTap,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildConnectionBanner(ColorScheme scheme) {
    return Material(
      color: scheme.errorContainer,
      child: InkWell(
        onTap: _retryConnection,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(
            children: [
              Icon(
                Icons.cloud_off_outlined,
                size: 19,
                color: scheme.onErrorContainer,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Connection lost. Showing the last received conversation.',
                  style: TextStyle(
                    color: scheme.onErrorContainer,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                'Retry',
                style: TextStyle(
                  color: scheme.onErrorContainer,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildOfflineState(ColorScheme scheme) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(28),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 78,
                height: 78,
                decoration: BoxDecoration(
                  color: scheme.errorContainer,
                  borderRadius: BorderRadius.circular(24),
                ),
                child: Icon(
                  Icons.cloud_off_rounded,
                  size: 38,
                  color: scheme.onErrorContainer,
                ),
              ),
              const SizedBox(height: 22),
              Text(
                'LiftOff is offline',
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                _connectionError ??
                    'Start the desktop server, then reconnect through your LAN or Tailscale.',
                textAlign: TextAlign.center,
                style: TextStyle(color: scheme.onSurfaceVariant, height: 1.45),
              ),
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: _retryConnection,
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Try again'),
              ),
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: _switchServer,
                icon: const Icon(Icons.dns_outlined),
                label: const Text('Switch server'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _retryConnection() {
    if (mounted) setState(() => _connectionError = null);
    unawaited(_ws.reconnectNow());
    unawaited(_refreshAll());
  }

  /// Carry over the styles that matter for readability and distinguish each
  /// speaker without changing Antigravity's source DOM.
  Map<String, String>? _snapshotStyles(dynamic element, ColorScheme scheme) {
    final cls = element.className as String? ?? '';
    final attributes = element.attributes;
    final role = attributes['data-liftoff-role']?.toString();
    final speaker = attributes['data-liftoff-speaker']?.toString();
    final isHermes = AppThemeController.style.value == AppThemeStyle.hermes;
    if (speaker != null) {
      final color = speaker == 'user'
          ? scheme.primary
          : speaker == 'context'
          ? scheme.tertiary
          : scheme.secondary;
      return {
        'color': _cssColor(color),
        'font-size': '11px',
        'font-weight': '800',
        'letter-spacing': '0.08em',
        'text-transform': 'uppercase',
        'margin-bottom': '6px',
      };
    }
    if (role == 'user') {
      return {
        'background-color': isHermes
            ? '#17150a'
            : _cssColor(scheme.primaryContainer),
        'color': isHermes ? '#f3efcf' : _cssColor(scheme.onPrimaryContainer),
        'border': isHermes ? '1px solid #4a4522' : 'none',
        'border-left': isHermes
            ? '3px solid #cbb94c'
            : '3px solid ${_cssColor(scheme.primary)}',
        'border-radius': '12px',
        'padding': '10px 12px',
        'margin': '8px 0 14px',
      };
    }
    if (role == 'assistant') {
      return {
        'background-color': isHermes
            ? '#0f0e08'
            : _cssColor(scheme.surfaceContainer),
        'color': isHermes ? '#ded9b8' : _cssColor(scheme.onSurface),
        'border-left': '3px solid ${_cssColor(scheme.secondary)}',
        'border-radius': '12px',
        'padding': '10px 12px',
        'margin': '8px 0 14px',
      };
    }
    if (role == 'context') {
      return {
        'background-color': _cssColor(scheme.surfaceContainerLow),
        'color': _cssColor(scheme.onSurfaceVariant),
        'border-left': '3px solid ${_cssColor(scheme.tertiary)}',
        'border-radius': '12px',
        'padding': '10px 12px',
        'margin': '8px 0 14px',
      };
    }
    if (role == 'activity') {
      return {'margin': '8px 0 14px'};
    }
    if (cls.contains('green')) return {'color': '#4ade80'};
    if (cls.contains('red') || cls.contains('destructive')) {
      return {'color': '#f87171'};
    }
    if (cls.contains('font-mono')) return {'font-family': 'monospace'};
    if (cls.contains('text-muted') || cls.contains('opacity-')) {
      return {'color': '#9aa0ae'};
    }
    return null;
  }

  Widget? _buildSnapshotWidget(dynamic element, ColorScheme scheme) {
    final attributes = element.attributes;
    final changesPath =
        attributes['data-liftoff-changes-path']?.toString() ?? '';
    if (changesPath.isNotEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Material(
          color: scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () => _showConversationChanges(changesPath),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              child: Row(
                children: [
                  Icon(Icons.difference_outlined, color: scheme.primary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      element.text.trim(),
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                  Icon(
                    Icons.chevron_right_rounded,
                    color: scheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }
    final path = attributes['data-liftoff-media-path']?.toString() ?? '';
    if (path.isEmpty) return null;
    final name =
        attributes['data-liftoff-media-name']?.toString() ?? 'Image attachment';
    final mimeType =
        attributes['data-liftoff-media-mime']?.toString() ?? 'image/png';
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Material(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => _showConversationImageActions(
            name: name,
            mimeType: mimeType,
            path: path,
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
            child: Row(
              children: [
                Icon(Icons.image_outlined, color: scheme.primary),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    name,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                Icon(
                  Icons.open_in_new_rounded,
                  size: 18,
                  color: scheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildAgentStatus(ColorScheme scheme) {
    final message = switch (_agentStatus) {
      'responding' => 'Antigravity is preparing the final answer...',
      'permission_required' => 'Antigravity needs your approval to continue.',
      _ => 'Antigravity is preparing an answer...',
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: scheme.secondary,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStartingConversationStatus(ColorScheme scheme) {
    return Material(
      color: scheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(
          children: [
            SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2.2,
                color: scheme.onSecondaryContainer,
              ),
            ),
            const SizedBox(width: 10),
            Text(
              'Starting a new conversation...',
              style: TextStyle(
                color: scheme.onSecondaryContainer,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _cssColor(Color color) =>
      '#${(color.toARGB32() & 0xffffff).toRadixString(16).padLeft(6, '0')}';

  /// RPC snapshots contain every available semantic turn plus Antigravity's
  /// retained compacted context, so scrolling remains entirely local. Only
  /// viewport-based CDP fallback snapshots mirror back to the desktop.
  bool _onScrollNotification(ScrollNotification n) {
    if (n.metrics.axis == Axis.vertical) {
      _stickToBottom = n.metrics.extentAfter < 160;
    }
    if (n is UserScrollNotification && n.direction != ScrollDirection.idle) {
      _userDragging = true;
    } else if (n is ScrollEndNotification && _userDragging) {
      _userDragging = false;
      if (_snapshotSource == 'language-server-rpc') {
        _scrollSyncDebounce?.cancel();
        return false;
      }
      _scrollSyncDebounce?.cancel();
      _scrollSyncDebounce = Timer(
        const Duration(milliseconds: 250),
        _syncScrollToDesktop,
      );
    }
    return false;
  }

  Future<void> _syncScrollToDesktop() async {
    if (_snapshotSource == 'language-server-rpc' || !_scroll.hasClients) return;
    final max = _scroll.position.maxScrollExtent;
    final percent = max <= 0
        ? 1.0
        : (_scroll.position.pixels / max).clamp(0.0, 1.0);
    if ((percent - _lastSyncedPercent).abs() < 0.02) return;
    _lastSyncedPercent = percent;
    try {
      await _api.remoteScroll(percent);
      Future.delayed(const Duration(milliseconds: 350), _loadSnapshot);
    } catch (_) {}
  }

  Widget _buildQuickCommands() {
    return SizedBox(
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: _quickCommands.length,
        separatorBuilder: (_, index) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final cmd = _quickCommands[i];
          return ActionChip(
            avatar: Text(cmd.icon, style: const TextStyle(fontSize: 14)),
            label: Text(
              cmd.label.isEmpty ? cmd.prompt : cmd.label,
              overflow: TextOverflow.ellipsis,
            ),
            onPressed: () {
              _composer.text = cmd.prompt;
              _composer.selection = TextSelection.fromPosition(
                TextPosition(offset: _composer.text.length),
              );
            },
          );
        },
      ),
    );
  }

  Widget _buildComposer(ColorScheme scheme) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_pendingImage != null) ...[
            _buildPendingImage(scheme, _pendingImage!),
            const SizedBox(height: 8),
          ],
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: _composer,
                  focusNode: _composerFocus,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: 'Message Antigravity…',
                    filled: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 12,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filledTonal(
                tooltip: 'Upload image',
                onPressed: _uploading || _startingConversation
                    ? null
                    : _pickAndUploadImage,
                icon: _uploading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.image_outlined),
              ),
              const SizedBox(width: 4),
              IconButton.filledTonal(
                tooltip: 'Stop agent',
                onPressed: _stopAgent,
                icon: const Icon(Icons.stop_rounded),
              ),
              const SizedBox(width: 4),
              IconButton.filled(
                tooltip: 'Send',
                onPressed: _sending || _startingConversation ? null : _send,
                icon: _sending
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.arrow_upward_rounded),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildPendingImage(ColorScheme scheme, _PendingImage image) {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.memory(
              image.bytes,
              width: 52,
              height: 52,
              fit: BoxFit.cover,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  image.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 3),
                Text(
                  'Ready to send with your message',
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Remove image',
            onPressed: _sending
                ? null
                : () => setState(() => _pendingImage = null),
            icon: const Icon(Icons.close_rounded),
          ),
        ],
      ),
    );
  }

  Widget _buildDrawer(ColorScheme scheme) {
    return Drawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Row(
                children: [
                  Icon(Icons.folder_copy_outlined, color: scheme.primary),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'Projects & Conversations',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Reload',
                    icon: _projectsLoading
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh_rounded, size: 20),
                    onPressed: _projectsLoading ? null : _loadProjects,
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: _projectsLoading && _projects.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : _projects.isEmpty
                  ? Center(
                      child: Text(
                        'No conversations found',
                        style: TextStyle(color: scheme.onSurfaceVariant),
                      ),
                    )
                  : ListView(
                      padding: const EdgeInsets.only(bottom: 24),
                      children: _projects
                          .map((p) => _buildProjectTile(p, scheme))
                          .toList(),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildProjectTile(Project project, ColorScheme scheme) {
    return ExpansionTile(
      initiallyExpanded:
          project.conversations.any((c) => c.active) || _projects.length <= 3,
      leading: const Icon(Icons.folder_outlined, size: 20),
      title: Text(
        project.title,
        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
      ),
      trailing: Text(
        '${project.conversations.length}',
        style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12),
      ),
      childrenPadding: const EdgeInsets.only(left: 12),
      children: project.conversations.isEmpty
          ? [
              ListTile(
                dense: true,
                title: Text(
                  'No conversations',
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 13,
                  ),
                ),
              ),
            ]
          : project.conversations
                .map(
                  (c) => ListTile(
                    dense: true,
                    selected: c.active,
                    leading: Icon(
                      c.active
                          ? Icons.chat_bubble_rounded
                          : Icons.chat_bubble_outline_rounded,
                      size: 18,
                    ),
                    title: Text(
                      c.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: c.time.isEmpty ? null : Text(c.time),
                    onTap: c.active ? null : () => _openConversation(c),
                  ),
                )
                .toList(),
    );
  }
}
