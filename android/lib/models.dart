/// Data models mirroring the LiftOff bridge API.
library;

class Conversation {
  final String id;
  final String title;
  final String time;
  final bool active;

  const Conversation({
    required this.id,
    required this.title,
    this.time = '',
    this.active = false,
  });

  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
    id: (json['id'] ?? '') as String,
    title: (json['title'] ?? '') as String,
    time: (json['time'] ?? json['date'] ?? '') as String,
    active: (json['active'] ?? false) as bool,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title,
    'time': time,
    'active': active,
  };
}

class Project {
  final String title;
  final List<Conversation> conversations;

  const Project({required this.title, required this.conversations});

  factory Project.fromJson(Map<String, dynamic> json) => Project(
    title: (json['title'] ?? 'Untitled') as String,
    conversations: ((json['conversations'] ?? []) as List)
        .map((c) => Conversation.fromJson(c as Map<String, dynamic>))
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'title': title,
    'conversations': conversations.map((c) => c.toJson()).toList(),
  };
}

class QuickCommand {
  final String id;
  final String icon;
  final String label;
  final String prompt;

  const QuickCommand({
    required this.id,
    required this.icon,
    required this.label,
    required this.prompt,
  });

  factory QuickCommand.fromJson(Map<String, dynamic> json) => QuickCommand(
    id: (json['id'] ?? '') as String,
    icon: (json['icon'] ?? '•') as String,
    label: (json['label'] ?? '') as String,
    prompt: (json['prompt'] ?? '') as String,
  );
}

class PendingAction {
  final String message;
  final List<String> options;
  final String context;

  const PendingAction({
    required this.message,
    this.options = const [],
    this.context = '',
  });
}

class Snapshot {
  final String html;
  final String css;
  final String revision;
  final String conversationId;
  final String source;

  const Snapshot({
    required this.html,
    this.css = '',
    this.revision = '',
    this.conversationId = '',
    this.source = '',
  });

  factory Snapshot.fromJson(Map<String, dynamic> json) => Snapshot(
    html: (json['html'] ?? '') as String,
    css: (json['css'] ?? '') as String,
    revision: (json['revision'] ?? '') as String,
    conversationId: (json['conversationId'] ?? '') as String,
    source: (json['source'] ?? '') as String,
  );

  Map<String, dynamic> toJson() => {
    'html': html,
    'css': css,
    'revision': revision,
    'conversationId': conversationId,
    'source': source,
  };
}

class AppState {
  final String mode;
  final String model;

  const AppState({this.mode = 'Unknown', this.model = 'Unknown'});

  factory AppState.fromJson(Map<String, dynamic> json) => AppState(
    mode: (json['mode'] ?? 'Unknown') as String,
    model: (json['model'] ?? 'Unknown') as String,
  );
}
