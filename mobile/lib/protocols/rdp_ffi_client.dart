import 'dart:async';
import 'dart:ffi' as ffi;
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ffi/ffi.dart';

typedef _JalaRdpCreateNative = ffi.Pointer<ffi.Void> Function(
  ffi.Pointer<Utf8> host,
  ffi.Int32 port,
  ffi.Pointer<Utf8> domain,
  ffi.Pointer<Utf8> username,
  ffi.Pointer<Utf8> password,
  ffi.Int32 width,
  ffi.Int32 height,
  ffi.Pointer<Utf8> configDir,
);
typedef _JalaRdpCreateDart = ffi.Pointer<ffi.Void> Function(
  ffi.Pointer<Utf8> host,
  int port,
  ffi.Pointer<Utf8> domain,
  ffi.Pointer<Utf8> username,
  ffi.Pointer<Utf8> password,
  int width,
  int height,
  ffi.Pointer<Utf8> configDir,
);

typedef _JalaRdpRequestResolutionNative = ffi.Void Function(
  ffi.Pointer<ffi.Void> handle,
  ffi.Int32 width,
  ffi.Int32 height,
  ffi.Int32 desktopScaleFactor,
);
typedef _JalaRdpRequestResolutionDart = void Function(
  ffi.Pointer<ffi.Void> handle,
  int width,
  int height,
  int desktopScaleFactor,
);

typedef _JalaRdpGetStateNative = ffi.Int32 Function(
  ffi.Pointer<ffi.Void> handle,
  ffi.Pointer<ffi.Int32> outWidth,
  ffi.Pointer<ffi.Int32> outHeight,
  ffi.Pointer<ffi.Uint64> outFrameSeq,
  ffi.Pointer<Utf8> outStatus,
  ffi.Int32 statusCap,
);
typedef _JalaRdpGetStateDart = int Function(
  ffi.Pointer<ffi.Void> handle,
  ffi.Pointer<ffi.Int32> outWidth,
  ffi.Pointer<ffi.Int32> outHeight,
  ffi.Pointer<ffi.Uint64> outFrameSeq,
  ffi.Pointer<Utf8> outStatus,
  int statusCap,
);

typedef _JalaRdpCopyFrameNative = ffi.Int32 Function(
  ffi.Pointer<ffi.Void> handle,
  ffi.Pointer<ffi.Uint8> dstRgba,
  ffi.Int32 maxBytes,
  ffi.Pointer<ffi.Int32> outW,
  ffi.Pointer<ffi.Int32> outH,
);
typedef _JalaRdpCopyFrameDart = int Function(
  ffi.Pointer<ffi.Void> handle,
  ffi.Pointer<ffi.Uint8> dstRgba,
  int maxBytes,
  ffi.Pointer<ffi.Int32> outW,
  ffi.Pointer<ffi.Int32> outH,
);

typedef _JalaRdpSendMouseNative = ffi.Void Function(
  ffi.Pointer<ffi.Void> handle,
  ffi.Int32 x,
  ffi.Int32 y,
  ffi.Int32 flags,
);
typedef _JalaRdpSendMouseDart = void Function(
  ffi.Pointer<ffi.Void> handle,
  int x,
  int y,
  int flags,
);

typedef _JalaRdpSendKeyScancodeNative = ffi.Void Function(
  ffi.Pointer<ffi.Void> handle,
  ffi.Int32 flags,
  ffi.Int32 scancode,
);
typedef _JalaRdpSendKeyScancodeDart = void Function(
  ffi.Pointer<ffi.Void> handle,
  int flags,
  int scancode,
);

typedef _JalaRdpSendUnicodeNative = ffi.Void Function(
  ffi.Pointer<ffi.Void> handle,
  ffi.Int32 flags,
  ffi.Int32 utf16Code,
);
typedef _JalaRdpSendUnicodeDart = void Function(
  ffi.Pointer<ffi.Void> handle,
  int flags,
  int utf16Code,
);

