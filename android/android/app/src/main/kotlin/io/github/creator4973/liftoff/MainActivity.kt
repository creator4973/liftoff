package io.github.creator4973.liftoff

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "liftoff/app_control"
        ).setMethodCallHandler { call, result ->
            if (call.method != "exitApp") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            result.success(null)
            finishAndRemoveTask()
        }
    }
}
