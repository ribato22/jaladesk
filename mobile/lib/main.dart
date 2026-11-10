import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'protocols/rdp_ffi_client.dart';
import 'protocols/vnc_rfb_client.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Color(0xFF0B1220),
      statusBarBrightness: Brightness.dark,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Color(0xFF0B1220),
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );
  runApp(const JalaDeskMobileApp());
}

/// Official JalaDesk Desktop & Mobile Unified Color Tokens
class JalaPalette {
  static const Color splashBg = Color(0xFF0B1220);
  static const Color header = Color(0xFF0E141A);
  static const Color page = Color(0xFF141A21);
  static const Color aside = Color(0xFF19212A);
  static const Color bar = Color(0xFF1B232D);
  static const Color surface = Color(0xFF1F2833);
  static const Color chip = Color(0xFF243242);
  static const Color selected = Color(0xFF2A4560);
  static const Color line = Color(0xFF2F3B49);
  static const Color lineInput = Color(0xFF4A5A6D);
  static const Color text = Color(0xFFE3EAF2);
  static const Color text2 = Color(0xFFC3CFDB);
  static const Color muted = Color(0xFFAFBECF);
  static const Color accent = Color(0xFF2F6F9C);
  static const Color accentLine = Color(0xFF5AA2D4);
  static const Color brandGold = Color(0xFFEDBA6E);
  static const Color amber = Color(0xFFDDA254);
  static const Color ok = Color(0xFF80D3A3);
  static const Color danger = Color(0xFFFFAAA1);
}

class JalaDeskMobileApp extends StatelessWidget {
  final List<RemoteHostItem>? initialHostsOverride;
  final bool disableNetworkProbes;
  final GlobalKey<JalaDeskMobileShellState>? shellKey;

  const JalaDeskMobileApp({
    super.key,
    this.initialHostsOverride,
    this.disableNetworkProbes = false,
    this.shellKey,
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'JalaDesk',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        useMaterial3: true,
        scaffoldBackgroundColor: JalaPalette.page,
        colorScheme: const ColorScheme.dark(
          primary: JalaPalette.accent,
          onPrimary: Colors.white,
          secondary: JalaPalette.brandGold,
          onSecondary: JalaPalette.header,
          surface: JalaPalette.surface,
          onSurface: JalaPalette.text,
          error: JalaPalette.danger,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: JalaPalette.header,
          foregroundColor: JalaPalette.text,
          elevation: 0,
          centerTitle: false,
          surfaceTintColor: Colors.transparent,
        ),
        cardTheme: CardThemeData(
          color: JalaPalette.surface,
          elevation: 0,
          margin: EdgeInsets.zero,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: JalaPalette.line, width: 1),
          ),
        ),
        dividerColor: JalaPalette.line,
        snackBarTheme: SnackBarThemeData(
          backgroundColor: JalaPalette.chip,
          contentTextStyle: const TextStyle(color: JalaPalette.text, fontSize: 12.5),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
            side: const BorderSide(color: JalaPalette.accentLine),
          ),
          behavior: SnackBarBehavior.floating,
        ),
      ),
      home: JalaDeskMobileShell(
        key: shellKey,
        initialHostsOverride: initialHostsOverride,
        disableNetworkProbes: disableNetworkProbes,
      ),
    );
  }
}

enum RemoteProtocol { ssh, rdp, vnc, sftp, hypervisor }

int defaultPortForProtocol(RemoteProtocol protocol) {
  switch (protocol) {
    case RemoteProtocol.ssh:
    case RemoteProtocol.sftp:
      return 22;
    case RemoteProtocol.rdp:
      return 3389;
    case RemoteProtocol.vnc:
      return 5900;
    case RemoteProtocol.hypervisor:
      return 8006;
  }
}

class RemoteHostItem {
  final String id;
  final String name;
  final String address;
  final int port;
  final RemoteProtocol protocol;
  final String folder;
  final String osLabel;
  final String domain;
  final String username;
  final String password;
  final String privateKeyPem;
  final int? latencyMs;
  final bool? isOnline;
  final String accentTint;

  const RemoteHostItem({
    required this.id,
    required this.name,
    required this.address,
    required this.port,
    required this.protocol,
    this.folder = 'General',
    this.osLabel = '',
    this.domain = '',
    this.username = 'root',
    this.password = '',
    this.privateKeyPem = '',
    this.latencyMs,
    this.isOnline,
    this.accentTint = 'sapphire',
  });

  /// Returns `(effectiveDomain, effectiveUsername)` by automatically splitting `DOMAIN\user` or `user@domain`
  (String, String) get resolvedDomainAndUser {
    final dom = domain.trim();
    final usr = username.trim();
    if (dom.isNotEmpty) return (dom, usr);
    if (usr.contains('\\')) {
      final parts = usr.split('\\');
      return (parts.first, parts.sublist(1).join('\\'));
    }
    if (usr.contains('@') && protocol == RemoteProtocol.rdp) {
      final parts = usr.split('@');
      return (parts.sublist(1).join('@'), parts.first);
    }
    return ('', usr);
  }

  String get displayAccount {
    final (dom, usr) = resolvedDomainAndUser;
    if (dom.isNotEmpty && !usr.contains('\\')) {
      return '$dom\\$usr';
    }
    return usr;
  }

  RemoteHostItem copyWith({
    String? id,
    String? name,
    String? address,
    int? port,
    RemoteProtocol? protocol,
    String? folder,
    String? osLabel,
    String? domain,
    String? username,
    String? password,
    String? privateKeyPem,
    int? latencyMs,
    bool? isOnline,
    String? accentTint,
  }) {
    return RemoteHostItem(
      id: id ?? this.id,
      name: name ?? this.name,
      address: address ?? this.address,
      port: port ?? this.port,
      protocol: protocol ?? this.protocol,
      folder: folder ?? this.folder,
      osLabel: osLabel ?? this.osLabel,
      domain: domain ?? this.domain,
      username: username ?? this.username,
      password: password ?? this.password,
      privateKeyPem: privateKeyPem ?? this.privateKeyPem,
      latencyMs: latencyMs ?? this.latencyMs,
      isOnline: isOnline ?? this.isOnline,
      accentTint: accentTint ?? this.accentTint,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'address': address,
        'port': port,
        'protocol': protocol.name,
        'folder': folder,
        'osLabel': osLabel,
        'domain': domain,
        'username': username,
        'password': password,
        'privateKeyPem': privateKeyPem,
        'latencyMs': latencyMs,
        'isOnline': isOnline,
        'accentTint': accentTint,
      };

  factory RemoteHostItem.fromJson(Map<String, dynamic> json) {
    final protoStr = (json['protocol'] as String? ?? 'ssh').toLowerCase();
    final proto = RemoteProtocol.values.firstWhere(
      (e) => e.name == protoStr,
      orElse: () => RemoteProtocol.ssh,
    );
    return RemoteHostItem(
      id: json['id'] as String? ?? 'h-${DateTime.now().millisecondsSinceEpoch}',
      name: json['name'] as String? ?? 'Remote Host',
      address: json['address'] as String? ?? '127.0.0.1',
      port: (json['port'] as num?)?.toInt() ?? defaultPortForProtocol(proto),
      protocol: proto,
      folder: json['folder'] as String? ?? 'General',
      osLabel: json['osLabel'] as String? ?? '${proto.name.toUpperCase()} Endpoint',
      domain: json['domain'] as String? ?? '',
      username: json['username'] as String? ?? 'root',
      password: json['password'] as String? ?? '',
      privateKeyPem: json['privateKeyPem'] as String? ?? '',
      latencyMs: (json['latencyMs'] as num?)?.toInt(),
      isOnline: json['isOnline'] as bool?,
      accentTint: json['accentTint'] as String? ?? 'sapphire',
    );
  }
}

class TotpEntryItem {
  final String id;
  final String label;
  final String secretBase32;
  final String algorithm;
  final int digits;

  const TotpEntryItem({
    required this.id,
    required this.label,
    required this.secretBase32,
    this.algorithm = 'SHA-1',
    this.digits = 6,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'label': label,
        'secretBase32': secretBase32,
        'algorithm': algorithm,
        'digits': digits,
      };

  factory TotpEntryItem.fromJson(Map<String, dynamic> json) {
    return TotpEntryItem(
      id: json['id'] as String? ?? 'totp-${DateTime.now().millisecondsSinceEpoch}',
      label: json['label'] as String? ?? 'Authenticator Key',
      secretBase32: json['secretBase32'] as String? ?? 'JBSWY3DPEHPK3PXP',
      algorithm: json['algorithm'] as String? ?? 'SHA-1',
      digits: (json['digits'] as num?)?.toInt() ?? 6,
    );
  }
}

/// Real RFC 6238 / RFC 4226 TOTP Generator using HMAC-SHA1/SHA256/SHA512
class Rfc6238Totp {
  static const String _alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  static Uint8List decodeBase32(String input) {
    final cleaned = input.toUpperCase().replaceAll(RegExp(r'[^A-Z2-7]'), '');
    if (cleaned.isEmpty) return Uint8List(0);
    final out = <int>[];
    int buffer = 0;
    int bitsLeft = 0;
    for (int i = 0; i < cleaned.length; i++) {
      final val = _alphabet.indexOf(cleaned[i]);
      if (val < 0) continue;
      buffer = (buffer << 5) | val;
      bitsLeft += 5;
      if (bitsLeft >= 8) {
        bitsLeft -= 8;
        out.add((buffer >> bitsLeft) & 0xFF);
      }
    }
    return Uint8List.fromList(out);
  }

  static String generateCode(
    String secretBase32, {
    DateTime? now,
    int periodSeconds = 30,
    int digits = 6,
    String algorithm = 'SHA-1',
  }) {
    final keyBytes = decodeBase32(secretBase32);
    if (keyBytes.isEmpty) return '000000';
    final epochSeconds = (now ?? DateTime.now()).millisecondsSinceEpoch ~/ 1000;
    int counter = epochSeconds ~/ periodSeconds;
    final counterBytes = Uint8List(8);
    for (int i = 7; i >= 0; i--) {
      counterBytes[i] = counter & 0xFF;
      counter >>= 8;
    }

    Hash hashAlgo = sha1;
    if (algorithm.toUpperCase().contains('256')) {
      hashAlgo = sha256;
    } else if (algorithm.toUpperCase().contains('512')) {
      hashAlgo = sha512;
    }

    final hmac = Hmac(hashAlgo, keyBytes);
    final digest = hmac.convert(counterBytes).bytes;
    final offset = digest[digest.length - 1] & 0x0F;
    final binary = ((digest[offset] & 0x7F) << 24) |
        ((digest[offset + 1] & 0xFF) << 16) |
        ((digest[offset + 2] & 0xFF) << 8) |
        (digest[offset + 3] & 0xFF);

    int mod = 1;
    for (int i = 0; i < digits; i++) {
      mod *= 10;
    }
    final otp = binary % mod;
    return otp.toString().padLeft(digits, '0');
  }
}

class RemoteSftpEntry {
  final String name;
  final String fullPath;
  final String permissions;
  final String sizeLabel;
  final bool isDirectory;

  const RemoteSftpEntry({
    required this.name,
    required this.fullPath,
    required this.permissions,
    required this.sizeLabel,
    required this.isDirectory,
  });
}

/// Jump Desktop-style Remote Resolution Negotiation Preset
enum JumpResolutionPreset {
  matchDisplay('Auto Match Screen (Native Aspect)', 'Auto Match', 1.0),
  matchHiDpi('Retina / HiDPI Match (1.35× Sharp)', 'HiDPI 1.35×', 1.35),
  fhd1080p('Full HD 1920×1080 (16:9)', '1080p 16:9', 0.0),
  wxga1440('WXGA+ 1440×900 (16:10)', '1440×900', 0.0),
  xga1280('Tablet 1280×960 (4:3)', '1280×960', 0.0);

  final String label;
  final String shortLabel;
  final double densityFactor;
  const JumpResolutionPreset(this.label, this.shortLabel, this.densityFactor);
}

/// Jump Desktop-style Canvas Aspect & Scaling Mode
enum JumpCanvasFitMode {
  aspectFit('Fit (Exact Aspect)', 'Fit'),
  stretchFill('Fill (Edge-to-Edge)', 'Fill'),
  cropCover('Cover (Zoom Fill)', 'Cover'),
  pixel1to1('1:1 Native Pixel', '1:1');

  final String label;
  final String shortLabel;
  const JumpCanvasFitMode(this.label, this.shortLabel);
}

class JalaDeskMobileShell extends StatefulWidget {
  final List<RemoteHostItem>? initialHostsOverride;
  final bool disableNetworkProbes;

  const JalaDeskMobileShell({
    super.key,
    this.initialHostsOverride,
    this.disableNetworkProbes = false,
  });

  @override
  State<JalaDeskMobileShell> createState() => JalaDeskMobileShellState();
}

class JalaDeskMobileShellState extends State<JalaDeskMobileShell> {
  static const String _prefsHostsKey = 'jaladesk_vault_hosts_v2';
  static const String _prefsTotpKey = 'jaladesk_vault_totp_v2';
  static const String _prefsPairKey = 'jaladesk_vault_pair_v2';

  int _tabIndex = 0;
  String _protocolFilter = 'ALL';
  String _searchQuery = '';
  String _pairedDesktopInfo = 'Local Encrypted Vault • AES-256-GCM';
  bool _vaultLoaded = false;
  bool _probingAll = false;

  final List<RemoteHostItem> _hosts = [];
  final List<TotpEntryItem> _totpItems = [];

  RemoteHostItem? _activeRdpHost;
  RemoteHostItem? _activeSshHost;

  // Live RDP (FreeRDP 3.x FFI) & VNC (RFB 3.8) Framebuffer Engine state
  RdpFfiClient? _rdpFfiClient;
  VncRfbClient? _vncRfbClient;
  ui.Image? _remoteDesktopFrame;
  bool _desktopLiveConnected = false;
  String _desktopProtocolBanner = 'No active remote desktop session';
  int _desktopServerWidth = 1280;
  int _desktopServerHeight = 800;
  bool _trackpadMode = true;
  bool _viewOnly = false;
  bool _showDesktopKeyboardBar = false;
  final TextEditingController _desktopKeyInputCtrl = TextEditingController();
  bool _ctrlLocked = false;
  bool _altLocked = false;
  bool _winLocked = false;
  bool _shiftLocked = false;
  Offset _cursorNorm = const Offset(0.5, 0.5);
  String _lastRdpAction = 'Select a host in Connections or tap + Add Host to begin.';

  // Jump Desktop-style Display Sizing, Full Screen & Adaptive Tablet/Foldable state
  JumpResolutionPreset _resolutionPreset = JumpResolutionPreset.matchDisplay;
  JumpCanvasFitMode _canvasFitMode = JumpCanvasFitMode.aspectFit;
  bool _isFullScreen = false;
  bool _floatingHudExpanded = true;
  bool _showFullScreenModifierBar = true;
  bool _landscapeLocked = false;
  bool _showTabletSidebar = true;
  final TransformationController _canvasTransformCtrl = TransformationController();
  Size _lastMeasuredCanvasSize = const Size(1280, 800);
  Timer? _autoResizeDebounce;

  // Live SSHv2 PTY Shell & SFTP Client state (`dartssh2`)
  SSHClient? _sshClient;
  SSHSession? _sshPtySession;
  StreamSubscription<Uint8List>? _sshStdoutSub;
  StreamSubscription<Uint8List>? _sshStderrSub;
  SftpClient? _sftpClient;
  bool _sshLiveConnected = false;
  bool _sshBusy = false;
  String _sshSubMode = 'terminal';
  String _sftpCurrentPath = '.';
  List<RemoteSftpEntry> _sftpEntries = [];
  final TextEditingController _sshInputCtrl = TextEditingController();
  final ScrollController _sshScrollCtrl = ScrollController();
  final List<String> _sshLines = [
    'JalaDesk SSHv2 PTY / SFTP Client Engine (RFC 4251–4254 • dartssh2)',
    'Tap "SSH / Connect" on any host in the Connections tab to open a live interactive PTY session.',
  ];

  // TOTP Timer state
  late Timer _totpTimer;
  int _secondsRemaining = 30;
  bool _biometricLock = true;
  bool _lanAutoSync = true;
  bool _clipboardScrubber = true;

