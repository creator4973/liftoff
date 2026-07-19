import 'package:flutter_test/flutter_test.dart';
import 'package:liftoff/models.dart';
import 'package:liftoff/project_cache.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('restores the last project list for a paired bridge', () async {
    final cache = ProjectCache();
    const projects = [
      Project(
        title: 'Project A',
        conversations: [
          Conversation(
            id: 'conversation-1',
            title: 'Cached conversation',
            time: '2m',
            active: true,
          ),
        ],
      ),
    ];

    await cache.save('https://198.51.100.1:4747', projects);

    final restored = await cache.load('https://198.51.100.1:4747');
    expect(restored.single.title, 'Project A');
    expect(restored.single.conversations.single.id, 'conversation-1');
    expect(restored.single.conversations.single.active, isTrue);
  });

  test('does not share project lists between bridges', () async {
    final cache = ProjectCache();
    await cache.save('https://first:4747', const [
      Project(title: 'First', conversations: []),
    ]);

    expect(await cache.load('https://second:4747'), isEmpty);
  });
}