typedef _JalaRdpDestroyNative = ffi.Void Function(ffi.Pointer<ffi.Void> handle);
typedef _JalaRdpDestroyDart = void Function(ffi.Pointer<ffi.Void> handle);

typedef _JalaRdpSelftestNtlmNative = ffi.Int32 Function();
typedef _JalaRdpSelftestNtlmDart = int Function();

/// FreeRDP 3.x Mouse Event Flags (`freerdp/input.h`)
class RdpMouseFlags {
  static const int move = 0x0800; // PTR_FLAGS_MOVE
  static const int down = 0x8000; // PTR_FLAGS_DOWN
  static const int button1 = 0x1000; // PTR_FLAGS_BUTTON1 (Left)
  static const int button2 = 0x2000; // PTR_FLAGS_BUTTON2 (Right)
  static const int button3 = 0x4000; // PTR_FLAGS_BUTTON3 (Middle)
  static const int wheel = 0x0200; // PTR_FLAGS_WHEEL
  static const int wheelNegative = 0x0100; // PTR_FLAGS_WHEEL_NEGATIVE
}

/// FreeRDP 3.x Keyboard Event Flags (`freerdp/input.h`)
class RdpKeyFlags {
  static const int down = 0x0000;
  static const int extended = 0x0100; // KBD_FLAGS_EXTENDED
  static const int release = 0x8000; // KBD_FLAGS_RELEASE
}

/// Native FreeRDP 3.32.2 Client Engine via Dart FFI (`libjaladesk_freerdp.so`)
class RdpFfiClient {
  static ffi.DynamicLibrary? _cachedLib;

  final String host;
  final int port;
  final String domain;
  final String username;
  final String password;
  final int initialWidth;
  final int initialHeight;
  final void Function(ui.Image image, int width, int height, String status) onFrame;
  final void Function(String status, {bool isError}) onStatus;

  ffi.Pointer<ffi.Void> _handle = ffi.nullptr;
  Timer? _pollTimer;
  int _lastFrameSeq = 0;
  bool _decodingFrame = false;
  bool _disposed = false;

  int width = 1280;
  int height = 800;
  int state = 0; // 0 = connecting, 1 = connected, 2 = closed, -1 = failed
  String statusText = 'Initializing FreeRDP 3.32.2...';

  ffi.Pointer<ffi.Int32>? _pWidth;
  ffi.Pointer<ffi.Int32>? _pHeight;
  ffi.Pointer<ffi.Uint64>? _pSeq;
  ffi.Pointer<Utf8>? _pStatus;
  ffi.Pointer<ffi.Uint8>? _pFrameBuf;
  int _frameBufCap = 0;

  late final _JalaRdpCreateDart _fnCreate;
  late final _JalaRdpRequestResolutionDart _fnRequestResolution;
  late final _JalaRdpGetStateDart _fnGetState;
  late final _JalaRdpCopyFrameDart _fnCopyFrame;
  late final _JalaRdpSendMouseDart _fnSendMouse;
  late final _JalaRdpSendKeyScancodeDart _fnSendKeyScancode;
  late final _JalaRdpSendUnicodeDart _fnSendUnicode;
  late final _JalaRdpDestroyDart _fnDestroy;

  RdpFfiClient({
    required this.host,
    required this.port,
    required this.domain,
    required this.username,
    required this.password,
    this.initialWidth = 1280,
    this.initialHeight = 800,
    required this.onFrame,
    required this.onStatus,
  }) {
    width = initialWidth;
    height = initialHeight;
  }

