# Headless Android Testing (ADB)

AI agents can build, install, run, and interact with the Android app entirely via CLI. No display needed.

```bash
# Boot emulator headless
emulator -avd spike_test -gpu swiftshader_indirect -no-window -no-audio &
adb wait-for-device
adb shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'

# Build + install + launch
cargo tauri android build --target x86_64 --debug
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n com.agaric.app/.MainActivity
sleep 3  # wait for WebView + Rust init

# Observe
adb exec-out screencap -p > /tmp/screenshot.png    # screenshot (read with image tool)
adb logcat -s RustStdoutStderr:V -d                 # Rust backend logs
adb shell dumpsys activity top | head -100          # activity/view state

# Interact
adb shell input tap 512 400                         # tap at (x,y)
adb shell input text "hello"                        # type text
adb shell input swipe 500 800 500 200               # swipe/scroll
adb shell input keyevent KEYCODE_BACK               # back button
adb shell input keyevent KEYCODE_ENTER              # enter key

# Inspect app data (debug builds only)
adb shell run-as com.agaric.app ls files/
adb shell run-as com.agaric.app cat files/device-id

# WebView JS execution via Chrome DevTools Protocol
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.agaric.app)
curl -s http://localhost:9222/json                   # list pages

# Cleanup
adb shell am force-stop com.agaric.app
adb emu kill
```

## Debugging Workflow

1. Build + install + launch (commands above)
2. Screenshot to see current state
3. Read logcat for Rust errors or JS console errors
4. Use `adb shell input` to interact (tap, type, swipe)
5. Screenshot again to verify result
6. Forward CDP port and `curl` the `/json` endpoint for WebView inspection
7. Repeat as needed — `adb shell am force-stop` + relaunch to reset
