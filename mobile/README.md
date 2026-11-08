# JalaDesk Mobile (iOS, iPadOS & Android)

**JalaDesk Mobile** is the cross-platform mobile companion to **JalaDesk Desktop**, engineered with Flutter 3.x to deliver **Jump Desktop Fluid Touch RDP/VNC** and **Termius Mobile SSH/SFTP** parity on iPhone, iPad, and Android phones/tablets.

## Key Capabilities

1. **Connections & Folder Vault (`.rtsz` / `.jaladesk` Sync)**
   - Browse folders, filter by protocol (`RDP`, `SSH`, `VNC`, `SFTP`, `HYPERVISOR`), and inspect live latency badges (`ms`).
   - Pair directly with JalaDesk Desktop via **Settings (`⌘,`) → `📱 Mobile (iOS / Android)` → `Generate Pairing Token`** (`jaladesk://pair?v=1&...`).
2. **Jump Desktop-Style Touch RDP / VNC Canvas**
   - **Dual Pointer Modes**: Switch on the fly between **Precision Trackpad Cursor** (relative finger movement moves a virtual desktop cursor with pixel-accurate hover/right-click) and **Direct Touch**.
   - **Multi-Touch Pinch-to-Zoom**: Smooth 1x–4x hardware-accelerated viewport zoom and pan.
   - **Extended On-Screen Modifier Strip**: Sticky `Ctrl`, `Alt`, `⌘/Win`, `Shift` toggles plus `Esc`, `Tab`, `Ctrl+Alt+Del`, `Win+D`, arrow keys (`←`, `↑`, `↓`, `→`), and `F1`–`F12`.
   - **View-Only Safety Lock**: Prevent accidental touch clicks during live production observation.
3. **Termius-Style Mobile SSH Terminal & SFTP**
   - Interactive SSH session console with quick-action bar (`uptime`, `docker ps`, `kubectl get pods`, `uname -a`, `df -h`, `clear`).
4. **Zero-Trust Security & RFC 6238 TOTP 2FA Vault**
   - Built-in 6-digit TOTP authenticator with 30-second countdown and Biometric Enclave (`FaceID` / `TouchID` / `Android BiometricPrompt`) lock toggle.

## How to Build & Run

```bash
cd /Users/ribato/Documents/APLIKASI/royal-clone/outputs/mobile

# Generate platform runners if not yet initialized
flutter create --platforms=ios,android .

# Run on iOS Simulator / iPhone / iPad
flutter run -d ios

# Run on Android Emulator / Device
flutter run -d android

# Build release packages
flutter build ipa      # iOS / iPadOS App Store & TestFlight
flutter build appbundle # Android Google Play (.aab)
flutter build apk       # Android Direct Install (.apk)
```