  /// Calculates Jump Desktop-style aspect-matched remote desktop dimensions
  /// aligned to multiples of 4x2 pixels so the remote GUI fills the viewport with zero black bars.
  static (int width, int height) computeJumpMatchResolution(
    double viewportWidth,
    double viewportHeight, {
    double densityMultiplier = 1.0,
  }) {
    final safeW = viewportWidth.clamp(240.0, 4096.0);
    final safeH = viewportHeight.clamp(240.0, 4096.0);
    final aspect = safeW / safeH;

    double targetW;
    double targetH;
    if (aspect >= 1.0) {
      // Landscape or square-ish foldable (e.g. Galaxy Z Fold unfolded, Tablet, Landscape Phone)
      final baseLongEdge = (safeW < 1100 ? 1280.0 : safeW) * densityMultiplier;
      targetW = baseLongEdge.clamp(800.0, 2560.0);
      targetH = (targetW / aspect).clamp(480.0, 2160.0);
    } else {
      // Portrait orientation on phone or tablet: keep short edge >= 768 so Windows UI fits cleanly
      final baseShortEdge = (safeW < 768 ? 800.0 : safeW) * densityMultiplier;
      targetW = baseShortEdge.clamp(680.0, 1600.0);
      targetH = (targetW / aspect).clamp(800.0, 2400.0);
    }

    final alignedW = (((targetW.round() + 3) ~/ 4) * 4).clamp(640, 3840);
    final alignedH = (((targetH.round() + 1) ~/ 2) * 2).clamp(480, 2400);
    return (alignedW, alignedH);
  }

  static ffi.DynamicLibrary? _loadLibrary() {
    if (_cachedLib != null) return _cachedLib;
    try {
      if (Platform.isAndroid) {
        _cachedLib = ffi.DynamicLibrary.open('libjaladesk_freerdp.so');
      } else if (Platform.isMacOS) {
        final candidates = [
          '${Directory.current.path}/libjaladesk_freerdp.dylib',
          '${Directory.current.path}/build/libjaladesk_freerdp.dylib',
        ];
        for (final c in candidates) {
          if (File(c).existsSync()) {
            _cachedLib = ffi.DynamicLibrary.open(c);
            return _cachedLib;
          }
        }
        _cachedLib = ffi.DynamicLibrary.open('libjaladesk_freerdp.dylib');
      } else if (Platform.isIOS) {
        _cachedLib = ffi.DynamicLibrary.process();
      }
      return _cachedLib;
    } catch (_) {
      return null;
    }
  }

  static bool get isNativeAvailable => _loadLibrary() != null;

  /// Verifies WinPR NTLMv2 MD4 digest (`NTOWFv1A("password")`) inside the loaded native binary.
  static bool selfTestNtlm() {
    final lib = _loadLibrary();
    if (lib == null) return false;
    try {
      final fn = lib.lookupFunction<_JalaRdpSelftestNtlmNative, _JalaRdpSelftestNtlmDart>(
        'jaladesk_rdp_selftest_ntlm',
      );
      return fn() == 1;
    } catch (_) {
      return false;
    }
  }

  static String _resolveWritableConfigDir() {
    if (Platform.isAndroid) {
      for (final candidate in [
        '/data/user/0/com.jaladesk.app/cache/freerdp',
        '/data/data/com.jaladesk.app/cache/freerdp',
      ]) {
        try {
          final dir = Directory(candidate);
          if (!dir.existsSync()) {
            dir.createSync(recursive: true);
          }
          return dir.path;
        } catch (_) {}
      }
    }
    try {
      final fallback = Directory('${Directory.systemTemp.path}/jaladesk_freerdp');
      if (!fallback.existsSync()) {
        fallback.createSync(recursive: true);
      }
      return fallback.path;
    } catch (_) {
      return Directory.systemTemp.path;
    }
  }

  bool get isConnected => !_disposed && _handle != ffi.nullptr && state == 1;

