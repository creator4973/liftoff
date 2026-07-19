import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

class ProjectCache {
  static const _prefix = 'liftoff_project_list_v1_';

  String _key(String serverUrl) =>
      '$_prefix${base64Url.encode(utf8.encode(serverUrl)).replaceAll('=', '')}';

  Future<List<Project>> load(String serverUrl) async {
    final prefs = await SharedPreferences.getInstance();
    final encoded = prefs.getString(_key(serverUrl));
    if (encoded == null || encoded.isEmpty) return const [];
    try {
      return (jsonDecode(encoded) as List)
          .map((item) => Project.fromJson(item as Map<String, dynamic>))
          .toList(growable: false);
    } catch (_) {
      return const [];
    }
  }

  Future<void> save(String serverUrl, List<Project> projects) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _key(serverUrl),
      jsonEncode(projects.map((project) => project.toJson()).toList()),
    );
  }
}
