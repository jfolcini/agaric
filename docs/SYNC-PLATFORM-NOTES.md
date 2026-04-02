# Sync Platform Notes

Platform-specific considerations for the Agaric sync protocol.

## mDNS on Android (#233)

### Background
Android restricts multicast by default. The `mdns-sd` 0.18.2 crate is pure Rust (no Avahi dependency)
and should work on Android if the multicast lock is acquired.

### Requirements
- `CHANGE_NETWORK_STATE` + `ACCESS_NETWORK_STATE` permissions (auto-added by Tauri 2)
- WiFi multicast lock must be acquired at runtime via Android API
- Some carriers restrict multicast on WiFi — test on real device, not just emulator

### Mitigation
- 5-second discovery timeout
- Fallback to manual IP entry if no peers found via mDNS
- Manual IP entry UI: text field for `host:port`, bypasses mDNS entirely

### Testing plan
1. Build debug APK: `cargo tauri android build --target x86_64 --debug`
2. Start emulator: `emulator -avd spike_test -gpu swiftshader_indirect -no-window -no-audio &`
3. Install + launch: `adb install -r <apk> && adb shell am start -n com.agaric.app/.MainActivity`
4. Check logcat for mDNS output: `adb logcat -s RustStdoutStderr:V`
5. If multicast fails, implement WiFi multicast lock via Tauri plugin

### Status
Not yet tested on Android. Pure Rust mdns-sd should work but needs verification.

---

## WebSocket Stability on Android (#234)

### Background
WebSocket transport runs in Rust backend via `tokio-tungstenite` (not frontend JS), so
Android WebView lifecycle shouldn't directly kill connections. However, Android may kill
the entire process when backgrounded.

### Implementation
- Reconnection with exponential backoff: 2s → 4s → 8s → 30s max
- Self-signed certs: pin cert hash in `peer_refs` table — no system cert store needed
- On reconnect: verify pinned cert hash matches

### Testing plan
1. Establish sync connection between two devices
2. Background the app on Android
3. Wait 30 seconds
4. Foreground the app
5. Verify sync resumes automatically

### Status
WebSocket implementation exists in `sync_net.rs`. Reconnection logic not yet implemented.

---

## Android Background Sync / Doze Mode (#235)

### Background
Android Doze mode aggressively restricts background processing after the screen turns off:
- Network access blocked
- Alarms deferred
- CPU wake locks ignored

### Decision: Foreground-only sync (Phase 4 v1)
For the initial sync implementation, sync only runs while the app is in the foreground.
This is simpler and avoids the complexity of Android foreground services.

### Future: Background sync (Phase 4 v2)
If users request background sync:
1. Use Android WorkManager for periodic sync (minimum 15-minute interval)
2. Implement a Tauri native plugin wrapping WorkManager
3. Show "Sync pending" indicator when backgrounded
4. On foreground resume: trigger immediate sync

### Status
Foreground-only sync is the current plan. No background service implemented.

---

## Linux Firewall (#236)

### Background
UFW (Ubuntu) / firewalld (Fedora) / iptables (various) may block incoming WebSocket
connections on the sync port.

### Documentation for users
Add to README or Help:

```
# Allow Agaric sync (replace PORT with actual port shown in app)
# Ubuntu/Debian (UFW):
sudo ufw allow PORT/tcp comment "Agaric sync"

# Fedora (firewalld):
sudo firewall-cmd --add-port=PORT/tcp --permanent
sudo firewall-cmd --reload

# Arch (iptables):
sudo iptables -A INPUT -p tcp --dport PORT -j ACCEPT
```

### Implementation
- On startup, if sync is enabled, show the listening port in StatusPanel
- If connection from peer fails, show user-friendly error: "Could not connect. Check firewall settings."
- Link to documentation from error message

### Status
Firewall documentation drafted. No runtime detection implemented yet.

---

## Linux mDNS / Avahi (#237)

### Background
`mdns-sd` 0.18.2 is pure Rust and does NOT depend on Avahi daemon (unlike `zeroconf`
which wraps platform APIs). It handles its own multicast directly.

However, the *other* device may need Avahi to resolve `.local` hostnames.

### Clarification
- `mdns-sd` handles multicast announcement and browsing independently
- Avahi is NOT required for Agaric sync to work
- Avahi IS recommended if users want `.local` hostname resolution from other apps
- Fallback to manual IP entry works without any mDNS daemon

### Documentation for users
```
Agaric sync uses mDNS for automatic peer discovery on your local network.
If automatic discovery doesn't work:
1. Install Avahi (optional): sudo apt install avahi-daemon
2. Or use manual IP entry: enter the other device's IP address and port
```

### Status
Pure Rust mDNS implementation avoids Avahi dependency. Fallback UI planned.

---

## QR Code Scanning on Android (#220)

### Libraries
- `html5-qrcode` 2.3.8 — already installed in package.json
- Uses `getUserMedia` + ZXing decoder
- Built-in fallback to file upload if camera denied

### Permissions Required
- `CAMERA` permission in AndroidManifest.xml
- Runtime permission request (Android 6+)

### Implementation Plan
1. Camera scanning (primary):
   - `Html5QrcodeScanner` component wraps the library
   - Request camera permission on first use
   - Parse QR data (JSON with passphrase + host)
   - Auto-fill passphrase fields

2. File upload fallback:
   - html5-qrcode supports image file upload natively
   - No additional code needed

3. Manual entry fallback:
   - 4 word input fields (already in PairingDialog)
   - Always available regardless of camera permission

### AndroidManifest.xml change needed
Add to `src-tauri/gen/android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

### Status
Library installed. Component stub created below. Permission request and full integration pending.