  Future<void> connect() async {
    final lib = _loadLibrary();
    if (lib == null) {
      throw UnsupportedError('FreeRDP native library is not available on this platform.');
    }

    _fnCreate = lib.lookupFunction<_JalaRdpCreateNative, _JalaRdpCreateDart>('jaladesk_rdp_create');
    _fnRequestResolution = lib.lookupFunction<_JalaRdpRequestResolutionNative, _JalaRdpRequestResolutionDart>(
      'jaladesk_rdp_request_resolution',
    );
    _fnGetState = lib.lookupFunction<_JalaRdpGetStateNative, _JalaRdpGetStateDart>('jaladesk_rdp_get_state');
    _fnCopyFrame = lib.lookupFunction<_JalaRdpCopyFrameNative, _JalaRdpCopyFrameDart>('jaladesk_rdp_copy_frame');
    _fnSendMouse = lib.lookupFunction<_JalaRdpSendMouseNative, _JalaRdpSendMouseDart>('jaladesk_rdp_send_mouse');
    _fnSendKeyScancode =
        lib.lookupFunction<_JalaRdpSendKeyScancodeNative, _JalaRdpSendKeyScancodeDart>('jaladesk_rdp_send_key_scancode');
    _fnSendUnicode =
        lib.lookupFunction<_JalaRdpSendUnicodeNative, _JalaRdpSendUnicodeDart>('jaladesk_rdp_send_unicode');
    _fnDestroy = lib.lookupFunction<_JalaRdpDestroyNative, _JalaRdpDestroyDart>('jaladesk_rdp_destroy');

    _pWidth = calloc<ffi.Int32>();
    _pHeight = calloc<ffi.Int32>();
    _pSeq = calloc<ffi.Uint64>();
    _pStatus = calloc<ffi.Uint8>(512).cast<Utf8>();

    final cHost = host.toNativeUtf8();
    final cDomain = domain.toNativeUtf8();
    final cUser = username.toNativeUtf8();
    final cPass = password.toNativeUtf8();
    final tempDir = _resolveWritableConfigDir();
    final cConfig = tempDir.toNativeUtf8();

    try {
      _handle = _fnCreate(
        cHost,
        port,
        cDomain,
        cUser,
        cPass,
        initialWidth,
        initialHeight,
        cConfig,
      );
    } finally {
      calloc.free(cHost);
      calloc.free(cDomain);
      calloc.free(cUser);
      calloc.free(cPass);
      calloc.free(cConfig);
    }

    if (_handle == ffi.nullptr) {
      throw const SocketException('Failed to initialize FreeRDP session context.');
    }

    // Wait until state transitions from 0 (connecting) to 1 (connected) or -1 (failed)
    final deadline = DateTime.now().add(const Duration(seconds: 15));
    while (!_disposed && DateTime.now().isBefore(deadline)) {
      _pollStateOnce();
      if (state == 1) {
        onStatus(statusText);
        _startFramePump();
        return;
      } else if (state < 0 || state == 2) {
        final msg = statusText;
        await dispose();
        throw SocketException(msg);
      }
      await Future<void>.delayed(const Duration(milliseconds: 45));
    }

    await dispose();
    throw TimeoutException('RDP connection to $host:$port timed out.');
  }

  /// Dynamically resizes the remote desktop session via MS-RDPEDISP (`DispClientContext`)
  /// or seamless fast-reconnect when the user rotates/unfolds the device or changes display preset.
  void requestResolution(int newWidth, int newHeight, {int desktopScaleFactor = 100}) {
    if (_disposed || _handle == ffi.nullptr) return;
    final alignedW = (((newWidth.clamp(320, 4096) + 3) ~/ 4) * 4);
    final alignedH = (((newHeight.clamp(240, 4096) + 1) ~/ 2) * 2);
    if ((alignedW - width).abs() < 4 && (alignedH - height).abs() < 4) return;
    _fnRequestResolution(_handle, alignedW, alignedH, desktopScaleFactor.clamp(100, 500));
  }

  void _pollStateOnce() {
    if (_disposed || _handle == ffi.nullptr) return;
    final st = _fnGetState(_handle, _pWidth!, _pHeight!, _pSeq!, _pStatus!, 512);
    state = st;
    final w = _pWidth!.value;
    final h = _pHeight!.value;
    if (w > 0 && h > 0) {
      width = w;
      height = h;
    }
    try {
      statusText = _pStatus!.toDartString();
    } catch (_) {}
  }

