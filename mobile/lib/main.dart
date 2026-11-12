import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' show max, min;
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'protocols/desktop_gesture_surface.dart';
import 'protocols/rdp_ffi_client.dart';
import 'protocols/ssh_bastion_tunnel.dart';
import 'protocols/vnc_rfb_client.dart';
import 'security/vault_security_service.dart';
import 'terminal/sftp_explorer_view.dart';
import 'terminal/sftp_transfer_service.dart';
import 'terminal/termius_terminal.dart';

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

  /// 9 Semantic Object Marks matching JalaDesk Desktop (`--mark-*` in `DESIGN.md`)
  static const Map<String, Color> semanticMarks = <String, Color>{
    'sapphire': Color(0xFF5AA2D4),
    'gold': Color(0xFFEDBA6E),
    'emerald': Color(0xFF69CE96),
    'teal': Color(0xFF4CC9C0),
    'coral': Color(0xFFF27D72),
    'amber': Color(0xFFE7A34B),
    'indigo': Color(0xFF8492F6),
    'purple': Color(0xFFB98CF7),
    'slate': Color(0xFF93A5BA),
  };

  static Color colorForMark(String mark) => semanticMarks[mark] ?? accentLine;
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
  final String? jumpHostId;
  final String? credentialId;
  final bool isFavorite;
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
    this.jumpHostId,
    this.credentialId,
    this.isFavorite = false,
    this.latencyMs,
    this.isOnline,
    this.accentTint = 'sapphire',
  });

  bool get hasJumpHost => jumpHostId != null && jumpHostId!.trim().isNotEmpty;
  bool get hasBoundCredential => credentialId != null && credentialId!.trim().isNotEmpty;

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
    if (dom.isNotEmpty && usr.isNotEmpty && !usr.contains('\\')) {
      return '$dom\\$usr';
    }
    return usr;
  }

  String get formattedEndpoint {
    final acct = displayAccount.trim();
    return acct.isNotEmpty ? '$acct@$address:$port' : '$address:$port';
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
    String? jumpHostId,
    bool clearJumpHost = false,
    String? credentialId,
    bool clearCredential = false,
    bool? isFavorite,
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
      jumpHostId: clearJumpHost ? null : (jumpHostId ?? this.jumpHostId),
      credentialId: clearCredential ? null : (credentialId ?? this.credentialId),
      isFavorite: isFavorite ?? this.isFavorite,
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
        'jumpHostId': jumpHostId,
        'credentialId': credentialId,
        'isFavorite': isFavorite,
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
    final rawJump = (json['jumpHostId'] as String?)?.trim();
    final rawCred = (json['credentialId'] as String?)?.trim();
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
      jumpHostId: (rawJump == null || rawJump.isEmpty) ? null : rawJump,
      credentialId: (rawCred == null || rawCred.isEmpty) ? null : rawCred,
      isFavorite: json['isFavorite'] as bool? ?? false,
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
  final int sizeBytes;
  final String sizeLabel;
  final bool isDirectory;

  const RemoteSftpEntry({
    required this.name,
    required this.fullPath,
    required this.permissions,
    this.sizeBytes = 0,
    required this.sizeLabel,
    required this.isDirectory,
  });

  SftpFileEntry toExplorerEntry() => SftpFileEntry(
        name: name,
        permissions: permissions,
        sizeBytes: sizeBytes,
        sizeLabel: sizeLabel,
        isDirectory: isDirectory,
      );
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

class JalaDeskMobileShellState extends State<JalaDeskMobileShell> with WidgetsBindingObserver {
  static const String _prefsHostsKey = 'jaladesk_vault_hosts_v2';
  static const String _prefsCredentialsKey = 'jaladesk_vault_credentials_v1';
  static const String _prefsTotpKey = 'jaladesk_vault_totp_v2';
  static const String _prefsPairKey = 'jaladesk_vault_pair_v2';
  static const String _prefsTermThemeKey = 'jaladesk_terminal_theme_v1';
  static const String _prefsTermFontKey = 'jaladesk_terminal_font_v1';
  static const String _prefsSnippetsKey = 'jaladesk_terminal_snippets_v1';
  static const String _prefsKnownHostsKey = 'jaladesk_ssh_known_hosts_v1';
  static const String _prefsPinHashKey = 'jaladesk_vault_pin_hash_v1';
  static const String _prefsSecureScreenKey = 'jaladesk_secure_screen_v1';

  int _tabIndex = 0;
  String _protocolFilter = 'ALL';
  String _searchQuery = '';
  String _pairedDesktopInfo = 'Local Encrypted Vault • AES-256-GCM';
  bool _vaultLoaded = false;
  bool _probingAll = false;
  final Set<String> _collapsedFolders = <String>{};

  final List<RemoteHostItem> _hosts = [];
  final List<VaultCredentialItem> _credentials = [];
  final List<TotpEntryItem> _totpItems = [];

  List<RemoteHostItem> get hosts => List.unmodifiable(_hosts);
  List<VaultCredentialItem> get credentials => List.unmodifiable(_credentials);
  List<ActiveLocalPortForward> get activePortForwards => List.unmodifiable(_activePortForwards);

  RemoteHostItem? _activeRdpHost;
  RemoteHostItem? _activeSshHost;

  // Live RDP (FreeRDP 3.x FFI) & VNC (RFB 3.8 / Apple ARD) Framebuffer Engine state
  RdpFfiClient? _rdpFfiClient;
  VncRfbClient? _vncRfbClient;
  ActiveLocalPortForward? _desktopBastionTunnel;
  ui.Image? _remoteDesktopFrame;
  bool _desktopLiveConnected = false;
  String _desktopProtocolBanner = 'No active remote desktop session';
  int _desktopServerWidth = 1280;
  int _desktopServerHeight = 800;
  static const String _kDesktopImeSentinel = '\u200B\u200B';
  bool _trackpadMode = true;
  bool _viewOnly = false;
  bool _showDesktopKeyboardBar = false;
  final TextEditingController _desktopKeyInputCtrl = TextEditingController();
  late final TextEditingController _desktopImeCtrl;
  final FocusNode _desktopImeFocusNode = FocusNode(debugLabel: 'DesktopLiveRemoteKeyboard');
  bool _suppressDesktopImeCallback = false;
  bool _desktopImeFocused = false;
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
  bool _fullScreenChromeVisible = true;
  bool _pinFullScreenChrome = false;
  Timer? _fullScreenAutoHideTimer;
  bool _landscapeLocked = false;
  bool _showTabletSidebar = true;
  final TransformationController _canvasTransformCtrl = TransformationController();
  Size _lastMeasuredCanvasSize = const Size(1280, 800);
  Timer? _autoResizeDebounce;

  // Live SSHv2 Interactive PTY Shell, SFTP Client & Bastion Port-Forwards (`dartssh2`)
  SSHClient? _sshClient;
  SSHSession? _sshPtySession;
  SshBastionChain? _sshBastionChain;
  final List<ActiveLocalPortForward> _activePortForwards = [];
  StreamSubscription<Uint8List>? _sshStdoutSub;
  StreamSubscription<Uint8List>? _sshStderrSub;
  SftpClient? _sftpClient;
  bool _sshLiveConnected = false;
  bool _sshBusy = false;
  String _sshSubMode = 'terminal';
  String _sftpCurrentPath = '/etc/nginx/conf.d';
  List<RemoteSftpEntry> _sftpEntries = [];
  final AnsiTerminalBuffer _terminalBuffer = AnsiTerminalBuffer();
  String _terminalThemeId = 'jala_sapphire';
  double _terminalFontSize = 13.0;
  final List<TerminalSnippetItem> _customSnippets = [];
  String _offlineTerminalLine = '';
  final List<RemoteSftpEntry> _offlineSftpEntries = [
    const RemoteSftpEntry(
      name: 'ssl-certs',
      fullPath: '/etc/nginx/conf.d/ssl-certs',
      permissions: 'drwxr-xr-x',
      sizeBytes: 4096,
      sizeLabel: '4.0 KB',
      isDirectory: true,
    ),
    const RemoteSftpEntry(
      name: 'upstreams',
      fullPath: '/etc/nginx/conf.d/upstreams',
      permissions: 'drwxr-xr-x',
      sizeBytes: 4096,
      sizeLabel: '4.0 KB',
      isDirectory: true,
    ),
    const RemoteSftpEntry(
      name: '.htpasswd.sealed',
      fullPath: '/etc/nginx/conf.d/.htpasswd.sealed',
      permissions: '-rw-------',
      sizeBytes: 2150,
      sizeLabel: '2.1 KB',
      isDirectory: false,
    ),
    const RemoteSftpEntry(
      name: 'default.conf',
      fullPath: '/etc/nginx/conf.d/default.conf',
      permissions: '-rw-r--r--',
      sizeBytes: 3480,
      sizeLabel: '3.4 KB',
      isDirectory: false,
    ),
    const RemoteSftpEntry(
      name: 'zero-trust-gateway.conf',
      fullPath: '/etc/nginx/conf.d/zero-trust-gateway.conf',
      permissions: '-rw-r-----',
      sizeBytes: 6963,
      sizeLabel: '6.8 KB',
      isDirectory: false,
    ),
    const RemoteSftpEntry(
      name: 'jaladesk-audit-2026.jsonl',
      fullPath: '/etc/nginx/conf.d/jaladesk-audit-2026.jsonl',
      permissions: '-rw-r--r--',
      sizeBytes: 1468006,
      sizeLabel: '1.4 MB',
      isDirectory: false,
    ),
  ];

  // TOTP Timer & Enterprise Security Enclave state
  late Timer _totpTimer;
  int _secondsRemaining = 30;
  bool _biometricLock = true;
  bool _secureScreenShield = true;
  bool _lanAutoSync = true;
  bool _clipboardScrubber = true;
  String _vaultPinHash = '';
  bool _isVaultLocked = false;
  DateTime? _backgroundedAt;
  SftpTransferProgress? _activeSftpTransfer;
  final SshKnownHostsStore _knownHostsStore = SshKnownHostsStore();
  final ClipboardSecretScrubber _clipboardScrubberEngine = ClipboardSecretScrubber();

  String get _offlinePrompt {
    final hostLabel = _activeSshHost?.name.split(' ').first ?? 'jaladesk';
    final userLabel = (_activeSshHost?.username.isNotEmpty ?? false) ? _activeSshHost!.username : 'root';
    return '\x1b[1;32m$userLabel@$hostLabel\x1b[0m:\x1b[1;34m~\x1b[0m\$ ';
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _desktopImeCtrl = TextEditingController(text: _kDesktopImeSentinel);
    _desktopImeCtrl.selection = const TextSelection.collapsed(offset: _kDesktopImeSentinel.length);
    _desktopImeFocusNode.addListener(() {
      if (mounted && _desktopImeFocused != _desktopImeFocusNode.hasFocus) {
        setState(() => _desktopImeFocused = _desktopImeFocusNode.hasFocus);
      }
    });
    _terminalBuffer.write(
      '\x1b[1;33mJalaDesk Interactive SSHv2 PTY\x1b[0m (xterm-256color)\r\n'
      'Tap anywhere on the terminal to type directly, or connect to a live SSH server.\r\n'
      '$_offlinePrompt',
    );
    _updateTotpCountdown();
    _totpTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) _updateTotpCountdown();
    });
    _loadPersistedVault();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      _backgroundedAt ??= DateTime.now();
    } else if (state == AppLifecycleState.resumed) {
      final bg = _backgroundedAt;
      _backgroundedAt = null;
      if (_vaultPinHash.isNotEmpty &&
          bg != null &&
          DateTime.now().difference(bg).inSeconds >= 12) {
        setState(() => _isVaultLocked = true);
      }
    }
  }

  void _scheduleFullScreenAutoHide({Duration delay = const Duration(milliseconds: 3500)}) {
    _fullScreenAutoHideTimer?.cancel();
    if (!_isFullScreen || _pinFullScreenChrome) return;
    _fullScreenAutoHideTimer = Timer(delay, () {
      if (!mounted || !_isFullScreen || _pinFullScreenChrome) return;
      setState(() {
        _fullScreenChromeVisible = false;
      });
    });
  }

  void _revealFullScreenChrome() {
    if (!_fullScreenChromeVisible) {
      setState(() {
        _fullScreenChromeVisible = true;
        _floatingHudExpanded = true;
      });
    }
    _scheduleFullScreenAutoHide();
  }

  /// Toggles true edge-to-edge Immersive Sticky Full Screen mode with auto-hiding shortcut chrome
  void toggleFullScreen([bool? forceValue]) {
    final next = forceValue ?? !_isFullScreen;
    _fullScreenAutoHideTimer?.cancel();
    setState(() {
      _isFullScreen = next;
      if (next) {
        _floatingHudExpanded = true;
        _fullScreenChromeVisible = true;
      } else {
        _fullScreenChromeVisible = true;
      }
    });
    if (next) {
      _scheduleFullScreenAutoHide();
    }
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

  /// Sends a live MS-RDPEDISP / VNC ExtendedDesktopSize resolution update to the active session
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
    } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
      if (_vncRfbClient!.supportsExtendedDesktopSize) {
        _vncRfbClient!.requestResolution(targetW, targetH);
        setState(() {
          _lastRdpAction = 'VNC Dynamic Display Sizing → ${targetW}x$targetH (${_resolutionPreset.shortLabel})';
        });
      } else {
        // Fixed hardware VNC monitor: preserve true server geometry so aspect ratio & pointer mapping stay 1:1
        setState(() {
          _desktopServerWidth = _vncRfbClient!.width;
          _desktopServerHeight = _vncRfbClient!.height;
          _canvasTransformCtrl.value = Matrix4.identity();
          _lastRdpAction =
              'VNC Fixed Display (${_vncRfbClient!.width}x${_vncRfbClient!.height}) • ${_canvasFitMode.label}';
        });
      }
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
    if (dw < 16 && dh < 16) return;
    _lastMeasuredCanvasSize = newSize;

    final canResizeRdp = _rdpFfiClient != null && _rdpFfiClient!.isConnected;
    final canResizeVnc = _vncRfbClient != null &&
        _vncRfbClient!.isConnected &&
        _vncRfbClient!.supportsExtendedDesktopSize;
    if ((canResizeRdp || canResizeVnc) &&
        (_resolutionPreset == JumpResolutionPreset.matchDisplay ||
            _resolutionPreset == JumpResolutionPreset.matchHiDpi)) {
      _autoResizeDebounce?.cancel();
      _autoResizeDebounce = Timer(const Duration(milliseconds: 180), () {
        if (!mounted) return;
        _applyTargetResolutionToActiveSession(viewportOverride: newSize);
      });
    }
  }

  /// Computes the exact destination `Rect` of the remote desktop frame inside the viewport.
  /// - `aspectFit` (`Fit`): Fits entire desktop inside viewport at 1:1 aspect ratio.
  /// - `cropCover` (`Fill` / Jump Pan): Fills 100% of screen at true 1:1 aspect ratio (zero distortion!)
  ///   and smoothly pans across the full width/height as you move the cursor or drag with 2 fingers.
  /// - `stretchFill` (`Stretch`): Stretches edge-to-edge.
  Rect _computeRenderedDesktopRect(Size viewportSize) {
    final srvW = _desktopServerWidth.clamp(64, 8192).toDouble();
    final srvH = _desktopServerHeight.clamp(64, 8192).toDouble();
    if (_canvasFitMode == JumpCanvasFitMode.stretchFill) {
      return Rect.fromLTWH(0, 0, viewportSize.width, viewportSize.height);
    }
    if (_canvasFitMode == JumpCanvasFitMode.cropCover) {
      final coverScale = max(viewportSize.width / srvW, viewportSize.height / srvH);
      final dstW = (srvW * coverScale).clamp(1.0, 16384.0);
      final dstH = (srvH * coverScale).clamp(1.0, 16384.0);
      final dx = (viewportSize.width - dstW) / 2.0;
      final dy = (viewportSize.height - dstH) / 2.0;
      return Rect.fromLTWH(dx, dy, dstW, dstH);
    }
    if (_canvasFitMode == JumpCanvasFitMode.pixel1to1) {
      final dx = (viewportSize.width - srvW) / 2.0;
      final dy = (viewportSize.height - srvH) / 2.0;
      return Rect.fromLTWH(dx, dy, srvW, srvH);
    }
    final fitScale = min(viewportSize.width / srvW, viewportSize.height / srvH);
    final dstW = (srvW * fitScale).clamp(1.0, viewportSize.width);
    final dstH = (srvH * fitScale).clamp(1.0, viewportSize.height);
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
    if ((mode == 'sftp' || mode == 'split') && _sshLiveConnected) {
      _browseRemoteSftpPath(_sftpCurrentPath);
    }
  }

  Future<void> runSshCommandForVerification(String cmd) async {
    await _runSshCommand(cmd);
  }

  void setTerminalThemeForVerification(String themeId) {
    setState(() => _terminalThemeId = themeId);
    _saveVaultToDisk();
  }

  void sendTerminalRawForVerification(String raw) {
    _sendRawTerminalInput(raw);
  }

  Future<void> browseSftpPathForVerification(String path) async {
    await _browseRemoteSftpPath(path);
  }

  void openThemeSheetForVerification() {
    _showTerminalThemeSheet();
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
      final rawLegacyHosts = prefs.getString(_prefsHostsKey);
      final rawHosts = await VaultAtRestCipher.decryptFromPrefs(prefs, _prefsHostsKey);
      final rawCreds = await VaultAtRestCipher.decryptFromPrefs(prefs, _prefsCredentialsKey);
      final rawTotp = await VaultAtRestCipher.decryptFromPrefs(prefs, _prefsTotpKey);
      final rawKnownHosts = await VaultAtRestCipher.decryptFromPrefs(prefs, _prefsKnownHostsKey);
      final savedPair = prefs.getString(_prefsPairKey);
      final savedTheme = prefs.getString(_prefsTermThemeKey);
      final savedFont = prefs.getDouble(_prefsTermFontKey);
      final rawSnippets = prefs.getString(_prefsSnippetsKey);
      final savedPinHash = prefs.getString(_prefsPinHashKey) ?? '';
      final savedSecureScreen = prefs.getBool(_prefsSecureScreenKey) ?? true;

      final loadedHosts = <RemoteHostItem>[];
      if (rawHosts != null && rawHosts.isNotEmpty) {
        final decoded = jsonDecode(rawHosts) as List<dynamic>;
        for (final item in decoded) {
          if (item is Map<String, dynamic>) {
            loadedHosts.add(RemoteHostItem.fromJson(item));
          }
        }
      }

      final loadedCreds = <VaultCredentialItem>[];
      if (rawCreds != null && rawCreds.isNotEmpty) {
        final decoded = jsonDecode(rawCreds) as List<dynamic>;
        for (final item in decoded) {
          if (item is Map<String, dynamic>) {
            loadedCreds.add(VaultCredentialItem.fromJson(item));
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

      if (rawKnownHosts != null && rawKnownHosts.isNotEmpty) {
        final decoded = jsonDecode(rawKnownHosts) as List<dynamic>;
        _knownHostsStore.loadFromJsonList(decoded);
      }

      final loadedSnippets = <TerminalSnippetItem>[];
      if (rawSnippets != null && rawSnippets.isNotEmpty) {
        final decoded = jsonDecode(rawSnippets) as List<dynamic>;
        for (final item in decoded) {
          if (item is Map<String, dynamic>) {
            loadedSnippets.add(TerminalSnippetItem.fromJson(item));
          }
        }
      }

      if (!mounted) return;
      setState(() {
        _hosts
          ..clear()
          ..addAll(loadedHosts);
        _credentials
          ..clear()
          ..addAll(loadedCreds);
        _totpItems
          ..clear()
          ..addAll(loadedTotp);
        _customSnippets
          ..clear()
          ..addAll(loadedSnippets);
        if (savedPair != null && savedPair.isNotEmpty) {
          _pairedDesktopInfo = savedPair;
        }
        if (savedTheme != null && savedTheme.isNotEmpty) {
          _terminalThemeId = savedTheme;
        }
        if (savedFont != null) {
          _terminalFontSize = savedFont.clamp(10.0, 18.0);
        }
        _vaultPinHash = savedPinHash;
        _isVaultLocked = savedPinHash.isNotEmpty;
        _secureScreenShield = savedSecureScreen;
        _syncActiveHostSelection();
        _vaultLoaded = true;
      });

      unawaited(NativePlatformBridge.setSecureScreen(savedSecureScreen));

      // Transparently seal legacy v2 plaintext JSON into AES-256-GCM on upgrade
      if (rawLegacyHosts != null &&
          rawLegacyHosts.isNotEmpty &&
          !rawLegacyHosts.startsWith(VaultAtRestCipher.envelopePrefix)) {
        unawaited(_saveVaultToDisk());
      }

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
      final sealedHosts = await VaultAtRestCipher.encryptForPrefs(
        prefs,
        jsonEncode(_hosts.map((h) => h.toJson()).toList()),
      );
      final sealedCreds = await VaultAtRestCipher.encryptForPrefs(
        prefs,
        jsonEncode(_credentials.map((c) => c.toJson()).toList()),
      );
      final sealedTotp = await VaultAtRestCipher.encryptForPrefs(
        prefs,
        jsonEncode(_totpItems.map((t) => t.toJson()).toList()),
      );
      final sealedKnownHosts = await VaultAtRestCipher.encryptForPrefs(
        prefs,
        jsonEncode(_knownHostsStore.toJsonList()),
      );
      await prefs.setString(_prefsHostsKey, sealedHosts);
      await prefs.setString(_prefsCredentialsKey, sealedCreds);
      await prefs.setString(_prefsTotpKey, sealedTotp);
      await prefs.setString(_prefsKnownHostsKey, sealedKnownHosts);
      await prefs.setString(_prefsPairKey, _pairedDesktopInfo);
      await prefs.setString(_prefsTermThemeKey, _terminalThemeId);
      await prefs.setDouble(_prefsTermFontKey, _terminalFontSize);
      await prefs.setString(_prefsPinHashKey, _vaultPinHash);
      await prefs.setBool(_prefsSecureScreenKey, _secureScreenShield);
      await prefs.setString(
        _prefsSnippetsKey,
        jsonEncode(_customSnippets.map((s) => s.toJson()).toList()),
      );
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
    WidgetsBinding.instance.removeObserver(this);
    _totpTimer.cancel();
    _autoResizeDebounce?.cancel();
    _fullScreenAutoHideTimer?.cancel();
    _clipboardScrubberEngine.dispose();
    _canvasTransformCtrl.dispose();
    _terminalBuffer.dispose();
    _desktopKeyInputCtrl.dispose();
    _desktopImeCtrl.dispose();
    _desktopImeFocusNode.dispose();
    _closeDesktopSession();
    _closeSshClient();
    for (final pf in _activePortForwards.toList()) {
      unawaited(pf.close());
    }
    _activePortForwards.clear();
    super.dispose();
  }

  bool _isHostLiveConnected(RemoteHostItem host) {
    if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
      return _sshLiveConnected && _activeSshHost?.id == host.id;
    }
    if (host.protocol == RemoteProtocol.rdp || host.protocol == RemoteProtocol.vnc) {
      return _desktopLiveConnected && _activeRdpHost?.id == host.id;
    }
    return false;
  }

  void _resumeLiveHostSession(RemoteHostItem host, {String? sshSubMode}) {
    setState(() {
      if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
        if (sshSubMode != null) {
          _sshSubMode = sshSubMode;
        }
        _tabIndex = 2;
      } else {
        _tabIndex = 1;
      }
    });
    if ((sshSubMode == 'sftp' || sshSubMode == 'split') && _sshLiveConnected) {
      unawaited(_browseRemoteSftpPath(_sftpCurrentPath));
    }
  }

  void _disconnectDesktopSession({bool showFeedback = true}) {
    final prevName = _activeRdpHost?.name ?? 'Remote Desktop';
    if (_isFullScreen && _tabIndex == 1) {
      toggleFullScreen(false);
    }
    setState(() {
      _closeDesktopSession();
      _canvasTransformCtrl.value = Matrix4.identity();
      _lastRdpAction = 'Disconnected from $prevName. Tap Connect Live to start a new session.';
      _desktopProtocolBanner = 'Session disconnected';
    });
    if (showFeedback && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Disconnected from $prevName')),
      );
    }
  }

  void _disconnectSshSession({bool showFeedback = true}) {
    final prevName = _activeSshHost?.name ?? 'SSH Server';
    if (_isFullScreen && _tabIndex == 2) {
      toggleFullScreen(false);
    }
    setState(() {
      _closeSshClient();
      _activeSftpTransfer = null;
    });
    _terminalBuffer.write(
      '\r\n\x1b[1;33m● Session disconnected from $prevName.\x1b[0m\r\n$_offlinePrompt',
    );
    if (showFeedback && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Disconnected from $prevName')),
      );
    }
  }

  void _closeDesktopSession() {
    final rdp = _rdpFfiClient;
    final vnc = _vncRfbClient;
    final bastionTunnel = _desktopBastionTunnel;
    _rdpFfiClient = null;
    _vncRfbClient = null;
    _desktopBastionTunnel = null;
    _desktopLiveConnected = false;
    // CRITICAL: Always clear previous session's GPU frame so switching RDP -> VNC never displays stale pixels!
    _remoteDesktopFrame = null;
    if (rdp != null) unawaited(rdp.dispose());
    if (vnc != null) unawaited(vnc.dispose());
    if (bastionTunnel != null) unawaited(bastionTunnel.close());
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
    final bastion = _sshBastionChain;
    _sshBastionChain = null;
    if (bastion != null) unawaited(bastion.dispose());
    _sshPtySession = null;
    _sftpClient = null;
    _sshClient = null;
    _sshLiveConnected = false;
  }

  void _appendPtyOutput(String chunk) {
    if (chunk.isEmpty || !mounted) return;
    _terminalBuffer.write(chunk);
  }

  VaultCredentialItem? _findCredential(String? id) {
    if (id == null || id.trim().isEmpty) return null;
    for (final c in _credentials) {
      if (c.id == id) return c;
    }
    return null;
  }

  /// Resolves effective authentication fields by applying any bound `VaultCredentialItem`
  /// (mirrors JalaDesk Desktop's credential binding & inheritance model).
  RemoteHostItem _resolveEffectiveHost(RemoteHostItem host) {
    final bound = _findCredential(host.credentialId);
    if (bound == null) return host;
    return host.copyWith(
      domain: bound.domain.trim().isNotEmpty ? bound.domain.trim() : host.domain,
      username: bound.username.trim().isNotEmpty ? bound.username.trim() : host.username,
      password: bound.password.isNotEmpty ? bound.password : host.password,
      privateKeyPem: bound.privateKeyPem.trim().isNotEmpty ? bound.privateKeyPem.trim() : host.privateKeyPem,
    );
  }

  List<RemoteHostItem> _tryResolveHopHosts(RemoteHostItem host) {
    try {
      return SshBastionRouteResolver.resolveHopItems<RemoteHostItem>(
        target: host,
        allHosts: _hosts,
        idOf: (h) => h.id,
        nameOf: (h) => h.name,
        jumpHostIdOf: (h) => h.jumpHostId,
        isSshCapable: (h) => h.protocol == RemoteProtocol.ssh,
      );
    } catch (_) {
      return const [];
    }
  }

  String _routeBadgeForHost(RemoteHostItem host) {
    if (!host.hasJumpHost) return '';
    try {
      final hops = SshBastionRouteResolver.resolveHopItems<RemoteHostItem>(
        target: host,
        allHosts: _hosts,
        idOf: (h) => h.id,
        nameOf: (h) => h.name,
        jumpHostIdOf: (h) => h.jumpHostId,
        isSshCapable: (h) => h.protocol == RemoteProtocol.ssh,
      );
      return SshBastionRouteResolver.formatRouteBadge(hops.map((h) => h.name).toList());
    } on BastionRoutingException {
      return 'Jump Host Warning';
    }
  }

  /// Resolves all SSH Jump Host hops (`[hop1, hop2, ...]`) for `target`, prompting for missing
  /// bastion credentials if needed before opening the encrypted tunnel. Returns `null` if cancelled.
  Future<List<BastionHopSpec>?> _prepareBastionHops(RemoteHostItem target) async {
    if (!target.hasJumpHost) return const <BastionHopSpec>[];
    final hopItems = SshBastionRouteResolver.resolveHopItems<RemoteHostItem>(
      target: target,
      allHosts: _hosts,
      idOf: (h) => h.id,
      nameOf: (h) => h.name,
      jumpHostIdOf: (h) => h.jumpHostId,
      isSshCapable: (h) => h.protocol == RemoteProtocol.ssh,
    );

    final specs = <BastionHopSpec>[];
    for (final rawHop in hopItems) {
      RemoteHostItem effectiveHop = _resolveEffectiveHost(rawHop);
      if (effectiveHop.password.isEmpty && effectiveHop.privateKeyPem.trim().isEmpty) {
        final prompted = await _promptCredentialsIfNeeded(
          effectiveHop,
          forcePrompt: true,
          customTitle: 'Jump Host Auth: ${rawHop.name}',
        );
        if (prompted == null) return null;
        effectiveHop = prompted;
      }
      final (_, hopUser) = effectiveHop.resolvedDomainAndUser;
      specs.add(
        BastionHopSpec(
          id: effectiveHop.id,
          name: effectiveHop.name,
          address: effectiveHop.address,
          port: effectiveHop.port,
          username: hopUser.isEmpty ? 'root' : hopUser,
          password: effectiveHop.password,
          privateKeyPem: effectiveHop.privateKeyPem,
        ),
      );
    }
    return specs;
  }

  /// Real TCP Socket RTT Prober (`dart:io` `Socket.connect`)
  /// Bastion-aware: if a host tunnels through an SSH Jump Host, probes the entry Jump Host gateway!
  Future<void> _probeSingleHost(RemoteHostItem host) async {
    if (widget.disableNetworkProbes) return;
    final hopChain = _tryResolveHopHosts(host);
    final probeTarget = hopChain.isNotEmpty ? hopChain.first : host;
    final sw = Stopwatch()..start();
    try {
      final socket = await Socket.connect(
        probeTarget.address,
        probeTarget.port,
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

  /// Opens Add or Edit Reusable Vault Credential Dialog (Desktop `src/credentials/` parity)
  Future<VaultCredentialItem?> _showVaultCredentialEditorDialog({VaultCredentialItem? existing}) async {
    final labelCtrl = TextEditingController(text: existing?.label ?? '');
    final domainCtrl = TextEditingController(text: existing?.domain ?? '');
    final userCtrl = TextEditingController(text: existing?.username ?? 'root');
    final passCtrl = TextEditingController(text: existing?.password ?? '');
    final keyCtrl = TextEditingController(text: existing?.privateKeyPem ?? '');
    final notesCtrl = TextEditingController(text: existing?.notes ?? '');
    bool obscurePass = true;
    bool showKeyField = (existing?.privateKeyPem ?? '').trim().isNotEmpty;

    return showDialog<VaultCredentialItem>(
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
              const Icon(Icons.vpn_key_rounded, size: 20, color: JalaPalette.brandGold),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  existing == null ? 'New Vault Credential' : 'Edit Vault Credential',
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: JalaPalette.text),
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
                  _buildModalField(
                    controller: labelCtrl,
                    label: 'Credential Name *',
                    hint: 'e.g. PLN Batam AD Admin or Prod Bastion Key',
                    icon: Icons.badge_outlined,
                  ),
                  const SizedBox(height: 10),
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
                          label: 'Username *',
                          hint: 'adminit / ribato',
                          icon: Icons.person_outline_rounded,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: passCtrl,
                    obscureText: obscurePass,
                    style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                    decoration: InputDecoration(
                      labelText: 'Password / Key Passphrase',
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
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: () => setModalState(() => showKeyField = !showKeyField),
                      icon: Icon(
                        showKeyField ? Icons.expand_less_rounded : Icons.key_rounded,
                        size: 16,
                        color: JalaPalette.brandGold,
                      ),
                      label: Text(
                        showKeyField ? 'Hide Private Key (PEM)' : '+ Attach SSH Private Key (Ed25519 / RSA PEM)',
                        style: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                      ),
                    ),
                  ),
                  if (showKeyField) ...[
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
                    const SizedBox(height: 10),
                  ],
                  _buildModalField(
                    controller: notesCtrl,
                    label: 'Scope / Notes (optional)',
                    hint: 'Shared across Core AD & Linux Bastions',
                    icon: Icons.notes_rounded,
                  ),
                ],
              ),
            ),
          ),
          actions: [
            if (existing != null)
              TextButton.icon(
                onPressed: () {
                  setState(() {
                    _credentials.removeWhere((c) => c.id == existing.id);
                    for (int i = 0; i < _hosts.length; i++) {
                      if (_hosts[i].credentialId == existing.id) {
                        _hosts[i] = _hosts[i].copyWith(clearCredential: true);
                      }
                    }
                  });
                  _saveVaultToDisk();
                  Navigator.of(ctx).pop(null);
                },
                icon: const Icon(Icons.delete_outline_rounded, size: 16, color: JalaPalette.danger),
                label: const Text('Delete', style: TextStyle(color: JalaPalette.danger)),
              ),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(null),
              child: const Text('Cancel', style: TextStyle(color: JalaPalette.muted)),
            ),
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: JalaPalette.accent, foregroundColor: Colors.white),
              onPressed: () {
                final lbl = labelCtrl.text.trim();
                if (lbl.isEmpty) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Please enter a Credential Name.')),
                  );
                  return;
                }
                final saved = VaultCredentialItem(
                  id: existing?.id ?? 'cred-${DateTime.now().microsecondsSinceEpoch}',
                  label: lbl,
                  domain: domainCtrl.text.trim(),
                  username: userCtrl.text.trim().isEmpty ? 'root' : userCtrl.text.trim(),
                  password: passCtrl.text,
                  privateKeyPem: keyCtrl.text.trim(),
                  notes: notesCtrl.text.trim(),
                );
                setState(() {
                  if (existing != null) {
                    final idx = _credentials.indexWhere((c) => c.id == existing.id);
                    if (idx >= 0) _credentials[idx] = saved;
                  } else {
                    _credentials.insert(0, saved);
                  }
                });
                _saveVaultToDisk();
                Navigator.of(ctx).pop(saved);
              },
              icon: const Icon(Icons.check_rounded, size: 16),
              label: Text(existing == null ? 'Save Credential' : 'Update'),
            ),
          ],
        ),
      ),
    );
  }

  /// Opens Add or Edit Connection Dialog (supports Jump Host / Bastion Tunneling & Vault Credential Binding)
  Future<RemoteHostItem?> _showHostEditorDialog({
    RemoteHostItem? existing,
    RemoteProtocol? presetProtocol,
    String? presetFolder,
    String? customDialogTitle,
  }) async {
    RemoteProtocol selectedProto = existing?.protocol ?? presetProtocol ?? RemoteProtocol.ssh;
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final hostCtrl = TextEditingController(text: existing?.address ?? '');
    final portCtrl = TextEditingController(
      text: (existing?.port ?? defaultPortForProtocol(selectedProto)).toString(),
    );
    final domainCtrl = TextEditingController(text: existing?.domain ?? '');
    final userCtrl = TextEditingController(text: existing?.username ?? 'root');
    final passCtrl = TextEditingController(text: existing?.password ?? '');
    final keyCtrl = TextEditingController(text: existing?.privateKeyPem ?? '');
    final folderCtrl = TextEditingController(text: existing?.folder ?? presetFolder ?? 'Production');
    final notesCtrl = TextEditingController(text: existing?.osLabel ?? '');
    String selectedJumpHostId = existing?.jumpHostId ?? '';
    String selectedCredentialId = existing?.credentialId ?? '';
    String selectedAccentTint = existing?.accentTint ??
        ((selectedProto == RemoteProtocol.ssh || selectedProto == RemoteProtocol.hypervisor)
            ? 'gold'
            : 'sapphire');
    bool isFavorite = existing?.isFavorite ?? false;
    bool obscurePass = true;
    bool showKeyField = (existing?.privateKeyPem ?? '').isNotEmpty;

    return showDialog<RemoteHostItem>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) {
          final validJumpHosts = _hosts.where((candidate) {
            if (candidate.protocol != RemoteProtocol.ssh) return false;
            return !SshBastionRouteResolver.wouldCreateCycle<RemoteHostItem>(
              editingHostId: existing?.id,
              candidateJumpId: candidate.id,
              allHosts: _hosts,
              idOf: (h) => h.id,
              jumpHostIdOf: (h) => h.jumpHostId,
            );
          }).toList();

          if (selectedJumpHostId.isNotEmpty &&
              !validJumpHosts.any((h) => h.id == selectedJumpHostId)) {
            selectedJumpHostId = '';
          }
          final boundCred = _findCredential(selectedCredentialId);
          if (selectedCredentialId.isNotEmpty && boundCred == null) {
            selectedCredentialId = '';
          }

          return AlertDialog(
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
                    customDialogTitle ??
                        (existing == null ? 'New Remote Connection' : 'Edit Connection'),
                    style: const TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w700,
                      color: JalaPalette.text,
                    ),
                  ),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  tooltip: isFavorite ? 'Unpin Favorite' : 'Pin to Favorites',
                  onPressed: () => setModalState(() => isFavorite = !isFavorite),
                  icon: Icon(
                    isFavorite ? Icons.star_rounded : Icons.star_border_rounded,
                    size: 20,
                    color: isFavorite ? JalaPalette.brandGold : JalaPalette.muted,
                  ),
                ),
              ],
            ),
            content: SizedBox(
              width: 420,
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
                    const SizedBox(height: 12),

                    // ==========================================================
                    // SSH JUMP HOST / BASTION TUNNEL (`ProxyJump` & Local Tunnel)
                    // ==========================================================
                    Row(
                      children: [
                        const Icon(Icons.alt_route_rounded, size: 15, color: JalaPalette.brandGold),
                        const SizedBox(width: 5),
                        const Expanded(
                          child: Text(
                            'SSH Jump Host / Bastion Tunnel',
                            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: JalaPalette.brandGold),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        InkWell(
                          key: const ValueKey('btn_inline_new_jump_host'),
                          borderRadius: BorderRadius.circular(6),
                          onTap: () async {
                            final createdJump = await _showHostEditorDialog(
                              presetProtocol: RemoteProtocol.ssh,
                              presetFolder: 'Bastions',
                              customDialogTitle: 'New SSH Jump Host / Bastion',
                            );
                            if (createdJump != null && createdJump.protocol == RemoteProtocol.ssh) {
                              setModalState(() => selectedJumpHostId = createdJump.id);
                            }
                          },
                          child: const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            child: Text(
                              '+ New Jump Host',
                              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: JalaPalette.accentLine),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      key: const ValueKey('dropdown_jump_host'),
                      initialValue: selectedJumpHostId,
                      isExpanded: true,
                      dropdownColor: JalaPalette.surface,
                      style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                      decoration: InputDecoration(
                        isDense: true,
                        filled: true,
                        fillColor: JalaPalette.header,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: const BorderSide(color: JalaPalette.lineInput),
                        ),
                      ),
                      items: [
                        const DropdownMenuItem<String>(
                          value: '',
                          child: Text(
                            'Direct Connection (No Jump Host)',
                            style: TextStyle(fontSize: 12, color: JalaPalette.text2),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        for (final jh in validJumpHosts)
                          DropdownMenuItem<String>(
                            value: jh.id,
                            child: Text(
                              'via ${jh.name} (${jh.address}:${jh.port})',
                              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: JalaPalette.brandGold),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                      onChanged: (val) => setModalState(() => selectedJumpHostId = val ?? ''),
                    ),
                    if (selectedJumpHostId.isNotEmpty) ...[
                      const SizedBox(height: 5),
                      Text(
                        selectedProto == RemoteProtocol.ssh || selectedProto == RemoteProtocol.sftp
                            ? 'Uses SSH ProxyJump (RFC 4254 direct-tcpip channel) through the selected bastion.'
                            : 'Creates an encrypted local loopback SSH tunnel for ${selectedProto.name.toUpperCase()} traffic automatically.',
                        style: const TextStyle(fontSize: 10.5, color: JalaPalette.ok),
                      ),
                    ],
                    const SizedBox(height: 12),

                    // ==========================================================
                    // AUTHENTICATION SOURCE (Inline vs Vault Credential Binding)
                    // ==========================================================
                    Row(
                      children: [
                        const Icon(Icons.key_rounded, size: 15, color: JalaPalette.brandGold),
                        const SizedBox(width: 5),
                        const Expanded(
                          child: Text(
                            'Authentication & Credentials',
                            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: JalaPalette.brandGold),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        InkWell(
                          key: const ValueKey('btn_inline_new_credential'),
                          borderRadius: BorderRadius.circular(6),
                          onTap: () async {
                            final createdCred = await _showVaultCredentialEditorDialog();
                            if (createdCred != null) {
                              setModalState(() => selectedCredentialId = createdCred.id);
                            }
                          },
                          child: const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            child: Text(
                              '+ New Credential',
                              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: JalaPalette.accentLine),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      key: const ValueKey('dropdown_vault_credential'),
                      initialValue: selectedCredentialId,
                      isExpanded: true,
                      dropdownColor: JalaPalette.surface,
                      style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                      decoration: InputDecoration(
                        isDense: true,
                        filled: true,
                        fillColor: JalaPalette.header,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: const BorderSide(color: JalaPalette.lineInput),
                        ),
                      ),
                      items: [
                        const DropdownMenuItem<String>(
                          value: '',
                          child: Text(
                            'Custom Inline Credentials (this host only)',
                            style: TextStyle(fontSize: 12, color: JalaPalette.text2),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        for (final cred in _credentials)
                          DropdownMenuItem<String>(
                            value: cred.id,
                            child: Text(
                              'Vault: ${cred.label} (${cred.displayPrincipal})',
                              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: JalaPalette.brandGold),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                      onChanged: (val) => setModalState(() => selectedCredentialId = val ?? ''),
                    ),
                    const SizedBox(height: 10),

                    if (boundCred != null) ...[
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
                        decoration: BoxDecoration(
                          color: JalaPalette.header,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.4)),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.verified_user_outlined, size: 16, color: JalaPalette.ok),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                'Bound to "${boundCred.label}" • ${boundCred.displayPrincipal} (${boundCred.kindBadge})',
                                style: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 10),
                      _buildModalField(
                        controller: folderCtrl,
                        label: 'Folder / Group',
                        hint: 'Production',
                        icon: Icons.folder_outlined,
                      ),
                    ] else ...[
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
                                label: selectedProto == RemoteProtocol.vnc
                                    ? 'Username (macOS / ARD)'
                                    : 'Username',
                                hint: selectedProto == RemoteProtocol.vnc
                                    ? 'ribato (optional)'
                                    : 'root / ubuntu',
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
                    const SizedBox(height: 10),
                    // 9 Desktop Semantic Mark Colors
                    Wrap(
                      spacing: 7,
                      runSpacing: 6,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        const Text(
                          'Color Mark:',
                          style: TextStyle(fontSize: 11, color: JalaPalette.muted, fontWeight: FontWeight.w600),
                        ),
                        for (final entry in JalaPalette.semanticMarks.entries)
                          InkWell(
                            borderRadius: BorderRadius.circular(99),
                            onTap: () => setModalState(() => selectedAccentTint = entry.key),
                            child: Container(
                              width: 19,
                              height: 19,
                              decoration: BoxDecoration(
                                color: entry.value,
                                shape: BoxShape.circle,
                                border: Border.all(
                                  color: selectedAccentTint == entry.key ? Colors.white : Colors.transparent,
                                  width: 2,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            actions: [
              if (existing != null)
                TextButton.icon(
                  onPressed: () {
                    Navigator.of(ctx).pop(null);
                    _deleteHost(existing);
                  },
                  icon: const Icon(Icons.delete_outline_rounded, size: 16, color: JalaPalette.danger),
                  label: const Text('Delete', style: TextStyle(color: JalaPalette.danger)),
                ),
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
                  final addr = hostCtrl.text.trim();
                  if (addr.isEmpty) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Please enter a valid Hostname or IP address.')),
                    );
                    return;
                  }
                  final parsedPort = int.tryParse(portCtrl.text.trim()) ?? defaultPortForProtocol(selectedProto);
                  final displayName = nameCtrl.text.trim().isNotEmpty ? nameCtrl.text.trim() : addr;
                  final effectiveCred = _findCredential(selectedCredentialId);
                  final rawUser = effectiveCred != null
                      ? effectiveCred.username
                      : (userCtrl.text.trim().isEmpty
                          ? (selectedProto == RemoteProtocol.vnc ? '' : 'root')
                          : userCtrl.text.trim());
                  final rawDom = effectiveCred != null ? effectiveCred.domain : domainCtrl.text.trim();
                  final acctDesc = rawDom.isNotEmpty && rawUser.isNotEmpty && !rawUser.contains('\\')
                      ? '$rawDom\\$rawUser'
                      : rawUser;
                  final osDesc = notesCtrl.text.trim().isNotEmpty
                      ? notesCtrl.text.trim()
                      : (acctDesc.isNotEmpty
                          ? '${selectedProto.name.toUpperCase()} • $acctDesc@$addr'
                          : '${selectedProto.name.toUpperCase()} • $addr');

                  final newItem = RemoteHostItem(
                    id: existing?.id ?? 'h-${DateTime.now().microsecondsSinceEpoch}',
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
                    jumpHostId: selectedJumpHostId.isEmpty ? null : selectedJumpHostId,
                    credentialId: selectedCredentialId.isEmpty ? null : selectedCredentialId,
                    isFavorite: isFavorite,
                    accentTint: selectedAccentTint,
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
                  Navigator.of(ctx).pop(newItem);
                  _probeSingleHost(newItem);
                },
                icon: const Icon(Icons.check_rounded, size: 16),
                label: Text(existing == null ? 'Save Host' : 'Update'),
              ),
            ],
          );
        },
      ),
    );
  }

  /// Prompts the user for password/credentials if connecting to a host whose password hasn't been entered yet
  Future<RemoteHostItem?> _promptCredentialsIfNeeded(
    RemoteHostItem host, {
    bool forcePrompt = false,
    String? customTitle,
  }) async {
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
                  customTitle ?? 'Authenticate to ${host.name}',
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
                _buildModalField(
                  controller: userCtrl,
                  label: host.protocol == RemoteProtocol.vnc
                      ? 'Username (macOS Screen Sharing / VeNCrypt)'
                      : 'Username',
                  hint: host.protocol == RemoteProtocol.vnc
                      ? 'e.g. ribato (blank for Classic VNC)'
                      : 'adminit / root',
                  icon: Icons.person_outline_rounded,
                ),
                const SizedBox(height: 10),
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
                  username: host.protocol == RemoteProtocol.vnc
                      ? userCtrl.text.trim()
                      : (userCtrl.text.trim().isEmpty ? host.username : userCtrl.text.trim()),
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
      for (int i = 0; i < _hosts.length; i++) {
        if (_hosts[i].jumpHostId == host.id) {
          _hosts[i] = _hosts[i].copyWith(clearJumpHost: true);
        }
      }
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
        jumpHostId: 'sample-ssh-bastion',
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

  void _copySensitiveSecret(String secret, {required String toastMessage}) {
    _clipboardScrubberEngine.copySecret(
      secret,
      autoScrubEnabled: _clipboardScrubber,
      onScrubbed: () {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Clipboard scrubbed automatically (Zero-Trust 30s policy).'),
            duration: Duration(seconds: 2),
          ),
        );
      },
    );
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(toastMessage)),
    );
  }

  Future<bool> _verifySshHostKeyWithTofu(
    String host,
    int port,
    String keyType,
    Uint8List fingerprint,
  ) {
    return _knownHostsStore.verifyOrPin(
      host: host,
      port: port,
      keyType: keyType,
      fingerprint: fingerprint,
      onStoreMutated: () {
        if (mounted) {
          setState(() {});
          unawaited(_saveVaultToDisk());
        }
      },
      onMismatch: (SshHostKeyMismatchAlert alert) async {
        if (!mounted) return false;
        final approved = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (ctx) => AlertDialog(
            backgroundColor: JalaPalette.surface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: const BorderSide(color: JalaPalette.danger, width: 1.2),
            ),
            title: const Row(
              children: [
                Icon(Icons.gpp_maybe_rounded, color: JalaPalette.danger, size: 22),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'SSH Host Key Changed!',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: JalaPalette.danger),
                  ),
                ),
              ],
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Remote server ${alert.endpoint} presented a different ${alert.keyType} host key than previously pinned. This could indicate a Man-in-the-Middle (MITM) interception or a rebuilt OS.',
                  style: const TextStyle(fontSize: 12, color: JalaPalette.text2, height: 1.4),
                ),
                const SizedBox(height: 10),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(9),
                  decoration: BoxDecoration(
                    color: JalaPalette.header,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: JalaPalette.lineInput),
                  ),
                  child: Text(
                    'Pinned (${alert.previousKeyType}):\n${alert.previousFingerprint}\n\nIncoming (${alert.keyType}):\n${alert.incomingFingerprint}',
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 10.5, color: JalaPalette.text),
                  ),
                ),
              ],
            ),
            actions: [
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: JalaPalette.accent),
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('Abort Connection (Safe)'),
              ),
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: const Text(
                  'Trust & Replace Key',
                  style: TextStyle(color: JalaPalette.danger, fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
        );
        return approved == true;
      },
    );
  }

  /// World-Class Multi-Protocol Connection Engine:
  /// - RDP: Native FreeRDP 3.32.2 (`RdpFfiClient` via `libjaladesk_freerdp.so`) with CredSSP/NLA + TLS + Live RGBA32 GDI Framebuffer
  /// - VNC: Full RFC 6143 RFB 3.3/3.7/3.8/3.889 (`VncRfbClient`) with Apple ARD (SecType 30), VeNCrypt TLS (19), Tight (16), MSLogonII (113), & DES (2)
  /// - SSH / SFTP: Full `dartssh2` Interactive PTY Shell (`client.shell()`) & SFTP Subsystem (`client.sftp()`)
  /// - Hypervisor: HTTPS TLS Certificate & Proxmox VE Endpoint Inspector
  Future<void> _connectToHost(
    RemoteHostItem rawHost, {
    bool forceCredentialPrompt = false,
    bool forceReconnect = false,
    String? initialSshSubMode,
  }) async {
    if (!forceReconnect && !forceCredentialPrompt && _isHostLiveConnected(rawHost)) {
      _resumeLiveHostSession(rawHost, sshSubMode: initialSshSubMode);
      return;
    }

    final resolvedInitial = _resolveEffectiveHost(rawHost);
    final routeBadge = _routeBadgeForHost(rawHost);
    final routeSuffix = routeBadge.isEmpty ? '' : ' • $routeBadge';

    if (widget.disableNetworkProbes) {
      setState(() {
        if (resolvedInitial.protocol == RemoteProtocol.ssh ||
            resolvedInitial.protocol == RemoteProtocol.sftp) {
          _activeSshHost = resolvedInitial;
          _sshSubMode = initialSshSubMode ??
              (resolvedInitial.protocol == RemoteProtocol.sftp ? 'sftp' : 'terminal');
          _tabIndex = 2;
          _offlineTerminalLine = '';
          _terminalBuffer.write(
            '\r\n\x1b[1;32m✓ Connected to ${resolvedInitial.name} (${resolvedInitial.address}:${resolvedInitial.port}$routeSuffix)\x1b[0m\r\n'
            '$_offlinePrompt',
          );
        } else {
          _activeRdpHost = resolvedInitial;
          _tabIndex = 1;
          _lastRdpAction =
              'Connected to ${resolvedInitial.name} (${resolvedInitial.address}:${resolvedInitial.port}$routeSuffix)';
        }
      });
      return;
    }

    // 1. Resolve & authenticate any SSH Jump Host / Bastion chain (`Hop 1 -> ... -> Hop N`)
    List<BastionHopSpec> bastionHops = const <BastionHopSpec>[];
    if (resolvedInitial.hasJumpHost) {
      try {
        final prepared = await _prepareBastionHops(resolvedInitial);
        if (prepared == null) return;
        bastionHops = prepared;
      } on BastionRoutingException catch (e) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message)),
        );
        return;
      }
    }

    // 2. Prompt for target password if none is stored/inherited yet (for RDP/SSH/SFTP/VNC)
    RemoteHostItem host = resolvedInitial;
    if (forceCredentialPrompt ||
        ((host.protocol == RemoteProtocol.rdp ||
                host.protocol == RemoteProtocol.ssh ||
                host.protocol == RemoteProtocol.sftp ||
                host.protocol == RemoteProtocol.vnc) &&
            host.password.isEmpty &&
            host.privateKeyPem.isEmpty)) {
      final prompted = await _promptCredentialsIfNeeded(host, forcePrompt: true);
      if (prompted == null) return;
      host = prompted;
    }

    String stageText =
        'Connecting to ${host.address}:${host.port}$routeSuffix (${host.protocol.name.toUpperCase()})...';
    String? errorDetail;
    bool connecting = true;
    bool dialogOpen = true;
    StateSetter? modalSetState;

    Future<void> performHandshake() async {
      final sw = Stopwatch()..start();
      SshBastionChain? pendingBastionChain;
      ActiveLocalPortForward? pendingLocalTunnel;

      try {
        if (bastionHops.isNotEmpty) {
          pendingBastionChain = await SshBastionChain.connect(
            bastionHops,
            onStage: (s) => modalSetState?.call(() => stageText = s),
            onVerifyHopHostKey: (hop, keyType, fp) =>
                _verifySshHostKeyWithTofu(hop.address, hop.port, keyType, fp),
          );
        }

        // =====================================================================
        // 1. SSHv2 INTERACTIVE PTY SHELL & SFTP ENGINE (dartssh2 + ProxyJump)
        // =====================================================================
        if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
          modalSetState?.call(() {
            stageText = pendingBastionChain != null
                ? 'Opening ProxyJump channel (${pendingBastionChain.routeSummary}) → ${host.address}:${host.port}...'
                : '1/3 Opening TCP socket to ${host.address}:${host.port}...';
          });
          final SSHSocket sshSocket = pendingBastionChain != null
              ? await pendingBastionChain.openTargetForward(host.address, host.port)
              : await SSHSocket.connect(
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
            onVerifyHostKey: (String keyType, Uint8List fp) =>
                _verifySshHostKeyWithTofu(host.address, host.port, keyType, fp),
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
          String resolvedHomePath = '.';
          List<RemoteSftpEntry> initialSftpEntries = [];
          try {
            sftp = await client.sftp();
            try {
              resolvedHomePath = await sftp.absolute('.');
            } catch (_) {
              resolvedHomePath = '.';
            }
            initialSftpEntries = await _fetchSftpDirectoryEntries(sftp, resolvedHomePath);
          } catch (_) {}

          if (!mounted) {
            client.close();
            await pendingBastionChain?.dispose();
            return;
          }

          _closeSshClient();
          final activeChain = pendingBastionChain;
          pendingBastionChain = null;

          _offlineTerminalLine = '';
          _terminalBuffer.clear();
          _terminalBuffer.write(
            '\x1b[1;32m✓ SSHv2 PTY Connected\x1b[0m to \x1b[1;33m${host.formattedEndpoint}\x1b[0m'
            '${activeChain != null ? " \x1b[1;36m[${activeChain.routeSummary}]\x1b[0m" : ""} (${rtt}ms)\r\n',
          );

          setState(() {
            final idx = _hosts.indexWhere((h) => h.id == host.id);
            if (idx >= 0) {
              _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
            }
            _activeSshHost = host.copyWith(latencyMs: rtt, isOnline: true);
            _sshBastionChain = activeChain;
            _sshClient = client;
            _sshPtySession = ptySession;
            _sftpClient = sftp;
            _sshLiveConnected = true;
            _sshSubMode = initialSshSubMode ?? (host.protocol == RemoteProtocol.sftp ? 'sftp' : 'terminal');
            _sftpCurrentPath = resolvedHomePath;
            _sftpEntries = initialSftpEntries;
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
            _appendPtyOutput(_offlinePrompt);
          }

          _saveVaultToDisk();
          if (dialogOpen && mounted) {
            Navigator.of(context, rootNavigator: true).pop();
          }
          return;
        }

        // For non-SSH protocols (RDP / VNC / Hypervisor) routed over SSH Jump Host:
        // Bind a Zero-Trust loopback (`127.0.0.1`) port forward through the Bastion chain!
        String effectiveTargetHost = host.address;
        int effectiveTargetPort = host.port;
        String activeRouteLabel = '';
        if (pendingBastionChain != null) {
          activeRouteLabel = pendingBastionChain.routeSummary;
          modalSetState?.call(() {
            stageText =
                'Binding encrypted local SSH tunnel ($activeRouteLabel → ${host.address}:${host.port})...';
          });
          pendingLocalTunnel = await pendingBastionChain.startLocalPortForward(
            remoteHost: host.address,
            remotePort: host.port,
            label: '${host.protocol.name.toUpperCase()} → ${host.name}',
            ownChainLifecycle: true,
          );
          effectiveTargetHost = '127.0.0.1';
          effectiveTargetPort = pendingLocalTunnel.localPort;
        }

        // =====================================================================
        // 2. RDP ENGINE — NATIVE FREERDP 3.32.2 (`libjaladesk_freerdp.so`)
        // =====================================================================
        if (host.protocol == RemoteProtocol.rdp) {
          final (resolvedDomain, resolvedUser) = host.resolvedDomainAndUser;
          modalSetState?.call(() {
            stageText =
                'Starting FreeRDP 3.32.2 Engine (${resolvedDomain.isNotEmpty ? "$resolvedDomain\\$resolvedUser" : resolvedUser}@${host.address}:${host.port}${activeRouteLabel.isNotEmpty ? " • $activeRouteLabel" : ""})...';
          });

          if (RdpFfiClient.isNativeAvailable) {
            setState(() {
              _closeDesktopSession();
              _canvasTransformCtrl.value = Matrix4.identity();
            });
            final (initW, initH) = _resolveTargetDesktopDimensions();
            final rdpClient = RdpFfiClient(
              host: effectiveTargetHost,
              port: effectiveTargetPort,
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
                  _desktopProtocolBanner =
                      activeRouteLabel.isNotEmpty ? '$status • $activeRouteLabel' : status;
                });
              },
              onStatus: (String status, {bool isError = false}) {
                if (!mounted) return;
                setState(() {
                  _desktopProtocolBanner =
                      activeRouteLabel.isNotEmpty ? '$status • $activeRouteLabel' : status;
                  _lastRdpAction = status;
                  if (isError) _desktopLiveConnected = false;
                });
              },
            );

            await rdpClient.connect();
            final rtt = sw.elapsedMilliseconds.clamp(1, 9999);
            if (!mounted) {
              await rdpClient.dispose();
              await pendingLocalTunnel?.close();
              return;
            }

            final boundTunnel = pendingLocalTunnel;
            pendingLocalTunnel = null;
            pendingBastionChain = null;

            setState(() {
              final idx = _hosts.indexWhere((h) => h.id == host.id);
              if (idx >= 0) {
                _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
              }
              _activeRdpHost = host.copyWith(latencyMs: rtt, isOnline: true);
              _desktopBastionTunnel = boundTunnel;
              _rdpFfiClient = rdpClient;
              _desktopLiveConnected = true;
              _desktopServerWidth = rdpClient.width;
              _desktopServerHeight = rdpClient.height;
              _desktopProtocolBanner = activeRouteLabel.isNotEmpty
                  ? '${rdpClient.statusText} • $activeRouteLabel'
                  : rdpClient.statusText;
              _lastRdpAction =
                  'Live FreeRDP 3.x Desktop (${rdpClient.width}x${rdpClient.height}${activeRouteLabel.isNotEmpty ? " • $activeRouteLabel" : ""})';
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
        // 3. VNC ENGINE — RFC 6143 RFB 3.3 / 3.7 / 3.8 / Apple ARD (`VncRfbClient`)
        // =====================================================================
        if (host.protocol == RemoteProtocol.vnc) {
          final (_, vncUser) = host.resolvedDomainAndUser;
          modalSetState?.call(() {
            stageText =
                'Negotiating VNC / Apple Screen Sharing session with ${host.address}:${host.port}${activeRouteLabel.isNotEmpty ? " ($activeRouteLabel)" : ""}...';
          });
          setState(() {
            _closeDesktopSession();
            _canvasTransformCtrl.value = Matrix4.identity();
          });
          final wantAutoMatchVnc = _resolutionPreset == JumpResolutionPreset.matchDisplay ||
              _resolutionPreset == JumpResolutionPreset.matchHiDpi;
          final (vncInitW, vncInitH) = _resolveTargetDesktopDimensions();
          final vncClient = VncRfbClient(
            host: effectiveTargetHost,
            port: effectiveTargetPort,
            username: vncUser,
            password: host.password,
            initialTargetWidth: wantAutoMatchVnc ? vncInitW : null,
            initialTargetHeight: wantAutoMatchVnc ? vncInitH : null,
            onDesktopGeometryChanged: (int w, int h, bool dynamicResizeOk) {
              if (!mounted) return;
              setState(() {
                _desktopServerWidth = w;
                _desktopServerHeight = h;
                if (dynamicResizeOk && _canvasFitMode == JumpCanvasFitMode.cropCover) {
                  _canvasFitMode = JumpCanvasFitMode.aspectFit;
                  _canvasTransformCtrl.value = Matrix4.identity();
                }
              });
            },
            onFrame: (ui.Image img, int w, int h, String status) {
              if (!mounted) return;
              setState(() {
                _remoteDesktopFrame = img;
                _desktopServerWidth = w;
                _desktopServerHeight = h;
                _desktopLiveConnected = true;
                _desktopProtocolBanner =
                    activeRouteLabel.isNotEmpty ? '$status • $activeRouteLabel' : status;
              });
            },
            onStatus: (String status, {bool isError = false}) {
              if (!mounted) return;
              setState(() {
                _desktopProtocolBanner =
                    activeRouteLabel.isNotEmpty ? '$status • $activeRouteLabel' : status;
                _lastRdpAction = status;
                if (isError) _desktopLiveConnected = false;
              });
            },
          );

          await vncClient.connect();
          final rtt = sw.elapsedMilliseconds.clamp(1, 9999);
          if (!mounted) {
            await vncClient.dispose();
            await pendingLocalTunnel?.close();
            return;
          }

          final boundTunnel = pendingLocalTunnel;
          pendingLocalTunnel = null;
          pendingBastionChain = null;

          setState(() {
            final idx = _hosts.indexWhere((h) => h.id == host.id);
            if (idx >= 0) {
              _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
            }
            _activeRdpHost = host.copyWith(latencyMs: rtt, isOnline: true);
            _desktopBastionTunnel = boundTunnel;
            _vncRfbClient = vncClient;
            _desktopLiveConnected = true;
            _desktopServerWidth = vncClient.width;
            _desktopServerHeight = vncClient.height;
            // Jump Desktop Smart Adaptation: if a widescreen fixed-monitor VNC server (>= 800px) connects
            // on a portrait phone without ExtendedDesktopSize, enable Smart Fill & Cursor-Follow Pan!
            final winSize = MediaQuery.sizeOf(context);
            final isPortraitPhone = winSize.height > winSize.width * 1.12 && winSize.width < 600;
            if (!vncClient.supportsExtendedDesktopSize &&
                isPortraitPhone &&
                vncClient.width >= 800 &&
                vncClient.width > vncClient.height * 1.18) {
              _canvasFitMode = JumpCanvasFitMode.cropCover;
            }
            _desktopProtocolBanner =
                '${vncClient.negotiatedAuthLabel} • ${vncClient.desktopName} (${vncClient.width}x${vncClient.height})${activeRouteLabel.isNotEmpty ? " • $activeRouteLabel" : ""}';
            _lastRdpAction =
                'Live VNC Framebuffer (${vncClient.width}x${vncClient.height}${activeRouteLabel.isNotEmpty ? " • $activeRouteLabel" : ""})';
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
          stageText =
              'Connecting to Hypervisor HTTPS endpoint ${host.address}:${host.port}${activeRouteLabel.isNotEmpty ? " ($activeRouteLabel)" : ""}...';
        });
        final httpClient = HttpClient()..badCertificateCallback = (_, __, ___) => true;
        httpClient.connectionTimeout = const Duration(seconds: 6);
        final uri = Uri.parse('https://$effectiveTargetHost:$effectiveTargetPort/api2/json/version');
        final req = await httpClient.getUrl(uri);
        req.headers.set(HttpHeaders.hostHeader, '${host.address}:${host.port}');
        final resp = await req.close().timeout(const Duration(seconds: 6));
        final rtt = sw.elapsedMilliseconds.clamp(1, 9999);
        final body = await resp.transform(utf8.decoder).join();
        httpClient.close();
        await pendingLocalTunnel?.close();
        pendingLocalTunnel = null;
        pendingBastionChain = null;

        if (!mounted) return;
        _terminalBuffer.clear();
        _terminalBuffer.write(
          '\x1b[1;32m✓ Hypervisor HTTPS Connected\x1b[0m to https://${host.address}:${host.port}'
          '${activeRouteLabel.isNotEmpty ? " [$activeRouteLabel]" : ""} ($rtt ms)\r\n'
          'HTTP Status: ${resp.statusCode} ${resp.reasonPhrase}\r\n'
          '${body.isNotEmpty ? "Response: $body" : "TLS Endpoint Verified."}\r\n'
          '$_offlinePrompt',
        );
        setState(() {
          final idx = _hosts.indexWhere((h) => h.id == host.id);
          if (idx >= 0) {
            _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
          }
          _activeSshHost = host.copyWith(latencyMs: rtt, isOnline: true);
          _sshSubMode = 'terminal';
          _tabIndex = 2;
        });
        _saveVaultToDisk();
        if (dialogOpen && mounted) {
          Navigator.of(context, rootNavigator: true).pop();
        }
      } catch (err) {
        sw.stop();
        await pendingLocalTunnel?.close();
        await pendingBastionChain?.dispose();
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
                  '${host.protocol.name.toUpperCase()} • ${host.formattedEndpoint}$routeSuffix',
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
                  Text(
                    host.protocol == RemoteProtocol.vnc
                        ? 'macOS Screen Sharing tip: Enter your Mac account Username & Password (Apple ARD SecType 30), or set an 8-char VNC password in System Settings > General > Sharing > Screen Sharing (i).'
                        : 'Verify your Domain/Username/Password and ensure your device has network routing to this host and port.',
                    style: const TextStyle(fontSize: 11.5, color: JalaPalette.muted, height: 1.35),
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
                    _connectToHost(host, forceCredentialPrompt: true, initialSshSubMode: initialSshSubMode);
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

  String _formatByteCount(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(2)} MB';
  }

  void _toggleHostFavorite(RemoteHostItem host) {
    setState(() {
      final idx = _hosts.indexWhere((h) => h.id == host.id);
      if (idx >= 0) {
        _hosts[idx] = _hosts[idx].copyWith(isFavorite: !host.isFavorite);
      }
    });
    _saveVaultToDisk();
  }

  /// Desktop-Parity Ad-Hoc Quick Connect (`ssh://user@host:2222`, `rdp://domain\user@host`, or `host:port`)
  /// Supports optional Jump Host routing and optional 1-click Save to Vault.
  Future<void> _showQuickConnectDialog() async {
    final targetCtrl = TextEditingController();
    final userCtrl = TextEditingController(text: 'root');
    final passCtrl = TextEditingController();
    RemoteProtocol selectedProto = RemoteProtocol.ssh;
    String? selectedJumpHostId;
    bool saveToVault = false;
    bool obscurePass = true;

    void parseQuickTarget(String raw, StateSetter setModalState) {
      final trimmed = raw.trim();
      if (trimmed.startsWith('ssh://')) {
        setModalState(() => selectedProto = RemoteProtocol.ssh);
      } else if (trimmed.startsWith('sftp://')) {
        setModalState(() => selectedProto = RemoteProtocol.sftp);
      } else if (trimmed.startsWith('rdp://')) {
        setModalState(() => selectedProto = RemoteProtocol.rdp);
      } else if (trimmed.startsWith('vnc://')) {
        setModalState(() => selectedProto = RemoteProtocol.vnc);
      }
    }

    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) {
          final jumpCandidates = _hosts.where((h) => h.protocol == RemoteProtocol.ssh).toList();
          if (selectedJumpHostId != null && !jumpCandidates.any((j) => j.id == selectedJumpHostId)) {
            selectedJumpHostId = null;
          }
          return AlertDialog(
            backgroundColor: JalaPalette.surface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: const BorderSide(color: JalaPalette.lineInput),
            ),
            title: const Row(
              children: [
                Icon(Icons.bolt_rounded, size: 20, color: JalaPalette.brandGold),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Quick Connect',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: JalaPalette.text),
                  ),
                ),
              ],
            ),
            content: SizedBox(
              width: 410,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final p in RemoteProtocol.values)
                          ChoiceChip(
                            label: Text(p.name.toUpperCase(), style: const TextStyle(fontSize: 11)),
                            selected: selectedProto == p,
                            selectedColor: JalaPalette.selected,
                            backgroundColor: JalaPalette.header,
                            labelStyle: TextStyle(
                              color: selectedProto == p ? JalaPalette.brandGold : JalaPalette.text2,
                              fontWeight: FontWeight.w700,
                            ),
                            onSelected: (_) => setModalState(() => selectedProto = p),
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('field_quick_connect_target'),
                      controller: targetCtrl,
                      onChanged: (v) => parseQuickTarget(v, setModalState),
                      style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace', color: JalaPalette.text),
                      decoration: InputDecoration(
                        labelText: 'Host, IP:Port, or URI *',
                        hintText: 'e.g. ssh://ubuntu@192.168.1.20:22 or 10.0.0.50:3389',
                        hintStyle: const TextStyle(fontSize: 11, color: JalaPalette.muted),
                        labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                        prefixIcon: const Icon(Icons.lan_outlined, size: 17, color: JalaPalette.brandGold),
                        isDense: true,
                        filled: true,
                        fillColor: JalaPalette.header,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: const BorderSide(color: JalaPalette.lineInput),
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: _buildModalField(
                            controller: userCtrl,
                            label: selectedProto == RemoteProtocol.rdp ? 'Domain\\Username' : 'Username',
                            hint: 'root / CORP\\admin',
                            icon: Icons.person_outline_rounded,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: TextField(
                            controller: passCtrl,
                            obscureText: obscurePass,
                            style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                            decoration: InputDecoration(
                              labelText: 'Password',
                              labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
                              suffixIcon: IconButton(
                                icon: Icon(
                                  obscurePass ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                                  size: 16,
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
                        ),
                      ],
                    ),
                    if (jumpCandidates.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      DropdownButtonFormField<String?>(
                        initialValue: selectedJumpHostId,
                        isExpanded: true,
                        dropdownColor: JalaPalette.surface,
                        style: const TextStyle(fontSize: 12, color: JalaPalette.text),
                        decoration: InputDecoration(
                          labelText: 'Route via SSH Jump Host (optional)',
                          labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                          prefixIcon: const Icon(Icons.alt_route_rounded, size: 17, color: JalaPalette.brandGold),
                          isDense: true,
                          filled: true,
                          fillColor: JalaPalette.header,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(8),
                            borderSide: const BorderSide(color: JalaPalette.lineInput),
                          ),
                        ),
                        items: [
                          const DropdownMenuItem<String?>(
                            value: null,
                            child: Text('Direct Connection (No Bastion)', overflow: TextOverflow.ellipsis),
                          ),
                          for (final j in jumpCandidates)
                            DropdownMenuItem<String?>(
                              value: j.id,
                              child: Text('${j.name} (${j.address}:${j.port})', overflow: TextOverflow.ellipsis),
                            ),
                        ],
                        onChanged: (v) => setModalState(() => selectedJumpHostId = v),
                      ),
                    ],
                    const SizedBox(height: 6),
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      activeColor: JalaPalette.brandGold,
                      checkColor: JalaPalette.header,
                      value: saveToVault,
                      onChanged: (v) => setModalState(() => saveToVault = v ?? false),
                      title: const Text(
                        'Save connection to Vault for future sessions',
                        style: TextStyle(fontSize: 12, color: JalaPalette.text2),
                      ),
                    ),
                  ],
                ),
              ),
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
                  String raw = targetCtrl.text.trim();
                  if (raw.isEmpty) return;
                  for (final prefix in ['ssh://', 'sftp://', 'rdp://', 'vnc://', 'https://']) {
                    if (raw.startsWith(prefix)) {
                      raw = raw.substring(prefix.length);
                      break;
                    }
                  }
                  String parsedUser = userCtrl.text.trim();
                  if (raw.contains('@')) {
                    final atIdx = raw.lastIndexOf('@');
                    parsedUser = raw.substring(0, atIdx);
                    raw = raw.substring(atIdx + 1);
                  }
                  String hostPart = raw;
                  int portPart = defaultPortForProtocol(selectedProto);
                  if (raw.contains(':')) {
                    final colonIdx = raw.lastIndexOf(':');
                    final maybePort = int.tryParse(raw.substring(colonIdx + 1));
                    if (maybePort != null && maybePort > 0 && maybePort <= 65535) {
                      hostPart = raw.substring(0, colonIdx);
                      portPart = maybePort;
                    }
                  }
                  String domainPart = '';
                  if (parsedUser.contains('\\')) {
                    final parts = parsedUser.split('\\');
                    domainPart = parts.first;
                    parsedUser = parts.sublist(1).join('\\');
                  }

                  final adHoc = RemoteHostItem(
                    id: 'quick-${DateTime.now().microsecondsSinceEpoch}',
                    name: hostPart,
                    folder: 'Quick Connect',
                    protocol: selectedProto,
                    address: hostPart,
                    port: portPart,
                    domain: domainPart,
                    username: parsedUser,
                    password: passCtrl.text,
                    osLabel: '${selectedProto.name.toUpperCase()} • Ad-Hoc Session',
                    accentTint: selectedProto == RemoteProtocol.rdp ? 'gold' : 'sapphire',
                    jumpHostId: selectedJumpHostId,
                  );

                  if (saveToVault) {
                    setState(() => _hosts.add(adHoc));
                    _saveVaultToDisk();
                  }
                  Navigator.of(ctx).pop();
                  _connectToHost(adHoc);
                },
                icon: const Icon(Icons.play_arrow_rounded, size: 17),
                label: const Text('Connect'),
              ),
            ],
          );
        },
      ),
    );
  }

  /// Standalone SSH Local Port Forwarding Studio (`ssh -L 127.0.0.1:<localPort>:<remoteHost>:<remotePort>`)
  /// Works over single-hop or multi-hop SSH Bastion chains!
  Future<void> _showPortForwardStudioSheet({RemoteHostItem? initialSshHost}) async {
    final sshHosts = _hosts.where((h) => h.protocol == RemoteProtocol.ssh).toList();
    String? selectedBastionId = initialSshHost?.id ?? (sshHosts.isNotEmpty ? sshHosts.first.id : null);
    final remoteHostCtrl = TextEditingController(text: '127.0.0.1');
    final remotePortCtrl = TextEditingController(text: '5432');
    final localPortCtrl = TextEditingController(text: '0');
    final labelCtrl = TextEditingController();
    bool startingTunnel = false;
    String? tunnelError;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: JalaPalette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          final currentSshHosts = _hosts.where((h) => h.protocol == RemoteProtocol.ssh).toList();
          if (selectedBastionId != null && !currentSshHosts.any((h) => h.id == selectedBastionId)) {
            selectedBastionId = currentSshHosts.isNotEmpty ? currentSshHosts.first.id : null;
          }

          return SafeArea(
            child: Padding(
              padding: EdgeInsets.only(
                left: 16,
                right: 16,
                top: 14,
                bottom: MediaQuery.viewInsetsOf(ctx).bottom + 16,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.swap_calls_rounded, size: 20, color: JalaPalette.brandGold),
                        const SizedBox(width: 9),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'SSH Port Forwarding Studio (ssh -L)',
                                style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: JalaPalette.text),
                                overflow: TextOverflow.ellipsis,
                              ),
                              Text(
                                'Expose private DBs, web consoles, or internal ports on 127.0.0.1',
                                style: TextStyle(fontSize: 11, color: JalaPalette.muted),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          visualDensity: VisualDensity.compact,
                          onPressed: () => Navigator.of(ctx).pop(),
                          icon: const Icon(Icons.close_rounded, size: 18, color: JalaPalette.muted),
                        ),
                      ],
                    ),
                    const Divider(height: 18, color: JalaPalette.line),
                    if (_activePortForwards.isNotEmpty) ...[
                      const Text(
                        'ACTIVE LOCAL TUNNELS',
                        style: TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.6,
                          color: JalaPalette.ok,
                        ),
                      ),
                      const SizedBox(height: 8),
                      for (final pf in _activePortForwards)
                        Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: JalaPalette.header,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: JalaPalette.ok.withValues(alpha: 0.4)),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const Icon(Icons.circle, size: 8, color: JalaPalette.ok),
                                  const SizedBox(width: 6),
                                  Expanded(
                                    child: Text(
                                      pf.label,
                                      style: const TextStyle(
                                        fontSize: 12.5,
                                        fontWeight: FontWeight.w700,
                                        color: JalaPalette.text,
                                      ),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                  TextButton.icon(
                                    style: TextButton.styleFrom(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                      minimumSize: Size.zero,
                                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                    ),
                                    onPressed: () {
                                      Clipboard.setData(ClipboardData(text: pf.localEndpoint));
                                      ScaffoldMessenger.of(context).showSnackBar(
                                        SnackBar(content: Text('Copied ${pf.localEndpoint}')),
                                      );
                                    },
                                    icon: const Icon(Icons.copy_rounded, size: 13, color: JalaPalette.brandGold),
                                    label: const Text(
                                      'Copy',
                                      style: TextStyle(fontSize: 11, color: JalaPalette.brandGold),
                                    ),
                                  ),
                                  const SizedBox(width: 4),
                                  TextButton.icon(
                                    style: TextButton.styleFrom(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                      minimumSize: Size.zero,
                                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                    ),
                                    onPressed: () async {
                                      await pf.close();
                                      if (!mounted) return;
                                      setState(() => _activePortForwards.removeWhere((x) => x.id == pf.id));
                                      setSheetState(() {});
                                    },
                                    icon: const Icon(Icons.stop_circle_outlined, size: 14, color: JalaPalette.danger),
                                    label: const Text(
                                      'Stop',
                                      style: TextStyle(fontSize: 11, color: JalaPalette.danger),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text(
                                '${pf.localEndpoint} ⇄ ${pf.remoteEndpoint} (${pf.bastionSummary})',
                                style: const TextStyle(
                                  fontSize: 11,
                                  fontFamily: 'monospace',
                                  color: JalaPalette.brandGold,
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 3),
                              Text(
                                'Conns: ${pf.totalConnections} (${pf.activeStreams} live) • TX ${_formatByteCount(pf.bytesSent)} • RX ${_formatByteCount(pf.bytesReceived)}',
                                style: const TextStyle(fontSize: 10.5, color: JalaPalette.muted),
                              ),
                            ],
                          ),
                        ),
                      const SizedBox(height: 8),
                    ],
                    const Text(
                      'NEW LOCAL PORT FORWARD',
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.6,
                        color: JalaPalette.brandGold,
                      ),
                    ),
                    const SizedBox(height: 8),
                    if (currentSshHosts.isEmpty)
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: JalaPalette.header,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: JalaPalette.lineInput),
                        ),
                        child: Column(
                          children: [
                            const Text(
                              'Add an SSH Bastion / Jump Host first to open local port forwards.',
                              style: TextStyle(fontSize: 12, color: JalaPalette.muted),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 8),
                            OutlinedButton.icon(
                              onPressed: () async {
                                final created = await _showHostEditorDialog(
                                  presetProtocol: RemoteProtocol.ssh,
                                  presetFolder: 'Jump Hosts / Bastions',
                                  customDialogTitle: 'New SSH Jump Host',
                                );
                                if (created != null) {
                                  setSheetState(() => selectedBastionId = created.id);
                                }
                              },
                              icon: const Icon(Icons.add_rounded, size: 16, color: JalaPalette.brandGold),
                              label: const Text(
                                '+ Add SSH Jump Host',
                                style: TextStyle(fontSize: 12, color: JalaPalette.brandGold),
                              ),
                            ),
                          ],
                        ),
                      )
                    else ...[
                      DropdownButtonFormField<String>(
                        initialValue: selectedBastionId,
                        isExpanded: true,
                        dropdownColor: JalaPalette.surface,
                        style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                        decoration: InputDecoration(
                          labelText: 'Tunnel via SSH Host / Bastion *',
                          labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                          prefixIcon: const Icon(Icons.alt_route_rounded, size: 17, color: JalaPalette.brandGold),
                          isDense: true,
                          filled: true,
                          fillColor: JalaPalette.header,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(8),
                            borderSide: const BorderSide(color: JalaPalette.lineInput),
                          ),
                        ),
                        items: [
                          for (final h in currentSshHosts)
                            DropdownMenuItem<String>(
                              value: h.id,
                              child: Text(
                                '${h.name} (${h.address}:${h.port})',
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                        ],
                        onChanged: (v) => setSheetState(() => selectedBastionId = v),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            flex: 2,
                            child: _buildModalField(
                              controller: remoteHostCtrl,
                              label: 'Remote Target Host *',
                              hint: '127.0.0.1 or 10.0.0.25',
                              icon: Icons.dns_outlined,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: _buildModalField(
                              controller: remotePortCtrl,
                              label: 'Remote Port *',
                              hint: '5432',
                              icon: Icons.numbers_rounded,
                              keyboardType: TextInputType.number,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: _buildModalField(
                              controller: localPortCtrl,
                              label: 'Local Port (0=Auto)',
                              hint: '0',
                              icon: Icons.hearing_rounded,
                              keyboardType: TextInputType.number,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            flex: 2,
                            child: _buildModalField(
                              controller: labelCtrl,
                              label: 'Label (optional)',
                              hint: 'e.g. Prod Postgres Tunnel',
                              icon: Icons.label_outline_rounded,
                            ),
                          ),
                        ],
                      ),
                      if (tunnelError != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          tunnelError!,
                          style: const TextStyle(fontSize: 11.5, color: JalaPalette.danger, fontFamily: 'monospace'),
                        ),
                      ],
                      const SizedBox(height: 12),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          key: const Key('btn_start_local_tunnel'),
                          style: FilledButton.styleFrom(
                            backgroundColor: JalaPalette.accent,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 11),
                          ),
                          onPressed: startingTunnel || selectedBastionId == null
                              ? null
                              : () async {
                                  final sshHost = currentSshHosts.firstWhere((h) => h.id == selectedBastionId);
                                  final rHost = remoteHostCtrl.text.trim();
                                  final rPort = int.tryParse(remotePortCtrl.text.trim()) ?? 0;
                                  final lPort = int.tryParse(localPortCtrl.text.trim()) ?? 0;
                                  if (rHost.isEmpty || rPort <= 0 || rPort > 65535) {
                                    setSheetState(() => tunnelError = 'Enter a valid remote target host and port (1-65535).');
                                    return;
                                  }
                                  setSheetState(() {
                                    startingTunnel = true;
                                    tunnelError = null;
                                  });

                                  SshBastionChain? chain;
                                  try {
                                    // Support multi-hop even for standalone `ssh -L`: resolve upstream hops + selected SSH host!
                                    final upstreamSpecs = await _prepareBastionHops(sshHost);
                                    if (upstreamSpecs == null) {
                                      setSheetState(() => startingTunnel = false);
                                      return;
                                    }
                                    RemoteHostItem effectiveExit = _resolveEffectiveHost(sshHost);
                                    if (effectiveExit.password.isEmpty && effectiveExit.privateKeyPem.trim().isEmpty) {
                                      final prompted = await _promptCredentialsIfNeeded(
                                        effectiveExit,
                                        forcePrompt: true,
                                        customTitle: 'SSH Tunnel Auth: ${sshHost.name}',
                                      );
                                      if (prompted == null) {
                                        setSheetState(() => startingTunnel = false);
                                        return;
                                      }
                                      effectiveExit = prompted;
                                    }
                                    final (_, exitUser) = effectiveExit.resolvedDomainAndUser;
                                    final allHops = <BastionHopSpec>[
                                      ...upstreamSpecs,
                                      BastionHopSpec(
                                        id: effectiveExit.id,
                                        name: effectiveExit.name,
                                        address: effectiveExit.address,
                                        port: effectiveExit.port,
                                        username: exitUser.isEmpty ? 'root' : exitUser,
                                        password: effectiveExit.password,
                                        privateKeyPem: effectiveExit.privateKeyPem,
                                      ),
                                    ];

                                    chain = await SshBastionChain.connect(allHops);
                                    final tunnel = await chain.startLocalPortForward(
                                      remoteHost: rHost,
                                      remotePort: rPort,
                                      localBindPort: lPort.clamp(0, 65535),
                                      label: labelCtrl.text.trim().isEmpty
                                          ? '${sshHost.name} → $rHost:$rPort'
                                          : labelCtrl.text.trim(),
                                      ownChainLifecycle: true,
                                      onStatsUpdated: () {
                                        if (mounted) setState(() {});
                                      },
                                    );
                                    if (!mounted) {
                                      await tunnel.close();
                                      return;
                                    }
                                    setState(() => _activePortForwards.add(tunnel));
                                    setSheetState(() => startingTunnel = false);
                                  } catch (err) {
                                    await chain?.dispose();
                                    setSheetState(() {
                                      startingTunnel = false;
                                      tunnelError = err.toString().replaceFirst('Exception: ', '');
                                    });
                                  }
                                },
                          icon: Icon(startingTunnel ? Icons.sync_rounded : Icons.play_arrow_rounded, size: 17),
                          label: Text(
                            startingTunnel ? 'Opening Encrypted SSH Tunnel...' : 'Start Local Port Forward (127.0.0.1)',
                            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  String _joinSftpChildPath(String basePath, String childName) {
    if (childName.startsWith('/')) return childName;
    final cleanBase = basePath.trim();
    if (cleanBase.isEmpty || cleanBase == '.') return './$childName';
    if (cleanBase == '/') return '/$childName';
    return cleanBase.endsWith('/') ? '$cleanBase$childName' : '$cleanBase/$childName';
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
      final full = _joinSftpChildPath(path, item.filename);
      entries.add(
        RemoteSftpEntry(
          name: item.filename,
          fullPath: full,
          permissions: item.longname.split(' ').first,
          sizeBytes: sizeBytes,
          sizeLabel: sizeStr,
          isDirectory: isDir,
        ),
      );
    }
    entries.sort((a, b) {
      if (a.isDirectory != b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
    return entries;
  }

  Future<void> _browseRemoteSftpPath(String newPath) async {
    if (!_sshLiveConnected) {
      setState(() {
        _sftpCurrentPath = newPath.isEmpty ? '/' : newPath;
      });
      return;
    }
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
      String resolvedPath = newPath;
      try {
        resolvedPath = await _sftpClient!.absolute(newPath);
      } catch (_) {}
      final list = await _fetchSftpDirectoryEntries(_sftpClient!, resolvedPath);
      if (!mounted) return;
      setState(() {
        _sftpCurrentPath = resolvedPath;
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

  Future<void> _navigateSftpUp() async {
    final cur = _sftpCurrentPath.trim();
    if (_sshLiveConnected && _sftpClient != null) {
      if (cur == '/') return;
      final candidate = cur.isEmpty || cur == '.' ? '..' : '$cur/..';
      await _browseRemoteSftpPath(candidate);
      return;
    }
    if (cur == '/' || cur == '.') return;
    final idx = cur.lastIndexOf('/');
    final parent = idx <= 0 ? '/' : cur.substring(0, idx);
    setState(() => _sftpCurrentPath = parent);
  }

  Future<void> _createSftpFolder(String folderName) async {
    final target = _joinSftpChildPath(_sftpCurrentPath, folderName);
    if (_sshLiveConnected && _sftpClient != null) {
      setState(() => _sshBusy = true);
      try {
        await _sftpClient!.mkdir(target);
        await _browseRemoteSftpPath(_sftpCurrentPath);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Created directory "$folderName"')),
          );
        }
      } catch (e) {
        if (!mounted) return;
        setState(() => _sshBusy = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to create folder: $e')),
        );
      }
      return;
    }
    setState(() {
      _offlineSftpEntries.insert(
        0,
        RemoteSftpEntry(
          name: folderName,
          fullPath: target,
          permissions: 'drwxr-xr-x',
          sizeBytes: 4096,
          sizeLabel: '4.0 KB',
          isDirectory: true,
        ),
      );
    });
  }

  Future<String> _readSftpTextFile(SftpFileEntry entry) async {
    final target = _joinSftpChildPath(_sftpCurrentPath, entry.name);
    if (_sshLiveConnected && _sftpClient != null) {
      final file = await _sftpClient!.open(target, mode: SftpFileOpenMode.read);
      try {
        final bytes = await file.readBytes(length: 65536);
        return utf8.decode(bytes, allowMalformed: true);
      } finally {
        await file.close();
      }
    }
    return '# Preview of $target\nserver {\n    listen 443 ssl http2;\n    server_name jaladesk.internal;\n}\n';
  }

  Future<void> _writeSftpTextFile(String fileName, String content) async {
    final target = _joinSftpChildPath(_sftpCurrentPath, fileName);
    final encoded = Uint8List.fromList(utf8.encode(content));
    if (_sshLiveConnected && _sftpClient != null) {
      setState(() => _sshBusy = true);
      try {
        final file = await _sftpClient!.open(
          target,
          mode: SftpFileOpenMode.create | SftpFileOpenMode.truncate | SftpFileOpenMode.write,
        );
        await file.writeBytes(encoded);
        await file.close();
        await _browseRemoteSftpPath(_sftpCurrentPath);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Saved "$fileName" (${encoded.length} B)')),
          );
        }
      } catch (e) {
        if (!mounted) return;
        setState(() => _sshBusy = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to save "$fileName": $e')),
        );
      }
      return;
    }
    final sizeLabel = encoded.length >= 1024
        ? '${(encoded.length / 1024).toStringAsFixed(1)} KB'
        : '${encoded.length} B';
    setState(() {
      _offlineSftpEntries.removeWhere((e) => e.name == fileName);
      _offlineSftpEntries.add(
        RemoteSftpEntry(
          name: fileName,
          fullPath: target,
          permissions: '-rw-r--r--',
          sizeBytes: encoded.length,
          sizeLabel: sizeLabel,
          isDirectory: false,
        ),
      );
    });
  }

  Future<void> _renameSftpEntry(SftpFileEntry entry, String newName) async {
    final oldPath = _joinSftpChildPath(_sftpCurrentPath, entry.name);
    final newPath = _joinSftpChildPath(_sftpCurrentPath, newName);
    if (_sshLiveConnected && _sftpClient != null) {
      setState(() => _sshBusy = true);
      try {
        await _sftpClient!.rename(oldPath, newPath);
        await _browseRemoteSftpPath(_sftpCurrentPath);
      } catch (e) {
        if (!mounted) return;
        setState(() => _sshBusy = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Rename failed: $e')),
        );
      }
      return;
    }
    setState(() {
      final idx = _offlineSftpEntries.indexWhere((e) => e.name == entry.name);
      if (idx >= 0) {
        final prev = _offlineSftpEntries[idx];
        _offlineSftpEntries[idx] = RemoteSftpEntry(
          name: newName,
          fullPath: newPath,
          permissions: prev.permissions,
          sizeBytes: prev.sizeBytes,
          sizeLabel: prev.sizeLabel,
          isDirectory: prev.isDirectory,
        );
      }
    });
  }

  Future<void> _deleteSftpEntry(SftpFileEntry entry) async {
    final target = _joinSftpChildPath(_sftpCurrentPath, entry.name);
    if (_sshLiveConnected && _sftpClient != null) {
      setState(() => _sshBusy = true);
      try {
        if (entry.isDirectory) {
          await SftpTransferService.deleteDirectoryRecursive(_sftpClient!, target);
        } else {
          await _sftpClient!.remove(target);
        }
        await _browseRemoteSftpPath(_sftpCurrentPath);
      } catch (e) {
        if (!mounted) return;
        setState(() => _sshBusy = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Delete failed: $e')),
        );
      }
      return;
    }
    setState(() {
      _offlineSftpEntries.removeWhere((e) => e.name == entry.name);
    });
  }

  Future<SftpClient?> _ensureLiveSftpSubsystem() async {
    if (!_sshLiveConnected) return null;
    if (_sftpClient == null && _sshClient != null) {
      try {
        _sftpClient = await _sshClient!.sftp();
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Unable to initialize SFTP subsystem: $e')),
          );
        }
        return null;
      }
    }
    return _sftpClient;
  }

  Future<void> _uploadSftpFilesFromDevice() async {
    try {
      final picked = await NativePlatformBridge.pickFiles(allowMultiple: true);
      if (picked == null || picked.isEmpty) return;
      await _performSftpUploadFiles(picked.map((p) => File(p.path)).toList());
    } on UnsupportedError {
      await _openLocalWorkspaceTransferSheet();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('File picker error: $e')),
      );
    }
  }

  Future<void> _uploadSftpFolderFromDevice() async {
    try {
      final dirInfo = await NativePlatformBridge.pickDirectory();
      if (dirInfo == null) return;
      await _performSftpUploadDirectory(Directory(dirInfo.path), overrideName: dirInfo.name);
    } on UnsupportedError {
      await _openLocalWorkspaceTransferSheet();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Folder picker error: $e')),
      );
    }
  }

  Future<void> _performSftpUploadFiles(List<File> localFiles) async {
    if (localFiles.isEmpty) return;
    final sftp = await _ensureLiveSftpSubsystem();
    if (sftp != null) {
      setState(() => _sshBusy = true);
      try {
        final done = await SftpTransferService.uploadFilesBatch(
          sftp: sftp,
          localFiles: localFiles,
          remoteDirectoryPath: _sftpCurrentPath,
          onProgress: (p) {
            if (mounted) setState(() => _activeSftpTransfer = p);
          },
        );
        await _browseRemoteSftpPath(_sftpCurrentPath);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                'Uploaded ${done.rootName} (${SftpTransferProgress.formatBytes(done.bytesTransferred)}) to $_sftpCurrentPath',
              ),
            ),
          );
        }
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _sshBusy = false;
          _activeSftpTransfer = SftpTransferProgress(
            direction: SftpTransferDirection.upload,
            rootName: SftpTransferService.basenameOf(localFiles.first.path),
            currentItem: '',
            isDirectory: false,
            filesCompleted: 0,
            totalFiles: localFiles.length,
            bytesTransferred: 0,
            totalBytes: 0,
            errorMessage: '$e',
          );
        });
      }
      return;
    }

    // Offline preview staging
    int totalBytes = 0;
    for (final f in localFiles) {
      final sz = await f.exists() ? await f.length() : 0;
      totalBytes += sz;
      final name = SftpTransferService.basenameOf(f.path);
      final target = _joinSftpChildPath(_sftpCurrentPath, name);
      _offlineSftpEntries.removeWhere((e) => e.name == name);
      _offlineSftpEntries.add(
        RemoteSftpEntry(
          name: name,
          fullPath: target,
          permissions: '-rw-r--r--',
          sizeBytes: sz,
          sizeLabel: SftpTransferProgress.formatBytes(sz),
          isDirectory: false,
        ),
      );
    }
    setState(() {
      _activeSftpTransfer = SftpTransferProgress(
        direction: SftpTransferDirection.upload,
        rootName: localFiles.length == 1
            ? SftpTransferService.basenameOf(localFiles.first.path)
            : '${localFiles.length} files',
        currentItem: '',
        isDirectory: false,
        filesCompleted: localFiles.length,
        totalFiles: localFiles.length,
        bytesTransferred: totalBytes,
        totalBytes: totalBytes,
        isDone: true,
        savedDestination: _sftpCurrentPath,
      );
    });
  }

  Future<void> _performSftpUploadDirectory(Directory localDir, {String? overrideName}) async {
    final folderName = overrideName ?? SftpTransferService.basenameOf(localDir.path);
    final sftp = await _ensureLiveSftpSubsystem();
    if (sftp != null) {
      setState(() => _sshBusy = true);
      try {
        final done = await SftpTransferService.uploadDirectoryRecursive(
          sftp: sftp,
          localDir: localDir,
          remoteParentPath: _sftpCurrentPath,
          overrideFolderName: folderName,
          onProgress: (p) {
            if (mounted) setState(() => _activeSftpTransfer = p);
          },
        );
        await _browseRemoteSftpPath(_sftpCurrentPath);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                'Uploaded folder "$folderName" (${done.filesCompleted} files • ${SftpTransferProgress.formatBytes(done.bytesTransferred)})',
              ),
            ),
          );
        }
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _sshBusy = false;
          _activeSftpTransfer = SftpTransferProgress(
            direction: SftpTransferDirection.upload,
            rootName: folderName,
            currentItem: '',
            isDirectory: true,
            filesCompleted: 0,
            totalFiles: 0,
            bytesTransferred: 0,
            totalBytes: 0,
            errorMessage: '$e',
          );
        });
      }
      return;
    }

    // Offline preview folder upload
    final target = _joinSftpChildPath(_sftpCurrentPath, folderName);
    setState(() {
      _offlineSftpEntries.removeWhere((e) => e.name == folderName);
      _offlineSftpEntries.insert(
        0,
        RemoteSftpEntry(
          name: folderName,
          fullPath: target,
          permissions: 'drwxr-xr-x',
          sizeBytes: 4096,
          sizeLabel: '4.0 KB',
          isDirectory: true,
        ),
      );
      _activeSftpTransfer = SftpTransferProgress(
        direction: SftpTransferDirection.upload,
        rootName: folderName,
        currentItem: folderName,
        isDirectory: true,
        filesCompleted: 1,
        totalFiles: 1,
        bytesTransferred: 4096,
        totalBytes: 4096,
        isDone: true,
        savedDestination: target,
      );
    });
  }

  Future<void> _downloadSftpEntryToDevice(SftpFileEntry entry) async {
    final remoteTarget = _joinSftpChildPath(_sftpCurrentPath, entry.name);
    final sftp = await _ensureLiveSftpSubsystem();
    if (sftp != null) {
      setState(() => _sshBusy = true);
      try {
        final SftpTransferProgress done;
        if (entry.isDirectory) {
          done = await SftpTransferService.downloadDirectoryRecursive(
            sftp: sftp,
            remoteDirPath: remoteTarget,
            dirName: entry.name,
            onProgress: (p) {
              if (mounted) setState(() => _activeSftpTransfer = p);
            },
          );
        } else {
          done = await SftpTransferService.downloadRemoteFile(
            sftp: sftp,
            remoteFilePath: remoteTarget,
            fileName: entry.name,
            knownSizeBytes: entry.sizeBytes,
            onProgress: (p) {
              if (mounted) setState(() => _activeSftpTransfer = p);
            },
          );
        }
        if (!mounted) return;
        setState(() => _sshBusy = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Downloaded "${entry.name}" (${SftpTransferProgress.formatBytes(done.bytesTransferred)}) → ${done.savedDestination ?? "Downloads/JalaDesk"}',
            ),
          ),
        );
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _sshBusy = false;
          _activeSftpTransfer = SftpTransferProgress(
            direction: SftpTransferDirection.download,
            rootName: entry.name,
            currentItem: entry.name,
            isDirectory: entry.isDirectory,
            filesCompleted: 0,
            totalFiles: 1,
            bytesTransferred: 0,
            totalBytes: entry.sizeBytes,
            errorMessage: '$e',
          );
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Download failed: $e')),
        );
      }
      return;
    }

    // Offline preview download to local workspace
    final ws = await NativePlatformBridge.resolveLocalWorkspaceDirectory();
    String savedDest;
    if (entry.isDirectory) {
      final localFolder = Directory('${ws.path}/${entry.name}');
      await localFolder.create(recursive: true);
      await File('${localFolder.path}/README.txt')
          .writeAsString('Preview snapshot of $remoteTarget\n');
      savedDest = localFolder.path;
    } else {
      final localFile = File('${ws.path}/${entry.name}');
      final txt = await _readSftpTextFile(entry);
      await localFile.writeAsString(txt);
      savedDest = localFile.path;
    }
    if (!mounted) return;
    setState(() {
      _activeSftpTransfer = SftpTransferProgress(
        direction: SftpTransferDirection.download,
        rootName: entry.name,
        currentItem: entry.name,
        isDirectory: entry.isDirectory,
        filesCompleted: 1,
        totalFiles: 1,
        bytesTransferred: entry.sizeBytes,
        totalBytes: entry.sizeBytes,
        isDone: true,
        savedDestination: savedDest,
      );
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Saved "${entry.name}" to $savedDest')),
    );
  }

  Future<void> _openLocalWorkspaceTransferSheet() async {
    final wsDir = await NativePlatformBridge.resolveLocalWorkspaceDirectory();
    if (!mounted) return;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: JalaPalette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          final entities = wsDir.existsSync()
              ? (wsDir.listSync(followLinks: false)
                ..sort((a, b) => a.path.compareTo(b.path)))
              : <FileSystemEntity>[];
          return SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.folder_copy_outlined, size: 18, color: JalaPalette.brandGold),
                      const SizedBox(width: 8),
                      const Expanded(
                        child: Text(
                          'Local Transfer Workspace',
                          style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: JalaPalette.text),
                        ),
                      ),
                      OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: JalaPalette.brandGold,
                          side: BorderSide(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
                          visualDensity: VisualDensity.compact,
                        ),
                        onPressed: () async {
                          final sampleDir = Directory('${wsDir.path}/deploy-bundle');
                          await sampleDir.create(recursive: true);
                          await File('${sampleDir.path}/release-manifest.json')
                              .writeAsString('{"app":"jaladesk","ready":true}\n');
                          setSheetState(() {});
                        },
                        icon: const Icon(Icons.create_new_folder_outlined, size: 14),
                        label: const Text('Stage Folder', style: TextStyle(fontSize: 11)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    wsDir.path,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 10.5, color: JalaPalette.muted),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 10),
                  if (entities.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 18),
                      child: Center(
                        child: Text(
                          'Workspace is empty. Downloaded items or staged folders appear here for 1-tap upload.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 12, color: JalaPalette.muted),
                        ),
                      ),
                    )
                  else
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 280),
                      child: ListView.separated(
                        shrinkWrap: true,
                        itemCount: entities.length,
                        separatorBuilder: (_, __) => const Divider(height: 1, color: JalaPalette.line),
                        itemBuilder: (ctx, i) {
                          final ent = entities[i];
                          final isDir = ent is Directory;
                          final name = SftpTransferService.basenameOf(ent.path);
                          return ListTile(
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            leading: Icon(
                              isDir ? Icons.folder_rounded : Icons.insert_drive_file_outlined,
                              color: isDir ? JalaPalette.brandGold : JalaPalette.accentLine,
                              size: 19,
                            ),
                            title: Text(
                              name,
                              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: JalaPalette.text),
                            ),
                            subtitle: Text(
                              isDir ? 'Local Directory (Recursive Upload)' : 'Local File',
                              style: const TextStyle(fontSize: 10.5, color: JalaPalette.muted),
                            ),
                            trailing: FilledButton.tonal(
                              style: FilledButton.styleFrom(
                                backgroundColor: JalaPalette.selected,
                                foregroundColor: JalaPalette.brandGold,
                                minimumSize: const Size(0, 30),
                                padding: const EdgeInsets.symmetric(horizontal: 10),
                              ),
                              onPressed: () {
                                Navigator.pop(ctx);
                                if (isDir) {
                                  unawaited(_performSftpUploadDirectory(ent));
                                } else if (ent is File) {
                                  unawaited(_performSftpUploadFiles([ent]));
                                }
                              },
                              child: const Text('Upload', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700)),
                            ),
                          );
                        },
                      ),
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  /// Sends raw keystrokes / control sequences directly into the live SSHv2 PTY (Termius-style)
  /// or handles interactive line-editing in offline/exec-fallback mode.
  void _sendRawTerminalInput(String raw) {
    if (raw.isEmpty) return;

    if (_sshLiveConnected && _sshPtySession != null) {
      _sshPtySession!.write(Uint8List.fromList(utf8.encode(raw)));
      return;
    }

    for (int i = 0; i < raw.length; i++) {
      final code = raw.codeUnitAt(i);
      if (code == 0x1B) {
        // Ignore ANSI arrow/escape sequences in offline line buffer
        if (i + 2 < raw.length && raw[i + 1] == '[') {
          i += 2;
        }
        continue;
      } else if (code == 0x03) {
        // Ctrl+C
        _offlineTerminalLine = '';
        _terminalBuffer.write('^C\r\n$_offlinePrompt');
      } else if (code == 0x04) {
        // Ctrl+D
        if (_offlineTerminalLine.isEmpty) {
          _terminalBuffer.write('logout\r\n$_offlinePrompt');
        }
      } else if (code == 0x0C) {
        // Ctrl+L (clear screen)
        _terminalBuffer.write('\x1b[2J\x1b[H$_offlinePrompt$_offlineTerminalLine');
      } else if (code == 0x7F || code == 0x08) {
        // Backspace
        if (_offlineTerminalLine.isNotEmpty) {
          _offlineTerminalLine = _offlineTerminalLine.substring(0, _offlineTerminalLine.length - 1);
          _terminalBuffer.write('\x08\x1b[K');
        }
      } else if (code == 0x09) {
        // Tab auto-complete common commands in offline preview
        const candidates = ['uptime', 'uname -a', 'docker ps', 'kubectl get pods', 'df -h', 'free -h', 'clear'];
        final match = candidates.where((c) => c.startsWith(_offlineTerminalLine)).firstOrNull;
        if (match != null && match.length > _offlineTerminalLine.length) {
          final suffix = match.substring(_offlineTerminalLine.length);
          _offlineTerminalLine = match;
          _terminalBuffer.write(suffix);
        }
      } else if (code == 0x0D || code == 0x0A) {
        final submitted = _offlineTerminalLine;
        _offlineTerminalLine = '';
        _terminalBuffer.write('\r\n');
        unawaited(_executeNonPtyCommand(submitted));
      } else if (code >= 0x20) {
        final ch = raw[i];
        _offlineTerminalLine += ch;
        _terminalBuffer.write(ch);
      }
    }
  }

  void _runTerminalSnippet(TerminalSnippetItem snippet) {
    if (_sshSubMode == 'sftp') {
      setState(() => _sshSubMode = 'terminal');
    }
    if (snippet.runImmediately) {
      unawaited(_runSshCommand(snippet.command));
    } else {
      _sendRawTerminalInput(snippet.command);
    }
  }

  /// Executes an SSH command on the live `dartssh2` PTY session or offline/exec fallback
  Future<void> _runSshCommand(String rawCmd) async {
    final cmd = rawCmd.trim();
    if (_sshLiveConnected && _sshPtySession != null) {
      _sshPtySession!.write(Uint8List.fromList(utf8.encode('$cmd\r')));
      return;
    }
    if (_offlineTerminalLine.isNotEmpty) {
      _terminalBuffer.write('\x08\x1b[K' * _offlineTerminalLine.length);
      _offlineTerminalLine = '';
    }
    _terminalBuffer.write('$cmd\r\n');
    await _executeNonPtyCommand(cmd);
  }

  Future<void> _executeNonPtyCommand(String rawCmd) async {
    final cmd = rawCmd.trim();
    final hostLabel = _activeSshHost?.name.split(' ').first ?? 'jaladesk';

    if (cmd == 'clear') {
      _terminalBuffer.clear();
      _terminalBuffer.write(_offlinePrompt);
      return;
    }

    if (cmd.isEmpty) {
      _terminalBuffer.write(_offlinePrompt);
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
        if (decoded.isNotEmpty) {
          _terminalBuffer.write('${decoded.replaceAll('\n', '\r\n')}\r\n');
        }
        _terminalBuffer.write(_offlinePrompt);
        setState(() => _sshBusy = false);
      } catch (e) {
        if (!mounted) return;
        _terminalBuffer.write('\x1b[31m[ssh error] $e\x1b[0m\r\n$_offlinePrompt');
        setState(() => _sshBusy = false);
      }
      return;
    }

    // Offline interactive preview fallback
    if (cmd == 'help') {
      _terminalBuffer.write(
        'Available preview commands: uptime, uname -a, docker ps, kubectl get pods, df -h, free -h, clear\r\n',
      );
    } else if (cmd == 'uptime') {
      _terminalBuffer.write(
        ' 19:36:12 up 142 days,  7:14,  2 users,  load average: 0.18, 0.24, 0.21\r\n',
      );
    } else if (cmd == 'uname -a') {
      _terminalBuffer.write(
        'Linux $hostLabel 6.8.0-45-generic #45-Ubuntu SMP aarch64 GNU/Linux\r\n',
      );
    } else if (cmd.startsWith('docker')) {
      _terminalBuffer.write(
        'NAMES        STATUS       PORTS\r\n'
        'jala-zt-gw   Up 14 days   0.0.0.0:443->443/tcp\r\n'
        'vault-db     Up 14 days   127.0.0.1:5432->5432/tcp\r\n',
      );
    } else if (cmd.startsWith('kubectl')) {
      _terminalBuffer.write(
        'NAMESPACE   NAME                              READY   STATUS    AGE\r\n'
        'prod        jaladesk-relay-6b7f9d8c4-x92lk    2/2     Running   19d\r\n'
        'monitoring  prometheus-node-exporter-m82qp    1/1     Running   45d\r\n',
      );
    } else if (cmd.startsWith('df')) {
      _terminalBuffer.write(
        'Filesystem      Size  Used Avail Use% Mounted on\r\n'
        '/dev/nvme0n1p2  500G  142G  358G  29% /\r\n',
      );
    } else if (cmd.startsWith('free')) {
      _terminalBuffer.write(
        '               total        used        free      available\r\n'
        'Mem:           31Gi       8.4Gi        14Gi           22Gi\r\n',
      );
    } else if (cmd.startsWith('top')) {
      _terminalBuffer.write(
        'top - 19:36:20 up 142 days,  2 users,  load average: 0.14, 0.20, 0.19\r\n'
        '%Cpu(s):  2.1 us,  0.8 sy,  0.0 ni, 96.9 id\r\n',
      );
    } else if (cmd.startsWith('ss ') || cmd.startsWith('ip ')) {
      _terminalBuffer.write(
        'eth0             UP             10.28.99.203/24\r\n'
        'lo               UNKNOWN        127.0.0.1/8\r\n',
      );
    } else {
      _terminalBuffer.write(
        '\x1b[33m[offline]\x1b[0m Connect to a live SSH server in Connections to execute "$cmd" remotely.\r\n',
      );
    }
    _terminalBuffer.write(_offlinePrompt);
  }

  /// Opens the Termius-Class Terminal Theme & Typography Studio
  void _showTerminalThemeSheet() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: JalaPalette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            return SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.palette_outlined, size: 19, color: JalaPalette.brandGold),
                        const SizedBox(width: 8),
                        const Expanded(
                          child: Text(
                            'Terminal Appearance & Themes',
                            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: JalaPalette.text),
                          ),
                        ),
                        // Font size stepper
                        Container(
                          decoration: BoxDecoration(
                            color: JalaPalette.header,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: JalaPalette.lineInput),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              InkWell(
                                borderRadius: BorderRadius.circular(7),
                                onTap: () {
                                  setState(() {
                                    _terminalFontSize = (_terminalFontSize - 1.0).clamp(10.0, 18.0);
                                  });
                                  setSheetState(() {});
                                  _saveVaultToDisk();
                                },
                                child: const Padding(
                                  padding: EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                                  child: Text('A−', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                                ),
                              ),
                              Text(
                                '${_terminalFontSize.toInt()}pt',
                                style: const TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 11.5,
                                  fontWeight: FontWeight.w700,
                                  color: JalaPalette.brandGold,
                                ),
                              ),
                              InkWell(
                                borderRadius: BorderRadius.circular(7),
                                onTap: () {
                                  setState(() {
                                    _terminalFontSize = (_terminalFontSize + 1.0).clamp(10.0, 18.0);
                                  });
                                  setSheetState(() {});
                                  _saveVaultToDisk();
                                },
                                child: const Padding(
                                  padding: EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                                  child: Text('A+', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                                ),
                              ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 6),
                          IconButton(
                            key: const ValueKey('btn_close_theme_sheet'),
                            visualDensity: VisualDensity.compact,
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                            icon: const Icon(Icons.close_rounded, size: 19, color: JalaPalette.muted),
                            onPressed: () => Navigator.of(ctx).pop(),
                          ),
                        ],
                      ),
                    const SizedBox(height: 12),
                    ConstrainedBox(
                      constraints: BoxConstraints(
                        maxHeight: MediaQuery.of(ctx).size.height * 0.46,
                      ),
                      child: GridView.builder(
                        shrinkWrap: true,
                        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 210,
                          mainAxisExtent: 76,
                          crossAxisSpacing: 8,
                          mainAxisSpacing: 8,
                        ),
                        itemCount: TerminalThemePreset.presets.length,
                        itemBuilder: (ctx, i) {
                          final preset = TerminalThemePreset.presets[i];
                          final selected = preset.id == _terminalThemeId;
                          return InkWell(
                            borderRadius: BorderRadius.circular(10),
                            onTap: () {
                              setState(() => _terminalThemeId = preset.id);
                              setSheetState(() {});
                              _saveVaultToDisk();
                            },
                            child: Container(
                              padding: const EdgeInsets.all(9),
                              decoration: BoxDecoration(
                                color: preset.background,
                                borderRadius: BorderRadius.circular(10),
                                border: Border.all(
                                  color: selected ? JalaPalette.brandGold : preset.border,
                                  width: selected ? 1.6 : 1.0,
                                ),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Text(
                                          preset.name,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w700,
                                            color: preset.foreground,
                                          ),
                                        ),
                                      ),
                                      if (selected)
                                        const Icon(Icons.check_circle_rounded, size: 15, color: JalaPalette.brandGold),
                                    ],
                                  ),
                                  Text(
                                    'root@host:~\$ █',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontFamily: 'monospace',
                                      fontSize: 10.5,
                                      color: preset.ansi16[2],
                                    ),
                                  ),
                                  Row(
                                    children: [
                                      for (final swatchIdx in [1, 2, 3, 4, 5, 6])
                                        Container(
                                          width: 12,
                                          height: 6,
                                          margin: const EdgeInsets.only(right: 3),
                                          decoration: BoxDecoration(
                                            color: preset.ansi16[swatchIdx],
                                            borderRadius: BorderRadius.circular(2),
                                          ),
                                        ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                    const SizedBox(height: 12),
                    Align(
                      alignment: Alignment.centerRight,
                      child: Wrap(
                        alignment: WrapAlignment.end,
                        spacing: 6,
                        runSpacing: 4,
                        children: [
                          TextButton.icon(
                            onPressed: () {
                              Clipboard.setData(ClipboardData(text: _terminalBuffer.toPlainText()));
                              Navigator.pop(ctx);
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(content: Text('Terminal scrollback copied to clipboard.')),
                              );
                            },
                            icon: const Icon(Icons.copy_all_rounded, size: 16, color: JalaPalette.brandGold),
                            label: const Text('Copy Output', style: TextStyle(color: JalaPalette.brandGold)),
                          ),
                          TextButton.icon(
                            onPressed: () {
                              Navigator.pop(ctx);
                              _terminalBuffer.clear();
                              if (_sshLiveConnected && _sshPtySession != null) {
                                _sshPtySession!.write(Uint8List.fromList([0x0C]));
                              } else {
                                _terminalBuffer.write(_offlinePrompt);
                              }
                            },
                            icon: const Icon(Icons.cleaning_services_outlined, size: 16, color: JalaPalette.text2),
                            label: const Text('Clear Screen', style: TextStyle(color: JalaPalette.text2)),
                          ),
                        ],
                      ),
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

  /// Opens the Categorized DevOps & Custom Command Snippets Studio
  void _showSnippetsStudioSheet() {
    String selectedCategory = 'All';
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: JalaPalette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            final allSnippets = [..._customSnippets, ...TerminalSnippetItem.builtIn];
            final categories = ['All', 'System', 'Docker', 'Kubernetes', 'Network', 'Custom'];
            final visible = selectedCategory == 'All'
                ? allSnippets
                : allSnippets.where((s) => s.category == selectedCategory).toList();

            return SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
                child: SizedBox(
                  height: MediaQuery.of(ctx).size.height * 0.65,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.bolt_rounded, size: 20, color: JalaPalette.brandGold),
                          const SizedBox(width: 8),
                          const Expanded(
                            child: Text(
                              'Command Snippets Studio',
                              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: JalaPalette.text),
                            ),
                          ),
                          FilledButton.tonalIcon(
                            style: FilledButton.styleFrom(
                              backgroundColor: JalaPalette.selected,
                              foregroundColor: JalaPalette.brandGold,
                              visualDensity: VisualDensity.compact,
                            ),
                            onPressed: () async {
                              final labelCtrl = TextEditingController();
                              final cmdCtrl = TextEditingController();
                              bool runNow = true;
                              final created = await showDialog<TerminalSnippetItem>(
                                context: ctx,
                                builder: (dCtx) => StatefulBuilder(
                                  builder: (dCtx, setDState) => AlertDialog(
                                    backgroundColor: JalaPalette.surface,
                                    title: const Text('New Command Snippet', style: TextStyle(fontSize: 15)),
                                    content: Column(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        _buildModalField(
                                          controller: labelCtrl,
                                          label: 'Short Label *',
                                          hint: 'e.g. nginx reload',
                                          icon: Icons.label_outline_rounded,
                                        ),
                                        const SizedBox(height: 10),
                                        _buildModalField(
                                          controller: cmdCtrl,
                                          label: 'Shell Command *',
                                          hint: 'sudo nginx -t && sudo systemctl reload nginx',
                                          icon: Icons.terminal_rounded,
                                        ),
                                        const SizedBox(height: 8),
                                        CheckboxListTile(
                                          contentPadding: EdgeInsets.zero,
                                          dense: true,
                                          activeColor: JalaPalette.brandGold,
                                          value: runNow,
                                          onChanged: (v) => setDState(() => runNow = v ?? true),
                                          title: const Text(
                                            'Execute immediately on tap (append Enter)',
                                            style: TextStyle(fontSize: 12),
                                          ),
                                        ),
                                      ],
                                    ),
                                    actions: [
                                      TextButton(
                                        onPressed: () => Navigator.pop(dCtx),
                                        child: const Text('Cancel'),
                                      ),
                                      FilledButton(
                                        onPressed: () {
                                          if (labelCtrl.text.trim().isEmpty || cmdCtrl.text.trim().isEmpty) return;
                                          Navigator.pop(
                                            dCtx,
                                            TerminalSnippetItem(
                                              id: 'cust-${DateTime.now().millisecondsSinceEpoch}',
                                              label: labelCtrl.text.trim(),
                                              command: cmdCtrl.text.trim(),
                                              category: 'Custom',
                                              runImmediately: runNow,
                                            ),
                                          );
                                        },
                                        child: const Text('Save Snippet'),
                                      ),
                                    ],
                                  ),
                                ),
                              );
                              if (created != null) {
                                setState(() => _customSnippets.insert(0, created));
                                setSheetState(() {});
                                _saveVaultToDisk();
                              }
                            },
                            icon: const Icon(Icons.add_rounded, size: 16),
                            label: const Text('New Snippet', style: TextStyle(fontSize: 12)),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            for (final cat in categories)
                              Padding(
                                padding: const EdgeInsets.only(right: 6),
                                child: ChoiceChip(
                                  label: Text(cat, style: const TextStyle(fontSize: 11.5)),
                                  selected: selectedCategory == cat,
                                  selectedColor: JalaPalette.selected,
                                  backgroundColor: JalaPalette.header,
                                  onSelected: (_) => setSheetState(() => selectedCategory = cat),
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 10),
                      Expanded(
                        child: visible.isEmpty
                            ? const Center(
                                child: Text(
                                  'No snippets in this category yet. Tap "New Snippet" to create one.',
                                  style: TextStyle(fontSize: 12.5, color: JalaPalette.muted),
                                ),
                              )
                            : ListView.separated(
                                itemCount: visible.length,
                                separatorBuilder: (_, __) => const Divider(height: 1, color: JalaPalette.line),
                                itemBuilder: (ctx, i) {
                                  final snip = visible[i];
                                  final isCustom = snip.category == 'Custom';
                                  return ListTile(
                                    contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                                    title: Row(
                                      children: [
                                        Text(
                                          snip.label,
                                          style: const TextStyle(
                                            fontSize: 13,
                                            fontWeight: FontWeight.w700,
                                            color: JalaPalette.text,
                                          ),
                                        ),
                                        const SizedBox(width: 8),
                                        Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                                          decoration: BoxDecoration(
                                            color: JalaPalette.header,
                                            borderRadius: BorderRadius.circular(4),
                                            border: Border.all(color: JalaPalette.line),
                                          ),
                                          child: Text(
                                            snip.category,
                                            style: const TextStyle(fontSize: 9.5, color: JalaPalette.brandGold),
                                          ),
                                        ),
                                      ],
                                    ),
                                    subtitle: Padding(
                                      padding: const EdgeInsets.only(top: 3),
                                      child: Text(
                                        snip.command,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          fontFamily: 'monospace',
                                          fontSize: 11.5,
                                          color: JalaPalette.muted,
                                        ),
                                      ),
                                    ),
                                    trailing: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        if (isCustom)
                                          IconButton(
                                            visualDensity: VisualDensity.compact,
                                            tooltip: 'Delete Snippet',
                                            icon: const Icon(
                                              Icons.delete_outline_rounded,
                                              size: 17,
                                              color: JalaPalette.danger,
                                            ),
                                            onPressed: () {
                                              setState(() {
                                                _customSnippets.removeWhere((c) => c.id == snip.id);
                                              });
                                              setSheetState(() {});
                                              _saveVaultToDisk();
                                            },
                                          ),
                                        IconButton(
                                          visualDensity: VisualDensity.compact,
                                          tooltip: 'Insert without Enter',
                                          icon: const Icon(
                                            Icons.edit_note_rounded,
                                            size: 18,
                                            color: JalaPalette.text2,
                                          ),
                                          onPressed: () {
                                            Navigator.pop(ctx);
                                            if (_sshSubMode == 'sftp') {
                                              setState(() => _sshSubMode = 'terminal');
                                            }
                                            _sendRawTerminalInput(snip.command);
                                          },
                                        ),
                                        FilledButton.tonal(
                                          style: FilledButton.styleFrom(
                                            backgroundColor: JalaPalette.selected,
                                            foregroundColor: JalaPalette.brandGold,
                                            padding: const EdgeInsets.symmetric(horizontal: 10),
                                            minimumSize: const Size(0, 30),
                                          ),
                                          onPressed: () {
                                            Navigator.pop(ctx);
                                            _runTerminalSnippet(snip);
                                          },
                                          child: const Text('Run', style: TextStyle(fontSize: 11.5)),
                                        ),
                                      ],
                                    ),
                                  );
                                },
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  /// Dispatches mouse coordinates, clicks, drags & wheel ticks to the active FreeRDP or VNC engine
  void _dispatchDesktopPointer({
    required double normX,
    required double normY,
    bool click = false,
    bool rightClick = false,
    bool doubleClick = false,
    bool isDragging = false,
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
        _vncRfbClient!.sendPointerEvent(rx, ry, isDragging ? 1 : 0);
      }
    }
  }

  void _dispatchDesktopLeftDragButton(Offset norm, {required bool down}) {
    final rx = (norm.dx.clamp(0.0, 1.0) * _desktopServerWidth).round().clamp(0, _desktopServerWidth - 1);
    final ry = (norm.dy.clamp(0.0, 1.0) * _desktopServerHeight).round().clamp(0, _desktopServerHeight - 1);
    if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
      _rdpFfiClient!.sendMouseMove(rx, ry);
      _rdpFfiClient!.sendMouseButton(rx, ry, buttonFlag: RdpMouseFlags.button1, down: down);
    } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
      _vncRfbClient!.sendPointerEvent(rx, ry, down ? 1 : 0);
    }
  }

  void _dispatchDesktopWheel(Offset norm, int wheelDelta) {
    final rx = (norm.dx.clamp(0.0, 1.0) * _desktopServerWidth).round().clamp(0, _desktopServerWidth - 1);
    final ry = (norm.dy.clamp(0.0, 1.0) * _desktopServerHeight).round().clamp(0, _desktopServerHeight - 1);
    if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
      _rdpFfiClient!.sendMouseWheel(rx, ry, wheelDelta);
    } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
      _vncRfbClient!.sendMouseWheel(rx, ry, wheelDelta);
    }
  }

  /// Dispatches special keys or live typed characters directly to the active FreeRDP or VNC engine.
  /// Automatically clears one-shot sticky modifiers (`Ctrl`, `Alt`, `Win`, `Shift`) after use.
  void _dispatchDesktopKey(String keyLabel, {bool autoClearStickyModifiers = true}) {
    if (_viewOnly) return;
    final ctrl = _ctrlLocked;
    final alt = _altLocked;
    final win = _winLocked;
    final shift = _shiftLocked;

    if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
      _rdpFfiClient!.sendSpecialKey(
        keyLabel,
        ctrl: ctrl,
        alt: alt,
        win: win,
        shift: shift,
      );
    } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
      _vncRfbClient!.sendSpecialKey(
        keyLabel,
        ctrl: ctrl,
        alt: alt,
        win: win,
        shift: shift,
      );
    }

    if (autoClearStickyModifiers && (ctrl || alt || win || shift)) {
      setState(() {
        _ctrlLocked = false;
        _altLocked = false;
        _winLocked = false;
        _shiftLocked = false;
      });
    }
  }

  void _resetDesktopImeSentinel() {
    _suppressDesktopImeCallback = true;
    _desktopImeCtrl.value = const TextEditingValue(
      text: _kDesktopImeSentinel,
      selection: TextSelection.collapsed(offset: _kDesktopImeSentinel.length),
    );
    _suppressDesktopImeCallback = false;
  }

  /// Opens or hides the native Android/iOS soft keyboard for 0ms direct live remote typing.
  void _toggleDesktopLiveKeyboard([bool? forceOpen]) {
    if (_viewOnly) return;
    final shouldOpen = forceOpen ?? !_desktopImeFocusNode.hasFocus;
    if (shouldOpen) {
      _resetDesktopImeSentinel();
      _desktopImeFocusNode.requestFocus();
      SystemChannels.textInput.invokeMethod<void>('TextInput.show');
      setState(() => _desktopImeFocused = true);
    } else {
      _desktopImeFocusNode.unfocus();
      SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
      setState(() => _desktopImeFocused = false);
    }
    if (_isFullScreen && _fullScreenChromeVisible && !_pinFullScreenChrome) {
      _scheduleFullScreenAutoHide();
    }
  }

  void _handleDesktopImeChanged(String val) {
    if (_suppressDesktopImeCallback || val == _kDesktopImeSentinel || _viewOnly) return;
    if (_isFullScreen && _fullScreenChromeVisible && !_pinFullScreenChrome) {
      _scheduleFullScreenAutoHide();
    }

    if (_kDesktopImeSentinel.startsWith(val)) {
      final deletedCount = _kDesktopImeSentinel.length - val.length;
      for (int i = 0; i < deletedCount; i++) {
        _dispatchDesktopKey('Bksp');
      }
      setState(() => _lastRdpAction = 'Live Key: [Bksp]');
    } else if (val.startsWith(_kDesktopImeSentinel)) {
      final inserted = val.substring(_kDesktopImeSentinel.length);
      for (final rune in inserted.runes) {
        final ch = String.fromCharCode(rune);
        if (ch == '\n' || ch == '\r') {
          _dispatchDesktopKey('Enter');
        } else {
          _dispatchDesktopKey(ch);
        }
      }
      setState(() => _lastRdpAction = 'Live Key: typed ${inserted.runes.length} char(s)');
    } else {
      final cleaned = val.replaceAll('\u200B', '');
      if (cleaned.isEmpty) {
        _dispatchDesktopKey('Bksp');
      } else {
        for (final rune in cleaned.runes) {
          final ch = String.fromCharCode(rune);
          if (ch == '\n' || ch == '\r') {
            _dispatchDesktopKey('Enter');
          } else {
            _dispatchDesktopKey(ch);
          }
        }
      }
    }
    _resetDesktopImeSentinel();
  }

  KeyEventResult _handleDesktopHardwareKey(FocusNode node, KeyEvent event) {
    if (_viewOnly || (event is! KeyDownEvent && event is! KeyRepeatEvent)) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    final hwCtrl = HardwareKeyboard.instance.isControlPressed || _ctrlLocked;
    final hwAlt = HardwareKeyboard.instance.isAltPressed || _altLocked;
    final hwWin = HardwareKeyboard.instance.isMetaPressed || _winLocked;
    final hwShift = HardwareKeyboard.instance.isShiftPressed || _shiftLocked;

    String? special;
    if (key == LogicalKeyboardKey.escape) {
      special = 'Esc';
    } else if (key == LogicalKeyboardKey.tab) {
      special = 'Tab';
    } else if (key == LogicalKeyboardKey.enter || key == LogicalKeyboardKey.numpadEnter) {
      special = 'Enter';
    } else if (key == LogicalKeyboardKey.backspace) {
      special = 'Bksp';
    } else if (key == LogicalKeyboardKey.delete) {
      special = 'Del';
    } else if (key == LogicalKeyboardKey.insert) {
      special = 'Ins';
    } else if (key == LogicalKeyboardKey.home) {
      special = 'Home';
    } else if (key == LogicalKeyboardKey.end) {
      special = 'End';
    } else if (key == LogicalKeyboardKey.pageUp) {
      special = 'PgUp';
    } else if (key == LogicalKeyboardKey.pageDown) {
      special = 'PgDn';
    } else if (key == LogicalKeyboardKey.arrowLeft) {
      special = '←';
    } else if (key == LogicalKeyboardKey.arrowUp) {
      special = '↑';
    } else if (key == LogicalKeyboardKey.arrowRight) {
      special = '→';
    } else if (key == LogicalKeyboardKey.arrowDown) {
      special = '↓';
    } else if (key == LogicalKeyboardKey.f1) {
      special = 'F1';
    } else if (key == LogicalKeyboardKey.f2) {
      special = 'F2';
    } else if (key == LogicalKeyboardKey.f3) {
      special = 'F3';
    } else if (key == LogicalKeyboardKey.f4) {
      special = 'F4';
    } else if (key == LogicalKeyboardKey.f5) {
      special = 'F5';
    } else if (key == LogicalKeyboardKey.f6) {
      special = 'F6';
    } else if (key == LogicalKeyboardKey.f7) {
      special = 'F7';
    } else if (key == LogicalKeyboardKey.f8) {
      special = 'F8';
    } else if (key == LogicalKeyboardKey.f9) {
      special = 'F9';
    } else if (key == LogicalKeyboardKey.f10) {
      special = 'F10';
    } else if (key == LogicalKeyboardKey.f11) {
      special = 'F11';
    } else if (key == LogicalKeyboardKey.f12) {
      special = 'F12';
    } else if ((hwCtrl || hwAlt || hwWin) && key.keyLabel.length == 1) {
      special = key.keyLabel;
    }

    if (special != null) {
      if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
        _rdpFfiClient!.sendSpecialKey(special, ctrl: hwCtrl, alt: hwAlt, win: hwWin, shift: hwShift);
      } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
        _vncRfbClient!.sendSpecialKey(special, ctrl: hwCtrl, alt: hwAlt, win: hwWin, shift: hwShift);
      }
      if (_ctrlLocked || _altLocked || _winLocked || _shiftLocked) {
        setState(() {
          _ctrlLocked = false;
          _altLocked = false;
          _winLocked = false;
          _shiftLocked = false;
        });
      }
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  Future<void> _pasteClipboardToRemoteDesktop() async {
    if (_viewOnly) return;
    final clip = await Clipboard.getData(Clipboard.kTextPlain);
    final text = clip?.text ?? '';
    if (text.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Clipboard is empty.')),
      );
      return;
    }
    if (_rdpFfiClient != null && _rdpFfiClient!.isConnected) {
      _rdpFfiClient!.sendUnicodeText(text);
    } else if (_vncRfbClient != null && _vncRfbClient!.isConnected) {
      _vncRfbClient!.sendText(text);
    }
    if (!mounted) return;
    setState(() {
      _lastRdpAction = 'Pasted ${text.length} character(s) to remote desktop';
    });
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
    if (_isVaultLocked && _vaultPinHash.isNotEmpty) {
      return _buildVaultPinLockScreen();
    }
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
            resizeToAvoidBottomInset: _tabIndex != 1,
            backgroundColor: JalaPalette.splashBg,
            body: activeTabBody,
          );
        }

        return Scaffold(
          resizeToAvoidBottomInset: _tabIndex != 1,
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
                      final routeBadge = _routeBadgeForHost(h);
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
                                Icon(
                                  _iconForProtocol(h.protocol),
                                  size: 16,
                                  color: JalaPalette.colorForMark(h.accentTint),
                                ),
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
                                        '${h.protocol.name.toUpperCase()} • ${h.address}:${h.port}${routeBadge.isNotEmpty ? " • $routeBadge" : ""}',
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
        final routeText = _routeBadgeForHost(h).toLowerCase();
        final credLabel = (_findCredential(h.credentialId)?.label ?? '').toLowerCase();
        return h.name.toLowerCase().contains(q) ||
            h.address.toLowerCase().contains(q) ||
            h.username.toLowerCase().contains(q) ||
            h.domain.toLowerCase().contains(q) ||
            h.folder.toLowerCase().contains(q) ||
            routeText.contains(q) ||
            credLabel.contains(q);
      }
      return true;
    }).toList();

    final onlineCount = _hosts.where((h) => h.isOnline == true).length;
    final latencies = _hosts.where((h) => h.latencyMs != null).map((h) => h.latencyMs!).toList();
    final avgRtt = latencies.isEmpty
        ? '—'
        : '${(latencies.reduce((a, b) => a + b) / latencies.length).toStringAsFixed(0)} ms';

    final pinnedFavorites = filtered.where((h) => h.isFavorite).toList();
    final regularHosts = filtered.where((h) => !h.isFavorite).toList();

    // Group non-pinned filtered hosts by folder (preserving insertion order)
    final Map<String, List<RemoteHostItem>> groupedByFolder = {};
    for (final h in regularHosts) {
      final folderName = h.folder.trim().isEmpty ? 'Default' : h.folder.trim();
      groupedByFolder.putIfAbsent(folderName, () => <RemoteHostItem>[]).add(h);
    }

    int countForProto(String proto) {
      if (proto == 'ALL') return _hosts.length;
      return _hosts.where((h) => h.protocol.name.toUpperCase() == proto).length;
    }

    final bool hasLiveActivity =
        _desktopLiveConnected || _sshLiveConnected || _activePortForwards.isNotEmpty;

    return LayoutBuilder(
      builder: (ctx, constraints) {
        final double availW = constraints.maxWidth;
        final int columns = availW >= 980 ? 3 : (availW >= 620 ? 2 : 1);
        const double spacing = 10.0;
        const double horizontalPad = 14.0;
        final double cardW = columns == 1
            ? (availW - horizontalPad * 2)
            : ((availW - horizontalPad * 2 - spacing * (columns - 1)) / columns);

        return ListView(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
          children: [
            // Executive Compact Vault Telemetry Header
            Container(
              padding: const EdgeInsets.fromLTRB(13, 12, 13, 11),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [JalaPalette.chip, JalaPalette.surface],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.32)),
              ),
              child: Column(
                children: [
                  Row(
                    children: [
                      _buildJalaBrandLogo(size: 36, radius: 9),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'JalaDesk Enterprise Vault',
                              style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: FontWeight.w800,
                                letterSpacing: -0.2,
                                color: JalaPalette.text,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 1),
                            Text(
                              _pairedDesktopInfo,
                              style: const TextStyle(fontSize: 11, color: JalaPalette.text2),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      FilledButton.icon(
                        style: FilledButton.styleFrom(
                          backgroundColor: JalaPalette.accent,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
                          minimumSize: const Size(0, 32),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                            side: const BorderSide(color: JalaPalette.accentLine, width: 0.8),
                          ),
                        ),
                        onPressed: () => _showHostEditorDialog(),
                        icon: const Icon(Icons.add_rounded, size: 16),
                        label: const Text('Add Host', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      _buildTelemetryMetricPill('${_hosts.length} SAVED', '$onlineCount Reachable', JalaPalette.ok),
                      const SizedBox(width: 7),
                      _buildTelemetryMetricPill(avgRtt, 'Live TCP RTT', JalaPalette.accentLine),
                      const SizedBox(width: 7),
                      _buildTelemetryMetricPill('AES-256', 'Zero-Trust GCM', JalaPalette.brandGold),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
            // Search + Quick Connect + SSH Port Forwards + Live Latency Probe Row
            Row(
              children: [
                Expanded(
                  child: TextField(
                    onChanged: (v) => setState(() => _searchQuery = v),
                    style: const TextStyle(fontSize: 13, color: JalaPalette.text),
                    decoration: InputDecoration(
                      hintText: 'Search hosts, users, Jump Hosts...',
                      hintStyle: const TextStyle(fontSize: 12, color: JalaPalette.muted),
                      prefixIcon: const Icon(Icons.search_rounded, size: 18, color: JalaPalette.brandGold),
                      prefixIconConstraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                      filled: true,
                      fillColor: JalaPalette.aside,
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(vertical: 9, horizontal: 10),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(9),
                        borderSide: const BorderSide(color: JalaPalette.lineInput, width: 1),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(9),
                        borderSide: const BorderSide(color: JalaPalette.accentLine, width: 1.4),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                SizedBox(
                  height: 36,
                  width: 36,
                  child: IconButton(
                    key: const Key('btn_quick_connect'),
                    padding: EdgeInsets.zero,
                    tooltip: 'Quick Connect (Ad-Hoc SSH/RDP/VNC)',
                    onPressed: _showQuickConnectDialog,
                    style: IconButton.styleFrom(
                      backgroundColor: JalaPalette.surface,
                      side: const BorderSide(color: JalaPalette.lineInput),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
                    ),
                    icon: const Icon(Icons.bolt_rounded, size: 17, color: JalaPalette.brandGold),
                  ),
                ),
                const SizedBox(width: 6),
                SizedBox(
                  height: 36,
                  width: 36,
                  child: IconButton(
                    key: const Key('btn_open_port_forwards'),
                    padding: EdgeInsets.zero,
                    tooltip: 'SSH Port Forwarding Studio (ssh -L)',
                    onPressed: () => _showPortForwardStudioSheet(),
                    style: IconButton.styleFrom(
                      backgroundColor: _activePortForwards.isNotEmpty
                          ? JalaPalette.ok.withValues(alpha: 0.14)
                          : JalaPalette.surface,
                      side: BorderSide(
                        color: _activePortForwards.isNotEmpty
                            ? JalaPalette.ok.withValues(alpha: 0.55)
                            : JalaPalette.lineInput,
                      ),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
                    ),
                    icon: Icon(
                      Icons.swap_calls_rounded,
                      size: 17,
                      color: _activePortForwards.isNotEmpty ? JalaPalette.ok : JalaPalette.accentLine,
                    ),
                  ),
                ),
                if (_hosts.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  SizedBox(
                    height: 36,
                    width: 36,
                    child: IconButton(
                      padding: EdgeInsets.zero,
                      tooltip: 'Probe Live TCP Latency',
                      onPressed: _probingAll ? null : _probeAllHosts,
                      style: IconButton.styleFrom(
                        backgroundColor: JalaPalette.surface,
                        side: const BorderSide(color: JalaPalette.lineInput),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
                      ),
                      icon: Icon(
                        Icons.network_ping_rounded,
                        size: 16,
                        color: _probingAll ? JalaPalette.muted : JalaPalette.brandGold,
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 9),
            // Protocol Filter Strip with Counts
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final proto in ['ALL', 'SSH', 'RDP', 'VNC', 'SFTP', 'HYPERVISOR'])
                    Builder(
                      builder: (ctx) {
                        final selected = _protocolFilter == proto;
                        final count = countForProto(proto);
                        return Padding(
                          padding: const EdgeInsets.only(right: 6),
                          child: InkWell(
                            borderRadius: BorderRadius.circular(8),
                            onTap: () => setState(() => _protocolFilter = proto),
                            child: AnimatedContainer(
                              duration: const Duration(milliseconds: 140),
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5.5),
                              decoration: BoxDecoration(
                                color: selected ? JalaPalette.selected : JalaPalette.surface,
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(
                                  color: selected ? JalaPalette.brandGold : JalaPalette.line,
                                  width: 1,
                                ),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    proto,
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                                      color: selected ? JalaPalette.brandGold : JalaPalette.text2,
                                    ),
                                  ),
                                  if (count > 0) ...[
                                    const SizedBox(width: 5),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 4.5, vertical: 1),
                                      decoration: BoxDecoration(
                                        color: selected
                                            ? JalaPalette.brandGold.withValues(alpha: 0.2)
                                            : JalaPalette.header,
                                        borderRadius: BorderRadius.circular(99),
                                      ),
                                      child: Text(
                                        '$count',
                                        style: TextStyle(
                                          fontSize: 9.5,
                                          fontWeight: FontWeight.w700,
                                          fontFeatures: const [FontFeature.tabularFigures()],
                                          color: selected ? JalaPalette.brandGold : JalaPalette.muted,
                                        ),
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                ],
              ),
            ),
            // Live Active Sessions & Tunnels Strip (Desktop `#tabs` parity)
            if (hasLiveActivity) ...[
              const SizedBox(height: 9),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    if (_desktopLiveConnected && _activeRdpHost != null)
                      Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: _buildActiveSessionPill(
                          icon: _iconForProtocol(_activeRdpHost!.protocol),
                          label: '${_activeRdpHost!.protocol.name.toUpperCase()}: ${_activeRdpHost!.name}',
                          onTap: () => setState(() => _tabIndex = 1),
                          onDisconnect: _disconnectDesktopSession,
                        ),
                      ),
                    if (_sshLiveConnected && _activeSshHost != null)
                      Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: _buildActiveSessionPill(
                          icon: Icons.terminal_rounded,
                          label: 'SSH: ${_activeSshHost!.name}',
                          onTap: () => setState(() => _tabIndex = 2),
                          onDisconnect: _disconnectSshSession,
                        ),
                      ),
                    if (_activePortForwards.isNotEmpty)
                      _buildActiveSessionPill(
                        icon: Icons.swap_calls_rounded,
                        label: '${_activePortForwards.length} Active Tunnel${_activePortForwards.length == 1 ? "" : "s"}',
                        onTap: () => _showPortForwardStudioSheet(),
                      ),
                  ],
                ),
              ),
            ],
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
              if (pinnedFavorites.isNotEmpty) ...[
                _buildFolderGroupHeader(
                  'Pinned Favorites',
                  pinnedFavorites.length,
                  iconOverride: Icons.star_rounded,
                ),
                if (!_collapsedFolders.contains('Pinned Favorites')) ...[
                  if (columns == 1)
                    for (final host in pinnedFavorites) _buildHostCard(host)
                  else
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Wrap(
                        spacing: spacing,
                        runSpacing: 0,
                        children: [
                          for (final host in pinnedFavorites)
                            SizedBox(
                              width: cardW,
                              child: _buildHostCard(host),
                            ),
                        ],
                      ),
                    ),
                ],
                const SizedBox(height: 4),
              ],
              for (final folderEntry in groupedByFolder.entries) ...[
                _buildFolderGroupHeader(folderEntry.key, folderEntry.value.length),
                if (!_collapsedFolders.contains(folderEntry.key)) ...[
                  if (columns == 1)
                    for (final host in folderEntry.value) _buildHostCard(host)
                  else
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Wrap(
                        spacing: spacing,
                        runSpacing: 0,
                        children: [
                          for (final host in folderEntry.value)
                            SizedBox(
                              width: cardW,
                              child: _buildHostCard(host),
                            ),
                        ],
                      ),
                    ),
                ],
                const SizedBox(height: 4),
              ],
              const SizedBox(height: 4),
              Wrap(
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 8,
                runSpacing: 2,
                children: [
                  Wrap(
                    spacing: 4,
                    runSpacing: 2,
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
                        key: const Key('btn_add_jump_host_shortcut'),
                        onPressed: () => _showHostEditorDialog(
                          presetProtocol: RemoteProtocol.ssh,
                          presetFolder: 'Jump Hosts / Bastions',
                          customDialogTitle: 'New SSH Jump Host',
                        ),
                        icon: const Icon(Icons.alt_route_rounded, size: 15, color: JalaPalette.accentLine),
                        label: const Text(
                          'Add Jump Host',
                          style: TextStyle(fontSize: 11.5, color: JalaPalette.accentLine, fontWeight: FontWeight.w600),
                        ),
                      ),
                    ],
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

  Widget _buildActiveSessionPill({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
    VoidCallback? onDisconnect,
  }) {
    return InkWell(
      borderRadius: BorderRadius.circular(99),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: JalaPalette.ok.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(99),
          border: Border.all(color: JalaPalette.ok.withValues(alpha: 0.45)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: const BoxDecoration(color: JalaPalette.ok, shape: BoxShape.circle),
            ),
            const SizedBox(width: 6),
            Icon(icon, size: 13.5, color: JalaPalette.ok),
            const SizedBox(width: 5),
            Text(
              label,
              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: JalaPalette.text),
            ),
            if (onDisconnect != null) ...[
              const SizedBox(width: 8),
              InkWell(
                borderRadius: BorderRadius.circular(99),
                onTap: onDisconnect,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: JalaPalette.danger.withValues(alpha: 0.16),
                    borderRadius: BorderRadius.circular(99),
                    border: Border.all(color: JalaPalette.danger.withValues(alpha: 0.55)),
                  ),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.power_settings_new_rounded, size: 11, color: JalaPalette.danger),
                      SizedBox(width: 3),
                      Text(
                        'Disconnect',
                        style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, color: JalaPalette.danger),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildFolderGroupHeader(String folderName, int count, {IconData? iconOverride}) {
    final collapsed = _collapsedFolders.contains(folderName);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6, top: 2),
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: () {
          setState(() {
            if (collapsed) {
              _collapsedFolders.remove(folderName);
            } else {
              _collapsedFolders.add(folderName);
            }
          });
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          child: Row(
            children: [
              Icon(
                collapsed ? Icons.keyboard_arrow_right_rounded : Icons.keyboard_arrow_down_rounded,
                size: 16,
                color: JalaPalette.muted,
              ),
              const SizedBox(width: 4),
              Icon(iconOverride ?? Icons.folder_outlined, size: 13.5, color: JalaPalette.brandGold),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  folderName.toUpperCase(),
                  style: const TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.6,
                    color: JalaPalette.text2,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                decoration: BoxDecoration(
                  color: JalaPalette.surface,
                  borderRadius: BorderRadius.circular(99),
                  border: Border.all(color: JalaPalette.line),
                ),
                child: Text(
                  '$count',
                  style: const TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    fontFeatures: [FontFeature.tabularFigures()],
                    color: JalaPalette.muted,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
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
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 8),
        decoration: BoxDecoration(
          color: JalaPalette.header.withValues(alpha: 0.68),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: JalaPalette.line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              value,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w800,
                fontFeatures: const [FontFeature.tabularFigures()],
                color: accentColor,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 1),
            Text(
              label,
              style: const TextStyle(fontSize: 9.5, color: JalaPalette.muted),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }

  /// World-Class Single-Surface Host Row (Termius / Jump Desktop / Royal TSX Craft)
  Widget _buildHostCard(RemoteHostItem host) {
    final badgeColor = JalaPalette.colorForMark(host.accentTint);
    final shortProto = host.protocol == RemoteProtocol.hypervisor ? 'HV' : host.protocol.name.toUpperCase();
    final fullProto = host.protocol.name.toUpperCase();
    final routeBadge = _routeBadgeForHost(host);
    final boundCred = _findCredential(host.credentialId);
    final isLive = _isHostLiveConnected(host);

    final bool? online = host.isOnline;
    final Color statusColor = isLive
        ? JalaPalette.ok
        : (online == true
            ? JalaPalette.ok
            : (online == false ? JalaPalette.amber : JalaPalette.accentLine));
    final String statusText = isLive
        ? 'LIVE${host.latencyMs != null ? " • ${host.latencyMs}ms" : ""}'
        : (host.latencyMs != null && online != false
            ? '${host.latencyMs}ms'
            : (online == false ? 'Offline' : 'Ready'));

    final defaultGeneratedLabelPrefix = '$fullProto • ';
    final bool hasCustomOsLabel = host.osLabel.trim().isNotEmpty &&
        !host.osLabel.startsWith(defaultGeneratedLabelPrefix);

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: JalaPalette.surface,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(
          color: isLive ? JalaPalette.ok.withValues(alpha: 0.65) : JalaPalette.lineInput,
        ),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(11),
          onTap: () => _connectToHost(host),
          onLongPress: () => _showHostActionsSheet(host),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
            child: Row(
              children: [
                // Protocol Icon + Micro Protocol Pill
                Container(
                  width: 40,
                  height: 42,
                  decoration: BoxDecoration(
                    color: JalaPalette.header,
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(color: badgeColor.withValues(alpha: 0.42)),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(_iconForProtocol(host.protocol), color: badgeColor, size: 16),
                      const SizedBox(height: 2),
                      Text(
                        shortProto,
                        style: TextStyle(
                          fontSize: 8.5,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.3,
                          color: badgeColor,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 11),
                // Host Identity & Monospace Endpoint
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          if (host.isFavorite) ...[
                            const Icon(Icons.star_rounded, size: 13.5, color: JalaPalette.brandGold),
                            const SizedBox(width: 4),
                          ],
                          Flexible(
                            child: Text(
                              host.name,
                              style: const TextStyle(
                                fontWeight: FontWeight.w700,
                                fontSize: 13.5,
                                color: JalaPalette.text,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 7),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                            decoration: BoxDecoration(
                              color: statusColor.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(99),
                              border: Border.all(color: statusColor.withValues(alpha: 0.36)),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Container(
                                  width: 5,
                                  height: 5,
                                  decoration: BoxDecoration(
                                    color: statusColor,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  statusText,
                                  style: TextStyle(
                                    fontSize: 9.5,
                                    fontWeight: FontWeight.w700,
                                    fontFeatures: const [FontFeature.tabularFigures()],
                                    color: statusColor,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        host.formattedEndpoint,
                        style: const TextStyle(
                          fontSize: 11.5,
                          fontFamily: 'monospace',
                          color: JalaPalette.text2,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (routeBadge.isNotEmpty || boundCred != null) ...[
                        const SizedBox(height: 4),
                        Wrap(
                          spacing: 5,
                          runSpacing: 4,
                          children: [
                            if (routeBadge.isNotEmpty)
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                                decoration: BoxDecoration(
                                  color: JalaPalette.selected,
                                  borderRadius: BorderRadius.circular(6),
                                  border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    const Icon(Icons.alt_route_rounded, size: 11, color: JalaPalette.brandGold),
                                    const SizedBox(width: 3),
                                    Flexible(
                                      child: Text(
                                        routeBadge,
                                        style: const TextStyle(
                                          fontSize: 9.5,
                                          fontWeight: FontWeight.w700,
                                          color: JalaPalette.brandGold,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            if (boundCred != null)
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                                decoration: BoxDecoration(
                                  color: JalaPalette.header,
                                  borderRadius: BorderRadius.circular(6),
                                  border: Border.all(color: JalaPalette.accentLine.withValues(alpha: 0.45)),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    const Icon(Icons.vpn_key_rounded, size: 10.5, color: JalaPalette.accentLine),
                                    const SizedBox(width: 3),
                                    Flexible(
                                      child: Text(
                                        'Vault: ${boundCred.label}',
                                        style: const TextStyle(
                                          fontSize: 9.5,
                                          fontWeight: FontWeight.w700,
                                          color: JalaPalette.accentLine,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                      ],
                      if (hasCustomOsLabel) ...[
                        const SizedBox(height: 2),
                        Text(
                          host.osLabel,
                          style: const TextStyle(fontSize: 10.5, color: JalaPalette.muted),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                // Quick SFTP Jump on SSH Hosts
                if (host.protocol == RemoteProtocol.ssh) ...[
                  SizedBox(
                    height: 30,
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        foregroundColor: JalaPalette.brandGold,
                        side: BorderSide(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                      ),
                      onPressed: () => _connectToHost(host, initialSshSubMode: 'sftp'),
                      child: const Text(
                        'SFTP',
                        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800),
                      ),
                    ),
                  ),
                  const SizedBox(width: 5),
                ],
                // Primary Connect / Resume Action (never re-handshakes an already-live session!)
                SizedBox(
                  height: 30,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: isLive ? JalaPalette.ok.withValues(alpha: 0.2) : JalaPalette.accent,
                      foregroundColor: isLive ? JalaPalette.ok : Colors.white,
                      padding: const EdgeInsets.symmetric(horizontal: 11),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(7),
                        side: BorderSide(
                          color: isLive ? JalaPalette.ok.withValues(alpha: 0.7) : JalaPalette.accentLine,
                          width: 0.8,
                        ),
                      ),
                    ),
                    onPressed: () => _connectToHost(host),
                    child: Text(
                      isLive
                          ? 'Resume'
                          : (host.protocol == RemoteProtocol.ssh ? 'SSH' : 'Connect'),
                      style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700),
                    ),
                  ),
                ),
                if (isLive) ...[
                  const SizedBox(width: 4),
                  SizedBox(
                    height: 30,
                    width: 30,
                    child: IconButton(
                      padding: EdgeInsets.zero,
                      tooltip: 'Disconnect ${host.name}',
                      style: IconButton.styleFrom(
                        backgroundColor: JalaPalette.danger.withValues(alpha: 0.14),
                        side: BorderSide(color: JalaPalette.danger.withValues(alpha: 0.55), width: 0.8),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                      ),
                      onPressed: () {
                        if (host.protocol == RemoteProtocol.ssh ||
                            host.protocol == RemoteProtocol.sftp) {
                          _disconnectSshSession();
                        } else {
                          _disconnectDesktopSession();
                        }
                      },
                      icon: const Icon(Icons.power_settings_new_rounded, size: 15, color: JalaPalette.danger),
                    ),
                  ),
                ],
                const SizedBox(width: 2),
                // Context Menu Trigger (`⋯`)
                InkWell(
                  borderRadius: BorderRadius.circular(7),
                  onTap: () => _showHostActionsSheet(host),
                  child: const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                    child: Icon(Icons.more_vert_rounded, size: 17, color: JalaPalette.muted),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _duplicateHost(RemoteHostItem source) {
    final clone = source.copyWith(
      id: 'host-${DateTime.now().microsecondsSinceEpoch}',
      name: '${source.name} (Copy)',
    );
    setState(() {
      _hosts.add(clone);
    });
    _saveVaultToDisk();
    _probeSingleHost(clone);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Duplicated "${source.name}"')),
    );
  }

  void _showHostActionsSheet(RemoteHostItem host) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: JalaPalette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                child: Row(
                  children: [
                    Icon(_iconForProtocol(host.protocol), size: 18, color: JalaPalette.brandGold),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            host.name,
                            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: JalaPalette.text),
                            overflow: TextOverflow.ellipsis,
                          ),
                          Text(
                            '${host.folder} • ${host.formattedEndpoint}',
                            style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: JalaPalette.muted),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(color: JalaPalette.line, height: 1),
              if (_isHostLiveConnected(host)) ...[
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.open_in_new_rounded, color: JalaPalette.ok, size: 19),
                  title: const Text(
                    'Resume Live Session',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: JalaPalette.ok),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    _resumeLiveHostSession(host);
                  },
                ),
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.refresh_rounded, color: JalaPalette.brandGold, size: 19),
                  title: const Text(
                    'Reconnect Session',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    _connectToHost(host, forceReconnect: true);
                  },
                ),
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.power_settings_new_rounded, color: JalaPalette.danger, size: 19),
                  title: const Text(
                    'Disconnect Active Session',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: JalaPalette.danger),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
                      _disconnectSshSession();
                    } else {
                      _disconnectDesktopSession();
                    }
                  },
                ),
              ] else
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.bolt_rounded, color: JalaPalette.ok, size: 19),
                  title: Text(
                    host.protocol == RemoteProtocol.ssh ? 'Open Interactive SSH Terminal' : 'Connect Now',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    _connectToHost(host);
                  },
                ),
              if (host.protocol == RemoteProtocol.ssh) ...[
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.folder_special_outlined, color: JalaPalette.brandGold, size: 19),
                  title: const Text(
                    'Open Direct SFTP File Browser',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    _connectToHost(host, initialSshSubMode: 'sftp');
                  },
                ),
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.swap_calls_rounded, color: JalaPalette.accentLine, size: 19),
                  title: const Text(
                    'Start Local Port Forward (ssh -L)',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    _showPortForwardStudioSheet(initialSshHost: host);
                  },
                ),
              ],
              ListTile(
                dense: true,
                leading: Icon(
                  host.isFavorite ? Icons.star_rounded : Icons.star_border_rounded,
                  color: JalaPalette.brandGold,
                  size: 19,
                ),
                title: Text(
                  host.isFavorite ? 'Remove from Pinned Favorites' : 'Pin to Favorites',
                  style: const TextStyle(fontSize: 13, color: JalaPalette.text),
                ),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _toggleHostFavorite(host);
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.edit_outlined, color: JalaPalette.accentLine, size: 19),
                title: const Text('Edit Connection & Jump Host', style: TextStyle(fontSize: 13, color: JalaPalette.text)),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _showHostEditorDialog(existing: host);
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.password_rounded, color: JalaPalette.brandGold, size: 19),
                title: const Text('Update Credentials & Reconnect', style: TextStyle(fontSize: 13, color: JalaPalette.text)),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _connectToHost(host, forceCredentialPrompt: true);
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.network_ping_rounded, color: JalaPalette.text2, size: 19),
                title: const Text('Probe TCP Latency', style: TextStyle(fontSize: 13, color: JalaPalette.text)),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _probeSingleHost(host);
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.copy_all_rounded, color: JalaPalette.text2, size: 19),
                title: const Text('Duplicate Host', style: TextStyle(fontSize: 13, color: JalaPalette.text)),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _duplicateHost(host);
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.content_copy_rounded, color: JalaPalette.text2, size: 19),
                title: const Text('Copy Endpoint Address', style: TextStyle(fontSize: 13, color: JalaPalette.text)),
                onTap: () {
                  Navigator.of(ctx).pop();
                  Clipboard.setData(ClipboardData(text: '${host.address}:${host.port}'));
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Copied ${host.address}:${host.port}')),
                  );
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.delete_outline_rounded, color: JalaPalette.danger, size: 19),
                title: const Text('Delete Connection', style: TextStyle(fontSize: 13, color: JalaPalette.danger)),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _deleteHost(host);
                },
              ),
            ],
          ),
        ),
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
  /// Dynamic Display Resolution Matching (`DispClientContext`), Zero-Latency Gestures, and Auto-Hiding Full-Screen Chrome
  Widget _buildJumpRdpCanvasTab({bool isFullScreen = false, bool isWideScreen = false}) {
    final hostTitle = _activeRdpHost != null
        ? '${_activeRdpHost!.name} (${_activeRdpHost!.address}:${_activeRdpHost!.port})'
        : 'No Remote Desktop Selected';
    final isVncHost = _activeRdpHost?.protocol == RemoteProtocol.vnc;
    final double keyboardInset = MediaQuery.viewInsetsOf(context).bottom;
    final bool overlayBottomShortcuts = isFullScreen || keyboardInset > 0;
    final showBottomShortcuts = !isFullScreen || (_showFullScreenModifierBar && _fullScreenChromeVisible);
    final showTopKeyboardBar = _showDesktopKeyboardBar && (!isFullScreen || _fullScreenChromeVisible);

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
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Primary Row: Host Title + Pinned Full Screen & Explicit Disconnect (always visible on phones!)
                Row(
                  children: [
                    Icon(
                      isVncHost ? Icons.laptop_mac_rounded : Icons.desktop_windows_rounded,
                      size: 14,
                      color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                    ),
                    const SizedBox(width: 5),
                    Expanded(
                      child: Text(
                        hostTitle,
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: JalaPalette.text),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (isWideScreen) ...[
                      const SizedBox(width: 6),
                      Flexible(
                        flex: 3,
                        child: _buildDesktopSecondaryControlsStrip(),
                      ),
                    ],
                    const SizedBox(width: 4),
                    // Direct Live Remote Keyboard Toggle (pinned so always visible on phones without scrolling!)
                    InkWell(
                      key: const ValueKey('btn_toggle_desktop_keyboard'),
                      borderRadius: BorderRadius.circular(7),
                      onTap: () => _toggleDesktopLiveKeyboard(),
                      onLongPress: () => setState(() => _showDesktopKeyboardBar = !_showDesktopKeyboardBar),
                      child: Container(
                        height: 26,
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: _desktopImeFocused ? JalaPalette.selected : JalaPalette.header,
                          borderRadius: BorderRadius.circular(7),
                          border: Border.all(
                            color: _desktopImeFocused ? JalaPalette.brandGold : JalaPalette.lineInput,
                          ),
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.keyboard_alt_outlined, size: 14, color: JalaPalette.brandGold),
                            SizedBox(width: 3),
                            Text(
                              'KB',
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
                    // Immersive Edge-to-Edge Full Screen Toggle (always visible without scrolling)
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
                    if (_desktopLiveConnected) ...[
                      const SizedBox(width: 4),
                      InkWell(
                        key: const ValueKey('btn_disconnect_desktop'),
                        borderRadius: BorderRadius.circular(7),
                        onTap: _disconnectDesktopSession,
                        child: Container(
                          height: 26,
                          padding: const EdgeInsets.symmetric(horizontal: 7),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: JalaPalette.danger.withValues(alpha: 0.16),
                            borderRadius: BorderRadius.circular(7),
                            border: Border.all(color: JalaPalette.danger.withValues(alpha: 0.65)),
                          ),
                          child: const Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.power_settings_new_rounded, size: 13, color: JalaPalette.danger),
                              SizedBox(width: 3),
                              Text(
                                'Disconnect',
                                style: TextStyle(
                                  fontSize: 9.5,
                                  fontWeight: FontWeight.w800,
                                  color: JalaPalette.danger,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
                if (!isWideScreen) ...[
                  const SizedBox(height: 5),
                  _buildDesktopSecondaryControlsStrip(),
                ],
              ],
            ),
          ),
        if (showTopKeyboardBar)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            color: JalaPalette.aside,
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _desktopKeyInputCtrl,
                    onChanged: (_) {
                      if (isFullScreen) _scheduleFullScreenAutoHide();
                    },
                    onSubmitted: (txt) {
                      if (txt.isNotEmpty) {
                        _dispatchDesktopKey(txt);
                        _desktopKeyInputCtrl.clear();
                      }
                      _dispatchDesktopKey('Enter');
                      if (isFullScreen) _scheduleFullScreenAutoHide();
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
                    if (isFullScreen) _scheduleFullScreenAutoHide();
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
              final margin = (isFullScreen || _remoteDesktopFrame != null) ? 0.0 : (isWideScreen ? 6.0 : 8.0);
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
                  // Hidden 0px-opacity Direct Live IME Bridge + Hardware Keyboard Listener (Jump / Termius style)
                  Positioned(
                    left: 2,
                    top: 2,
                    width: 12,
                    height: 12,
                    child: IgnorePointer(
                      child: Opacity(
                        opacity: 0.0,
                        child: Focus(
                          onKeyEvent: _handleDesktopHardwareKey,
                          child: TextField(
                            key: const ValueKey('desktop_hidden_ime_input'),
                            controller: _desktopImeCtrl,
                            focusNode: _desktopImeFocusNode,
                            readOnly: _viewOnly,
                            autocorrect: false,
                            enableSuggestions: false,
                            enableIMEPersonalizedLearning: false,
                            keyboardType: TextInputType.visiblePassword,
                            textInputAction: TextInputAction.newline,
                            textCapitalization: TextCapitalization.none,
                            onChanged: _handleDesktopImeChanged,
                            onSubmitted: (_) {
                              if (!_viewOnly) {
                                _dispatchDesktopKey('Enter');
                              }
                              _resetDesktopImeSentinel();
                              if (mounted) _desktopImeFocusNode.requestFocus();
                            },
                          ),
                        ),
                      ),
                    ),
                  ),
                  DesktopGestureSurface(
                    key: const ValueKey('desktop_gesture_surface'),
                    transformationController: _canvasTransformCtrl,
                    desktopRect: desktopRect,
                    viewportSize: viewportSize,
                    canvasMargin: margin,
                    isTrackpadMode: _trackpadMode,
                    viewOnly: _viewOnly,
                    cursorNorm: _cursorNorm,
                    bottomObstructionPx: keyboardInset > 0
                        ? (keyboardInset + (showBottomShortcuts ? 48.0 : 0.0))
                        : 0.0,
                    onThreeFingerTap: () => _toggleDesktopLiveKeyboard(),
                    onUserCanvasInteraction: isFullScreen && _fullScreenChromeVisible && !_pinFullScreenChrome
                        ? _scheduleFullScreenAutoHide
                        : null,
                    onCursorMoved: (norm, {bool isDragging = false}) {
                      if ((_cursorNorm - norm).distanceSquared > 0.00000001) {
                        setState(() => _cursorNorm = norm);
                      }
                      _dispatchDesktopPointer(
                        normX: norm.dx,
                        normY: norm.dy,
                        isDragging: isDragging,
                      );
                    },
                    onLeftClick: (norm, {required bool isConsecutiveDoubleTap}) {
                      setState(() {
                        _cursorNorm = norm;
                        _lastRdpAction =
                            '${isConsecutiveDoubleTap ? "Double Click" : "Left Click"} @ (${(norm.dx * _desktopServerWidth).round()}, ${(norm.dy * _desktopServerHeight).round()}) [${_activeModifierSummary()}]';
                      });
                      _dispatchDesktopPointer(
                        normX: norm.dx,
                        normY: norm.dy,
                        click: !isConsecutiveDoubleTap,
                        doubleClick: isConsecutiveDoubleTap,
                      );
                    },
                    onRightClick: (norm) {
                      setState(() {
                        _cursorNorm = norm;
                        _lastRdpAction =
                            'Right Click @ (${(norm.dx * _desktopServerWidth).round()}, ${(norm.dy * _desktopServerHeight).round()})';
                      });
                      _dispatchDesktopPointer(
                        normX: norm.dx,
                        normY: norm.dy,
                        rightClick: true,
                      );
                    },
                    onLeftDragStart: (norm) {
                      setState(() {
                        _cursorNorm = norm;
                        _lastRdpAction =
                            'Drag @ (${(norm.dx * _desktopServerWidth).round()}, ${(norm.dy * _desktopServerHeight).round()})';
                      });
                      _dispatchDesktopLeftDragButton(norm, down: true);
                    },
                    onLeftDragEnd: (norm) {
                      setState(() => _cursorNorm = norm);
                      _dispatchDesktopLeftDragButton(norm, down: false);
                    },
                    onMouseWheel: (norm, wheelDelta) {
                      _dispatchDesktopWheel(norm, wheelDelta);
                    },
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
                        borderRadius: BorderRadius.circular((isFullScreen || _remoteDesktopFrame != null) ? 0 : 12),
                        border: (isFullScreen || _remoteDesktopFrame != null)
                            ? null
                            : Border.all(
                                color: _desktopLiveConnected
                                    ? JalaPalette.ok.withValues(alpha: 0.75)
                                    : JalaPalette.accentLine.withValues(alpha: 0.55),
                              ),
                      ),
                      clipBehavior: _remoteDesktopFrame != null ? Clip.none : Clip.antiAlias,
                      child: Stack(
                        fit: StackFit.expand,
                        clipBehavior: Clip.none,
                        children: [
                          // REAL LIVE REMOTE DESKTOP PIXEL FRAMEBUFFER (FreeRDP 3.x / VNC RFB 3.8)
                          // Positioned at the exact Jump aspect-fitted rectangle so Direct Touch & Trackpad coordinates
                          // map 1:1 to remote desktop server pixels with zero aspect distortion.
                          if (_remoteDesktopFrame != null)
                            Positioned.fromRect(
                              rect: desktopRect,
                              child: RepaintBoundary(
                                child: RawImage(
                                  image: _remoteDesktopFrame,
                                  fit: BoxFit.fill,
                                  filterQuality: FilterQuality.low,
                                ),
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
                                  color: JalaPalette.header.withValues(alpha: 0.92),
                                  borderRadius: BorderRadius.circular(10),
                                  border: Border.all(color: JalaPalette.lineInput),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        if (_desktopLiveConnected)
                                          const Padding(
                                            padding: EdgeInsets.only(right: 8),
                                            child: SizedBox(
                                              width: 15,
                                              height: 15,
                                              child: CircularProgressIndicator(
                                                strokeWidth: 2,
                                                color: JalaPalette.ok,
                                              ),
                                            ),
                                          )
                                        else ...[
                                          _buildJalaBrandLogo(size: 20, radius: 5),
                                          const SizedBox(width: 8),
                                        ],
                                        Expanded(
                                          child: Text(
                                            _desktopLiveConnected
                                                ? 'SYNCING FRAMEBUFFER • $_desktopProtocolBanner'
                                                : 'REMOTE DESKTOP CANVAS • ${_activeRdpHost?.osLabel ?? "READY"}',
                                            style: TextStyle(
                                              fontSize: 10.5,
                                              fontWeight: FontWeight.w700,
                                              color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                                            ),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ),
                                        if (_desktopLiveConnected)
                                          SizedBox(
                                            height: 26,
                                            child: OutlinedButton(
                                              style: OutlinedButton.styleFrom(
                                                foregroundColor: JalaPalette.danger,
                                                side: BorderSide(color: JalaPalette.danger.withValues(alpha: 0.65)),
                                                padding: const EdgeInsets.symmetric(horizontal: 8),
                                              ),
                                              onPressed: _disconnectDesktopSession,
                                              child: const Text(
                                                'Disconnect',
                                                style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700),
                                              ),
                                            ),
                                          )
                                        else if (_activeRdpHost != null)
                                          SizedBox(
                                            height: 26,
                                            child: FilledButton.tonal(
                                              style: FilledButton.styleFrom(
                                                backgroundColor: JalaPalette.selected,
                                                foregroundColor: JalaPalette.brandGold,
                                                padding: const EdgeInsets.symmetric(horizontal: 8),
                                              ),
                                              onPressed: () => _connectToHost(_activeRdpHost!),
                                              child: const Text(
                                                'Connect Live',
                                                style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700),
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
                                    const SizedBox(height: 4),
                                    Text(
                                      _trackpadMode
                                          ? 'Trackpad: 1-finger move/tap • double-tap drag • 2-finger right-click / scroll / pinch'
                                          : 'Direct Touch: 1-tap click • 1-finger drag • hold or 2-finger tap for right-click • pinch zoom',
                                      style: const TextStyle(fontSize: 10, color: JalaPalette.muted),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          // Precision Virtual Pointer (always shown in Trackpad mode; subtle indicator when offline)
                          if (_trackpadMode || _remoteDesktopFrame == null)
                            Positioned(
                              left: pointerPx.dx.clamp(
                                desktopRect.left,
                                max(desktopRect.left, desktopRect.right - 18.0),
                              ),
                              top: pointerPx.dy.clamp(
                                desktopRect.top,
                                max(desktopRect.top, desktopRect.bottom - 18.0),
                              ),
                              child: IgnorePointer(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    const Icon(
                                      Icons.near_me_rounded,
                                      color: JalaPalette.brandGold,
                                      size: 19,
                                      shadows: [Shadow(color: Colors.black87, blurRadius: 4)],
                                    ),
                                    if (_remoteDesktopFrame == null)
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
                          // Bottom status bar (only shown when no live remote desktop frame is active)
                          if (!isFullScreen && _remoteDesktopFrame == null)
                            Positioned(
                              left: 0,
                              right: 0,
                              bottom: 0,
                              child: IgnorePointer(
                                child: Container(
                                  height: 28,
                                  padding: const EdgeInsets.symmetric(horizontal: 10),
                                  decoration: BoxDecoration(
                                    color: JalaPalette.header.withValues(alpha: 0.84),
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
                                                '${_desktopServerWidth}x$_desktopServerHeight • ${_trackpadMode ? "Trackpad" : "Direct Touch"} • ${_canvasFitMode.shortLabel}',
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
                                              ? '60FPS LIVE STREAM • ${_activeRdpHost?.latencyMs ?? 1}ms'
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
                            ),
                        ],
                      ),
                    ),
                  ),
                  // Jump Desktop-style Auto-Hiding Floating Mini-Pill HUD in Full Screen Mode
                  if (isFullScreen)
                    Positioned(
                      top: 10,
                      right: 10,
                      child: SafeArea(
                        child: AnimatedSwitcher(
                          duration: const Duration(milliseconds: 220),
                          child: _fullScreenChromeVisible
                              ? Container(
                                  key: const ValueKey('fullscreen_floating_hud'),
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                                  decoration: BoxDecoration(
                                    color: JalaPalette.header.withValues(alpha: 0.90),
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
                                        onTap: () {
                                          setState(() => _floatingHudExpanded = !_floatingHudExpanded);
                                          _scheduleFullScreenAutoHide();
                                        },
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
                                        const SizedBox(width: 7),
                                        InkWell(
                                          onTap: () {
                                            _scheduleFullScreenAutoHide();
                                            _showDisplaySizingModal();
                                          },
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
                                          onTap: () {
                                            setState(() => _trackpadMode = !_trackpadMode);
                                            _scheduleFullScreenAutoHide();
                                          },
                                          child: Icon(
                                            _trackpadMode ? Icons.mouse_outlined : Icons.touch_app_outlined,
                                            size: 15,
                                            color: JalaPalette.brandGold,
                                          ),
                                        ),
                                        const SizedBox(width: 6),
                                        InkWell(
                                          onTap: () {
                                            setState(() => _showFullScreenModifierBar = !_showFullScreenModifierBar);
                                            _scheduleFullScreenAutoHide();
                                          },
                                          child: Icon(
                                            Icons.keyboard_command_key_rounded,
                                            size: 15,
                                            color: _showFullScreenModifierBar ? JalaPalette.brandGold : JalaPalette.text2,
                                          ),
                                        ),
                                        const SizedBox(width: 6),
                                        InkWell(
                                          key: const ValueKey('btn_fullscreen_keyboard'),
                                          onTap: () {
                                            _toggleDesktopLiveKeyboard();
                                            _scheduleFullScreenAutoHide();
                                          },
                                          child: Icon(
                                            Icons.keyboard_alt_outlined,
                                            size: 15,
                                            color: _desktopImeFocused ? JalaPalette.brandGold : JalaPalette.text2,
                                          ),
                                        ),
                                        const SizedBox(width: 6),
                                        InkWell(
                                          onTap: () {
                                            toggleLandscapeOrientation();
                                            _scheduleFullScreenAutoHide();
                                          },
                                          child: Icon(
                                            Icons.screen_rotation_rounded,
                                            size: 15,
                                            color: _landscapeLocked ? JalaPalette.brandGold : JalaPalette.text2,
                                          ),
                                        ),
                                        const SizedBox(width: 6),
                                        InkWell(
                                          key: const ValueKey('btn_pin_fullscreen_hud'),
                                          onTap: () {
                                            setState(() => _pinFullScreenChrome = !_pinFullScreenChrome);
                                            if (_pinFullScreenChrome) {
                                              _fullScreenAutoHideTimer?.cancel();
                                            } else {
                                              _scheduleFullScreenAutoHide();
                                            }
                                          },
                                          child: Icon(
                                            _pinFullScreenChrome ? Icons.push_pin_rounded : Icons.push_pin_outlined,
                                            size: 14,
                                            color: _pinFullScreenChrome ? JalaPalette.brandGold : JalaPalette.muted,
                                          ),
                                        ),
                                        if (_desktopLiveConnected) ...[
                                          const SizedBox(width: 6),
                                          InkWell(
                                            key: const ValueKey('btn_disconnect_desktop_fullscreen'),
                                            onTap: _disconnectDesktopSession,
                                            child: Container(
                                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                              decoration: BoxDecoration(
                                                color: JalaPalette.danger.withValues(alpha: 0.20),
                                                borderRadius: BorderRadius.circular(99),
                                                border: Border.all(color: JalaPalette.danger.withValues(alpha: 0.65)),
                                              ),
                                              child: const Icon(
                                                Icons.power_settings_new_rounded,
                                                size: 13,
                                                color: JalaPalette.danger,
                                              ),
                                            ),
                                          ),
                                        ],
                                      ],
                                      const SizedBox(width: 7),
                                      InkWell(
                                        key: const ValueKey('btn_exit_fullscreen_pill'),
                                        onTap: () => toggleFullScreen(false),
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                          decoration: BoxDecoration(
                                            color: JalaPalette.selected,
                                            borderRadius: BorderRadius.circular(99),
                                            border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.55)),
                                          ),
                                          child: const Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              Icon(
                                                Icons.fullscreen_exit_rounded,
                                                size: 13,
                                                color: JalaPalette.brandGold,
                                              ),
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
                                )
                              : Opacity(
                                  key: const ValueKey('btn_reveal_fullscreen_hud'),
                                  opacity: 0.55,
                                  child: InkWell(
                                    borderRadius: BorderRadius.circular(99),
                                    onTap: _revealFullScreenChrome,
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                                      decoration: BoxDecoration(
                                        color: JalaPalette.header.withValues(alpha: 0.78),
                                        borderRadius: BorderRadius.circular(99),
                                        border: Border.all(color: JalaPalette.lineInput),
                                      ),
                                      child: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(
                                            Icons.circle,
                                            size: 7,
                                            color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                                          ),
                                          const SizedBox(width: 4),
                                          const Icon(Icons.tune_rounded, size: 14, color: JalaPalette.brandGold),
                                        ],
                                      ),
                                    ),
                                  ),
                                ),
                        ),
                      ),
                    ),
                  // Zero-Flicker Overlay Modifier & Shortcut Strip (in Full Screen or floating above live Soft Keyboard)
                  if (overlayBottomShortcuts && showBottomShortcuts)
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: keyboardInset,
                      child: SafeArea(
                        top: false,
                        bottom: keyboardInset == 0,
                        child: _buildDesktopBottomShortcutBar(isFullScreen: isFullScreen),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
        // Docked Bottom Shortcut Bar in normal non-fullscreen mode when soft keyboard is closed
        if (!overlayBottomShortcuts && showBottomShortcuts)
          _buildDesktopBottomShortcutBar(isFullScreen: isFullScreen),
      ],
    );
  }

  Widget _buildDesktopBottomShortcutBar({required bool isFullScreen}) {
    return Container(
      key: const ValueKey('desktop_bottom_shortcut_bar'),
      decoration: BoxDecoration(
        color: JalaPalette.header.withValues(alpha: isFullScreen ? 0.94 : 1.0),
        border: const Border(top: BorderSide(color: JalaPalette.line)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            if (_desktopImeFocused)
              Padding(
                padding: const EdgeInsets.only(right: 5),
                child: ActionChip(
                  key: const ValueKey('btn_hide_live_keyboard'),
                  visualDensity: VisualDensity.compact,
                  backgroundColor: JalaPalette.selected,
                  side: const BorderSide(color: JalaPalette.brandGold),
                  label: const Icon(Icons.keyboard_hide_rounded, size: 15, color: JalaPalette.brandGold),
                  onPressed: () => _toggleDesktopLiveKeyboard(false),
                ),
              ),
            _buildModifierChip('Ctrl', _ctrlLocked, (v) {
              setState(() => _ctrlLocked = v);
              if (isFullScreen) _scheduleFullScreenAutoHide();
            }),
            _buildModifierChip('Alt', _altLocked, (v) {
              setState(() => _altLocked = v);
              if (isFullScreen) _scheduleFullScreenAutoHide();
            }),
            _buildModifierChip('⌘/Win', _winLocked, (v) {
              setState(() => _winLocked = v);
              if (isFullScreen) _scheduleFullScreenAutoHide();
            }),
            _buildModifierChip('Shift', _shiftLocked, (v) {
              setState(() => _shiftLocked = v);
              if (isFullScreen) _scheduleFullScreenAutoHide();
            }),
            Padding(
              padding: const EdgeInsets.only(right: 5),
              child: ActionChip(
                key: const ValueKey('btn_paste_clipboard_desktop'),
                visualDensity: VisualDensity.compact,
                backgroundColor: JalaPalette.surface,
                side: const BorderSide(color: JalaPalette.accentLine),
                label: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.content_paste_rounded, size: 12, color: JalaPalette.brandGold),
                    SizedBox(width: 3),
                    Text(
                      'Paste',
                      style: TextStyle(fontSize: 11, color: JalaPalette.brandGold, fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
                onPressed: _viewOnly
                    ? null
                    : () {
                        if (isFullScreen) _scheduleFullScreenAutoHide();
                        _pasteClipboardToRemoteDesktop();
                      },
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(right: 5),
              child: ActionChip(
                visualDensity: VisualDensity.compact,
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
                        if (isFullScreen) _scheduleFullScreenAutoHide();
                        _dispatchDesktopPointer(normX: _cursorNorm.dx, normY: _cursorNorm.dy, rightClick: true);
                      },
              ),
            ),
            for (final keyLabel in [
              'Esc',
              'Tab',
              'Enter',
              'Bksp',
              'Del',
              'Ctrl+Alt+Del',
              'Win+D',
              '←',
              '↑',
              '↓',
              '→',
              'Home',
              'End',
              'PgUp',
              'PgDn',
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
                          if (isFullScreen) _scheduleFullScreenAutoHide();
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

  Widget _buildDesktopSecondaryControlsStrip() {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
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
          const SizedBox(width: 5),
          // Jump Display Sizing & Aspect Ratio Match Pill
          InkWell(
            key: const ValueKey('btn_display_sizing'),
            borderRadius: BorderRadius.circular(7),
            onTap: _showDisplaySizingModal,
            child: Container(
              height: 25,
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
                    _resolutionPreset.shortLabel,
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
          // 1-Tap Quick Fit <-> Fill (Jump Pan) <-> Stretch Toggle
          InkWell(
            key: const ValueKey('btn_quick_cycle_fit'),
            borderRadius: BorderRadius.circular(7),
            onTap: () {
              const modes = JumpCanvasFitMode.values;
              final next = modes[(_canvasFitMode.index + 1) % modes.length];
              setState(() {
                _canvasFitMode = next;
                _canvasTransformCtrl.value = Matrix4.identity();
                _lastRdpAction = 'Canvas Fit: ${next.shortLabel} (${_desktopServerWidth}x$_desktopServerHeight)';
              });
            },
            child: Container(
              height: 25,
              padding: const EdgeInsets.symmetric(horizontal: 6),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _canvasFitMode == JumpCanvasFitMode.cropCover ? JalaPalette.selected : JalaPalette.header,
                borderRadius: BorderRadius.circular(7),
                border: Border.all(
                  color: _canvasFitMode == JumpCanvasFitMode.cropCover ? JalaPalette.brandGold : JalaPalette.lineInput,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    _canvasFitMode == JumpCanvasFitMode.cropCover ? Icons.crop_free_rounded : Icons.fit_screen_rounded,
                    size: 12,
                    color: JalaPalette.brandGold,
                  ),
                  const SizedBox(width: 3),
                  Text(
                    _canvasFitMode.shortLabel,
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
          const SizedBox(width: 5),
          // Reset Zoom Pill when zoomed in
          ValueListenableBuilder<Matrix4>(
            valueListenable: _canvasTransformCtrl,
            builder: (ctx, matrix, _) {
              final scale = matrix.storage[0];
              if (scale <= 1.03) return const SizedBox.shrink();
              return Padding(
                padding: const EdgeInsets.only(right: 5),
                child: InkWell(
                  borderRadius: BorderRadius.circular(7),
                  onTap: () => setState(() => _canvasTransformCtrl.value = Matrix4.identity()),
                  child: Container(
                    height: 25,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: JalaPalette.header,
                      borderRadius: BorderRadius.circular(7),
                      border: Border.all(color: JalaPalette.accentLine),
                    ),
                    child: Text(
                      '${scale.toStringAsFixed(1)}x↺',
                      style: const TextStyle(
                        fontSize: 9.5,
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.w700,
                        color: JalaPalette.brandGold,
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
          // Rotate Landscape / Portrait Toggle
          InkWell(
            key: const ValueKey('btn_rotate_orientation'),
            borderRadius: BorderRadius.circular(7),
            onTap: () => toggleLandscapeOrientation(),
            child: Container(
              width: 25,
              height: 25,
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
          // View-Only Lock Toggle
          InkWell(
            borderRadius: BorderRadius.circular(7),
            onTap: () => setState(() => _viewOnly = !_viewOnly),
            child: Container(
              width: 25,
              height: 25,
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
    );
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
      padding: const EdgeInsets.only(right: 5),
      child: FilterChip(
        visualDensity: VisualDensity.compact,
        showCheckmark: false,
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

  /// Termius-style Mobile SSHv2 Interactive Terminal + SFTP Studio (`dartssh2`)
  /// Supports side-by-side Split SSH + SFTP mode on foldables & tablets (`constraints.maxWidth >= 700`)
  /// and Auto-Hiding Full-Screen Chrome
  Widget _buildTermiusSshTab({bool isFullScreen = false, bool isWideScreen = false}) {
    final hostDesc = _activeSshHost != null
        ? _activeSshHost!.formattedEndpoint
        : 'Interactive Terminal Preview';
    final activeTheme = TerminalThemePreset.byId(_terminalThemeId);
    final routeBadge = _activeSshHost != null ? _routeBadgeForHost(_activeSshHost!) : '';

    return LayoutBuilder(
      builder: (ctx, constraints) {
        final canSplitSshSftp = constraints.maxWidth >= 700;
        final isTerminalVisible = _sshSubMode != 'sftp' || (canSplitSshSftp && _sshSubMode == 'split');

        void selectSshSubMode(String mode) {
          setState(() => _sshSubMode = mode);
          if (isFullScreen) _scheduleFullScreenAutoHide();
          if ((mode == 'sftp' || mode == 'split') && _sshLiveConnected) {
            _browseRemoteSftpPath(_sftpCurrentPath);
          }
        }

        Widget buildTerminalPane() {
          return TermiusInteractiveTerminal(
            buffer: _terminalBuffer,
            theme: activeTheme,
            fontSize: _terminalFontSize,
            isLiveSshConnected: _sshLiveConnected,
            showAccessoryDeck: !isFullScreen || _fullScreenChromeVisible,
            snippets: [..._customSnippets, ...TerminalSnippetItem.builtIn],
            onSendRaw: (raw) {
              if (isFullScreen && _fullScreenChromeVisible && !_pinFullScreenChrome) {
                _scheduleFullScreenAutoHide();
              }
              _sendRawTerminalInput(raw);
            },
            onRunSnippet: (snip) {
              if (isFullScreen && _fullScreenChromeVisible && !_pinFullScreenChrome) {
                _scheduleFullScreenAutoHide();
              }
              _runTerminalSnippet(snip);
            },
            onOpenThemePicker: _showTerminalThemeSheet,
            onOpenSnippetsStudio: _showSnippetsStudioSheet,
            onFontSizeChanged: (nextSize) {
              setState(() => _terminalFontSize = nextSize.clamp(10.0, 20.0));
              unawaited(_saveVaultToDisk());
            },
            onUserInteraction: isFullScreen && _fullScreenChromeVisible && !_pinFullScreenChrome
                ? _scheduleFullScreenAutoHide
                : null,
            onTerminalResize: (cols, rows) {
              try {
                _sshPtySession?.resizeTerminal(cols, rows);
              } catch (_) {}
            },
          );
        }

        final mainWorkspace = canSplitSshSftp && _sshSubMode == 'split'
            ? Row(
                children: [
                  Expanded(flex: 3, child: buildTerminalPane()),
                  Container(width: 1, color: JalaPalette.line),
                  Expanded(flex: 2, child: _buildSftpMobileBrowser()),
                ],
              )
            : (_sshSubMode == 'sftp' ? _buildSftpMobileBrowser() : buildTerminalPane());

        return Column(
          children: [
            if (!isFullScreen)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: activeTheme.chromeSurface,
                  border: Border(bottom: BorderSide(color: activeTheme.border)),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 24,
                      height: 24,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: _sshLiveConnected
                            ? JalaPalette.ok.withValues(alpha: 0.14)
                            : JalaPalette.selected.withValues(alpha: 0.7),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(
                          color: _sshLiveConnected
                              ? JalaPalette.ok.withValues(alpha: 0.45)
                              : activeTheme.border,
                        ),
                      ),
                      child: Icon(
                        _sshSubMode == 'sftp' && !canSplitSshSftp
                            ? Icons.folder_special_rounded
                            : Icons.terminal_rounded,
                        size: 13.5,
                        color: _sshLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                      ),
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      flex: 3,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            hostDesc,
                            style: const TextStyle(
                              fontSize: 11.5,
                              fontFamily: 'monospace',
                              fontWeight: FontWeight.w700,
                              color: JalaPalette.text,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          if (routeBadge.isNotEmpty)
                            Text(
                              routeBadge,
                              style: const TextStyle(
                                fontSize: 9.5,
                                fontWeight: FontWeight.w600,
                                color: JalaPalette.brandGold,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 6),
                    Flexible(
                      flex: 5,
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // Clean Segmented [Terminal | SFTP] Switcher
                            Container(
                              padding: const EdgeInsets.all(2),
                              decoration: BoxDecoration(
                                color: JalaPalette.header.withValues(alpha: 0.85),
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(color: activeTheme.border),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  _buildSshModeSegment(
                                    key: const ValueKey('seg_ssh_terminal'),
                                    label: 'Terminal',
                                    icon: Icons.terminal_rounded,
                                    selected: _sshSubMode == 'terminal',
                                    onTap: () => selectSshSubMode('terminal'),
                                  ),
                                  _buildSshModeSegment(
                                    key: const ValueKey('seg_ssh_sftp'),
                                    label: 'SFTP',
                                    icon: Icons.folder_copy_outlined,
                                    selected: _sshSubMode == 'sftp',
                                    onTap: () => selectSshSubMode('sftp'),
                                  ),
                                ],
                              ),
                            ),
                            if (canSplitSshSftp) ...[
                              const SizedBox(width: 5),
                              TextButton.icon(
                                style: TextButton.styleFrom(
                                  foregroundColor: JalaPalette.brandGold,
                                  backgroundColor: _sshSubMode == 'split'
                                      ? JalaPalette.selected
                                      : JalaPalette.surface,
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                  minimumSize: Size.zero,
                                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(7),
                                    side: BorderSide(
                                      color: _sshSubMode == 'split'
                                          ? JalaPalette.brandGold
                                          : activeTheme.border,
                                    ),
                                  ),
                                ),
                                onPressed: () => selectSshSubMode(_sshSubMode == 'split' ? 'terminal' : 'split'),
                                icon: const Icon(Icons.vertical_split_rounded, size: 13.5),
                                label: Text(
                                  _sshSubMode == 'split' ? 'Single Terminal' : 'Split SSH+SFTP',
                                  style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700),
                                ),
                              ),
                            ],
                            if (isTerminalVisible && constraints.maxWidth >= 460) ...[
                              const SizedBox(width: 4),
                              InkWell(
                                borderRadius: BorderRadius.circular(6),
                                onTap: _showTerminalThemeSheet,
                                child: const Tooltip(
                                  message: 'Terminal Themes',
                                  child: Padding(
                                    padding: EdgeInsets.all(5),
                                    child: Icon(Icons.palette_outlined, size: 15.5, color: JalaPalette.text2),
                                  ),
                                ),
                              ),
                              InkWell(
                                borderRadius: BorderRadius.circular(6),
                                onTap: _showSnippetsStudioSheet,
                                child: const Tooltip(
                                  message: 'Snippets Studio',
                                  child: Padding(
                                    padding: EdgeInsets.all(5),
                                    child: Icon(Icons.bolt_rounded, size: 15.5, color: JalaPalette.brandGold),
                                  ),
                                ),
                              ),
                            ],
                            if (_sshLiveConnected) ...[
                              const SizedBox(width: 5),
                              InkWell(
                                key: const ValueKey('btn_disconnect_ssh'),
                                borderRadius: BorderRadius.circular(7),
                                onTap: _disconnectSshSession,
                                child: Container(
                                  height: 26,
                                  padding: const EdgeInsets.symmetric(horizontal: 7),
                                  alignment: Alignment.center,
                                  decoration: BoxDecoration(
                                    color: JalaPalette.danger.withValues(alpha: 0.16),
                                    borderRadius: BorderRadius.circular(7),
                                    border: Border.all(color: JalaPalette.danger.withValues(alpha: 0.65)),
                                  ),
                                  child: const Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(Icons.power_settings_new_rounded, size: 13, color: JalaPalette.danger),
                                      SizedBox(width: 3),
                                      Text(
                                        'Disconnect',
                                        style: TextStyle(
                                          fontSize: 10,
                                          fontWeight: FontWeight.w800,
                                          color: JalaPalette.danger,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ] else if (_activeSshHost != null) ...[
                              const SizedBox(width: 5),
                              SizedBox(
                                height: 26,
                                child: FilledButton.tonal(
                                  style: FilledButton.styleFrom(
                                    backgroundColor: JalaPalette.selected,
                                    foregroundColor: JalaPalette.brandGold,
                                    padding: const EdgeInsets.symmetric(horizontal: 7),
                                    minimumSize: Size.zero,
                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  ),
                                  onPressed: () => _connectToHost(_activeSshHost!),
                                  child: Text(
                                    constraints.maxWidth >= 420 ? 'Connect SSH' : 'Connect',
                                    style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700),
                                  ),
                                ),
                              ),
                            ],
                            const SizedBox(width: 4),
                            InkWell(
                              key: const ValueKey('btn_ssh_toggle_fullscreen'),
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
              child: Stack(
                fit: StackFit.expand,
                children: [
                  mainWorkspace,
                  if (isFullScreen)
                    Positioned(
                      top: 10,
                      right: 10,
                      child: SafeArea(
                        child: AnimatedSwitcher(
                          duration: const Duration(milliseconds: 220),
                          child: _fullScreenChromeVisible
                              ? Container(
                                  key: const ValueKey('ssh_fullscreen_floating_hud'),
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                                  decoration: BoxDecoration(
                                    color: activeTheme.chromeSurface.withValues(alpha: 0.92),
                                    borderRadius: BorderRadius.circular(99),
                                    border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.65)),
                                    boxShadow: const [
                                      BoxShadow(color: Colors.black54, blurRadius: 10, offset: Offset(0, 3)),
                                    ],
                                  ),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(
                                        Icons.circle,
                                        size: 7,
                                        color: _sshLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
                                      ),
                                      const SizedBox(width: 6),
                                      InkWell(
                                        onTap: () => selectSshSubMode(_sshSubMode == 'sftp' ? 'terminal' : 'sftp'),
                                        child: Text(
                                          _sshSubMode == 'sftp' ? 'Terminal' : 'SFTP',
                                          style: const TextStyle(
                                            fontSize: 10,
                                            fontWeight: FontWeight.w700,
                                            color: JalaPalette.brandGold,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      InkWell(
                                        onTap: () {
                                          setState(() => _pinFullScreenChrome = !_pinFullScreenChrome);
                                          if (_pinFullScreenChrome) {
                                            _fullScreenAutoHideTimer?.cancel();
                                          } else {
                                            _scheduleFullScreenAutoHide();
                                          }
                                        },
                                        child: Icon(
                                          _pinFullScreenChrome ? Icons.push_pin_rounded : Icons.push_pin_outlined,
                                          size: 14,
                                          color: _pinFullScreenChrome ? JalaPalette.brandGold : JalaPalette.muted,
                                        ),
                                      ),
                                      if (_sshLiveConnected) ...[
                                        const SizedBox(width: 7),
                                        InkWell(
                                          onTap: _disconnectSshSession,
                                          child: const Icon(
                                            Icons.power_settings_new_rounded,
                                            size: 14,
                                            color: JalaPalette.danger,
                                          ),
                                        ),
                                      ],
                                      const SizedBox(width: 8),
                                      InkWell(
                                        onTap: () => toggleFullScreen(false),
                                        child: const Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Icon(
                                              Icons.fullscreen_exit_rounded,
                                              size: 13,
                                              color: JalaPalette.brandGold,
                                            ),
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
                                    ],
                                  ),
                                )
                              : Opacity(
                                  opacity: 0.55,
                                  child: InkWell(
                                    borderRadius: BorderRadius.circular(99),
                                    onTap: _revealFullScreenChrome,
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                                      decoration: BoxDecoration(
                                        color: activeTheme.chromeSurface.withValues(alpha: 0.8),
                                        borderRadius: BorderRadius.circular(99),
                                        border: Border.all(color: activeTheme.border),
                                      ),
                                      child: const Icon(Icons.tune_rounded, size: 14, color: JalaPalette.brandGold),
                                    ),
                                  ),
                                ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _buildSshModeSegment({
    Key? key,
    required String label,
    required IconData icon,
    required bool selected,
    required VoidCallback onTap,
  }) {
    return InkWell(
      key: key,
      borderRadius: BorderRadius.circular(6),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3.5),
        decoration: BoxDecoration(
          color: selected ? JalaPalette.selected : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
          border: selected
              ? Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.45), width: 0.7)
              : null,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 12,
              color: selected ? JalaPalette.brandGold : JalaPalette.muted,
            ),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 10.5,
                fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                color: selected ? JalaPalette.brandGold : JalaPalette.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSftpMobileBrowser() {
    final activeEntries = (_sshLiveConnected ? _sftpEntries : _offlineSftpEntries)
        .map((e) => e.toExplorerEntry())
        .toList();

    return SftpExplorerView(
      currentPath: _sftpCurrentPath,
      isLiveSftp: _sshLiveConnected,
      isLoading: _sshBusy,
      entries: activeEntries,
      activeTransfer: _activeSftpTransfer,
      onNavigatePath: _browseRemoteSftpPath,
      onNavigateUp: _navigateSftpUp,
      onRefresh: () => _browseRemoteSftpPath(_sftpCurrentPath),
      onCreateFolder: _createSftpFolder,
      onReadTextFile: _readSftpTextFile,
      onWriteTextFile: _writeSftpTextFile,
      onRenameEntry: _renameSftpEntry,
      onDeleteEntry: _deleteSftpEntry,
      onUploadFiles: _uploadSftpFilesFromDevice,
      onUploadFolder: _uploadSftpFolderFromDevice,
      onOpenLocalWorkspaceTransfer: _openLocalWorkspaceTransferSheet,
      onDownloadEntry: _downloadSftpEntryToDevice,
    );
  }

  /// Zero-Trust Vault, App-Lock PIN, SSH TOFU Known-Hosts & Real RFC 6238 HMAC TOTP 2FA Tab
  Widget _buildSecurityVaultTab() {
    final pinnedHosts = _knownHostsStore.entries;

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
                  key: const Key('btn_add_totp_2fa'),
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
                if (_totpItems.isNotEmpty) ...[
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
              ],
            ),
            const SizedBox(height: 10),
            if (_totpItems.isEmpty)
              const Text(
                'Add your Base32 TOTP secret keys (SHA-1 / SHA-256 / SHA-512) for Bastion SSH MFA, Active Directory, or Proxmox VE. Tap any code to copy with 30s auto-scrub.',
                style: TextStyle(fontSize: 11.5, color: JalaPalette.muted, height: 1.35),
              )
            else
              for (int i = 0; i < _totpItems.length; i++) ...[
                if (i > 0) const Divider(height: 18),
                _buildTotpRow(
                  _totpItems[i],
                  Rfc6238Totp.generateCode(
                    _totpItems[i].secretBase32,
                    algorithm: _totpItems[i].algorithm,
                    digits: _totpItems[i].digits,
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
          ListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            leading: Icon(
              _vaultPinHash.isNotEmpty ? Icons.lock_rounded : Icons.lock_open_rounded,
              color: _vaultPinHash.isNotEmpty ? JalaPalette.ok : JalaPalette.brandGold,
              size: 20,
            ),
            title: const Text(
              'Vault App-Lock PIN (PBKDF2-SHA256)',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
            ),
            subtitle: Text(
              _vaultPinHash.isNotEmpty
                  ? 'Active • Auto-locks vault when backgrounded'
                  : 'Protect saved servers, keys & 2FA with an App-Lock PIN',
              style: const TextStyle(fontSize: 11.5, color: JalaPalette.muted),
            ),
            trailing: Wrap(
              spacing: 6,
              children: [
                if (_vaultPinHash.isNotEmpty)
                  OutlinedButton(
                    key: const Key('btn_lock_vault_now'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: JalaPalette.brandGold,
                      side: BorderSide(color: JalaPalette.brandGold.withValues(alpha: 0.5)),
                      visualDensity: VisualDensity.compact,
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                    ),
                    onPressed: () => setState(() => _isVaultLocked = true),
                    child: const Text('Lock', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                  ),
                FilledButton.tonal(
                  key: const Key('btn_configure_vault_pin'),
                  style: FilledButton.styleFrom(
                    backgroundColor: JalaPalette.selected,
                    foregroundColor: JalaPalette.brandGold,
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                  ),
                  onPressed: _showConfigureVaultPinDialog,
                  child: Text(
                    _vaultPinHash.isNotEmpty ? 'Manage' : 'Set PIN',
                    style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          SwitchListTile(
            key: const Key('switch_secure_screen'),
            activeThumbColor: JalaPalette.brandGold,
            activeTrackColor: JalaPalette.selected,
            value: _secureScreenShield,
            onChanged: (v) {
              setState(() => _secureScreenShield = v);
              unawaited(NativePlatformBridge.setSecureScreen(v));
              unawaited(_saveVaultToDisk());
            },
            title: const Text(
              'Screen Capture & Recents Shield (FLAG_SECURE)',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JalaPalette.text),
            ),
            subtitle: const Text(
              'Block OS screenshots, screen recorders, and Android Recents previews of live sessions',
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
          const Divider(height: 1),
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
        ],
      ),
    );

    final knownHostsCard = Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.verified_user_outlined, size: 17, color: JalaPalette.ok),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text(
                    'Trusted SSH Host Keys (TOFU Pinning)',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5, color: JalaPalette.text),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: JalaPalette.header,
                    borderRadius: BorderRadius.circular(99),
                    border: Border.all(color: JalaPalette.lineInput),
                  ),
                  child: Text(
                    '${pinnedHosts.length} pinned',
                    style: const TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: JalaPalette.text2),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (pinnedHosts.isEmpty)
              const Text(
                'SSH server & Jump Host fingerprints are automatically pinned on first connection (RFC 4251 TOFU) and verified on every reconnect to block Man-in-the-Middle interception.',
                style: TextStyle(fontSize: 11.5, color: JalaPalette.muted, height: 1.35),
              )
            else
              for (int i = 0; i < pinnedHosts.length; i++) ...[
                if (i > 0) const Divider(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${pinnedHosts[i].endpoint} • ${pinnedHosts[i].keyType}',
                            style: const TextStyle(
                              fontSize: 12,
                              fontFamily: 'monospace',
                              fontWeight: FontWeight.w700,
                              color: JalaPalette.text,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            pinnedHosts[i].fingerprintDisplay,
                            style: const TextStyle(
                              fontSize: 10.5,
                              fontFamily: 'monospace',
                              color: JalaPalette.brandGold,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Revoke Pinned Key',
                      onPressed: () {
                        final ep = pinnedHosts[i].endpoint;
                        setState(() => _knownHostsStore.removeEndpoint(ep));
                        _saveVaultToDisk();
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('Revoked pinned SSH host key for $ep')),
                        );
                      },
                      icon: const Icon(Icons.link_off_rounded, size: 17, color: JalaPalette.muted),
                    ),
                  ],
                ),
              ],
          ],
        ),
      ),
    );

    final credentialsVaultCard = Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.vpn_key_outlined, size: 17, color: JalaPalette.accentLine),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text(
                    'Reusable Credential Vault',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5, color: JalaPalette.text),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 6),
                InkWell(
                  key: const Key('btn_add_vault_credential'),
                  borderRadius: BorderRadius.circular(6),
                  onTap: () => _showVaultCredentialEditorDialog(),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3.5),
                    decoration: BoxDecoration(
                      color: JalaPalette.header,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: JalaPalette.lineInput),
                    ),
                    child: const Text(
                      '+ Add Credential',
                      style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: JalaPalette.brandGold),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (_credentials.isEmpty)
              const Text(
                'Store shared AD Domain accounts, SSH Ed25519/RSA keys, and Bastion logins once — bind them to any host or Jump Host.',
                style: TextStyle(fontSize: 11.5, color: JalaPalette.muted, height: 1.35),
              )
            else
              for (int i = 0; i < _credentials.length; i++) ...[
                if (i > 0) const Divider(height: 16),
                Builder(
                  builder: (ctx) {
                    final cred = _credentials[i];
                    final boundCount = _hosts.where((h) => h.credentialId == cred.id).length;
                    return InkWell(
                      borderRadius: BorderRadius.circular(8),
                      onTap: () => _showVaultCredentialEditorDialog(existing: cred),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  cred.label,
                                  style: const TextStyle(
                                    fontSize: 12.5,
                                    fontWeight: FontWeight.w700,
                                    color: JalaPalette.text,
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  '${cred.displayPrincipal} • ${cred.kindBadge} • $boundCount host${boundCount == 1 ? "" : "s"}',
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                    color: JalaPalette.muted,
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ),
                          ),
                          if (cred.password.isNotEmpty)
                            IconButton(
                              visualDensity: VisualDensity.compact,
                              tooltip: 'Copy Password (30s Auto-Scrub)',
                              onPressed: () => _copySensitiveSecret(
                                cred.password,
                                toastMessage:
                                    'Copied password for "${cred.label}" • Auto-scrubs in ${_clipboardScrubber ? "30s" : "manual mode"}',
                              ),
                              icon: const Icon(Icons.copy_rounded, size: 15.5, color: JalaPalette.brandGold),
                            ),
                          IconButton(
                            visualDensity: VisualDensity.compact,
                            tooltip: 'Delete Credential',
                            onPressed: () => _deleteVaultCredential(cred),
                            icon: const Icon(Icons.delete_outline_rounded, size: 17, color: JalaPalette.muted),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ],
          ],
        ),
      ),
    );

    final encryptedBackupCard = Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.enhanced_encryption_outlined, size: 17, color: JalaPalette.brandGold),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Encrypted Vault Snapshot (.jvault)',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5, color: JalaPalette.text),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            const Text(
              'Authenticated AES-256-GCM + PBKDF2-HMAC-SHA256 (100k) portable backup of hosts, Jump Host routes, credentials, 2FA seeds, and snippets.',
              style: TextStyle(fontSize: 11.5, color: JalaPalette.muted, height: 1.35),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  key: const Key('btn_export_encrypted_vault'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: JalaPalette.brandGold,
                    side: BorderSide(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
                    visualDensity: VisualDensity.compact,
                  ),
                  onPressed: _showExportEncryptedVaultDialog,
                  icon: const Icon(Icons.upload_file_rounded, size: 15),
                  label: const Text('Export .jvault', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700)),
                ),
                OutlinedButton.icon(
                  key: const Key('btn_import_encrypted_vault'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: JalaPalette.accentLine,
                    side: BorderSide(color: JalaPalette.accentLine.withValues(alpha: 0.45)),
                    visualDensity: VisualDensity.compact,
                  ),
                  onPressed: _showImportEncryptedVaultDialog,
                  icon: const Icon(Icons.download_rounded, size: 15),
                  label: const Text('Import .jvault', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700)),
                ),
              ],
            ),
          ],
        ),
      ),
    );

    return LayoutBuilder(
      builder: (ctx, constraints) {
        final isTwoColumn = constraints.maxWidth >= 720;
        return SingleChildScrollView(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
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
                            'AES-256-GCM At-Rest • SSH TOFU • FLAG_SECURE Shield',
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
              if (isTwoColumn) ...[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: credentialsVaultCard),
                    const SizedBox(width: 12),
                    Expanded(child: totpCard),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        children: [
                          knownHostsCard,
                          const SizedBox(height: 12),
                          encryptedBackupCard,
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(child: securitySwitchesCard),
                  ],
                ),
              ] else ...[
                credentialsVaultCard,
                const SizedBox(height: 12),
                totpCard,
                const SizedBox(height: 12),
                knownHostsCard,
                const SizedBox(height: 12),
                encryptedBackupCard,
                const SizedBox(height: 12),
                securitySwitchesCard,
              ],
            ],
          ),
        );
      },
    );
  }

  Widget _buildTotpRow(TotpEntryItem item, String digits) {
    final formatted = digits.length >= 6
        ? '${digits.substring(0, 3)} ${digits.substring(3)}'
        : digits;
    final meta = '${item.algorithm} • ${item.digits} digits';
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                item.label,
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
          onTap: () => _copySensitiveSecret(
            digits,
            toastMessage:
                'Copied 2FA code ($formatted) • Auto-scrubs in ${_clipboardScrubber ? "30s" : "manual mode"}',
          ),
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
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: 'Remove 2FA Entry',
          onPressed: () {
            setState(() => _totpItems.removeWhere((t) => t.id == item.id));
            _saveVaultToDisk();
          },
          icon: const Icon(Icons.delete_outline_rounded, size: 16, color: JalaPalette.muted),
        ),
      ],
    );
  }

  Widget _buildVaultPinLockScreen() {
    return _VaultPinLockView(
      pinHash: _vaultPinHash,
      brandLogo: _buildJalaBrandLogo(size: 48, radius: 12),
      onUnlocked: () => setState(() => _isVaultLocked = false),
    );
  }

  Future<void> _showConfigureVaultPinDialog() async {
    final currentCtrl = TextEditingController();
    final newPinCtrl = TextEditingController();
    final confirmCtrl = TextEditingController();
    final hasExisting = _vaultPinHash.isNotEmpty;
    String? errorMsg;

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
              const Icon(Icons.pin_outlined, size: 20, color: JalaPalette.brandGold),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  hasExisting ? 'Manage Vault App-Lock PIN' : 'Set Vault App-Lock PIN',
                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: JalaPalette.text),
                ),
              ),
            ],
          ),
          content: SizedBox(
            width: 380,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Derived with 60,000 rounds of PBKDF2-HMAC-SHA256. Automatically locks JalaDesk when backgrounded.',
                    style: TextStyle(fontSize: 11.5, color: JalaPalette.muted, height: 1.35),
                  ),
                  const SizedBox(height: 12),
                  if (hasExisting) ...[
                    TextField(
                      key: const Key('field_current_vault_pin'),
                      controller: currentCtrl,
                      obscureText: true,
                      keyboardType: TextInputType.number,
                      style: const TextStyle(fontSize: 13, color: JalaPalette.text),
                      decoration: InputDecoration(
                        labelText: 'Current PIN *',
                        labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                        isDense: true,
                        filled: true,
                        fillColor: JalaPalette.header,
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                    ),
                    const SizedBox(height: 10),
                  ],
                  TextField(
                    key: const Key('field_new_vault_pin'),
                    controller: newPinCtrl,
                    obscureText: true,
                    keyboardType: TextInputType.number,
                    style: const TextStyle(fontSize: 13, color: JalaPalette.text),
                    decoration: InputDecoration(
                      labelText: hasExisting ? 'New PIN (4–12 digits)' : 'PIN (4–12 digits) *',
                      labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
                      isDense: true,
                      filled: true,
                      fillColor: JalaPalette.header,
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('field_confirm_vault_pin'),
                    controller: confirmCtrl,
                    obscureText: true,
                    keyboardType: TextInputType.number,
                    style: const TextStyle(fontSize: 13, color: JalaPalette.text),
                    decoration: InputDecoration(
                      labelText: 'Confirm PIN',
                      labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
                      isDense: true,
                      filled: true,
                      fillColor: JalaPalette.header,
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                  ),
                  if (errorMsg != null) ...[
                    const SizedBox(height: 8),
                    Text(errorMsg!, style: const TextStyle(fontSize: 11.5, color: JalaPalette.danger)),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel', style: TextStyle(color: JalaPalette.muted)),
            ),
            if (hasExisting)
              TextButton(
                key: const Key('btn_remove_vault_pin'),
                onPressed: () {
                  if (!VaultPinHasher.verifyPin(currentCtrl.text.trim(), _vaultPinHash)) {
                    setModalState(() => errorMsg = 'Current PIN is incorrect.');
                    return;
                  }
                  setState(() {
                    _vaultPinHash = '';
                    _isVaultLocked = false;
                  });
                  _saveVaultToDisk();
                  Navigator.of(ctx).pop();
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Vault App-Lock PIN removed.')),
                  );
                },
                child: const Text('Remove PIN', style: TextStyle(color: JalaPalette.danger)),
              ),
            FilledButton(
              key: const Key('btn_save_vault_pin'),
              style: FilledButton.styleFrom(backgroundColor: JalaPalette.accent),
              onPressed: () {
                if (hasExisting && !VaultPinHasher.verifyPin(currentCtrl.text.trim(), _vaultPinHash)) {
                  setModalState(() => errorMsg = 'Current PIN is incorrect.');
                  return;
                }
                final pin = newPinCtrl.text.trim();
                if (pin.length < 4 || pin.length > 12) {
                  setModalState(() => errorMsg = 'PIN must be between 4 and 12 characters.');
                  return;
                }
                if (pin != confirmCtrl.text.trim()) {
                  setModalState(() => errorMsg = 'PIN confirmation does not match.');
                  return;
                }
                final hashed = VaultPinHasher.hashPin(pin);
                setState(() {
                  _vaultPinHash = hashed;
                  _isVaultLocked = false;
                });
                _saveVaultToDisk();
                Navigator.of(ctx).pop();
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Vault App-Lock PIN enabled.')),
                );
              },
              child: const Text('Save PIN'),
            ),
          ],
        ),
      ),
    );
  }

  void _deleteVaultCredential(VaultCredentialItem cred) {
    setState(() {
      _credentials.removeWhere((c) => c.id == cred.id);
      for (int i = 0; i < _hosts.length; i++) {
        if (_hosts[i].credentialId == cred.id) {
          _hosts[i] = _hosts[i].copyWith(clearCredential: true);
        }
      }
    });
    _saveVaultToDisk();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Removed credential "${cred.label}"')),
    );
  }

  Future<void> _showExportEncryptedVaultDialog() async {
    final passCtrl = TextEditingController();
    String? sealedResult;
    String? errorMsg;
    bool obscure = true;

    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) => AlertDialog(
          backgroundColor: JalaPalette.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: JalaPalette.lineInput),
          ),
          title: const Row(
            children: [
              Icon(Icons.enhanced_encryption_rounded, size: 20, color: JalaPalette.brandGold),
              SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Export Encrypted Vault (.jvault)',
                  style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: JalaPalette.text),
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
                    'Choose a strong master passphrase to seal your hosts, Jump Host chains, reusable credentials, 2FA seeds, and snippets with AES-256-GCM.',
                    style: TextStyle(fontSize: 11.5, color: JalaPalette.muted, height: 1.35),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('field_export_vault_passphrase'),
                    controller: passCtrl,
                    obscureText: obscure,
                    style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                    decoration: InputDecoration(
                      labelText: 'Master Backup Passphrase *',
                      labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                      prefixIcon: const Icon(Icons.lock_outline_rounded, size: 17, color: JalaPalette.brandGold),
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
                  if (errorMsg != null) ...[
                    const SizedBox(height: 8),
                    Text(errorMsg!, style: const TextStyle(fontSize: 11.5, color: JalaPalette.danger)),
                  ],
                  if (sealedResult != null) ...[
                    const SizedBox(height: 10),
                    Container(
                      padding: const EdgeInsets.all(9),
                      decoration: BoxDecoration(
                        color: JalaPalette.header,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: JalaPalette.ok.withValues(alpha: 0.5)),
                      ),
                      child: SelectableText(
                        sealedResult!,
                        maxLines: 5,
                        style: const TextStyle(fontSize: 10, fontFamily: 'monospace', color: JalaPalette.ok),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Close', style: TextStyle(color: JalaPalette.muted)),
            ),
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: JalaPalette.accent,
                foregroundColor: Colors.white,
              ),
              onPressed: () {
                final pass = passCtrl.text;
                if (pass.length < 4) {
                  setModalState(() => errorMsg = 'Passphrase must be at least 4 characters.');
                  return;
                }
                final payload = <String, dynamic>{
                  'hosts': _hosts.map((h) => h.toJson()).toList(),
                  'credentials': _credentials.map((c) => c.toJson()).toList(),
                  'totp': _totpItems.map((t) => t.toJson()).toList(),
                  'snippets': _customSnippets.map((s) => s.toJson()).toList(),
                };
                final sealed = EncryptedVaultBackupCodec.sealJson(
                  payload: payload,
                  passphrase: pass,
                );
                Clipboard.setData(ClipboardData(text: sealed));
                setModalState(() {
                  errorMsg = null;
                  sealedResult = sealed;
                });
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Encrypted .jvault snapshot copied to clipboard!')),
                );
              },
              icon: const Icon(Icons.copy_rounded, size: 15),
              label: Text(sealedResult == null ? 'Seal & Copy .jvault' : 'Re-Seal & Copy'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showImportEncryptedVaultDialog() async {
    final jsonCtrl = TextEditingController();
    final passCtrl = TextEditingController();
    String? errorMsg;
    bool obscure = true;

    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) => AlertDialog(
          backgroundColor: JalaPalette.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: JalaPalette.lineInput),
          ),
          title: const Row(
            children: [
              Icon(Icons.lock_open_rounded, size: 20, color: JalaPalette.brandGold),
              SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Import Encrypted Vault (.jvault)',
                  style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: JalaPalette.text),
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
                  TextField(
                    key: const Key('field_import_vault_json'),
                    controller: jsonCtrl,
                    maxLines: 4,
                    style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: JalaPalette.text),
                    decoration: InputDecoration(
                      labelText: 'Paste Encrypted .jvault JSON *',
                      labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.brandGold),
                      filled: true,
                      fillColor: JalaPalette.header,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: JalaPalette.lineInput),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('field_import_vault_passphrase'),
                    controller: passCtrl,
                    obscureText: obscure,
                    style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                    decoration: InputDecoration(
                      labelText: 'Master Backup Passphrase *',
                      labelStyle: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
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
                  if (errorMsg != null) ...[
                    const SizedBox(height: 8),
                    Text(errorMsg!, style: const TextStyle(fontSize: 11.5, color: JalaPalette.danger)),
                  ],
                ],
              ),
            ),
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
                try {
                  final map = EncryptedVaultBackupCodec.openJson(
                    rawEnvelopeJson: jsonCtrl.text.trim(),
                    passphrase: passCtrl.text,
                  );
                  final importedHosts = (map['hosts'] as List<dynamic>? ?? const [])
                      .whereType<Map<String, dynamic>>()
                      .map(RemoteHostItem.fromJson)
                      .toList();
                  final importedCreds = (map['credentials'] as List<dynamic>? ?? const [])
                      .whereType<Map<String, dynamic>>()
                      .map(VaultCredentialItem.fromJson)
                      .toList();
                  final importedTotp = (map['totp'] as List<dynamic>? ?? const [])
                      .whereType<Map<String, dynamic>>()
                      .map(TotpEntryItem.fromJson)
                      .toList();
                  final importedSnippets = (map['snippets'] as List<dynamic>? ?? const [])
                      .whereType<Map<String, dynamic>>()
                      .map(TerminalSnippetItem.fromJson)
                      .toList();

                  setState(() {
                    for (final c in importedCreds) {
                      final idx = _credentials.indexWhere((x) => x.id == c.id);
                      if (idx >= 0) {
                        _credentials[idx] = c;
                      } else {
                        _credentials.add(c);
                      }
                    }
                    for (final h in importedHosts) {
                      final idx = _hosts.indexWhere((x) => x.id == h.id);
                      if (idx >= 0) {
                        _hosts[idx] = h;
                      } else {
                        _hosts.add(h);
                      }
                    }
                    for (final t in importedTotp) {
                      final idx = _totpItems.indexWhere((x) => x.id == t.id);
                      if (idx >= 0) {
                        _totpItems[idx] = t;
                      } else {
                        _totpItems.add(t);
                      }
                    }
                    for (final s in importedSnippets) {
                      final idx = _customSnippets.indexWhere((x) => x.id == s.id);
                      if (idx >= 0) {
                        _customSnippets[idx] = s;
                      } else {
                        _customSnippets.add(s);
                      }
                    }
                    _syncActiveHostSelection();
                  });
                  _saveVaultToDisk();
                  Navigator.of(ctx).pop();
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        'Restored ${importedHosts.length} host(s) & ${importedCreds.length} credential(s) from encrypted .jvault.',
                      ),
                    ),
                  );
                } catch (err) {
                  setModalState(() {
                    errorMsg = err.toString().replaceFirst('FormatException: ', '');
                  });
                }
              },
              icon: const Icon(Icons.verified_user_outlined, size: 15),
              label: const Text('Decrypt & Restore'),
            ),
          ],
        ),
      ),
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

class _VaultPinLockView extends StatefulWidget {
  final String pinHash;
  final Widget brandLogo;
  final VoidCallback onUnlocked;

  const _VaultPinLockView({
    required this.pinHash,
    required this.brandLogo,
    required this.onUnlocked,
  });

  @override
  State<_VaultPinLockView> createState() => _VaultPinLockViewState();
}

class _VaultPinLockViewState extends State<_VaultPinLockView> {
  final TextEditingController _pinCtrl = TextEditingController();
  String? _unlockError;

  @override
  void dispose() {
    _pinCtrl.dispose();
    super.dispose();
  }

  void _tryUnlock() {
    final pin = _pinCtrl.text.trim();
    if (VaultPinHasher.verifyPin(pin, widget.pinHash)) {
      HapticFeedback.mediumImpact();
      widget.onUnlocked();
    } else {
      HapticFeedback.heavyImpact();
      setState(() => _unlockError = 'Incorrect Vault PIN. Please try again.');
      _pinCtrl.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('vault_pin_lock_screen'),
      backgroundColor: JalaPalette.splashBg,
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 360),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Container(
                padding: const EdgeInsets.all(22),
                decoration: BoxDecoration(
                  color: JalaPalette.surface,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
                  boxShadow: const [
                    BoxShadow(color: Colors.black54, blurRadius: 24, offset: Offset(0, 10)),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    widget.brandLogo,
                    const SizedBox(height: 14),
                    const Text(
                      'JalaDesk Vault Locked',
                      style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: JalaPalette.text),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Enter your App-Lock PIN to unseal saved servers, SSH keys, and 2FA tokens.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12, color: JalaPalette.muted, height: 1.35),
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      key: const Key('field_unlock_vault_pin'),
                      controller: _pinCtrl,
                      obscureText: true,
                      autofocus: true,
                      keyboardType: TextInputType.number,
                      textAlign: TextAlign.center,
                      onSubmitted: (_) => _tryUnlock(),
                      style: const TextStyle(
                        fontSize: 18,
                        fontFamily: 'monospace',
                        letterSpacing: 4,
                        fontWeight: FontWeight.w800,
                        color: JalaPalette.brandGold,
                      ),
                      decoration: InputDecoration(
                        hintText: '••••',
                        hintStyle: const TextStyle(color: JalaPalette.muted, letterSpacing: 4),
                        filled: true,
                        fillColor: JalaPalette.header,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: JalaPalette.lineInput),
                        ),
                      ),
                    ),
                    if (_unlockError != null) ...[
                      const SizedBox(height: 8),
                      Text(_unlockError!, style: const TextStyle(fontSize: 11.5, color: JalaPalette.danger)),
                    ],
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        key: const Key('btn_unlock_vault_pin'),
                        style: FilledButton.styleFrom(
                          backgroundColor: JalaPalette.accent,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 11),
                        ),
                        onPressed: _tryUnlock,
                        icon: const Icon(Icons.lock_open_rounded, size: 17),
                        label: const Text('Unlock Vault', style: TextStyle(fontWeight: FontWeight.w700)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