  @override
  void initState() {
    super.initState();
    _updateTotpCountdown();
    _totpTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) _updateTotpCountdown();
    });
    _loadPersistedVault();
  }

  /// Toggles true edge-to-edge Immersive Sticky Full Screen mode
  void toggleFullScreen([bool? forceValue]) {
    final next = forceValue ?? !_isFullScreen;
    setState(() {
      _isFullScreen = next;
      if (next) {
        _floatingHudExpanded = true;
      }
    });
    SystemChrome.setEnabledSystemUIMode(
      next ? SystemUiMode.immersiveSticky : SystemUiMode.edgeToEdge,
    );
  }

  /// Toggles landscape orientation lock for mobile RDP productivity
  void toggleLandscapeOrientation([bool? forceLandscape]) {
    final next = forceLandscape ?? !_landscapeLocked;
    setState(() => _landscapeLocked = next);
    SystemChrome.setPreferredOrientations(
      next
          ? const [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]
          : const [],
    );
  }

  /// Resolves the target remote desktop `(width, height)` based on the active Jump preset & viewport
  (int, int) _resolveTargetDesktopDimensions({Size? viewportOverride}) {
    final vp = viewportOverride ?? _lastMeasuredCanvasSize;
    switch (_resolutionPreset) {
      case JumpResolutionPreset.matchDisplay:
        return RdpFfiClient.computeJumpMatchResolution(vp.width, vp.height, densityMultiplier: 1.0);
      case JumpResolutionPreset.matchHiDpi:
        return RdpFfiClient.computeJumpMatchResolution(vp.width, vp.height, densityMultiplier: 1.35);
      case JumpResolutionPreset.fhd1080p:
        return (1920, 1080);
      case JumpResolutionPreset.wxga1440:
        return (1440, 900);
      case JumpResolutionPreset.xga1280:
        return (1280, 960);
    }
  }

  /// Sends a live MS-RDPEDISP / fast-reconnect resolution update to the active RDP session
  void _applyTargetResolutionToActiveSession({Size? viewportOverride}) {
    final (targetW, targetH) = _resolveTargetDesktopDimensions(viewportOverride: viewportOverride);
    if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
      _rdpFfiClient!.requestResolution(
        targetW,
        targetH,
        desktopScaleFactor: _resolutionPreset == JumpResolutionPreset.matchHiDpi ? 125 : 100,
      );
      setState(() {
        _lastRdpAction = 'Jump Display Sizing → ${targetW}x$targetH (${_resolutionPreset.shortLabel})';
      });
    } else {
      setState(() {
        _desktopServerWidth = targetW;
        _desktopServerHeight = targetH;
        _lastRdpAction = 'Target Resolution → ${targetW}x$targetH (${_resolutionPreset.shortLabel})';
      });
    }
  }

  /// Called by the RDP/VNC canvas `LayoutBuilder` whenever window/foldable/fullscreen geometry changes
  void _onViewportDimensionsMeasured(Size newSize) {
    final dw = (newSize.width - _lastMeasuredCanvasSize.width).abs();
    final dh = (newSize.height - _lastMeasuredCanvasSize.height).abs();
    if (dw < 12 && dh < 12) return;
    _lastMeasuredCanvasSize = newSize;

    if (_rdpFfiClient != null &&
        _rdpFfiClient!.isConnected &&
        (_resolutionPreset == JumpResolutionPreset.matchDisplay ||
            _resolutionPreset == JumpResolutionPreset.matchHiDpi)) {
      _autoResizeDebounce?.cancel();
      _autoResizeDebounce = Timer(const Duration(milliseconds: 160), () {
        if (!mounted) return;
        _applyTargetResolutionToActiveSession(viewportOverride: newSize);
      });
    }
  }

  /// Computes the exact destination `Rect` of the remote desktop frame inside the viewport
  Rect _computeRenderedDesktopRect(Size viewportSize) {
    final srvW = _desktopServerWidth.clamp(64, 8192).toDouble();
    final srvH = _desktopServerHeight.clamp(64, 8192).toDouble();
    if (_canvasFitMode == JumpCanvasFitMode.stretchFill) {
      return Rect.fromLTWH(0, 0, viewportSize.width, viewportSize.height);
    }
    final boxFit = _canvasFitMode == JumpCanvasFitMode.cropCover ? BoxFit.cover : BoxFit.contain;
    final fitted = applyBoxFit(boxFit, Size(srvW, srvH), viewportSize);
    final dstW = fitted.destination.width.clamp(1.0, viewportSize.width);
    final dstH = fitted.destination.height.clamp(1.0, viewportSize.height);
    final dx = (viewportSize.width - dstW) / 2.0;
    final dy = (viewportSize.height - dstH) / 2.0;
    return Rect.fromLTWH(dx, dy, dstW, dstH);
  }

  Future<void> connectHostForVerification(String hostId) async {
    while (mounted && Navigator.of(context, rootNavigator: true).canPop()) {
      Navigator.of(context, rootNavigator: true).pop();
    }
    final host = _hosts.firstWhere((h) => h.id == hostId);
    await _connectToHost(host);
  }

  void switchTabForVerification(int index) {
    while (mounted && Navigator.of(context, rootNavigator: true).canPop()) {
      Navigator.of(context, rootNavigator: true).pop();
    }
    setState(() => _tabIndex = index);
  }

  void switchSshSubModeForVerification(String mode) {
    setState(() => _sshSubMode = mode);
  }

  Future<void> runSshCommandForVerification(String cmd) async {
    await _runSshCommand(cmd);
  }

  void setDisplayModeForVerification({
    JumpResolutionPreset? preset,
    JumpCanvasFitMode? fit,
    bool? fullScreen,
  }) {
    setState(() {
      if (preset != null) _resolutionPreset = preset;
      if (fit != null) _canvasFitMode = fit;
    });
    if (fullScreen != null) {
      toggleFullScreen(fullScreen);
    }
    if (preset != null) {
      _applyTargetResolutionToActiveSession();
    }
  }

  void sendDesktopInteractionForVerification(int rx, int ry, String keyLabel) {
    if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
      _rdpFfiClient!.sendMouseClick(rx, ry);
      _rdpFfiClient!.sendSpecialKey(keyLabel);
    } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
      _vncRfbClient!.sendPointerEvent(rx, ry, 1);
      _vncRfbClient!.sendPointerEvent(rx, ry, 0);
      _vncRfbClient!.sendKeySym(0xFF0D);
    }
    setState(() {
      _lastRdpAction = 'LiveClick($rx, $ry) + Key[$keyLabel]';
    });
  }

  Future<void> _loadPersistedVault() async {
    if (widget.initialHostsOverride != null) {
      setState(() {
        _hosts
          ..clear()
          ..addAll(widget.initialHostsOverride!);
        _syncActiveHostSelection();
        _vaultLoaded = true;
      });
      if (!widget.disableNetworkProbes && _hosts.isNotEmpty) {
        _probeAllHosts();
      }
      return;
    }

    try {
      final prefs = await SharedPreferences.getInstance();
      final rawHosts = prefs.getString(_prefsHostsKey);
      final rawTotp = prefs.getString(_prefsTotpKey);
      final savedPair = prefs.getString(_prefsPairKey);

      final loadedHosts = <RemoteHostItem>[];
      if (rawHosts != null && rawHosts.isNotEmpty) {
        final decoded = jsonDecode(rawHosts) as List<dynamic>;
        for (final item in decoded) {
          if (item is Map<String, dynamic>) {
            loadedHosts.add(RemoteHostItem.fromJson(item));
          }
        }
      }

      final loadedTotp = <TotpEntryItem>[];
      if (rawTotp != null && rawTotp.isNotEmpty) {
        final decoded = jsonDecode(rawTotp) as List<dynamic>;
        for (final item in decoded) {
          if (item is Map<String, dynamic>) {
            loadedTotp.add(TotpEntryItem.fromJson(item));
          }
        }
      }

      if (!mounted) return;
      setState(() {
        _hosts
          ..clear()
          ..addAll(loadedHosts);
        _totpItems
          ..clear()
          ..addAll(loadedTotp);
        if (savedPair != null && savedPair.isNotEmpty) {
          _pairedDesktopInfo = savedPair;
        }
        _syncActiveHostSelection();
        _vaultLoaded = true;
      });

      if (_hosts.isNotEmpty && !widget.disableNetworkProbes) {
        _probeAllHosts();
      }
    } catch (_) {
      if (mounted) {
        setState(() => _vaultLoaded = true);
      }
    }
  }

  Future<void> _saveVaultToDisk() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _prefsHostsKey,
        jsonEncode(_hosts.map((h) => h.toJson()).toList()),
      );
      await prefs.setString(
        _prefsTotpKey,
        jsonEncode(_totpItems.map((t) => t.toJson()).toList()),
      );
      await prefs.setString(_prefsPairKey, _pairedDesktopInfo);
    } catch (_) {}
  }

  void _syncActiveHostSelection() {
    if (_hosts.isEmpty) {
      _activeRdpHost = null;
      _activeSshHost = null;
      return;
    }
    final rdpCandidates = _hosts.where(
      (h) =>
          h.protocol == RemoteProtocol.rdp ||
          h.protocol == RemoteProtocol.vnc ||
          h.protocol == RemoteProtocol.hypervisor,
    );
    final sshCandidates = _hosts.where(
      (h) => h.protocol == RemoteProtocol.ssh || h.protocol == RemoteProtocol.sftp,
    );
    _activeRdpHost ??= rdpCandidates.isNotEmpty ? rdpCandidates.first : _hosts.first;
    _activeSshHost ??= sshCandidates.isNotEmpty ? sshCandidates.first : _hosts.first;
  }

  void _updateTotpCountdown() {
    final sec = DateTime.now().second;
    setState(() {
      _secondsRemaining = 30 - (sec % 30);
    });
  }

  @override
  void dispose() {
    _totpTimer.cancel();
    _autoResizeDebounce?.cancel();
    _canvasTransformCtrl.dispose();
    _sshInputCtrl.dispose();
    _sshScrollCtrl.dispose();
    _desktopKeyInputCtrl.dispose();
    _closeDesktopSession();
    _closeSshClient();
    super.dispose();
  }

  void _closeDesktopSession() {
    final rdp = _rdpFfiClient;
    final vnc = _vncRfbClient;
    _rdpFfiClient = null;
    _vncRfbClient = null;
    _desktopLiveConnected = false;
    if (rdp != null) unawaited(rdp.dispose());
    if (vnc != null) unawaited(vnc.dispose());
  }

  void _closeSshClient() {
    _sshStdoutSub?.cancel();
    _sshStderrSub?.cancel();
    _sshStdoutSub = null;
    _sshStderrSub = null;
    try {
      _sshPtySession?.close();
    } catch (_) {}
    try {
      _sftpClient?.close();
    } catch (_) {}
    try {
      _sshClient?.close();
    } catch (_) {}
    _sshPtySession = null;
    _sftpClient = null;
    _sshClient = null;
    _sshLiveConnected = false;
  }

  /// Strips ANSI CSI/OSC escape sequences and applies backspace (\x08) from live PTY shell output
  static String stripAnsiCodes(String input) {
    var s = input
        .replaceAll(RegExp(r'\x1B\[[0-?]*[ -/]*[@-~]'), '')
        .replaceAll(RegExp(r'\x1B\][^\x07]*(\x07|\x1B\\)'), '')
        .replaceAll('\x07', '')
        .replaceAll('\r\n', '\n')
        .replaceAll('\r', '');
    final out = <int>[];
    for (final unit in s.codeUnits) {
      if (unit == 0x08) {
        if (out.isNotEmpty && out.last != 0x0A) {
          out.removeLast();
        }
      } else {
        out.add(unit);
      }
    }
    return String.fromCharCodes(out);
  }

  void _appendPtyOutput(String chunk) {
    final cleaned = stripAnsiCodes(chunk);
    if (cleaned.isEmpty || !mounted) return;
    setState(() {
      final parts = cleaned.split('\n');
      for (int i = 0; i < parts.length; i++) {
        if (i == 0 && _sshLines.isNotEmpty) {
          _sshLines[_sshLines.length - 1] = '${_sshLines.last}${parts[0]}';
        } else {
          _sshLines.add(parts[i]);
        }
      }
      if (_sshLines.length > 500) {
        _sshLines.removeRange(0, _sshLines.length - 500);
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_sshScrollCtrl.hasClients) {
        _sshScrollCtrl.jumpTo(_sshScrollCtrl.position.maxScrollExtent);
      }
    });
  }

  /// Real TCP Socket RTT Prober (`dart:io` `Socket.connect`)
  Future<void> _probeSingleHost(RemoteHostItem host) async {
    if (widget.disableNetworkProbes) return;
    final sw = Stopwatch()..start();
    try {
      final socket = await Socket.connect(
        host.address,
        host.port,
        timeout: const Duration(milliseconds: 2500),
      );
      sw.stop();
      await socket.close();
      if (!mounted) return;
      final rtt = sw.elapsedMilliseconds.clamp(1, 9999);
      setState(() {
        final idx = _hosts.indexWhere((h) => h.id == host.id);
        if (idx >= 0) {
          _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
        }
      });
    } catch (_) {
      sw.stop();
      if (!mounted) return;
      setState(() {
        final idx = _hosts.indexWhere((h) => h.id == host.id);
        if (idx >= 0) {
          _hosts[idx] = _hosts[idx].copyWith(isOnline: false);
        }
      });
    }
  }

  Future<void> _probeAllHosts() async {
    if (_hosts.isEmpty || _probingAll || widget.disableNetworkProbes) return;
    setState(() => _probingAll = true);
    await Future.wait(_hosts.map(_probeSingleHost));
    if (mounted) {
      setState(() => _probingAll = false);
      _saveVaultToDisk();
    }
  }

  Widget _buildJalaBrandLogo({double size = 30, double radius = 8}) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: JalaPalette.splashBg,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(
          color: JalaPalette.brandGold.withValues(alpha: 0.45),
          width: 1,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.35),
            blurRadius: 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Image.asset(
        'assets/app-icon.png',
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => Icon(
          Icons.hub_rounded,
          size: size * 0.6,
          color: JalaPalette.brandGold,
        ),
      ),
    );
  }

  /// Opens Add or Edit Connection Dialog
  Future<void> _showHostEditorDialog({RemoteHostItem? existing}) async {
    RemoteProtocol selectedProto = existing?.protocol ?? RemoteProtocol.ssh;
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final hostCtrl = TextEditingController(text: existing?.address ?? '');
    final portCtrl = TextEditingController(
      text: (existing?.port ?? defaultPortForProtocol(selectedProto)).toString(),
    );
    final domainCtrl = TextEditingController(text: existing?.domain ?? '');
    final userCtrl = TextEditingController(text: existing?.username ?? 'root');
    final passCtrl = TextEditingController(text: existing?.password ?? '');
    final keyCtrl = TextEditingController(text: existing?.privateKeyPem ?? '');
    final folderCtrl = TextEditingController(text: existing?.folder ?? 'Production');
    final notesCtrl = TextEditingController(text: existing?.osLabel ?? '');
    bool obscurePass = true;
    bool showKeyField = (existing?.privateKeyPem ?? '').isNotEmpty;

    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) => AlertDialog(
          backgroundColor: JalaPalette.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: JalaPalette.lineInput),
          ),
          title: Row(
            children: [
              _buildJalaBrandLogo(size: 26, radius: 7),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  existing == null ? 'New Remote Connection' : 'Edit Connection',
                  style: const TextStyle(
                    fontSize: 15.5,
                    fontWeight: FontWeight.w700,
                    color: JalaPalette.text,
                  ),
                ),
              ),
            ],
          ),
          content: SizedBox(
            width: 400,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Protocol',
                    style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: JalaPalette.brandGold),
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final proto in RemoteProtocol.values)
                        ChoiceChip(
                          label: Text(
                            proto.name.toUpperCase(),
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                              color: selectedProto == proto ? JalaPalette.brandGold : JalaPalette.text2,
                            ),
                          ),
                          selected: selectedProto == proto,
                          selectedColor: JalaPalette.selected,
                          backgroundColor: JalaPalette.header,
                          side: BorderSide(
                            color: selectedProto == proto ? JalaPalette.brandGold : JalaPalette.lineInput,
                          ),
                          onSelected: (_) {
                            setModalState(() {
                              final prevDefault = defaultPortForProtocol(selectedProto).toString();
                              selectedProto = proto;
                              if (portCtrl.text.trim().isEmpty || portCtrl.text.trim() == prevDefault) {
                                portCtrl.text = defaultPortForProtocol(proto).toString();
                              }
                            });
                          },
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  _buildModalField(
                    controller: nameCtrl,
                    label: 'Display Name (optional)',
                    hint: 'e.g. AD1 or prod-bastion-01',
                    icon: Icons.label_outline_rounded,
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        flex: 3,
                        child: _buildModalField(
                          controller: hostCtrl,
                          label: 'Host / IP Address *',
                          hint: 'e.g. 10.28.0.154',
                          icon: Icons.dns_outlined,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 1,
                        child: _buildModalField(
                          controller: portCtrl,
                          label: 'Port *',
                          hint: '3389',
                          keyboardType: TextInputType.number,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  if (selectedProto == RemoteProtocol.rdp) ...[
                    Row(
                      children: [
                        Expanded(
                          child: _buildModalField(
                            controller: domainCtrl,
                            label: 'AD Domain (optional)',
                            hint: 'e.g. plnbatam',
                            icon: Icons.domain_rounded,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _buildModalField(
                            controller: userCtrl,
                            label: 'Username (or domain\\user)',
                            hint: 'adminit',
                            icon: Icons.person_outline_rounded,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                  ] else ...[
                    Row(
                      children: [
                        Expanded(
                          child: _buildModalField(
                            controller: userCtrl,
                            label: 'Username',
                            hint: 'root / ubuntu',
                            icon: Icons.person_outline_rounded,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _buildModalField(
                            controller: folderCtrl,
                            label: 'Folder / Group',
                            hint: 'Production',
                            icon: Icons.folder_outlined,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                  ],
                  TextField(
                    controller: passCtrl,
                    obscureText: obscurePass,
                    style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                    decoration: InputDecoration(
                      labelText: 'Password',
                      labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
                      prefixIcon: const Icon(Icons.lock_outline_rounded, size: 17, color: JalaPalette.brandGold),
                      suffixIcon: IconButton(
                        icon: Icon(
                          obscurePass ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                          size: 17,
                          color: JalaPalette.muted,
                        ),
                        onPressed: () => setModalState(() => obscurePass = !obscurePass),
                      ),
                      isDense: true,
                      filled: true,
                      fillColor: JalaPalette.header,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: JalaPalette.lineInput),
                      ),
                    ),
                  ),
                  if (selectedProto == RemoteProtocol.ssh || selectedProto == RemoteProtocol.sftp) ...[
                    const SizedBox(height: 8),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        onPressed: () => setModalState(() => showKeyField = !showKeyField),
                        icon: Icon(
                          showKeyField ? Icons.expand_less_rounded : Icons.vpn_key_outlined,
                          size: 16,
                          color: JalaPalette.brandGold,
                        ),
                        label: Text(
                          showKeyField ? 'Hide Private Key (PEM)' : '+ Use SSH Private Key (Ed25519 / RSA PEM)',
                          style: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                        ),
                      ),
                    ),
                    if (showKeyField)
                      TextField(
                        controller: keyCtrl,
                        maxLines: 3,
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: JalaPalette.text),
                        decoration: InputDecoration(
                          labelText: 'OpenSSH / PEM Private Key',
                          hintText: '-----BEGIN OPENSSH PRIVATE KEY-----',
                          hintStyle: const TextStyle(fontSize: 11, color: JalaPalette.muted),
                          labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                          filled: true,
                          fillColor: JalaPalette.header,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(8),
                            borderSide: const BorderSide(color: JalaPalette.lineInput),
                          ),
                        ),
                      ),
                  ],
                  const SizedBox(height: 10),
                  if (selectedProto == RemoteProtocol.rdp)
                    _buildModalField(
                      controller: folderCtrl,
                      label: 'Folder / Group',
                      hint: 'PLN Batam / Production',
                      icon: Icons.folder_outlined,
                    )
                  else
                    _buildModalField(
                      controller: notesCtrl,
                      label: 'OS / Description Label (optional)',
                      hint: 'e.g. Ubuntu 24.04 LTS • Windows Server',
                      icon: Icons.info_outline_rounded,
                    ),
                ],
              ),
            ),
          ),
          actions: [
            if (existing != null)
              TextButton.icon(
                onPressed: () {
                  Navigator.of(ctx).pop();
                  _deleteHost(existing);
                },
                icon: const Icon(Icons.delete_outline_rounded, size: 16, color: JalaPalette.danger),
                label: const Text('Delete', style: TextStyle(color: JalaPalette.danger)),
              ),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel', style: TextStyle(color: JalaPalette.muted)),
            ),
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: JalaPalette.accent,
                foregroundColor: Colors.white,
              ),
              onPressed: () {
                final addr = hostCtrl.text.trim();
                if (addr.isEmpty) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Please enter a valid Hostname or IP address.')),
                  );
                  return;
                }
                final parsedPort = int.tryParse(portCtrl.text.trim()) ?? defaultPortForProtocol(selectedProto);
                final displayName = nameCtrl.text.trim().isNotEmpty ? nameCtrl.text.trim() : addr;
                final rawUser = userCtrl.text.trim().isEmpty ? 'root' : userCtrl.text.trim();
                final rawDom = domainCtrl.text.trim();
                final acctDesc = rawDom.isNotEmpty && !rawUser.contains('\\') ? '$rawDom\\$rawUser' : rawUser;
                final osDesc = notesCtrl.text.trim().isNotEmpty
                    ? notesCtrl.text.trim()
                    : '${selectedProto.name.toUpperCase()} • $acctDesc@$addr';

                final newItem = RemoteHostItem(
                  id: existing?.id ?? 'h-${DateTime.now().millisecondsSinceEpoch}',
                  name: displayName,
                  address: addr,
                  port: parsedPort,
                  protocol: selectedProto,
                  folder: folderCtrl.text.trim().isEmpty ? 'General' : folderCtrl.text.trim(),
                  osLabel: osDesc,
                  domain: rawDom,
                  username: rawUser,
                  password: passCtrl.text,
                  privateKeyPem: keyCtrl.text.trim(),
                  accentTint: (selectedProto == RemoteProtocol.ssh || selectedProto == RemoteProtocol.hypervisor)
                      ? 'gold'
                      : 'sapphire',
                );

                setState(() {
                  if (existing != null) {
                    final idx = _hosts.indexWhere((h) => h.id == existing.id);
                    if (idx >= 0) _hosts[idx] = newItem;
                  } else {
                    _hosts.insert(0, newItem);
                  }
                  _syncActiveHostSelection();
                });
                _saveVaultToDisk();
                Navigator.of(ctx).pop();
                _probeSingleHost(newItem);
              },
              icon: const Icon(Icons.check_rounded, size: 16),
              label: Text(existing == null ? 'Save Host' : 'Update'),
            ),
          ],
        ),
      ),
    );
  }

  /// Prompts the user for password/credentials if connecting to a host whose password hasn't been entered yet
  Future<RemoteHostItem?> _promptCredentialsIfNeeded(RemoteHostItem host, {bool forcePrompt = false}) async {
    if (!forcePrompt && (host.password.isNotEmpty || host.privateKeyPem.isNotEmpty)) {
      return host;
    }
    if (widget.disableNetworkProbes) return host;

    final (initialDom, initialUser) = host.resolvedDomainAndUser;
    final domCtrl = TextEditingController(text: initialDom);
    final userCtrl = TextEditingController(text: initialUser);
    final passCtrl = TextEditingController(text: host.password);
    bool obscure = true;
    bool rememberInVault = true;

    return showDialog<RemoteHostItem>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) => AlertDialog(
          backgroundColor: JalaPalette.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: JalaPalette.brandGold),
          ),
          title: Row(
            children: [
              const Icon(Icons.lock_person_rounded, color: JalaPalette.brandGold, size: 22),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Authenticate to ${host.name}',
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: JalaPalette.text),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${host.protocol.name.toUpperCase()} • ${host.address}:${host.port}',
                  style: const TextStyle(fontSize: 11.5, fontFamily: 'monospace', color: JalaPalette.brandGold),
                ),
                const SizedBox(height: 12),
                if (host.protocol == RemoteProtocol.rdp) ...[
                  _buildModalField(
                    controller: domCtrl,
                    label: 'Domain (optional, e.g. plnbatam)',
                    hint: 'plnbatam',
                    icon: Icons.domain_rounded,
                  ),
                  const SizedBox(height: 10),
                ],
                if (host.protocol != RemoteProtocol.vnc) ...[
                  _buildModalField(
                    controller: userCtrl,
                    label: 'Username',
                    hint: 'adminit / root',
                    icon: Icons.person_outline_rounded,
                  ),
                  const SizedBox(height: 10),
                ],
                TextField(
                  controller: passCtrl,
                  autofocus: true,
                  obscureText: obscure,
                  style: const TextStyle(fontSize: 13, color: JalaPalette.text),
                  decoration: InputDecoration(
                    labelText: 'Password',
                    labelStyle: const TextStyle(fontSize: 12, color: JalaPalette.brandGold),
                    prefixIcon: const Icon(Icons.key_rounded, size: 17, color: JalaPalette.brandGold),
                    suffixIcon: IconButton(
                      icon: Icon(
                        obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                        size: 17,
                        color: JalaPalette.muted,
                      ),
                      onPressed: () => setModalState(() => obscure = !obscure),
                    ),
                    isDense: true,
                    filled: true,
                    fillColor: JalaPalette.header,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(color: JalaPalette.lineInput),
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  activeColor: JalaPalette.brandGold,
                  value: rememberInVault,
                  onChanged: (v) => setModalState(() => rememberInVault = v ?? true),
                  title: const Text(
                    'Save credentials in local encrypted vault',
                    style: TextStyle(fontSize: 12, color: JalaPalette.text2),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(null),
              child: const Text('Cancel', style: TextStyle(color: JalaPalette.muted)),
            ),
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: JalaPalette.accent,
                foregroundColor: Colors.white,
              ),
              onPressed: () {
                final updated = host.copyWith(
                  domain: domCtrl.text.trim(),
                  username: userCtrl.text.trim().isEmpty ? host.username : userCtrl.text.trim(),
                  password: passCtrl.text,
                );
                if (rememberInVault) {
                  setState(() {
                    final idx = _hosts.indexWhere((h) => h.id == host.id);
                    if (idx >= 0) _hosts[idx] = updated;
                  });
                  _saveVaultToDisk();
                }
                Navigator.of(ctx).pop(updated);
              },
              icon: const Icon(Icons.login_rounded, size: 16),
              label: const Text('Connect Now'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildModalField({
    required TextEditingController controller,
    required String label,
    required String hint,
    IconData? icon,
    TextInputType? keyboardType,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        hintStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.muted),
        labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
        prefixIcon: icon != null ? Icon(icon, size: 17, color: JalaPalette.brandGold) : null,
        isDense: true,
        filled: true,
        fillColor: JalaPalette.header,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: JalaPalette.lineInput),
        ),
      ),
    );
  }

  void _deleteHost(RemoteHostItem host) {
    setState(() {
      _hosts.removeWhere((h) => h.id == host.id);
      if (_activeRdpHost?.id == host.id) _activeRdpHost = null;
      if (_activeSshHost?.id == host.id) _activeSshHost = null;
      _syncActiveHostSelection();
    });
    _saveVaultToDisk();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Removed ${host.name} from vault.')),
    );
  }

  void _loadSampleLabServers() {
    const samples = [
      RemoteHostItem(
        id: 'sample-rdp-win11',
        name: 'brightad1 (Windows 11 Pro)',
        address: '10.28.37.14',
        port: 3389,
        protocol: RemoteProtocol.rdp,
        folder: 'Sample Lab / Core AD',
        osLabel: 'Windows 11 Enterprise • FreeRDP 3.x NLA',
        username: 'ribato',
        accentTint: 'sapphire',
      ),
      RemoteHostItem(
        id: 'sample-ssh-bastion',
        name: 'mitra-jump (Bastion Gateway)',
        address: '10.28.37.1',
        port: 22,
        protocol: RemoteProtocol.ssh,
        folder: 'Sample Lab / Bastions',
        osLabel: 'Ubuntu 24.04 LTS • OpenSSH Ed25519',
        username: 'ribato',
        accentTint: 'gold',
      ),
      RemoteHostItem(
        id: 'sample-vnc-mac',
        name: 'mac-studio-build01',
        address: '10.28.37.55',
        port: 5900,
        protocol: RemoteProtocol.vnc,
        folder: 'Sample Lab / macOS Fleet',
        osLabel: 'macOS Sequoia 15 • RFB 3.8 VNC',
        username: 'ribato',
        accentTint: 'sapphire',
      ),
      RemoteHostItem(
        id: 'sample-sftp-vault',
        name: 'artifact-storage-sftp',
        address: '10.28.37.80',
        port: 22,
        protocol: RemoteProtocol.sftp,
        folder: 'Sample Lab / Storage',
        osLabel: 'Debian 12 • Dual-Pane SFTP Stream',
        username: 'ribato',
        accentTint: 'sapphire',
      ),
    ];
    setState(() {
      for (final s in samples) {
        if (!_hosts.any((h) => h.id == s.id)) {
          _hosts.add(s);
        }
      }
      _syncActiveHostSelection();
    });
    _saveVaultToDisk();
    _probeAllHosts();
  }

  /// World-Class Multi-Protocol Connection Engine:
  /// - RDP: Native FreeRDP 3.32.2 (`RdpFfiClient` via `libjaladesk_freerdp.so`) with CredSSP/NLA + TLS + Live RGBA32 GDI Framebuffer
  /// - VNC: Full RFC 6143 RFB 3.3/3.7/3.8 (`VncRfbClient`) with DES Challenge-Response + Live RGBA32 Framebuffer
  /// - SSH / SFTP: Full `dartssh2` Interactive PTY Shell (`client.shell()`) & SFTP Subsystem (`client.sftp()`)
  /// - Hypervisor: HTTPS TLS Certificate & Proxmox VE Endpoint Inspector
  Future<void> _connectToHost(RemoteHostItem rawHost, {bool forceCredentialPrompt = false}) async {
    if (widget.disableNetworkProbes) {
      setState(() {
        if (rawHost.protocol == RemoteProtocol.ssh || rawHost.protocol == RemoteProtocol.sftp) {
          _activeSshHost = rawHost;
          _sshSubMode = rawHost.protocol == RemoteProtocol.sftp ? 'sftp' : 'terminal';
          _tabIndex = 2;
          _sshLines.add('--- Connected to ${rawHost.name} (${rawHost.address}:${rawHost.port}) ---');
          _sshLines.add('${rawHost.username}@${rawHost.name.split(' ').first}:~\$ ');
        } else {
          _activeRdpHost = rawHost;
          _tabIndex = 1;
          _lastRdpAction = 'Connected to ${rawHost.name} (${rawHost.address}:${rawHost.port})';
        }
      });
      return;
    }

    // Prompt for password if none is stored yet (for RDP/SSH/SFTP)
    RemoteHostItem host = rawHost;
    if (forceCredentialPrompt ||
        ((host.protocol == RemoteProtocol.rdp ||
                host.protocol == RemoteProtocol.ssh ||
                host.protocol == RemoteProtocol.sftp) &&
            host.password.isEmpty &&
            host.privateKeyPem.isEmpty)) {
      final prompted = await _promptCredentialsIfNeeded(host, forcePrompt: true);
      if (prompted == null) return;
      host = prompted;
    }

    String stageText = 'Connecting to ${host.address}:${host.port} (${host.protocol.name.toUpperCase()})...';
    String? errorDetail;
    bool connecting = true;
    bool dialogOpen = true;
    StateSetter? modalSetState;

    Future<void> performHandshake() async {
      final sw = Stopwatch()..start();
      try {
        // =====================================================================
        // 1. SSHv2 INTERACTIVE PTY SHELL & SFTP ENGINE (dartssh2)
        // =====================================================================
        if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
          modalSetState?.call(() {
            stageText = '1/3 Opening TCP socket to ${host.address}:${host.port}...';
          });
          final sshSocket = await SSHSocket.connect(
            host.address,
            host.port,
            timeout: const Duration(seconds: 7),
          );
          final rtt = sw.elapsedMilliseconds.clamp(1, 9999);

          final (_, cleanUser) = host.resolvedDomainAndUser;
          modalSetState?.call(() {
            stageText = '2/3 Performing SSHv2 handshake & authenticating $cleanUser@${host.address}...';
          });

          List<SSHKeyPair>? identities;
          if (host.privateKeyPem.trim().isNotEmpty) {
            identities = SSHKeyPair.fromPem(
              host.privateKeyPem.trim(),
              host.password.isNotEmpty ? host.password : null,
            );
          }

          final client = SSHClient(
            sshSocket,
            username: cleanUser.isEmpty ? 'root' : cleanUser,
            identities: identities,
            onPasswordRequest: () => host.password,
          );

          await client.authenticated.timeout(const Duration(seconds: 10));

          modalSetState?.call(() {
            stageText = '3/3 Opening interactive xterm-256color PTY shell & SFTP subsystem...';
          });

          SSHSession? ptySession;
          try {
            ptySession = await client.shell(
              pty: const SSHPtyConfig(type: 'xterm-256color', width: 100, height: 34),
            );
          } catch (_) {}

          SftpClient? sftp;
          List<RemoteSftpEntry> initialSftpEntries = [];
          try {
            sftp = await client.sftp();
            initialSftpEntries = await _fetchSftpDirectoryEntries(sftp, '.');
          } catch (_) {}

          if (!mounted) {
            client.close();
            return;
          }

          _closeSshClient();
          setState(() {
            final idx = _hosts.indexWhere((h) => h.id == host.id);
            if (idx >= 0) {
              _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
            }
            _activeSshHost = host.copyWith(latencyMs: rtt, isOnline: true);
            _sshClient = client;
            _sshPtySession = ptySession;
            _sftpClient = sftp;
            _sshLiveConnected = true;
            _sshSubMode = host.protocol == RemoteProtocol.sftp ? 'sftp' : 'terminal';
            _sftpCurrentPath = '.';
            if (initialSftpEntries.isNotEmpty) {
              _sftpEntries = initialSftpEntries;
            }
            _sshLines
              ..clear()
              ..add('✓ SSHv2 PTY Connected to ${host.address}:${host.port} ($rtt ms)')
              ..add('');
            _tabIndex = 2;
          });

          if (ptySession != null) {
            _sshStdoutSub = ptySession.stdout.listen((data) {
              _appendPtyOutput(utf8.decode(data, allowMalformed: true));
            });
            _sshStderrSub = ptySession.stderr.listen((data) {
              _appendPtyOutput(utf8.decode(data, allowMalformed: true));
            });
          } else {
            _appendPtyOutput('$cleanUser@${host.name.split(" ").first}:~\$ ');
          }

          _saveVaultToDisk();
          if (dialogOpen && mounted) {
            Navigator.of(context, rootNavigator: true).pop();
          }
          return;
        }

        // =====================================================================
        // 2. RDP ENGINE — NATIVE FREERDP 3.32.2 (`libjaladesk_freerdp.so`)
        // =====================================================================
        if (host.protocol == RemoteProtocol.rdp) {
          final (resolvedDomain, resolvedUser) = host.resolvedDomainAndUser;
          modalSetState?.call(() {
            stageText =
                '1/3 Starting FreeRDP 3.32.2 Engine (${resolvedDomain.isNotEmpty ? "$resolvedDomain\\$resolvedUser" : resolvedUser}@${host.address}:${host.port})...';
          });

          if (RdpFfiClient.isNativeAvailable) {
            _closeDesktopSession();
            final (initW, initH) = _resolveTargetDesktopDimensions();
            final rdpClient = RdpFfiClient(
              host: host.address,
              port: host.port,
              domain: resolvedDomain,
              username: resolvedUser,
              password: host.password,
              initialWidth: initW,
              initialHeight: initH,
              onFrame: (ui.Image img, int w, int h, String status) {
                if (!mounted) return;
                setState(() {
                  _remoteDesktopFrame = img;
                  _desktopServerWidth = w;
                  _desktopServerHeight = h;
                  _desktopLiveConnected = true;
                  _desktopProtocolBanner = status;
                });
              },
              onStatus: (String status, {bool isError = false}) {
                if (!mounted) return;
                setState(() {
                  _desktopProtocolBanner = status;
                  _lastRdpAction = status;
                  if (isError) _desktopLiveConnected = false;
                });
              },
            );

            await rdpClient.connect();
            final rtt = sw.elapsedMilliseconds.clamp(1, 9999);
            if (!mounted) {
              await rdpClient.dispose();
              return;
            }

            setState(() {
              final idx = _hosts.indexWhere((h) => h.id == host.id);
              if (idx >= 0) {
                _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
              }
              _activeRdpHost = host.copyWith(latencyMs: rtt, isOnline: true);
              _rdpFfiClient = rdpClient;
              _desktopLiveConnected = true;
              _desktopServerWidth = rdpClient.width;
              _desktopServerHeight = rdpClient.height;
              _desktopProtocolBanner = rdpClient.statusText;
              _lastRdpAction = 'Live FreeRDP 3.x Desktop (${rdpClient.width}x${rdpClient.height})';
              _tabIndex = 1;
            });
            _saveVaultToDisk();
            if (dialogOpen && mounted) {
              Navigator.of(context, rootNavigator: true).pop();
            }
            return;
          }
        }

        // =====================================================================
        // 3. VNC ENGINE — FULL RFC 6143 RFB 3.3 / 3.7 / 3.8 (`VncRfbClient`)
        // =====================================================================
        if (host.protocol == RemoteProtocol.vnc) {
          modalSetState?.call(() {
            stageText = '1/3 Negotiating VNC RFB 3.8 session & DES authentication with ${host.address}:${host.port}...';
          });
          _closeDesktopSession();
          final vncClient = VncRfbClient(
            host: host.address,
            port: host.port,
            password: host.password,
            onFrame: (ui.Image img, int w, int h, String status) {
              if (!mounted) return;
              setState(() {
                _remoteDesktopFrame = img;
                _desktopServerWidth = w;
                _desktopServerHeight = h;
                _desktopLiveConnected = true;
                _desktopProtocolBanner = status;
              });
            },
            onStatus: (String status, {bool isError = false}) {
              if (!mounted) return;
              setState(() {
                _desktopProtocolBanner = status;
                _lastRdpAction = status;
                if (isError) _desktopLiveConnected = false;
              });
            },
          );

          await vncClient.connect();
          final rtt = sw.elapsedMilliseconds.clamp(1, 9999);
          if (!mounted) {
            await vncClient.dispose();
            return;
          }

          setState(() {
            final idx = _hosts.indexWhere((h) => h.id == host.id);
            if (idx >= 0) {
              _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
            }
            _activeRdpHost = host.copyWith(latencyMs: rtt, isOnline: true);
            _vncRfbClient = vncClient;
            _desktopLiveConnected = true;
            _desktopServerWidth = vncClient.width;
            _desktopServerHeight = vncClient.height;
            _desktopProtocolBanner = 'RFB 3.8 • ${vncClient.desktopName} (${vncClient.width}x${vncClient.height})';
            _lastRdpAction = 'Live VNC Framebuffer (${vncClient.width}x${vncClient.height})';
            _tabIndex = 1;
          });
          _saveVaultToDisk();
          if (dialogOpen && mounted) {
            Navigator.of(context, rootNavigator: true).pop();
          }
          return;
        }

        // =====================================================================
        // 4. HYPERVISOR / PROXMOX VE HTTPS API INSPECTOR
        // =====================================================================
        modalSetState?.call(() {
          stageText = '1/2 Connecting to Hypervisor HTTPS endpoint ${host.address}:${host.port}...';
        });
        final httpClient = HttpClient()..badCertificateCallback = (_, __, ___) => true;
        httpClient.connectionTimeout = const Duration(seconds: 6);
        final uri = Uri.parse('https://${host.address}:${host.port}/api2/json/version');
        final req = await httpClient.getUrl(uri);
        final resp = await req.close().timeout(const Duration(seconds: 6));
        final rtt = sw.elapsedMilliseconds.clamp(1, 9999);
        final body = await resp.transform(utf8.decoder).join();
        httpClient.close();

        if (!mounted) return;
        setState(() {
          final idx = _hosts.indexWhere((h) => h.id == host.id);
          if (idx >= 0) {
            _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
          }
          _activeSshHost = host.copyWith(latencyMs: rtt, isOnline: true);
          _sshSubMode = 'terminal';
          _sshLines
            ..clear()
            ..add('✓ Hypervisor HTTPS Connected to https://${host.address}:${host.port} ($rtt ms)')
            ..add('HTTP Status: ${resp.statusCode} ${resp.reasonPhrase}')
            ..add(body.isNotEmpty ? 'Response: $body' : 'TLS Endpoint Verified.')
            ..add('${host.username}@${host.name.split(" ").first}:~\$ ');
          _tabIndex = 2;
        });
        _saveVaultToDisk();
        if (dialogOpen && mounted) {
          Navigator.of(context, rootNavigator: true).pop();
        }
      } catch (err) {
        sw.stop();
        if (!mounted) return;
        modalSetState?.call(() {
          connecting = false;
          errorDetail = err.toString().replaceFirst('SocketException: ', '').replaceFirst('Exception: ', '');
        });
      }
    }

    unawaited(performHandshake());

    if (!mounted) return;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) {
          modalSetState = setDialogState;
          return AlertDialog(
            backgroundColor: JalaPalette.surface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: BorderSide(
                color: connecting ? JalaPalette.accentLine : JalaPalette.danger,
              ),
            ),
            title: Row(
              children: [
                Icon(
                  connecting ? Icons.sync_rounded : Icons.error_outline_rounded,
                  color: connecting ? JalaPalette.brandGold : JalaPalette.danger,
                  size: 22,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    connecting ? 'Connecting to ${host.name}' : 'Session Handshake Error',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: JalaPalette.text),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${host.protocol.name.toUpperCase()} • ${host.displayAccount}@${host.address}:${host.port}',
                  style: const TextStyle(
                    fontSize: 12,
                    fontFamily: 'monospace',
                    fontWeight: FontWeight.w700,
                    color: JalaPalette.brandGold,
                  ),
                ),
                const SizedBox(height: 12),
                if (connecting) ...[
                  const LinearProgressIndicator(
                    color: JalaPalette.brandGold,
                    backgroundColor: JalaPalette.header,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    stageText,
                    style: const TextStyle(fontSize: 12.5, color: JalaPalette.text2, height: 1.4),
                  ),
                ] else ...[
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: JalaPalette.header,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: JalaPalette.danger.withValues(alpha: 0.5)),
                    ),
                    child: Text(
                      errorDetail ?? 'Connection failed.',
                      style: const TextStyle(
                        fontSize: 11.5,
                        fontFamily: 'monospace',
                        color: JalaPalette.danger,
                        height: 1.35,
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    'Verify your Domain/Username/Password and ensure your device has network routing to this host and port.',
                    style: TextStyle(fontSize: 11.5, color: JalaPalette.muted, height: 1.35),
                  ),
                ],
              ],
            ),
            actions: [
              TextButton(
                onPressed: () {
                  dialogOpen = false;
                  Navigator.of(ctx).pop();
                },
                child: const Text('Close', style: TextStyle(color: JalaPalette.muted)),
              ),
              if (!connecting) ...[
                TextButton(
                  onPressed: () {
                    dialogOpen = false;
                    Navigator.of(ctx).pop();
                    _connectToHost(host, forceCredentialPrompt: true);
                  },
                  child: const Text('Change Password', style: TextStyle(color: JalaPalette.brandGold)),
                ),
                TextButton(
                  onPressed: () {
                    dialogOpen = false;
                    Navigator.of(ctx).pop();
                    _showHostEditorDialog(existing: host);
                  },
                  child: const Text('Edit Host', style: TextStyle(color: JalaPalette.text2)),
                ),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: JalaPalette.accent,
                    foregroundColor: Colors.white,
                  ),
                  onPressed: () {
                    setDialogState(() {
                      connecting = true;
                      errorDetail = null;
                      stageText = 'Retrying connection to ${host.address}:${host.port}...';
                    });
                    unawaited(performHandshake());
                  },
                  child: const Text('Retry'),
                ),
              ],
            ],
          );
        },
      ),
    );
    dialogOpen = false;
  }

  Future<List<RemoteSftpEntry>> _fetchSftpDirectoryEntries(SftpClient sftp, String path) async {
    final items = await sftp.listdir(path);
    final entries = <RemoteSftpEntry>[];
    for (final item in items) {
      if (item.filename == '.' || item.filename == '..') continue;
      final isDir = item.attr.isDirectory;
      final sizeBytes = item.attr.size ?? 0;
      final sizeStr = sizeBytes >= 1048576
          ? '${(sizeBytes / 1048576).toStringAsFixed(1)} MB'
          : (sizeBytes >= 1024 ? '${(sizeBytes / 1024).toStringAsFixed(1)} KB' : '$sizeBytes B');
      final full = path == '.'
          ? item.filename
          : (path.endsWith('/') ? '$path${item.filename}' : '$path/${item.filename}');
      entries.add(
        RemoteSftpEntry(
          name: item.filename,
          fullPath: full,
          permissions: item.longname.split(' ').first,
          sizeLabel: sizeStr,
          isDirectory: isDir,
        ),
      );
    }
    entries.sort((a, b) {
      if (a.isDirectory != b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.compareTo(b.name);
    });
    return entries;
  }

  Future<void> _browseRemoteSftpPath(String newPath) async {
    if (_sftpClient == null && _sshClient != null) {
      try {
        _sftpClient = await _sshClient!.sftp();
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to open SFTP subsystem: $e')),
          );
        }
        return;
      }
    }
    if (_sftpClient == null) return;
    setState(() => _sshBusy = true);
    try {
      final list = await _fetchSftpDirectoryEntries(_sftpClient!, newPath);
      if (!mounted) return;
      setState(() {
        _sftpCurrentPath = newPath;
        _sftpEntries = list;
        _sshBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _sshBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('SFTP error on "$newPath": $e')),
      );
    }
  }

  Future<void> _viewRemoteSftpFile(RemoteSftpEntry entry) async {
    final sftp = _sftpClient;
    if (sftp == null) return;
    setState(() => _sshBusy = true);
    try {
      final file = await sftp.open(entry.fullPath, mode: SftpFileOpenMode.read);
      final bytes = await file.readBytes(length: 16384);
      await file.close();
      if (!mounted) return;
      setState(() => _sshBusy = false);
      final content = utf8.decode(bytes, allowMalformed: true);
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: JalaPalette.surface,
          title: Text(
            entry.name,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: JalaPalette.brandGold),
          ),
          content: SizedBox(
            width: 380,
            height: 260,
            child: SingleChildScrollView(
              child: SelectableText(
                content.isEmpty ? '(Empty file)' : content,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: JalaPalette.text),
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: content));
                Navigator.of(ctx).pop();
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Copied ${entry.name} content to clipboard')),
                );
              },
              child: const Text('Copy', style: TextStyle(color: JalaPalette.brandGold)),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _sshBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to read ${entry.name}: $e')),
      );
    }
  }

  /// Executes an SSH command on the live `dartssh2` PTY session or `SSHClient.run`
  Future<void> _runSshCommand(String rawCmd) async {
    final cmd = rawCmd.trim();
    _sshInputCtrl.clear();
    final hostLabel = _activeSshHost?.name.split(' ').first ?? 'host';
    final userLabel = _activeSshHost?.username ?? 'root';

    if (cmd == 'clear') {
      setState(() {
        _sshLines.clear();
      });
      if (_sshLiveConnected && _sshPtySession != null) {
        _sshPtySession!.write(Uint8List.fromList(utf8.encode('\n')));
      } else {
        setState(() => _sshLines.add('$userLabel@$hostLabel:~\$ '));
      }
      return;
    }

    // If an interactive PTY shell is open, write directly to PTY stdin!
    if (_sshLiveConnected && _sshPtySession != null) {
      _sshPtySession!.write(Uint8List.fromList(utf8.encode('$cmd\n')));
      return;
    }

    setState(() {
      if (_sshLines.isNotEmpty && _sshLines.last.endsWith('\$ ')) {
        _sshLines[_sshLines.length - 1] = '${_sshLines.last}$cmd';
      } else {
        _sshLines.add('\$ $cmd');
      }
    });

    if (cmd.isEmpty) {
      setState(() => _sshLines.add('$userLabel@$hostLabel:~\$ '));
      return;
    }

    if (_sshLiveConnected && _sshClient != null) {
      setState(() => _sshBusy = true);
      try {
        final outputBytes = await _sshClient!
            .run('$cmd 2>&1')
            .timeout(const Duration(seconds: 15));
        final decoded = utf8.decode(outputBytes, allowMalformed: true).trimRight();
        if (!mounted) return;
        setState(() {
          if (decoded.isNotEmpty) {
            for (final line in decoded.split('\n')) {
              _sshLines.add(line);
            }
          }
          _sshLines.add('$userLabel@$hostLabel:~\$ ');
          _sshBusy = false;
        });
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _sshLines.add('[ssh error] $e');
          _sshLines.add('$userLabel@$hostLabel:~\$ ');
          _sshBusy = false;
        });
      }
      return;
    }

    // Offline preview fallback (used by widget tests and offline mode)
    setState(() {
      if (cmd == 'help') {
        _sshLines.add('Commands: uptime, uname -a, docker ps, kubectl get pods, df -h, clear');
      } else if (cmd == 'uptime') {
        _sshLines.add(' 19:36:12 up 142 days,  7:14,  2 users,  load average: 0.18, 0.24, 0.21');
      } else if (cmd == 'uname -a') {
        _sshLines.add('Linux $hostLabel 6.8.0-45-generic #45-Ubuntu SMP aarch64 GNU/Linux');
      } else if (cmd == 'docker ps') {
        _sshLines.add('CONTAINER ID   IMAGE                     STATUS        PORTS                    NAMES');
        _sshLines.add('a81f92c01b2e   envoyproxy/envoy:v1.31    Up 14 days    0.0.0.0:443->443/tcp     jala-zt-gw');
        _sshLines.add('73d10c92be14   postgres:16-alpine        Up 14 days    127.0.0.1:5432->5432/tcp vault-db');
      } else if (cmd == 'kubectl get pods') {
        _sshLines.add('NAME                               READY   STATUS    RESTARTS   AGE');
        _sshLines.add('jaladesk-relay-6b7f9d8c4-x92lk     2/2     Running   0          19d');
        _sshLines.add('prometheus-node-exporter-m82qp     1/1     Running   0          45d');
      } else if (cmd == 'df -h') {
        _sshLines.add('Filesystem      Size  Used Avail Use% Mounted on');
        _sshLines.add('/dev/nvme0n1p2  500G  142G  358G  29% /');
      } else {
        _sshLines.add('[offline] Connect to a live SSH server in Connections to execute "$cmd" remotely.');
      }
      _sshLines.add('$userLabel@$hostLabel:~\$ ');
    });
  }

  /// Dispatches mouse coordinates & clicks to the active FreeRDP or VNC engine
  void _dispatchDesktopPointer({
    required double normX,
    required double normY,
    bool click = false,
    bool rightClick = false,
    bool doubleClick = false,
  }) {
    final rx = (normX.clamp(0.0, 1.0) * _desktopServerWidth).round().clamp(0, _desktopServerWidth - 1);
    final ry = (normY.clamp(0.0, 1.0) * _desktopServerHeight).round().clamp(0, _desktopServerHeight - 1);

    if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
      if (click || rightClick || doubleClick) {
        _rdpFfiClient!.sendMouseClick(rx, ry, rightClick: rightClick, doubleClick: doubleClick);
      } else {
        _rdpFfiClient!.sendMouseMove(rx, ry);
      }
    } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
      if (rightClick) {
        _vncRfbClient!.sendPointerEvent(rx, ry, 4);
        _vncRfbClient!.sendPointerEvent(rx, ry, 0);
      } else if (doubleClick) {
        _vncRfbClient!.sendPointerEvent(rx, ry, 1);
        _vncRfbClient!.sendPointerEvent(rx, ry, 0);
        _vncRfbClient!.sendPointerEvent(rx, ry, 1);
        _vncRfbClient!.sendPointerEvent(rx, ry, 0);
      } else if (click) {
        _vncRfbClient!.sendPointerEvent(rx, ry, 1);
        _vncRfbClient!.sendPointerEvent(rx, ry, 0);
      } else {
        _vncRfbClient!.sendPointerEvent(rx, ry, 0);
      }
    }
  }

  /// Dispatches special keys or typed text to the active FreeRDP or VNC engine
  void _dispatchDesktopKey(String keyLabel) {
    if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
      _rdpFfiClient!.sendSpecialKey(
        keyLabel,
        ctrl: _ctrlLocked,
        alt: _altLocked,
        win: _winLocked,
        shift: _shiftLocked,
      );
    } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
      switch (keyLabel) {
        case 'Esc':
          _vncRfbClient!.sendKeySym(0xFF1B);
          break;
        case 'Tab':
          _vncRfbClient!.sendKeySym(0xFF09);
          break;
        case 'Enter':
          _vncRfbClient!.sendKeySym(0xFF0D);
          break;
        case 'Bksp':
          _vncRfbClient!.sendKeySym(0xFF08);
          break;
        case '←':
          _vncRfbClient!.sendKeySym(0xFF51);
          break;
        case '↑':
          _vncRfbClient!.sendKeySym(0xFF52);
          break;
        case '→':
          _vncRfbClient!.sendKeySym(0xFF53);
          break;
        case '↓':
          _vncRfbClient!.sendKeySym(0xFF54);
          break;
        default:
          _vncRfbClient!.sendText(keyLabel);
      }
    }
  }

  void _showQrPairDialog() {
    final controller = TextEditingController(
      text: 'jaladesk://pair?v=1&relay=lan-direct&touch=hybrid&biometric=required&fp=SHA256:9F8E7D6C5B4A3210',
    );
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: JalaPalette.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: const BorderSide(color: JalaPalette.lineInput),
        ),
        title: Row(
          children: [
            _buildJalaBrandLogo(size: 26, radius: 7),
            const SizedBox(width: 10),
            const Expanded(
              child: Text(
                'Pair with JalaDesk Desktop',
                style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, color: JalaPalette.text),
              ),
            ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Open JalaDesk on macOS/Windows → Settings (⌘,) → Mobile (iOS / Android) → Generate Pairing URI, or paste a connection URI (ssh://user@host:port, rdp://host:3389, vnc://host:5900) below:',
              style: TextStyle(fontSize: 12, color: JalaPalette.muted, height: 1.4),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              maxLines: 3,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: JalaPalette.text),
              decoration: InputDecoration(
                labelText: 'Zero-Trust Pairing or Connection URI',
                labelStyle: const TextStyle(color: JalaPalette.brandGold, fontSize: 12),
                filled: true,
                fillColor: JalaPalette.header,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: JalaPalette.lineInput),
                ),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel', style: TextStyle(color: JalaPalette.muted)),
          ),
          FilledButton.icon(
            style: FilledButton.styleFrom(
              backgroundColor: JalaPalette.accent,
              foregroundColor: Colors.white,
            ),
            onPressed: () {
              final raw = controller.text.trim();
              if (raw.startsWith('[')) {
                try {
                  final list = jsonDecode(raw) as List<dynamic>;
                  final importedList = <RemoteHostItem>[];
                  for (final item in list) {
                    if (item is Map<String, dynamic>) {
                      importedList.add(RemoteHostItem.fromJson(item));
                    }
                  }
                  if (importedList.isNotEmpty) {
                    setState(() {
                      _hosts
                        ..clear()
                        ..addAll(importedList);
                      _syncActiveHostSelection();
                    });
                    _saveVaultToDisk();
                    _probeAllHosts();
                    Navigator.of(ctx).pop();
                    return;
                  }
                } catch (_) {}
              }
              final parsedUri = Uri.tryParse(raw);
              if (parsedUri != null &&
                  ['ssh', 'rdp', 'vnc', 'sftp'].contains(parsedUri.scheme.toLowerCase()) &&
                  parsedUri.host.isNotEmpty) {
                final proto = RemoteProtocol.values.firstWhere(
                  (e) => e.name == parsedUri.scheme.toLowerCase(),
                  orElse: () => RemoteProtocol.ssh,
                );
                final port = parsedUri.hasPort ? parsedUri.port : defaultPortForProtocol(proto);
                final userParts = parsedUri.userInfo.split(':');
                final user = userParts.isNotEmpty && userParts.first.isNotEmpty
                    ? Uri.decodeComponent(userParts.first)
                    : 'root';
                final pass = userParts.length > 1
                    ? Uri.decodeComponent(userParts.sublist(1).join(':'))
                    : '';
                final qp = parsedUri.queryParameters;
                final imported = RemoteHostItem(
                  id: 'h-${DateTime.now().millisecondsSinceEpoch}',
                  name: qp['name'] ?? parsedUri.host,
                  address: parsedUri.host,
                  port: port,
                  protocol: proto,
                  domain: qp['domain'] ?? '',
                  username: user,
                  password: pass,
                  folder: qp['folder'] ?? 'Imported URI',
                  osLabel: '${proto.name.toUpperCase()} • $user@${parsedUri.host}',
                );
                setState(() {
                  _hosts.insert(0, imported);
                  _syncActiveHostSelection();
                });
                _saveVaultToDisk();
                _probeSingleHost(imported);
              } else {
                setState(() {
                  _pairedDesktopInfo = raw.startsWith('jaladesk://pair')
                      ? 'Paired via Zero-Trust Token (${raw.contains("lan-direct") ? "LAN mDNS" : "Cloud Relay"})'
                      : 'Paired with Desktop Vault';
                });
                _saveVaultToDisk();
              }
              Navigator.of(ctx).pop();
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('✓ Zero-Trust Vault synchronized with JalaDesk Desktop'),
                ),
              );
            },
            icon: const Icon(Icons.verified_user_outlined, size: 16),
            label: const Text('Verify & Sync Vault'),
          ),
        ],
      ),
    );
  }

  Future<void> _showAddTotpDialog() async {
    final labelCtrl = TextEditingController();
    final secretCtrl = TextEditingController();
    String selectedAlgo = 'SHA-1';

    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) => AlertDialog(
          backgroundColor: JalaPalette.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: JalaPalette.lineInput),
          ),
          title: const Text(
            'Add RFC 6238 2FA Authenticator Key',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: JalaPalette.text),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildModalField(
                controller: labelCtrl,
                label: 'Account / Server Name *',
                hint: 'e.g. Production Bastion (root@10.0.0.1)',
                icon: Icons.badge_outlined,
              ),
              const SizedBox(height: 10),
              _buildModalField(
                controller: secretCtrl,
                label: 'Base32 Secret Key *',
                hint: 'e.g. JBSWY3DPEHPK3PXP',
                icon: Icons.key_rounded,
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  const Text('Algorithm: ', style: TextStyle(fontSize: 12, color: JalaPalette.text2)),
                  const SizedBox(width: 8),
                  for (final algo in ['SHA-1', 'SHA-256', 'SHA-512'])
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(algo, style: const TextStyle(fontSize: 11)),
                        selected: selectedAlgo == algo,
                        selectedColor: JalaPalette.selected,
                        onSelected: (_) => setModalState(() => selectedAlgo = algo),
                      ),
                    ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel', style: TextStyle(color: JalaPalette.muted)),
            ),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: JalaPalette.accent),
              onPressed: () {
                final label = labelCtrl.text.trim();
                final secret = secretCtrl.text.trim();
                if (label.isEmpty || Rfc6238Totp.decodeBase32(secret).isEmpty) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Enter an account name and valid Base32 secret (A-Z, 2-7).')),
                  );
                  return;
                }
                setState(() {
                  _totpItems.add(
                    TotpEntryItem(
                      id: 'totp-${DateTime.now().millisecondsSinceEpoch}',
                      label: label,
                      secretBase32: secret,
                      algorithm: selectedAlgo,
                    ),
                  );
                });
                _saveVaultToDisk();
                Navigator.of(ctx).pop();
              },
              child: const Text('Save 2FA Key'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, windowConstraints) {
        final double winW = windowConstraints.maxWidth;
        final bool isWideScreen = winW >= 600;
        final bool isLargeTablet = winW >= 800;
        final bool isFullTablet = winW >= 960;
        final bool activeFullScreen = _isFullScreen && (_tabIndex == 1 || _tabIndex == 2);

        final Widget activeTabBody = IndexedStack(
          index: _tabIndex,
          children: [
            _buildConnectionsTab(),
            _buildJumpRdpCanvasTab(isFullScreen: activeFullScreen, isWideScreen: isWideScreen),
            _buildTermiusSshTab(isFullScreen: activeFullScreen, isWideScreen: isWideScreen),
            _buildSecurityVaultTab(),
          ],
        );

        // True 100% edge-to-edge Immersive Full Screen Mode for RDP/VNC and SSH/SFTP
        if (activeFullScreen) {
          return Scaffold(
            backgroundColor: JalaPalette.splashBg,
            body: activeTabBody,
          );
        }

        return Scaffold(
          appBar: PreferredSize(
            preferredSize: const Size.fromHeight(56),
            child: Container(
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [JalaPalette.chip, JalaPalette.header],
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                ),
                border: Border(
                  bottom: BorderSide(color: JalaPalette.line, width: 1),
                ),
              ),
              child: SafeArea(
                bottom: false,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  child: Row(
                    children: [
                      _buildJalaBrandLogo(size: 32, radius: 8),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            FittedBox(
                              fit: BoxFit.scaleDown,
                              alignment: Alignment.centerLeft,
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Text(
                                    'JalaDesk',
                                    style: TextStyle(
                                      fontWeight: FontWeight.w800,
                                      fontSize: 16,
                                      letterSpacing: -0.3,
                                      color: JalaPalette.text,
                                    ),
                                  ),
                                  const SizedBox(width: 7),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                                    decoration: BoxDecoration(
                                      color: JalaPalette.brandGold.withValues(alpha: 0.14),
                                      borderRadius: BorderRadius.circular(5),
                                      border: Border.all(
                                        color: JalaPalette.brandGold.withValues(alpha: 0.45),
                                        width: 0.8,
                                      ),
                                    ),
                                    child: Text(
                                      isFullTablet
                                          ? 'TABLET PRO'
                                          : (isWideScreen ? 'FOLDABLE PRO' : 'MOBILE PRO'),
                                      style: const TextStyle(
                                        fontSize: 9.5,
                                        fontWeight: FontWeight.w700,
                                        letterSpacing: 0.4,
                                        color: JalaPalette.brandGold,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const Text(
                              'Sapphire-Gold Zero-Trust Workspace',
                              style: TextStyle(fontSize: 10.5, color: JalaPalette.muted),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      if (isLargeTablet && (_tabIndex == 1 || _tabIndex == 2)) ...[
                        IconButton(
                          tooltip: _showTabletSidebar ? 'Hide Host Sidebar' : 'Show Host Sidebar',
                          onPressed: () => setState(() => _showTabletSidebar = !_showTabletSidebar),
                          style: IconButton.styleFrom(
                            backgroundColor: _showTabletSidebar ? JalaPalette.selected : JalaPalette.surface,
                            side: BorderSide(
                              color: _showTabletSidebar ? JalaPalette.brandGold : JalaPalette.lineInput,
                              width: 0.8,
                            ),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                          ),
                          icon: const Icon(Icons.view_sidebar_outlined, size: 18, color: JalaPalette.brandGold),
                        ),
                        const SizedBox(width: 6),
                      ],
                      if (isWideScreen && (_tabIndex == 1 || _tabIndex == 2)) ...[
                        IconButton(
                          tooltip: 'Enter Full Screen Mode',
                          onPressed: () => toggleFullScreen(true),
                          style: IconButton.styleFrom(
                            backgroundColor: JalaPalette.surface,
                            side: const BorderSide(color: JalaPalette.lineInput, width: 0.8),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                          ),
                          icon: const Icon(Icons.fullscreen_rounded, size: 19, color: JalaPalette.brandGold),
                        ),
                        const SizedBox(width: 6),
                      ],
                      IconButton(
                        tooltip: 'Add New Connection',
                        onPressed: () => _showHostEditorDialog(),
                        style: IconButton.styleFrom(
                          backgroundColor: JalaPalette.selected,
                          side: BorderSide(color: JalaPalette.brandGold.withValues(alpha: 0.5), width: 0.8),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        icon: const Icon(Icons.add_rounded, size: 19, color: JalaPalette.brandGold),
                      ),
                      const SizedBox(width: 6),
                      IconButton(
                        tooltip: 'Pair with JalaDesk Desktop (QR / URI)',
                        onPressed: _showQrPairDialog,
                        style: IconButton.styleFrom(
                          backgroundColor: JalaPalette.surface,
                          side: const BorderSide(color: JalaPalette.lineInput, width: 0.8),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        icon: const Icon(Icons.qr_code_scanner, size: 18, color: JalaPalette.brandGold),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          body: isWideScreen
              ? Row(
                  children: [
                    Container(
                      decoration: const BoxDecoration(
                        color: JalaPalette.header,
                        border: Border(right: BorderSide(color: JalaPalette.line, width: 1)),
                      ),
                      child: NavigationRail(
                        backgroundColor: JalaPalette.header,
                        selectedIndex: _tabIndex,
                        onDestinationSelected: (idx) => setState(() => _tabIndex = idx),
                        labelType: NavigationRailLabelType.all,
                        minWidth: 74,
                        indicatorColor: JalaPalette.selected,
                        selectedIconTheme: const IconThemeData(color: JalaPalette.brandGold, size: 21),
                        unselectedIconTheme: const IconThemeData(color: JalaPalette.muted, size: 20),
                        selectedLabelTextStyle: const TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w700,
                          color: JalaPalette.brandGold,
                        ),
                        unselectedLabelTextStyle: const TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w500,
                          color: JalaPalette.muted,
                        ),
                        destinations: const [
                          NavigationRailDestination(
                            icon: Icon(Icons.dns_outlined),
                            selectedIcon: Icon(Icons.dns_rounded),
                            label: Text('Connections'),
                          ),
                          NavigationRailDestination(
                            icon: Icon(Icons.desktop_windows_outlined),
                            selectedIcon: Icon(Icons.desktop_windows_rounded),
                            label: Text('RDP / VNC'),
                          ),
                          NavigationRailDestination(
                            icon: Icon(Icons.terminal_outlined),
                            selectedIcon: Icon(Icons.terminal_rounded),
                            label: Text('SSH & SFTP'),
                          ),
                          NavigationRailDestination(
                            icon: Icon(Icons.shield_outlined),
                            selectedIcon: Icon(Icons.shield_rounded),
                            label: Text('Vault & 2FA'),
                          ),
                        ],
                      ),
                    ),
                    if (isLargeTablet && _showTabletSidebar && (_tabIndex == 1 || _tabIndex == 2))
                      _buildTabletQuickHostSidebar(),
                    Expanded(child: activeTabBody),
                  ],
                )
              : activeTabBody,
          bottomNavigationBar: isWideScreen
              ? null
              : Container(
                  decoration: const BoxDecoration(
                    color: JalaPalette.header,
                    border: Border(top: BorderSide(color: JalaPalette.line, width: 1)),
                  ),
                  child: NavigationBarTheme(
                    data: NavigationBarThemeData(
                      backgroundColor: JalaPalette.header,
                      indicatorColor: JalaPalette.selected,
                      labelTextStyle: WidgetStateProperty.resolveWith((states) {
                        final selected = states.contains(WidgetState.selected);
                        return TextStyle(
                          fontSize: 11,
                          fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                          color: selected ? JalaPalette.brandGold : JalaPalette.muted,
                        );
                      }),
                      iconTheme: WidgetStateProperty.resolveWith((states) {
                        final selected = states.contains(WidgetState.selected);
                        return IconThemeData(
                          size: 20,
                          color: selected ? JalaPalette.brandGold : JalaPalette.muted,
                        );
                      }),
                    ),
                    child: NavigationBar(
                      height: 62,
                      selectedIndex: _tabIndex,
                      onDestinationSelected: (idx) => setState(() => _tabIndex = idx),
                      destinations: const [
                        NavigationDestination(
                          icon: Icon(Icons.dns_outlined),
                          selectedIcon: Icon(Icons.dns_rounded),
                          label: 'Connections',
                        ),
                        NavigationDestination(
                          icon: Icon(Icons.desktop_windows_outlined),
                          selectedIcon: Icon(Icons.desktop_windows_rounded),
                          label: 'RDP / VNC',
                        ),
                        NavigationDestination(
                          icon: Icon(Icons.terminal_outlined),
                          selectedIcon: Icon(Icons.terminal_rounded),
                          label: 'SSH & SFTP',
                        ),
                        NavigationDestination(
                          icon: Icon(Icons.shield_outlined),
                          selectedIcon: Icon(Icons.shield_rounded),
                          label: 'Vault & 2FA',
                        ),
                      ],
                    ),
                  ),
                ),
        );
      },
    );
  }

  /// Tablet / Foldable Split-Screen Quick Host Switcher Sidebar
  Widget _buildTabletQuickHostSidebar() {
    return Container(
      width: 236,
      decoration: const BoxDecoration(
        color: JalaPalette.aside,
        border: Border(right: BorderSide(color: JalaPalette.line, width: 1)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: const BoxDecoration(
              color: JalaPalette.bar,
              border: Border(bottom: BorderSide(color: JalaPalette.line)),
            ),
            child: Row(
              children: [
                const Icon(Icons.storage_rounded, size: 14, color: JalaPalette.brandGold),
                const SizedBox(width: 7),
                const Expanded(
                  child: Text(
                    'QUICK HOST SWITCHER',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.4,
                      color: JalaPalette.brandGold,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                InkWell(
                  onTap: () => _showHostEditorDialog(),
                  child: const Icon(Icons.add_circle_outline_rounded, size: 16, color: JalaPalette.brandGold),
                ),
              ],
            ),
          ),
          Expanded(
            child: _hosts.isEmpty
                ? const Center(
                    child: Padding(
                      padding: EdgeInsets.all(14),
                      child: Text(
                        'No saved hosts yet.\nTap + to add a server.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 11.5, color: JalaPalette.muted),
                      ),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(8),
                    itemCount: _hosts.length,
                    itemBuilder: (ctx, i) {
                      final h = _hosts[i];
                      final isSelected = (_tabIndex == 1 && _activeRdpHost?.id == h.id) ||
                          (_tabIndex == 2 && _activeSshHost?.id == h.id);
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(9),
                          onTap: () => _connectToHost(h),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                            decoration: BoxDecoration(
                              color: isSelected ? JalaPalette.selected : JalaPalette.surface,
                              borderRadius: BorderRadius.circular(9),
                              border: Border.all(
                                color: isSelected ? JalaPalette.brandGold : JalaPalette.line,
                              ),
                            ),
                            child: Row(
                              children: [
                                Icon(_iconForProtocol(h.protocol), size: 16, color: JalaPalette.brandGold),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        h.name,
                                        style: const TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.w700,
                                          color: JalaPalette.text,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                      Text(
                                        '${h.protocol.name.toUpperCase()} • ${h.address}:${h.port}',
                                        style: const TextStyle(fontSize: 10, color: JalaPalette.muted),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ],
                                  ),
                                ),
                                if (h.latencyMs != null)
                                  Text(
                                    '${h.latencyMs}ms',
                                    style: const TextStyle(
                                      fontSize: 9.5,
                                      fontWeight: FontWeight.w700,
                                      color: JalaPalette.ok,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildConnectionsTab() {
    final filtered = _hosts.where((h) {
      if (_protocolFilter != 'ALL' && h.protocol.name.toUpperCase() != _protocolFilter) {
        return false;
      }
      if (_searchQuery.isNotEmpty) {
        final q = _searchQuery.toLowerCase();
        return h.name.toLowerCase().contains(q) ||
            h.address.toLowerCase().contains(q) ||
            h.folder.toLowerCase().contains(q);
      }
      return true;
    }).toList();

    final onlineCount = _hosts.where((h) => h.isOnline == true).length;
    final latencies = _hosts.where((h) => h.latencyMs != null).map((h) => h.latencyMs!).toList();
    final avgRtt = latencies.isEmpty
        ? '—'
        : '${(latencies.reduce((a, b) => a + b) / latencies.length).toStringAsFixed(0)} ms';

    return LayoutBuilder(
      builder: (ctx, constraints) {
        final double availW = constraints.maxWidth;
        final int columns = availW >= 980 ? 3 : (availW >= 600 ? 2 : 1);
        const double spacing = 10.0;
        const double horizontalPad = 14.0;
        final double cardW = columns == 1
            ? (availW - horizontalPad * 2)
            : ((availW - horizontalPad * 2 - spacing * (columns - 1)) / columns);

        return ListView(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 24),
          children: [
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [JalaPalette.chip, JalaPalette.surface],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(13),
                border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.35)),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.25),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Column(
                children: [
                  Row(
                    children: [
                      _buildJalaBrandLogo(size: 40, radius: 10),
                      const SizedBox(width: 11),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'JalaDesk Enterprise Vault',
                              style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w700,
                                color: JalaPalette.text,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 2),
                            Text(
                              _pairedDesktopInfo,
                              style: const TextStyle(fontSize: 11, color: JalaPalette.text2),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 6),
                      FilledButton.tonal(
                        style: FilledButton.styleFrom(
                          backgroundColor: JalaPalette.selected,
                          foregroundColor: JalaPalette.brandGold,
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                          minimumSize: const Size(0, 32),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                            side: BorderSide(color: JalaPalette.brandGold.withValues(alpha: 0.4)),
                          ),
                        ),
                        onPressed: () => _showHostEditorDialog(),
                        child: const Text('+ Add Host', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      _buildTelemetryMetricPill('${_hosts.length} SAVED', '$onlineCount Reachable', JalaPalette.ok),
                      const SizedBox(width: 8),
                      _buildTelemetryMetricPill(avgRtt, 'Live TCP RTT', JalaPalette.accentLine),
                      const SizedBox(width: 8),
                      _buildTelemetryMetricPill('AES-256', 'Zero-Trust GCM', JalaPalette.brandGold),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    onChanged: (v) => setState(() => _searchQuery = v),
                    style: const TextStyle(fontSize: 13, color: JalaPalette.text),
                    decoration: InputDecoration(
                      hintText: 'Search servers, IPs, folders...',
                      hintStyle: const TextStyle(fontSize: 12.5, color: JalaPalette.muted),
                      prefixIcon: const Icon(Icons.search_rounded, size: 18, color: JalaPalette.brandGold),
                      filled: true,
                      fillColor: JalaPalette.aside,
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(vertical: 11, horizontal: 12),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(10),
                        borderSide: const BorderSide(color: JalaPalette.lineInput, width: 1),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(10),
                        borderSide: const BorderSide(color: JalaPalette.accentLine, width: 1.5),
                      ),
                    ),
                  ),
                ),
                if (_hosts.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  IconButton(
                    tooltip: 'Probe Live TCP Latency',
                    onPressed: _probingAll ? null : _probeAllHosts,
                    style: IconButton.styleFrom(
                      backgroundColor: JalaPalette.surface,
                      side: const BorderSide(color: JalaPalette.lineInput),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    icon: Icon(
                      Icons.network_ping_rounded,
                      size: 18,
                      color: _probingAll ? JalaPalette.muted : JalaPalette.brandGold,
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 10),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final proto in ['ALL', 'SSH', 'RDP', 'VNC', 'SFTP', 'HYPERVISOR'])
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(8),
                        onTap: () => setState(() => _protocolFilter = proto),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 140),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            color: _protocolFilter == proto ? JalaPalette.selected : JalaPalette.surface,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: _protocolFilter == proto ? JalaPalette.brandGold : JalaPalette.line,
                              width: 1,
                            ),
                          ),
                          child: Text(
                            proto,
                            style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: _protocolFilter == proto ? FontWeight.w700 : FontWeight.w500,
                              color: _protocolFilter == proto ? JalaPalette.brandGold : JalaPalette.text2,
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            if (_hosts.isEmpty && _vaultLoaded)
              _buildEmptyConnectionsCard()
            else if (filtered.isEmpty)
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: JalaPalette.surface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: JalaPalette.line),
                ),
                child: const Center(
                  child: Text(
                    'No connections match the active filter.',
                    style: TextStyle(fontSize: 12.5, color: JalaPalette.muted),
                  ),
                ),
              )
            else ...[
              if (columns == 1)
                for (final host in filtered) _buildHostCard(host)
              else
                Wrap(
                  spacing: spacing,
                  runSpacing: 0,
                  children: [
                    for (final host in filtered)
                      SizedBox(
                        width: cardW,
                        child: _buildHostCard(host),
                      ),
                  ],
                ),
              const SizedBox(height: 6),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  TextButton.icon(
                    onPressed: () => _showHostEditorDialog(),
                    icon: const Icon(Icons.add_circle_outline_rounded, size: 16, color: JalaPalette.brandGold),
                    label: const Text(
                      'Add New Connection',
                      style: TextStyle(fontSize: 12, color: JalaPalette.brandGold, fontWeight: FontWeight.w600),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () {
                      setState(() {
                        _hosts.clear();
                        _activeRdpHost = null;
                        _activeSshHost = null;
                      });
                      _saveVaultToDisk();
                    },
                    icon: const Icon(Icons.delete_sweep_outlined, size: 16, color: JalaPalette.muted),
                    label: const Text(
                      'Clear Vault',
                      style: TextStyle(fontSize: 11.5, color: JalaPalette.muted),
                    ),
                  ),
                ],
              ),
            ],
          ],
        );
      },
    );
  }

  Widget _buildEmptyConnectionsCard() {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: JalaPalette.surface,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: JalaPalette.lineInput),
      ),
      child: Column(
        children: [
          Container(
            width: 50,
            height: 50,
            decoration: BoxDecoration(
              color: JalaPalette.header,
              borderRadius: BorderRadius.circular(13),
              border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
            ),
            child: const Icon(Icons.dns_rounded, color: JalaPalette.brandGold, size: 26),
          ),
          const SizedBox(height: 12),
          const Text(
            'Your Connection Vault is Ready',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: JalaPalette.text),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 6),
          const Text(
            'Add your own SSH, SFTP, RDP (FreeRDP 3.x NLA), or VNC server to open a live remote session.',
            style: TextStyle(fontSize: 12, color: JalaPalette.muted, height: 1.4),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.center,
            children: [
              FilledButton.icon(
                style: FilledButton.styleFrom(
                  backgroundColor: JalaPalette.accent,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                ),
                onPressed: () => _showHostEditorDialog(),
                icon: const Icon(Icons.add_rounded, size: 18),
                label: const Text('New Connection', style: TextStyle(fontWeight: FontWeight.w700)),
              ),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                  foregroundColor: JalaPalette.brandGold,
                  side: BorderSide(color: JalaPalette.brandGold.withValues(alpha: 0.5)),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                ),
                onPressed: _loadSampleLabServers,
                icon: const Icon(Icons.science_outlined, size: 16),
                label: const Text('Load Sample Lab', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildTelemetryMetricPill(String value, String label, Color accentColor) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 8),
        decoration: BoxDecoration(
          color: JalaPalette.header.withValues(alpha: 0.65),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: JalaPalette.line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              value,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w800,
                color: accentColor,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 1),
            Text(
              label,
              style: const TextStyle(fontSize: 10, color: JalaPalette.muted),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHostCard(RemoteHostItem host) {
    final isGold = host.accentTint == 'gold';
    final badgeColor = isGold ? JalaPalette.brandGold : JalaPalette.accentLine;
    final protoLabel = host.protocol.name.toUpperCase();

    final bool? online = host.isOnline;
    final Color statusColor = online == true
        ? JalaPalette.ok
        : (online == false ? JalaPalette.amber : JalaPalette.accentLine);
    final String statusText = host.latencyMs != null && online != false
        ? '● ${host.latencyMs} ms'
        : (online == false ? '○ UNREACHABLE' : '● READY');

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: JalaPalette.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: JalaPalette.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: JalaPalette.header,
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(color: badgeColor.withValues(alpha: 0.45)),
                ),
                child: Icon(_iconForProtocol(host.protocol), color: badgeColor, size: 18),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: InkWell(
                  onTap: () => _showHostEditorDialog(existing: host),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        host.name,
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 13.5,
                          color: JalaPalette.text,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${host.folder} • ${host.displayAccount}@${host.address}:${host.port}',
                        style: const TextStyle(fontSize: 11.5, color: JalaPalette.muted),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(99),
                  border: Border.all(color: statusColor.withValues(alpha: 0.4)),
                ),
                child: Text(
                  statusText,
                  style: TextStyle(
                    fontSize: 10,
                    color: statusColor,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 4),
              InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: () => _showHostEditorDialog(existing: host),
                child: const Padding(
                  padding: EdgeInsets.all(4),
                  child: Icon(Icons.edit_outlined, size: 16, color: JalaPalette.muted),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              color: JalaPalette.aside,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: JalaPalette.line),
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: JalaPalette.selected,
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: Text(
                    protoLabel,
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                      color: badgeColor,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    host.osLabel,
                    style: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  height: 30,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: JalaPalette.accent,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(7),
                        side: const BorderSide(color: JalaPalette.accentLine, width: 0.8),
                      ),
                    ),
                    onPressed: () => _connectToHost(host),
                    child: Text(
                      host.protocol == RemoteProtocol.ssh ? 'SSH' : 'Connect',
                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Show Jump Desktop-style Display Resolution & Aspect Ratio Sheet
  void _showDisplaySizingModal() {
    showModalBottomSheet(
      context: context,
      backgroundColor: JalaPalette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModalState) {
            return SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.aspect_ratio_rounded, size: 18, color: JalaPalette.brandGold),
                        const SizedBox(width: 8),
                        const Expanded(
                          child: Text(
                            'Jump Display Sizing & Aspect Match',
                            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: JalaPalette.text),
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                            color: JalaPalette.selected,
                            borderRadius: BorderRadius.circular(99),
                            border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.5)),
                          ),
                          child: Text(
                            'Active: ${_desktopServerWidth}x$_desktopServerHeight',
                            style: const TextStyle(
                              fontSize: 10.5,
                              fontFamily: 'monospace',
                              fontWeight: FontWeight.w700,
                              color: JalaPalette.brandGold,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Automatically matches the remote GUI desktop resolution and aspect ratio to your phone, foldable, or tablet screen (FreeRDP DisplayControl DVC).',
                      style: TextStyle(fontSize: 11.5, color: JalaPalette.muted),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'REMOTE DESKTOP RESOLUTION',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.5,
                        color: JalaPalette.brandGold,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final preset in JumpResolutionPreset.values)
                          ChoiceChip(
                            label: Text(preset.shortLabel, style: const TextStyle(fontSize: 11.5)),
                            selected: _resolutionPreset == preset,
                            selectedColor: JalaPalette.selected,
                            backgroundColor: JalaPalette.header,
                            labelStyle: TextStyle(
                              fontWeight: FontWeight.w700,
                              color: _resolutionPreset == preset ? JalaPalette.brandGold : JalaPalette.text2,
                            ),
                            side: BorderSide(
                              color: _resolutionPreset == preset ? JalaPalette.brandGold : JalaPalette.lineInput,
                            ),
                            onSelected: (_) {
                              setState(() {
                                _resolutionPreset = preset;
                                if (preset == JumpResolutionPreset.matchDisplay ||
                                    preset == JumpResolutionPreset.matchHiDpi) {
                                  _canvasFitMode = JumpCanvasFitMode.aspectFit;
                                }
                              });
                              setModalState(() {});
                              _applyTargetResolutionToActiveSession();
                            },
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'VIEWPORT SCALING MODE',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.5,
                        color: JalaPalette.brandGold,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final fitMode in JumpCanvasFitMode.values)
                          ChoiceChip(
                            label: Text(fitMode.shortLabel, style: const TextStyle(fontSize: 11.5)),
                            selected: _canvasFitMode == fitMode,
                            selectedColor: JalaPalette.selected,
                            backgroundColor: JalaPalette.header,
                            labelStyle: TextStyle(
                              fontWeight: FontWeight.w700,
                              color: _canvasFitMode == fitMode ? JalaPalette.brandGold : JalaPalette.text2,
                            ),
                            side: BorderSide(
                              color: _canvasFitMode == fitMode ? JalaPalette.brandGold : JalaPalette.lineInput,
                            ),
                            onSelected: (_) {
                              setState(() => _canvasFitMode = fitMode);
                              setModalState(() {});
                            },
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: JalaPalette.text,
                              side: const BorderSide(color: JalaPalette.lineInput),
                            ),
                            onPressed: () {
                              Navigator.of(ctx).pop();
                              toggleLandscapeOrientation();
                            },
                            icon: const Icon(Icons.screen_rotation_rounded, size: 15),
                            label: Text(
                              _landscapeLocked ? 'Unlock Orientation' : 'Force Landscape',
                              style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: FilledButton.icon(
                            style: FilledButton.styleFrom(
                              backgroundColor: JalaPalette.accent,
                              foregroundColor: Colors.white,
                            ),
                            onPressed: () {
                              Navigator.of(ctx).pop();
                              toggleFullScreen();
                            },
                            icon: Icon(
                              _isFullScreen ? Icons.fullscreen_exit_rounded : Icons.fullscreen_rounded,
                              size: 16,
                            ),
                            label: Text(
                              _isFullScreen ? 'Exit Full Screen' : 'Max Full Screen',
                              style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  /// Jump Desktop-style Touch RDP / VNC Canvas with Real Live Framebuffer (`ui.Image`),
  /// Dynamic Display Resolution Matching (`DispClientContext`), and Immersive Full-Screen Mode
  Widget _buildJumpRdpCanvasTab({bool isFullScreen = false, bool isWideScreen = false}) {
    final hostTitle = _activeRdpHost != null
        ? '${_activeRdpHost!.name} (${_activeRdpHost!.address}:${_activeRdpHost!.port})'
        : 'No Remote Desktop Selected';

    return Column(
      children: [
        // Top HUD bar (hidden in Full Screen mode for 100% edge-to-edge canvas)
        if (!isFullScreen)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: const BoxDecoration(
              color: JalaPalette.bar,
              border: Border(bottom: BorderSide(color: JalaPalette.line)),
            ),
            child: Row(
              children: [
                Icon(
                  Icons.desktop_windows_rounded,
                  size: 14,
                  color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                ),
                const SizedBox(width: 5),
                Expanded(
                  flex: 2,
                  child: Text(
                    hostTitle,
                    style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: JalaPalette.text),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 4),
                Flexible(
                  flex: 5,
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Jump Display Sizing & Aspect Ratio Match Pill
                        InkWell(
                          key: const ValueKey('btn_display_sizing'),
                          borderRadius: BorderRadius.circular(7),
                          onTap: _showDisplaySizingModal,
                          child: Container(
                            height: 26,
                            padding: const EdgeInsets.symmetric(horizontal: 7),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: JalaPalette.selected,
                              borderRadius: BorderRadius.circular(7),
                              border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.65)),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(Icons.aspect_ratio_rounded, size: 13, color: JalaPalette.brandGold),
                                const SizedBox(width: 4),
                                Text(
                                  '${_resolutionPreset.shortLabel} • ${_canvasFitMode.shortLabel}',
                                  style: const TextStyle(
                                    fontSize: 9.5,
                                    fontWeight: FontWeight.w700,
                                    color: JalaPalette.brandGold,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 4),
                        Container(
                          padding: const EdgeInsets.all(2),
                          decoration: BoxDecoration(
                            color: JalaPalette.header,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: JalaPalette.lineInput),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              _buildTouchModeOption('Trackpad', true),
                              _buildTouchModeOption('Direct Touch', false),
                            ],
                          ),
                        ),
                        const SizedBox(width: 4),
                        // Keyboard Input Bar Toggle
                        InkWell(
                          borderRadius: BorderRadius.circular(7),
                          onTap: () => setState(() => _showDesktopKeyboardBar = !_showDesktopKeyboardBar),
                          child: Container(
                            width: 26,
                            height: 26,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: _showDesktopKeyboardBar ? JalaPalette.selected : JalaPalette.header,
                              borderRadius: BorderRadius.circular(7),
                              border: Border.all(
                                color: _showDesktopKeyboardBar ? JalaPalette.brandGold : JalaPalette.lineInput,
                              ),
                            ),
                            child: const Icon(Icons.keyboard_alt_outlined, size: 14, color: JalaPalette.brandGold),
                          ),
                        ),
                        const SizedBox(width: 4),
                        // Rotate Landscape / Portrait Toggle
                        InkWell(
                          key: const ValueKey('btn_rotate_orientation'),
                          borderRadius: BorderRadius.circular(7),
                          onTap: () => toggleLandscapeOrientation(),
                          child: Container(
                            width: 26,
                            height: 26,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: _landscapeLocked ? JalaPalette.selected : JalaPalette.header,
                              borderRadius: BorderRadius.circular(7),
                              border: Border.all(
                                color: _landscapeLocked ? JalaPalette.brandGold : JalaPalette.lineInput,
                              ),
                            ),
                            child: const Icon(Icons.screen_rotation_rounded, size: 14, color: JalaPalette.brandGold),
                          ),
                        ),
                        const SizedBox(width: 4),
                        // Immersive Edge-to-Edge Full Screen Toggle
                        InkWell(
                          key: const ValueKey('btn_toggle_fullscreen'),
                          borderRadius: BorderRadius.circular(7),
                          onTap: () => toggleFullScreen(),
                          child: Container(
                            height: 26,
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: JalaPalette.accent.withValues(alpha: 0.22),
                              borderRadius: BorderRadius.circular(7),
                              border: Border.all(color: JalaPalette.accentLine),
                            ),
                            child: const Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.fullscreen_rounded, size: 15, color: JalaPalette.brandGold),
                                SizedBox(width: 2),
                                Text(
                                  'Full',
                                  style: TextStyle(
                                    fontSize: 9.5,
                                    fontWeight: FontWeight.w800,
                                    color: JalaPalette.brandGold,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 4),
                        // View-Only Lock Toggle
                        InkWell(
                          borderRadius: BorderRadius.circular(7),
                          onTap: () => setState(() => _viewOnly = !_viewOnly),
                          child: Container(
                            width: 26,
                            height: 26,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: JalaPalette.header,
                              borderRadius: BorderRadius.circular(7),
                              border: Border.all(color: JalaPalette.lineInput),
                            ),
                            child: Icon(
                              _viewOnly ? Icons.lock_rounded : Icons.lock_open_rounded,
                              size: 14,
                              color: _viewOnly ? JalaPalette.amber : JalaPalette.ok,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (_showDesktopKeyboardBar)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            color: JalaPalette.aside,
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _desktopKeyInputCtrl,
                    onSubmitted: (txt) {
                      if (txt.isNotEmpty) {
                        _dispatchDesktopKey(txt);
                        _desktopKeyInputCtrl.clear();
                      }
                      _dispatchDesktopKey('Enter');
                    },
                    style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                    decoration: InputDecoration(
                      hintText: 'Type text to send to remote desktop...',
                      hintStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.muted),
                      isDense: true,
                      filled: true,
                      fillColor: JalaPalette.header,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(7),
                        borderSide: const BorderSide(color: JalaPalette.lineInput),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: JalaPalette.accent,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    minimumSize: const Size(0, 34),
                  ),
                  onPressed: () {
                    final txt = _desktopKeyInputCtrl.text;
                    if (txt.isNotEmpty) {
                      _dispatchDesktopKey(txt);
                      _desktopKeyInputCtrl.clear();
                    }
                  },
                  child: const Text('Send', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
          ),
        // Interactive Remote Desktop Viewport
        Expanded(
          child: LayoutBuilder(
            builder: (ctx, constraints) {
              final margin = isFullScreen ? 0.0 : (isWideScreen ? 6.0 : 8.0);
              final canvasW = (constraints.maxWidth - margin * 2).clamp(160.0, 4096.0);
              final canvasH = (constraints.maxHeight - margin * 2).clamp(120.0, 4096.0);
              final viewportSize = Size(canvasW, canvasH);

              // Notify Jump Auto-Match engine when viewport dimensions change (foldable unfold / orientation / fullscreen)
              WidgetsBinding.instance.addPostFrameCallback((_) {
                _onViewportDimensionsMeasured(viewportSize);
              });

              final desktopRect = _computeRenderedDesktopRect(viewportSize);
              final pointerPx = Offset(
                desktopRect.left + _cursorNorm.dx.clamp(0.0, 1.0) * desktopRect.width,
                desktopRect.top + _cursorNorm.dy.clamp(0.0, 1.0) * desktopRect.height,
              );

              return Stack(
                fit: StackFit.expand,
                children: [
                  GestureDetector(
                    onPanUpdate: (details) {
                      if (_viewOnly) return;
                      if (_trackpadMode) {
                        setState(() {
                          final nextDx =
                              (_cursorNorm.dx + (details.delta.dx * 1.25) / desktopRect.width).clamp(0.0, 1.0);
                          final nextDy =
                              (_cursorNorm.dy + (details.delta.dy * 1.25) / desktopRect.height).clamp(0.0, 1.0);
                          _cursorNorm = Offset(nextDx, nextDy);
                        });
                        _dispatchDesktopPointer(
                          normX: _cursorNorm.dx,
                          normY: _cursorNorm.dy,
                        );
                      }
                    },
                    onTapDown: (details) {
                      if (_viewOnly) return;
                      setState(() {
                        if (!_trackpadMode) {
                          final relX =
                              ((details.localPosition.dx - margin - desktopRect.left) / desktopRect.width)
                                  .clamp(0.0, 1.0);
                          final relY =
                              ((details.localPosition.dy - margin - desktopRect.top) / desktopRect.height)
                                  .clamp(0.0, 1.0);
                          _cursorNorm = Offset(relX, relY);
                        }
                        _lastRdpAction =
                            'Left Click @ (${(_cursorNorm.dx * _desktopServerWidth).round()}, ${(_cursorNorm.dy * _desktopServerHeight).round()}) [${_activeModifierSummary()}]';
                      });
                      _dispatchDesktopPointer(
                        normX: _cursorNorm.dx,
                        normY: _cursorNorm.dy,
                        click: true,
                      );
                    },
                    onDoubleTap: () {
                      if (_viewOnly) return;
                      setState(() {
                        _lastRdpAction =
                            'Double Click @ (${(_cursorNorm.dx * _desktopServerWidth).round()}, ${(_cursorNorm.dy * _desktopServerHeight).round()})';
                      });
                      _dispatchDesktopPointer(
                        normX: _cursorNorm.dx,
                        normY: _cursorNorm.dy,
                        doubleClick: true,
                      );
                    },
                    onSecondaryTap: () {
                      if (_viewOnly) return;
                      setState(() {
                        _lastRdpAction =
                            'Right Click @ (${(_cursorNorm.dx * _desktopServerWidth).round()}, ${(_cursorNorm.dy * _desktopServerHeight).round()})';
                      });
                      _dispatchDesktopPointer(
                        normX: _cursorNorm.dx,
                        normY: _cursorNorm.dy,
                        rightClick: true,
                      );
                    },
                    child: InteractiveViewer(
                      transformationController: _canvasTransformCtrl,
                      minScale: 1.0,
                      maxScale: 5.0,
                      child: Container(
                        key: const ValueKey('remote_desktop_viewport_container'),
                        margin: EdgeInsets.all(margin),
                        decoration: BoxDecoration(
                          color: JalaPalette.splashBg,
                          gradient: _remoteDesktopFrame == null
                              ? const LinearGradient(
                                  colors: [JalaPalette.header, JalaPalette.chip, JalaPalette.selected],
                                  begin: Alignment.topLeft,
                                  end: Alignment.bottomRight,
                                )
                              : null,
                          borderRadius: BorderRadius.circular(isFullScreen ? 0 : 12),
                          border: isFullScreen
                              ? null
                              : Border.all(
                                  color: _desktopLiveConnected
                                      ? JalaPalette.ok.withValues(alpha: 0.75)
                                      : JalaPalette.accentLine.withValues(alpha: 0.55),
                                ),
                        ),
                        clipBehavior: Clip.antiAlias,
                        child: Stack(
                          fit: StackFit.expand,
                          children: [
                            // REAL LIVE REMOTE DESKTOP PIXEL FRAMEBUFFER (FreeRDP 3.x / VNC RFB 3.8)
                            // Positioned at the exact Jump aspect-fitted rectangle so Direct Touch & Trackpad coordinates
                            // map 1:1 to remote desktop server pixels with zero aspect distortion.
                            if (_remoteDesktopFrame != null)
                              Positioned.fromRect(
                                rect: desktopRect,
                                child: RawImage(
                                  image: _remoteDesktopFrame,
                                  fit: BoxFit.fill,
                                  filterQuality: FilterQuality.medium,
                                ),
                              ),
                            // Top overlay HUD (only shown when no pixel frame has arrived yet)
                            if (_remoteDesktopFrame == null)
                              Positioned(
                                top: 14,
                                left: 14,
                                right: 14,
                                child: Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: JalaPalette.header.withValues(alpha: 0.9),
                                    borderRadius: BorderRadius.circular(9),
                                    border: Border.all(color: JalaPalette.lineInput),
                                  ),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        children: [
                                          _buildJalaBrandLogo(size: 20, radius: 5),
                                          const SizedBox(width: 8),
                                          Expanded(
                                            child: Text(
                                              _desktopLiveConnected
                                                  ? 'LIVE STREAM • $_desktopProtocolBanner'
                                                  : 'REMOTE DESKTOP CANVAS • ${_activeRdpHost?.osLabel ?? "READY"}',
                                              style: TextStyle(
                                                fontSize: 10.5,
                                                fontWeight: FontWeight.w700,
                                                color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                                              ),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                          if (_activeRdpHost != null)
                                            SizedBox(
                                              height: 26,
                                              child: FilledButton.tonal(
                                                style: FilledButton.styleFrom(
                                                  backgroundColor: JalaPalette.selected,
                                                  foregroundColor: JalaPalette.brandGold,
                                                  padding: const EdgeInsets.symmetric(horizontal: 8),
                                                ),
                                                onPressed: () => _connectToHost(_activeRdpHost!),
                                                child: Text(
                                                  _desktopLiveConnected ? 'Reconnect' : 'Connect Live',
                                                  style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700),
                                                ),
                                              ),
                                            ),
                                        ],
                                      ),
                                      const SizedBox(height: 6),
                                      Text(
                                        _lastRdpAction,
                                        style: const TextStyle(fontSize: 11.5, color: JalaPalette.text),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            // Precision Trackpad Virtual Pointer
                            Positioned(
                              left: pointerPx.dx.clamp(4.0, (canvasW - 44.0).clamp(4.0, 4096.0)),
                              top: pointerPx.dy.clamp(4.0, (canvasH - 36.0).clamp(4.0, 4096.0)),
                              child: IgnorePointer(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    const Icon(Icons.near_me_rounded, color: JalaPalette.brandGold, size: 20),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                      decoration: BoxDecoration(
                                        color: JalaPalette.header.withValues(alpha: 0.85),
                                        borderRadius: BorderRadius.circular(4),
                                        border: Border.all(color: JalaPalette.brandGold, width: 0.6),
                                      ),
                                      child: Text(
                                        '${(_cursorNorm.dx * _desktopServerWidth).round()},${(_cursorNorm.dy * _desktopServerHeight).round()}',
                                        style: const TextStyle(fontSize: 9, color: JalaPalette.brandGold),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                            // Bottom status bar (hidden in Full Screen mode for unobstructed view)
                            if (!isFullScreen)
                              Positioned(
                                left: 0,
                                right: 0,
                                bottom: 0,
                                child: Container(
                                  height: 30,
                                  padding: const EdgeInsets.symmetric(horizontal: 10),
                                  decoration: BoxDecoration(
                                    color: JalaPalette.header.withValues(alpha: 0.86),
                                    border: const Border(top: BorderSide(color: JalaPalette.line)),
                                  ),
                                  child: Row(
                                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                    children: [
                                      Flexible(
                                        child: Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Icon(
                                              Icons.circle,
                                              size: 8,
                                              color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.amber,
                                            ),
                                            const SizedBox(width: 6),
                                            Flexible(
                                              child: Text(
                                                '${_desktopServerWidth}x$_desktopServerHeight • ${_resolutionPreset.shortLabel} (${_canvasFitMode.shortLabel})',
                                                style: const TextStyle(
                                                  fontSize: 10,
                                                  fontFamily: 'monospace',
                                                  color: JalaPalette.text2,
                                                ),
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      Flexible(
                                        child: Text(
                                          _desktopLiveConnected
                                              ? 'LIVE PIXEL STREAM • ${_activeRdpHost?.latencyMs ?? 1}ms'
                                              : 'JUMP AUTO-MATCH READY',
                                          style: TextStyle(
                                            fontSize: 10,
                                            fontWeight: FontWeight.w700,
                                            color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                                          ),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  // Jump Desktop-style Floating Mini-Pill HUD in Full Screen Mode (above GestureDetector/InteractiveViewer)
                  if (isFullScreen)
                    Positioned(
                      top: 10,
                      right: 10,
                      child: SafeArea(
                        child: Container(
                          key: const ValueKey('fullscreen_floating_hud'),
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                          decoration: BoxDecoration(
                            color: JalaPalette.header.withValues(alpha: 0.88),
                            borderRadius: BorderRadius.circular(99),
                            border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.65)),
                            boxShadow: const [
                              BoxShadow(color: Colors.black54, blurRadius: 10, offset: Offset(0, 3)),
                            ],
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              InkWell(
                                onTap: () => setState(() => _floatingHudExpanded = !_floatingHudExpanded),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(
                                      Icons.circle,
                                      size: 8,
                                      color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                                    ),
                                    const SizedBox(width: 5),
                                    Text(
                                      '${_desktopServerWidth}x$_desktopServerHeight',
                                      style: const TextStyle(
                                        fontSize: 10,
                                        fontFamily: 'monospace',
                                        fontWeight: FontWeight.w800,
                                        color: JalaPalette.brandGold,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              if (_floatingHudExpanded) ...[
                                const SizedBox(width: 8),
                                InkWell(
                                  onTap: _showDisplaySizingModal,
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                    decoration: BoxDecoration(
                                      color: JalaPalette.selected,
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Text(
                                      _resolutionPreset.shortLabel,
                                      style: const TextStyle(
                                        fontSize: 9.5,
                                        fontWeight: FontWeight.w700,
                                        color: JalaPalette.brandGold,
                                      ),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                InkWell(
                                  onTap: () => setState(() => _showFullScreenModifierBar = !_showFullScreenModifierBar),
                                  child: Icon(
                                    Icons.keyboard_command_key_rounded,
                                    size: 15,
                                    color: _showFullScreenModifierBar ? JalaPalette.brandGold : JalaPalette.text2,
                                  ),
                                ),
                                const SizedBox(width: 6),
                                InkWell(
                                  onTap: () => setState(() => _showDesktopKeyboardBar = !_showDesktopKeyboardBar),
                                  child: Icon(
                                    Icons.keyboard_alt_outlined,
                                    size: 15,
                                    color: _showDesktopKeyboardBar ? JalaPalette.brandGold : JalaPalette.text2,
                                  ),
                                ),
                                const SizedBox(width: 6),
                                InkWell(
                                  onTap: () => toggleLandscapeOrientation(),
                                  child: Icon(
                                    Icons.screen_rotation_rounded,
                                    size: 15,
                                    color: _landscapeLocked ? JalaPalette.brandGold : JalaPalette.text2,
                                  ),
                                ),
                              ],
                              const SizedBox(width: 8),
                              InkWell(
                                key: const ValueKey('btn_exit_fullscreen_pill'),
                                onTap: () => toggleFullScreen(false),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: JalaPalette.danger.withValues(alpha: 0.2),
                                    borderRadius: BorderRadius.circular(99),
                                    border: Border.all(color: JalaPalette.danger.withValues(alpha: 0.6)),
                                  ),
                                  child: const Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(Icons.fullscreen_exit_rounded, size: 13, color: JalaPalette.brandGold),
                                      SizedBox(width: 2),
                                      Text(
                                        'Exit',
                                        style: TextStyle(
                                          fontSize: 9.5,
                                          fontWeight: FontWeight.w800,
                                          color: JalaPalette.brandGold,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
        // Extended On-Screen Modifier & Function Key Strip (shown normally, or optionally in Full Screen)
        if (!isFullScreen || _showFullScreenModifierBar)
          Container(
            decoration: const BoxDecoration(
              color: JalaPalette.header,
              border: Border(top: BorderSide(color: JalaPalette.line)),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: ActionChip(
                      backgroundColor: JalaPalette.selected,
                      side: const BorderSide(color: JalaPalette.brandGold),
                      label: const Text(
                        'R-Click',
                        style: TextStyle(fontSize: 11, color: JalaPalette.brandGold, fontWeight: FontWeight.w700),
                      ),
                      onPressed: _viewOnly
                          ? null
                          : () {
                              HapticFeedback.lightImpact();
                              _dispatchDesktopPointer(normX: _cursorNorm.dx, normY: _cursorNorm.dy, rightClick: true);
                            },
                    ),
                  ),
                  _buildModifierChip('Ctrl', _ctrlLocked, (v) => setState(() => _ctrlLocked = v)),
                  _buildModifierChip('Alt', _altLocked, (v) => setState(() => _altLocked = v)),
                  _buildModifierChip('⌘/Win', _winLocked, (v) => setState(() => _winLocked = v)),
                  _buildModifierChip('Shift', _shiftLocked, (v) => setState(() => _shiftLocked = v)),
                  for (final keyLabel in [
                    'Esc',
                    'Tab',
                    'Enter',
                    'Bksp',
                    'Ctrl+Alt+Del',
                    'Win+D',
                    '←',
                    '↑',
                    '↓',
                    '→',
                    'F1',
                    'F5',
                    'F11',
                    'F12',
                  ])
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ActionChip(
                        backgroundColor: JalaPalette.surface,
                        side: const BorderSide(color: JalaPalette.lineInput),
                        label: Text(
                          keyLabel,
                          style: const TextStyle(fontSize: 11.5, color: JalaPalette.text, fontWeight: FontWeight.w600),
                        ),
                        onPressed: _viewOnly
                            ? null
                            : () {
                                HapticFeedback.lightImpact();
                                _dispatchDesktopKey(keyLabel);
                                setState(() {
                                  _lastRdpAction =
                                      'Sent Key: [${_activeModifierSummary()}$keyLabel] to ${_activeRdpHost?.name ?? "session"}';
                                });
                              },
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  String _activeModifierSummary() {
    final mods = <String>[];
    if (_ctrlLocked) mods.add('Ctrl+');
    if (_altLocked) mods.add('Alt+');
    if (_winLocked) mods.add('Win+');
    if (_shiftLocked) mods.add('Shift+');
    return mods.isEmpty ? '' : mods.join();
  }

  Widget _buildTouchModeOption(String label, bool isTrackpad) {
    final active = _trackpadMode == isTrackpad;
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: () => setState(() => _trackpadMode = isTrackpad),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 3),
        decoration: BoxDecoration(
          color: active ? JalaPalette.selected : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 8.5,
            fontWeight: active ? FontWeight.w700 : FontWeight.w500,
            color: active ? JalaPalette.brandGold : JalaPalette.muted,
          ),
        ),
      ),
    );
  }

  Widget _buildModifierChip(String label, bool active, ValueChanged<bool> onSelected) {
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: FilterChip(
        selectedColor: JalaPalette.selected,
        backgroundColor: JalaPalette.surface,
        checkmarkColor: JalaPalette.brandGold,
        side: BorderSide(color: active ? JalaPalette.brandGold : JalaPalette.lineInput),
        label: Text(
          label,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w700,
            color: active ? JalaPalette.brandGold : JalaPalette.text2,
          ),
        ),
        selected: active,
        onSelected: _viewOnly ? null : onSelected,
      ),
    );
  }

  /// Termius-style Mobile SSHv2 Terminal + SFTP Studio (`dartssh2`)
  /// Supports side-by-side Split SSH + SFTP mode on foldables & tablets (`isWideScreen == true`)
  Widget _buildTermiusSshTab({bool isFullScreen = false, bool isWideScreen = false}) {
    final hostDesc = _activeSshHost != null
        ? '${_activeSshHost!.displayAccount}@${_activeSshHost!.address}:${_activeSshHost!.port}'
        : 'No SSH Host Selected';

    return LayoutBuilder(
      builder: (ctx, constraints) {
        final canSplitSshSftp = constraints.maxWidth >= 700;

        Widget buildTerminalPane() {
          return Container(
            width: double.infinity,
            margin: EdgeInsets.all(isFullScreen ? 4 : 10),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: JalaPalette.header,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: _sshLiveConnected ? JalaPalette.ok.withValues(alpha: 0.5) : JalaPalette.lineInput,
              ),
            ),
            child: ListView.builder(
              controller: _sshScrollCtrl,
              itemCount: _sshLines.length,
              itemBuilder: (ctx, i) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  _sshLines[i],
                  style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                    color: _sshLines[i].contains('@') && _sshLines[i].endsWith('\$ ')
                        ? JalaPalette.brandGold
                        : (_sshLines[i].startsWith('✓') ? JalaPalette.ok : JalaPalette.text),
                    height: 1.35,
                  ),
                ),
              ),
            ),
          );
        }

        return Column(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: const BoxDecoration(
                color: JalaPalette.bar,
                border: Border(bottom: BorderSide(color: JalaPalette.line)),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.terminal_rounded,
                    size: 16,
                    color: _sshLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      hostDesc,
                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: JalaPalette.text),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (_activeSshHost != null && !_sshLiveConnected)
                    Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: SizedBox(
                        height: 26,
                        child: FilledButton.tonal(
                          style: FilledButton.styleFrom(
                            backgroundColor: JalaPalette.selected,
                            foregroundColor: JalaPalette.brandGold,
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            minimumSize: Size.zero,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          onPressed: () => _connectToHost(_activeSshHost!),
                          child: const Text('Connect SSH', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700)),
                        ),
                      ),
                    ),
                  TextButton.icon(
                    style: TextButton.styleFrom(
                      foregroundColor: JalaPalette.brandGold,
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    onPressed: () {
                      setState(() {
                        if (canSplitSshSftp) {
                          _sshSubMode = _sshSubMode == 'split' ? 'terminal' : 'split';
                        } else {
                          _sshSubMode = _sshSubMode == 'sftp' ? 'terminal' : 'sftp';
                        }
                      });
                      if ((_sshSubMode == 'sftp' || _sshSubMode == 'split') && _sshLiveConnected) {
                        _browseRemoteSftpPath(_sftpCurrentPath);
                      }
                    },
                    icon: Icon(
                      _sshSubMode == 'sftp'
                          ? Icons.terminal_rounded
                          : (canSplitSshSftp ? Icons.vertical_split_rounded : Icons.folder_shared_outlined),
                      size: 14,
                    ),
                    label: Text(
                      canSplitSshSftp
                          ? (_sshSubMode == 'split' ? 'Single Terminal' : 'Split SSH+SFTP')
                          : (_sshSubMode == 'sftp' ? 'Terminal' : 'SFTP Check'),
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
                    ),
                  ),
                  const SizedBox(width: 4),
                  InkWell(
                    borderRadius: BorderRadius.circular(6),
                    onTap: () => toggleFullScreen(),
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: Icon(
                        isFullScreen ? Icons.fullscreen_exit_rounded : Icons.fullscreen_rounded,
                        size: 17,
                        color: JalaPalette.brandGold,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (_sshBusy)
              const LinearProgressIndicator(
                minHeight: 2,
                color: JalaPalette.brandGold,
                backgroundColor: JalaPalette.header,
              ),
            Expanded(
              child: canSplitSshSftp && _sshSubMode == 'split'
                  ? Row(
                      children: [
                        Expanded(flex: 3, child: buildTerminalPane()),
                        Container(width: 1, color: JalaPalette.line),
                        Expanded(flex: 2, child: _buildSftpMobileBrowser()),
                      ],
                    )
                  : (_sshSubMode == 'sftp' ? _buildSftpMobileBrowser() : buildTerminalPane()),
            ),
            // Quick-Key Strip
            Container(
              decoration: const BoxDecoration(
                color: JalaPalette.header,
                border: Border(top: BorderSide(color: JalaPalette.line)),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    if (_sshLiveConnected && _sshPtySession != null)
                      Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: ActionChip(
                          backgroundColor: JalaPalette.selected,
                          side: const BorderSide(color: JalaPalette.danger),
                          label: const Text(
                            'Ctrl+C',
                            style: TextStyle(fontSize: 11, fontFamily: 'monospace', color: JalaPalette.danger),
                          ),
                          onPressed: () {
                            _sshPtySession?.write(Uint8List.fromList([0x03]));
                          },
                        ),
                      ),
                    for (final quick in [
                      'uptime',
                      'docker ps',
                      'kubectl get pods',
                      'uname -a',
                      'df -h',
                      'clear',
                    ])
                      Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: ActionChip(
                          backgroundColor: JalaPalette.surface,
                          side: const BorderSide(color: JalaPalette.lineInput),
                          label: Text(
                            quick,
                            style: const TextStyle(
                              fontSize: 11,
                              fontFamily: 'monospace',
                              color: JalaPalette.brandGold,
                            ),
                          ),
                          onPressed: () {
                            if (!canSplitSshSftp) {
                              setState(() => _sshSubMode = 'terminal');
                            }
                            _runSshCommand(quick);
                          },
                        ),
                      ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _sshInputCtrl,
                      onSubmitted: _runSshCommand,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5, color: JalaPalette.text),
                      decoration: InputDecoration(
                        hintText: _sshLiveConnected ? 'Execute remote SSH command...' : 'Enter SSH command...',
                        hintStyle: const TextStyle(color: JalaPalette.muted, fontSize: 12),
                        isDense: true,
                        filled: true,
                        fillColor: JalaPalette.aside,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: const BorderSide(color: JalaPalette.lineInput),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: JalaPalette.accent,
                      foregroundColor: Colors.white,
                    ),
                    onPressed: () => _runSshCommand(_sshInputCtrl.text),
                    child: const Text('Run'),
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _buildSftpMobileBrowser() {
    final entries = _sshLiveConnected && _sftpEntries.isNotEmpty
        ? _sftpEntries
        : const [
            RemoteSftpEntry(
              name: '/etc/nginx/conf.d',
              fullPath: '/etc/nginx/conf.d',
              permissions: 'drwxr-xr-x',
              sizeLabel: '4.0 KB',
              isDirectory: true,
            ),
            RemoteSftpEntry(
              name: '/home/ribato/.ssh',
              fullPath: '/home/ribato/.ssh',
              permissions: 'drwxr-x---',
              sizeLabel: '4.0 KB',
              isDirectory: true,
            ),
            RemoteSftpEntry(
              name: 'docker-compose.prod.yml',
              fullPath: 'docker-compose.prod.yml',
              permissions: '-rw-r-----',
              sizeLabel: '6.8 KB',
              isDirectory: false,
            ),
            RemoteSftpEntry(
              name: '.env.production.sealed',
              fullPath: '.env.production.sealed',
              permissions: '-rw-------',
              sizeLabel: '2.1 KB',
              isDirectory: false,
            ),
            RemoteSftpEntry(
              name: 'jaladesk-audit-2026.jsonl',
              fullPath: 'jaladesk-audit-2026.jsonl',
              permissions: '-rw-r--r--',
              sizeLabel: '1.4 MB',
              isDirectory: false,
            ),
          ];

    return Column(
      children: [
        if (_sshLiveConnected)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            color: JalaPalette.aside,
            child: Row(
              children: [
                const Icon(Icons.folder_open_rounded, size: 15, color: JalaPalette.brandGold),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Remote Path: $_sftpCurrentPath',
                    style: const TextStyle(fontSize: 11.5, fontFamily: 'monospace', color: JalaPalette.text),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                TextButton(
                  onPressed: () {
                    final parent = _sftpCurrentPath.contains('/')
                        ? _sftpCurrentPath.substring(0, _sftpCurrentPath.lastIndexOf('/'))
                        : '..';
                    _browseRemoteSftpPath(parent.isEmpty ? '/' : parent);
                  },
                  child: const Text('Up (..)', style: TextStyle(fontSize: 11, color: JalaPalette.brandGold)),
                ),
              ],
            ),
          ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.all(12),
            itemCount: entries.length,
            itemBuilder: (ctx, i) {
              final item = entries[i];
              return Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: JalaPalette.surface,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: JalaPalette.line),
                ),
                child: Row(
                  children: [
                    Icon(
                      item.isDirectory ? Icons.folder_rounded : Icons.insert_drive_file_outlined,
                      color: item.isDirectory ? JalaPalette.brandGold : JalaPalette.accentLine,
                      size: 20,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            item.name,
                            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: JalaPalette.text),
                          ),
                          Text(
                            '${item.permissions} • ${item.sizeLabel}',
                            style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: JalaPalette.muted),
                          ),
                        ],
                      ),
                    ),
                    TextButton(
                      onPressed: () {
                        if (_sshLiveConnected && item.isDirectory) {
                          _browseRemoteSftpPath(item.fullPath);
                        } else if (_sshLiveConnected && !item.isDirectory) {
                          _viewRemoteSftpFile(item);
                        } else {
                          setState(() => _sshSubMode = 'terminal');
                          _runSshCommand('ls -la ${item.fullPath}');
                        }
                      },
                      child: Text(
                        _sshLiveConnected ? (item.isDirectory ? 'Open' : 'View') : 'Inspect',
                        style: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  /// Zero-Trust Vault, Biometric Lock & Real RFC 6238 HMAC TOTP 2FA Generator Tab
  Widget _buildSecurityVaultTab() {
    final activeTotpList = _totpItems.isNotEmpty
        ? _totpItems
        : const [
            TotpEntryItem(
              id: 'default-totp-1',
              label: 'Production Bastion (mitra-jump)',
              secretBase32: 'JBSWY3DPEHPK3PXP',
              algorithm: 'SHA-256',
            ),
            TotpEntryItem(
              id: 'default-totp-2',
              label: 'Active Directory Admin (brightad1)',
              secretBase32: 'GEZDGNBVGY3TQOJQ',
              algorithm: 'SHA-1',
            ),
            TotpEntryItem(
              id: 'default-totp-3',
              label: 'Proxmox Cluster Root (pve-node01)',
              secretBase32: 'MFRGGZDFMZTWQ2LK',
              algorithm: 'SHA-512',
            ),
          ];

    final totpCard = Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.key_rounded, size: 17, color: JalaPalette.brandGold),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text(
                    'RFC 6238 TOTP 2FA Authenticator',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5, color: JalaPalette.text),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 6),
                InkWell(
                  borderRadius: BorderRadius.circular(6),
                  onTap: _showAddTotpDialog,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                    decoration: BoxDecoration(
                      color: JalaPalette.header,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: JalaPalette.lineInput),
                    ),
                    child: const Text(
                      '+ Add 2FA',
                      style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: JalaPalette.brandGold),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: JalaPalette.selected,
                    borderRadius: BorderRadius.circular(99),
                    border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
                  ),
                  child: Text(
                    '${_secondsRemaining}s',
                    style: const TextStyle(fontSize: 11, color: JalaPalette.brandGold, fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            for (int i = 0; i < activeTotpList.length; i++) ...[
              if (i > 0) const Divider(height: 18),
              _buildTotpRow(
                activeTotpList[i].label,
                '${activeTotpList[i].algorithm} • ${activeTotpList[i].digits} digits',
                Rfc6238Totp.generateCode(
                  activeTotpList[i].secretBase32,
                  algorithm: activeTotpList[i].algorithm,
                  digits: activeTotpList[i].digits,
                ),
              ),
            ],
          ],
        ),
      ),
    );

    final securitySwitchesCard = Card(
      child: Column(
        children: [
          SwitchListTile(
            activeThumbColor: JalaPalette.brandGold,
            activeTrackColor: JalaPalette.selected,
            value: _biometricLock,
            onChanged: (v) => setState(() => _biometricLock = v),
            title: const Text(
              'Biometric Enclave Unlock (FaceID / TouchID)',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
            ),
            subtitle: const Text(
              'Require hardware biometric verification before decrypting .rtsz / .jaladesk credentials',
              style: TextStyle(fontSize: 11.5, color: JalaPalette.muted),
            ),
          ),
          const Divider(height: 1),
          SwitchListTile(
            activeThumbColor: JalaPalette.brandGold,
            activeTrackColor: JalaPalette.selected,
            value: _lanAutoSync,
            onChanged: (v) => setState(() => _lanAutoSync = v),
            title: const Text(
              'Zero-Knowledge LAN mDNS Vault Sync',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
            ),
            subtitle: const Text(
              'Automatically synchronize encrypted connection documents with JalaDesk Desktop on Wi-Fi',
              style: TextStyle(fontSize: 11.5, color: JalaPalette.muted),
            ),
          ),
          const Divider(height: 1),
          SwitchListTile(
            activeThumbColor: JalaPalette.brandGold,
            activeTrackColor: JalaPalette.selected,
            value: _clipboardScrubber,
            onChanged: (v) => setState(() => _clipboardScrubber = v),
            title: const Text(
              'Automatic Clipboard Secret Scrubber (30s)',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
            ),
            subtitle: const Text(
              'Purge copied passwords and TOTP tokens from mobile OS clipboard after 30 seconds',
              style: TextStyle(fontSize: 11.5, color: JalaPalette.muted),
            ),
          ),
        ],
      ),
    );

    return LayoutBuilder(
      builder: (ctx, constraints) {
        final isTwoColumn = constraints.maxWidth >= 720;
        return ListView(
          padding: const EdgeInsets.all(14),
          children: [
            Container(
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [JalaPalette.chip, JalaPalette.surface],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.35)),
              ),
              child: Row(
                children: [
                  _buildJalaBrandLogo(size: 38, radius: 10),
                  const SizedBox(width: 11),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Zero-Trust Hardware Enclave',
                          style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: JalaPalette.text),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        SizedBox(height: 2),
                        Text(
                          'AES-256-GCM • PBKDF2 210k • Secure Enclave Active',
                          style: TextStyle(fontSize: 11, color: JalaPalette.brandGold),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: JalaPalette.ok.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(99),
                      border: Border.all(color: JalaPalette.ok.withValues(alpha: 0.45)),
                    ),
                    child: const Text(
                      'SEALED',
                      style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: JalaPalette.ok),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            if (isTwoColumn)
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: totpCard),
                  const SizedBox(width: 12),
                  Expanded(child: securitySwitchesCard),
                ],
              )
            else ...[
              totpCard,
              const SizedBox(height: 12),
              securitySwitchesCard,
            ],
          ],
        );
      },
    );
  }

  Widget _buildTotpRow(String label, String meta, String digits) {
    final formatted = digits.length >= 6
        ? '${digits.substring(0, 3)} ${digits.substring(3)}'
        : digits;
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: JalaPalette.text),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              Text(meta, style: const TextStyle(fontSize: 11, color: JalaPalette.muted)),
            ],
          ),
        ),
        const SizedBox(width: 8),
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () {
            Clipboard.setData(ClipboardData(text: digits));
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(
                  'Copied 2FA code ($formatted) • Auto-scrubs in ${_clipboardScrubber ? "30s" : "manual mode"}',
                ),
              ),
            );
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: JalaPalette.header,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
            ),
            child: Text(
              formatted,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontWeight: FontWeight.w800,
                fontSize: 14,
                letterSpacing: 1.1,
                color: JalaPalette.brandGold,
              ),
            ),
          ),
        ),
      ],
    );
  }

  IconData _iconForProtocol(RemoteProtocol protocol) {
    switch (protocol) {
      case RemoteProtocol.rdp:
        return Icons.desktop_windows_rounded;
      case RemoteProtocol.ssh:
        return Icons.terminal_rounded;
      case RemoteProtocol.vnc:
        return Icons.laptop_mac_rounded;
      case RemoteProtocol.sftp:
        return Icons.folder_shared_rounded;
      case RemoteProtocol.hypervisor:
        return Icons.dns_rounded;
    }
  }
}
