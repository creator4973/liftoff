import 'package:flutter_test/flutter_test.dart';

import 'package:liftoff/main.dart';

void main() {
  testWidgets('renders pairing screen when unpaired', (tester) async {
    await tester.pumpWidget(const AntigravityRemoteApp(initialConfig: null));
    expect(find.text('LiftOff'), findsOneWidget);
    expect(find.text('Connect'), findsOneWidget);
  });
}