  void _startFramePump() {
    _pollTimer?.cancel();
    // 60fps low-latency frame pump (16ms cadence + immediate catch-up when decode completes)
    _pollTimer = Timer.periodic(const Duration(milliseconds: 16), (_) {
      if (_disposed || _handle == ffi.nullptr || _decodingFrame) return;
      _pollStateOnce();
      if (state == -1 || state == 2) {
        onStatus(statusText, isError: state == -1);
        _pollTimer?.cancel();
        return;
      }
      final seq = _pSeq!.value;
      if (seq > _lastFrameSeq && width > 0 && height > 0) {
        _lastFrameSeq = seq;
        _pullAndDecodeFrame();
      }
    });
  }

  void _pullAndDecodeFrame() {
    if (_disposed || _handle == ffi.nullptr || _decodingFrame) return;
    final needed = width * height * 4;
    if (needed <= 0 || needed > 64 * 1024 * 1024) return;
    if (_pFrameBuf == null || _frameBufCap < needed) {
      if (_pFrameBuf != null) calloc.free(_pFrameBuf!);
      _pFrameBuf = calloc<ffi.Uint8>(needed);
      _frameBufCap = needed;
    }
    final copied = _fnCopyFrame(_handle, _pFrameBuf!, _frameBufCap, _pWidth!, _pHeight!);
    if (copied <= 0) return;
    final fw = _pWidth!.value;
    final fh = _pHeight!.value;
    if (fw <= 0 || fh <= 0 || copied < fw * fh * 4) return;

    _decodingFrame = true;
    final dartBytes = Uint8List.fromList(_pFrameBuf!.asTypedList(fw * fh * 4));
    ui.decodeImageFromPixels(
      dartBytes,
      fw,
      fh,
      ui.PixelFormat.rgba8888,
      (ui.Image img) {
        _decodingFrame = false;
        if (!_disposed) {
          onFrame(img, fw, fh, statusText);
          // Immediately catch up if FreeRDP pushed a newer frame while GPU texture uploaded
          if (_handle != ffi.nullptr && _pSeq != null) {
            _pollStateOnce();
            final latestSeq = _pSeq!.value;
            if (state == 1 && latestSeq > _lastFrameSeq && width > 0 && height > 0) {
              _lastFrameSeq = latestSeq;
              _pullAndDecodeFrame();
            }
          }
        }
      },
    );
  }

  int _lastSentMouseX = -1;
  int _lastSentMouseY = -1;

  void sendMouseMove(int x, int y) {
    if (_disposed || _handle == ffi.nullptr) return;
    final cx = x.clamp(0, width - 1);
    final cy = y.clamp(0, height - 1);
    if (cx == _lastSentMouseX && cy == _lastSentMouseY) return;
    _lastSentMouseX = cx;
    _lastSentMouseY = cy;
    _fnSendMouse(_handle, cx, cy, RdpMouseFlags.move);
  }

  void sendMouseClick(int x, int y, {bool rightClick = false, bool doubleClick = false}) {
    if (_disposed || _handle == ffi.nullptr) return;
    final cx = x.clamp(0, width - 1);
    final cy = y.clamp(0, height - 1);
    final btn = rightClick ? RdpMouseFlags.button2 : RdpMouseFlags.button1;
    final count = doubleClick ? 2 : 1;
    _fnSendMouse(_handle, cx, cy, RdpMouseFlags.move);
    for (int i = 0; i < count; i++) {
      _fnSendMouse(_handle, cx, cy, RdpMouseFlags.down | btn);
      _fnSendMouse(_handle, cx, cy, btn);
    }
  }

  void sendMouseButton(int x, int y, {required int buttonFlag, required bool down}) {
    if (_disposed || _handle == ffi.nullptr) return;
    final cx = x.clamp(0, width - 1);
    final cy = y.clamp(0, height - 1);
    _fnSendMouse(_handle, cx, cy, (down ? RdpMouseFlags.down : 0) | buttonFlag);
  }

  void sendMouseWheel(int x, int y, int delta) {
    if (_disposed || _handle == ffi.nullptr) return;
    final cx = x.clamp(0, width - 1);
    final cy = y.clamp(0, height - 1);
    final neg = delta < 0;
    final mag = delta.abs().clamp(1, 0xFF);
    final flags = RdpMouseFlags.wheel | (neg ? RdpMouseFlags.wheelNegative : 0) | mag;
    _fnSendMouse(_handle, cx, cy, flags);
  }

  void sendScancode(int scancode, {bool extended = false, bool? down}) {
    if (_disposed || _handle == ffi.nullptr) return;
    final extFlag = extended ? RdpKeyFlags.extended : 0;
    if (down != null) {
      _fnSendKeyScancode(_handle, extFlag | (down ? RdpKeyFlags.down : RdpKeyFlags.release), scancode);
    } else {
      _fnSendKeyScancode(_handle, extFlag | RdpKeyFlags.down, scancode);
      _fnSendKeyScancode(_handle, extFlag | RdpKeyFlags.release, scancode);
    }
  }

  void sendUnicodeText(String text) {
    if (_disposed || _handle == ffi.nullptr) return;
    for (final unit in text.codeUnits) {
      if (unit == 10 || unit == 13) {
        sendScancode(0x1C); // Enter
      } else {
        _fnSendUnicode(_handle, RdpKeyFlags.down, unit);
        _fnSendUnicode(_handle, RdpKeyFlags.release, unit);
      }
    }
  }

  void sendSpecialKey(String label, {bool ctrl = false, bool alt = false, bool win = false, bool shift = false}) {
    if (_disposed || _handle == ffi.nullptr) return;
    if (label == 'Ctrl+Alt+Del') {
      sendScancode(0x1D, down: true); // Ctrl
      sendScancode(0x38, down: true); // Alt
      sendScancode(0x53, extended: true, down: true); // Del
      sendScancode(0x53, extended: true, down: false);
      sendScancode(0x38, down: false);
      sendScancode(0x1D, down: false);
      return;
    }
    if (label == 'Win+D') {
      sendScancode(0x5B, extended: true, down: true); // Left Win
      sendScancode(0x20, down: true); // D
      sendScancode(0x20, down: false);
      sendScancode(0x5B, extended: true, down: false);
      return;
    }

    if (ctrl) sendScancode(0x1D, down: true);
    if (alt) sendScancode(0x38, down: true);
    if (win) sendScancode(0x5B, extended: true, down: true);
    if (shift) sendScancode(0x2A, down: true);

    switch (label) {
      case 'Esc':
        sendScancode(0x01);
        break;
      case 'Tab':
        sendScancode(0x0F);
        break;
      case 'Enter':
        sendScancode(0x1C);
        break;
      case 'Bksp':
        sendScancode(0x0E);
        break;
      case '←':
        sendScancode(0x4B, extended: true);
        break;
      case '↑':
        sendScancode(0x48, extended: true);
        break;
      case '↓':
        sendScancode(0x50, extended: true);
        break;
      case '→':
        sendScancode(0x4D, extended: true);
        break;
      case 'F1':
        sendScancode(0x3B);
        break;
      case 'F5':
        sendScancode(0x3F);
        break;
      case 'F11':
        sendScancode(0x57);
        break;
      case 'F12':
        sendScancode(0x58);
        break;
      default:
        sendUnicodeText(label);
    }

    if (shift) sendScancode(0x2A, down: false);
    if (win) sendScancode(0x5B, extended: true, down: false);
    if (alt) sendScancode(0x38, down: false);
    if (ctrl) sendScancode(0x1D, down: false);
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _pollTimer?.cancel();
    _pollTimer = null;
    final h = _handle;
    _handle = ffi.nullptr;
    if (h != ffi.nullptr) {
      _fnDestroy(h);
    }
    if (_pWidth != null) calloc.free(_pWidth!);
    if (_pHeight != null) calloc.free(_pHeight!);
    if (_pSeq != null) calloc.free(_pSeq!);
    if (_pStatus != null) calloc.free(_pStatus!);
    if (_pFrameBuf != null) calloc.free(_pFrameBuf!);
    _pWidth = null;
    _pHeight = null;
    _pSeq = null;
    _pStatus = null;
    _pFrameBuf = null;
  }
}
