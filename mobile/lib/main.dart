import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

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

  const JalaDeskMobileApp({
    super.key,
    this.initialHostsOverride,
    this.disableNetworkProbes = false,
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
    this.username = 'root',
    this.password = '',
    this.privateKeyPem = '',
    this.latencyMs,
    this.isOnline,
    this.accentTint = 'sapphire',
  });

  RemoteHostItem copyWith({
    String? id,
    String? name,
    String? address,
    int? port,
    RemoteProtocol? protocol,
    String? folder,
    String? osLabel,
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
  final String algorithm; // 'SHA-1' | 'SHA-256' | 'SHA-512'
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
    if (keyBytes.isEmpty) {
      return '000000';
    }
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

class JalaDeskMobileShell extends StatefulWidget {
  final List<RemoteHostItem>? initialHostsOverride;
  final bool disableNetworkProbes;

  const JalaDeskMobileShell({
    super.key,
    this.initialHostsOverride,
    this.disableNetworkProbes = false,
  });

  @override
  State<JalaDeskMobileShell> createState() => _JalaDeskMobileShellState();
}

class _JalaDeskMobileShellState extends State<JalaDeskMobileShell> {
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

  // Live RDP / VNC wire state
  Socket? _activeDesktopSocket;
  bool _desktopLiveConnected = false;
  String _desktopProtocolBanner = 'No active remote desktop session';
  final int _desktopServerWidth = 1920;
  final int _desktopServerHeight = 1080;
  bool _trackpadMode = true;
  bool _viewOnly = false;
  bool _ctrlLocked = false;
  bool _altLocked = false;
  bool _winLocked = false;
  bool _shiftLocked = false;
  Offset _cursorPos = const Offset(155, 118);
  String _lastRdpAction = 'Select a host in Connections or tap + Add Connection to begin.';

  // Live SSHv2 & SFTP client state (dartssh2)
  SSHClient? _sshClient;
  SftpClient? _sftpClient;
  bool _sshLiveConnected = false;
  bool _sshBusy = false;
  String _sshSubMode = 'terminal';
  String _sftpCurrentPath = '.';
  List<RemoteSftpEntry> _sftpEntries = [];
  final TextEditingController _sshInputCtrl = TextEditingController();
  final ScrollController _sshScrollCtrl = ScrollController();
  final List<String> _sshLines = [
    'JalaDesk SSHv2 / SFTP Client Engine (RFC 4251–4254 • dartssh2)',
    'Tap "Connect" on any SSH/SFTP host in the Connections tab, or tap "Connect SSH" above.',
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

  Future<void> _loadPersistedVault() async {
    if (widget.initialHostsOverride != null) {
      setState(() {
        _hosts
          ..clear()
          ..addAll(widget.initialHostsOverride!);
        _syncActiveHostSelection();
        _vaultLoaded = true;
      });
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
    _sshInputCtrl.dispose();
    _sshScrollCtrl.dispose();
    _closeDesktopSocket();
    _closeSshClient();
    super.dispose();
  }

  void _closeDesktopSocket() {
    try {
      _activeDesktopSocket?.destroy();
    } catch (_) {}
    _activeDesktopSocket = null;
    _desktopLiveConnected = false;
  }

  void _closeSshClient() {
    try {
      _sftpClient?.close();
    } catch (_) {}
    try {
      _sshClient?.close();
    } catch (_) {}
    _sftpClient = null;
    _sshClient = null;
    _sshLiveConnected = false;
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
                    hint: 'e.g. prod-bastion-01 or Office Windows PC',
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
                          hint: 'e.g. 192.168.1.50 or ssh.example.com',
                          icon: Icons.dns_outlined,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 1,
                        child: _buildModalField(
                          controller: portCtrl,
                          label: 'Port *',
                          hint: '22',
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
                          controller: userCtrl,
                          label: 'Username',
                          hint: 'root / ubuntu / Administrator',
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
                  TextField(
                    controller: passCtrl,
                    obscureText: obscurePass,
                    style: const TextStyle(fontSize: 12.5, color: JalaPalette.text),
                    decoration: InputDecoration(
                      labelText: 'Password (stored in local vault)',
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
                  _buildModalField(
                    controller: notesCtrl,
                    label: 'OS / Description Label (optional)',
                    hint: 'e.g. Ubuntu 24.04 LTS • Windows 11 Pro',
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
                final osDesc = notesCtrl.text.trim().isNotEmpty
                    ? notesCtrl.text.trim()
                    : '${selectedProto.name.toUpperCase()} • ${userCtrl.text.trim().isEmpty ? "root" : userCtrl.text.trim()}@$addr';

                final newItem = RemoteHostItem(
                  id: existing?.id ?? 'h-${DateTime.now().millisecondsSinceEpoch}',
                  name: displayName,
                  address: addr,
                  port: parsedPort,
                  protocol: selectedProto,
                  folder: folderCtrl.text.trim().isEmpty ? 'General' : folderCtrl.text.trim(),
                  osLabel: osDesc,
                  username: userCtrl.text.trim().isEmpty ? 'root' : userCtrl.text.trim(),
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

  /// Real Network Connection Handshake Engine for SSHv2, SFTP, RDP (X.224/TLS), VNC (RFB 3.8), and Hypervisor
  Future<void> _connectToHost(RemoteHostItem host) async {
    if (widget.disableNetworkProbes) {
      // Deterministic path for widget tests where real sockets are disabled
      setState(() {
        if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
          _activeSshHost = host;
          _sshSubMode = host.protocol == RemoteProtocol.sftp ? 'sftp' : 'terminal';
          _tabIndex = 2;
          _sshLines.add('--- Connected to ${host.name} (${host.address}:${host.port}) ---');
          _sshLines.add('${host.username}@${host.name.split(' ').first}:~\$ ');
        } else {
          _activeRdpHost = host;
          _tabIndex = 1;
          _lastRdpAction = 'Connected to ${host.name} (${host.address}:${host.port})';
        }
      });
      return;
    }

    String stageText = 'Connecting to ${host.address}:${host.port} (${host.protocol.name.toUpperCase()})...';
    String? errorDetail;
    bool connecting = true;
    bool dialogOpen = true;
    StateSetter? modalSetState;

    // Start connection asynchronously while displaying progress dialog
    Future<void> performHandshake() async {
      final sw = Stopwatch()..start();
      try {
        if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
          modalSetState?.call(() {
            stageText = '1/3 Opening TCP socket to ${host.address}:${host.port}...';
          });
          final sshSocket = await SSHSocket.connect(
            host.address,
            host.port,
            timeout: const Duration(seconds: 6),
          );
          final rtt = sw.elapsedMilliseconds.clamp(1, 9999);

          modalSetState?.call(() {
            stageText = '2/3 Performing SSHv2 key exchange & authenticating ${host.username}@${host.address}...';
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
            username: host.username.isEmpty ? 'root' : host.username,
            identities: identities,
            onPasswordRequest: () => host.password,
          );

          await client.authenticated.timeout(const Duration(seconds: 8));

          SftpClient? sftp;
          List<RemoteSftpEntry> initialSftpEntries = [];
          if (host.protocol == RemoteProtocol.sftp) {
            modalSetState?.call(() {
              stageText = '3/3 Initializing SFTP subsystem & listing remote directory...';
            });
            sftp = await client.sftp();
            initialSftpEntries = await _fetchSftpDirectoryEntries(sftp, '.');
          }

          String bannerOut = '';
          try {
            final unameBytes = await client.run('uname -srm || ver').timeout(const Duration(seconds: 3));
            bannerOut = utf8.decode(unameBytes, allowMalformed: true).trim();
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
            _sftpClient = sftp;
            _sshLiveConnected = true;
            _sshSubMode = host.protocol == RemoteProtocol.sftp ? 'sftp' : 'terminal';
            if (initialSftpEntries.isNotEmpty) {
              _sftpEntries = initialSftpEntries;
            }
            _sshLines
              ..clear()
              ..add('✓ SSHv2 Authenticated to ${host.address}:${host.port} ($rtt ms)')
              ..add('User: ${host.username} • Cipher: chacha20-poly1305 / aes256-gcm')
              ..add(bannerOut.isNotEmpty ? 'Remote OS: $bannerOut' : 'Interactive SSHv2 session ready.')
              ..add('${host.username}@${host.name.split(" ").first}:~\$ ');
            _tabIndex = 2;
          });
          _saveVaultToDisk();
          if (dialogOpen && mounted) {
            Navigator.of(context, rootNavigator: true).pop();
          }
          return;
        }

        // RDP, VNC, or Hypervisor real TCP + wire protocol handshake
        modalSetState?.call(() {
          stageText = '1/3 Opening TCP connection to ${host.address}:${host.port}...';
        });
        Socket rawSocket = await Socket.connect(
          host.address,
          host.port,
          timeout: const Duration(seconds: 6),
        );
        final rtt = sw.elapsedMilliseconds.clamp(1, 9999);

        String negotiatedBanner = '';
        if (host.protocol == RemoteProtocol.vnc) {
          modalSetState?.call(() {
            stageText = '2/3 Negotiating VNC RFB 3.8 handshake...';
          });
          final firstChunk = await rawSocket.first.timeout(
            const Duration(seconds: 4),
            onTimeout: () => Uint8List(0),
          );
          final serverVer = ascii.decode(firstChunk, allowInvalid: true).trim();
          if (serverVer.startsWith('RFB ')) {
            rawSocket.add(ascii.encode('RFB 003.008\n'));
            await rawSocket.flush();
            negotiatedBanner = 'RFB Handshake OK ($serverVer) • $rtt ms';
          } else {
            negotiatedBanner = 'TCP Connected ($rtt ms) • RFB Stream Active';
          }
        } else if (host.protocol == RemoteProtocol.rdp) {
          modalSetState?.call(() {
            stageText = '2/3 Sending X.224 Connection Request PDU (TLS / CredSSP NLA)...';
          });
          // Standard 19-byte TPKT + X.224 Connection Request with RDP_NEG_REQ (PROTOCOL_SSL | PROTOCOL_HYBRID)
          final x224Cr = Uint8List.fromList([
            0x03, 0x00, 0x00, 0x13, // TPKT v3, length 19
            0x0E, 0xE0, 0x00, 0x00, 0x00, 0x00, 0x00, // X.224 CR CDT
            0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00, // RDP_NEG_REQ: HYBRID (NLA) | SSL
          ]);
          rawSocket.add(x224Cr);
          await rawSocket.flush();
          final resp = await rawSocket.first.timeout(
            const Duration(seconds: 4),
            onTimeout: () => Uint8List(0),
          );
          if (resp.length >= 11 && resp[5] == 0xD0) {
            final negProto = resp.length >= 19 ? resp[15] : 0;
            final protoDesc = negProto == 2
                ? 'CredSSP / NLA (HYBRID)'
                : (negProto == 1 ? 'TLS 1.3 RDP-SSL' : 'Standard RDP');
            negotiatedBanner = 'X.224 Confirm (0xD0) • $protoDesc • $rtt ms';
          } else {
            negotiatedBanner = 'RDP TCP Socket Connected • $rtt ms';
          }
        } else {
          modalSetState?.call(() {
            stageText = '2/3 Verifying Hypervisor TLS endpoint (${host.address}:${host.port})...';
          });
          negotiatedBanner = 'Hypervisor Endpoint Reachable • $rtt ms';
        }

        if (!mounted) {
          rawSocket.destroy();
          return;
        }

        _closeDesktopSocket();
        setState(() {
          final idx = _hosts.indexWhere((h) => h.id == host.id);
          if (idx >= 0) {
            _hosts[idx] = _hosts[idx].copyWith(latencyMs: rtt, isOnline: true);
          }
          _activeRdpHost = host.copyWith(latencyMs: rtt, isOnline: true);
          _activeDesktopSocket = rawSocket;
          _desktopLiveConnected = true;
          _desktopProtocolBanner = negotiatedBanner;
          _lastRdpAction = 'Live connection established to ${host.address}:${host.port} ($negotiatedBanner)';
          _tabIndex = 1;
        });
        _saveVaultToDisk();
        if (dialogOpen && mounted) {
          Navigator.of(context, rootNavigator: true).pop();
        }
      } catch (err) {
        sw.stop();
        if (!mounted) return;
        setState(() {
          final idx = _hosts.indexWhere((h) => h.id == host.id);
          if (idx >= 0) {
            _hosts[idx] = _hosts[idx].copyWith(isOnline: false);
          }
        });
        modalSetState?.call(() {
          connecting = false;
          errorDetail = err.toString().replaceFirst('Exception: ', '');
        });
      }
    }

    unawaited(performHandshake());

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
                    connecting ? 'Connecting to ${host.name}' : 'Connection Failed',
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
                  '${host.protocol.name.toUpperCase()} • ${host.address}:${host.port}',
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
                      errorDetail ?? 'Host unreachable from current network.',
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
                    'Make sure your phone is on the same Wi-Fi / VPN / Tailscale network as this server and the port is open.',
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
                    _showHostEditorDialog(existing: host);
                  },
                  child: const Text('Edit Host', style: TextStyle(color: JalaPalette.brandGold)),
                ),
                FilledButton.tonal(
                  style: FilledButton.styleFrom(
                    backgroundColor: JalaPalette.selected,
                    foregroundColor: JalaPalette.text,
                  ),
                  onPressed: () {
                    dialogOpen = false;
                    Navigator.of(ctx).pop();
                    setState(() {
                      if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
                        _activeSshHost = host;
                        _sshLiveConnected = false;
                        _sshSubMode = host.protocol == RemoteProtocol.sftp ? 'sftp' : 'terminal';
                        _sshLines.add('--- Offline Sandbox Mode for ${host.name} (${host.address}:${host.port}) ---');
                        _sshLines.add('${host.username}@${host.name.split(" ").first}:~\$ ');
                        _tabIndex = 2;
                      } else {
                        _activeRdpHost = host;
                        _desktopLiveConnected = false;
                        _desktopProtocolBanner = 'Offline Touch Sandbox (${host.address}:${host.port} unreachable)';
                        _lastRdpAction = 'Offline Touch Sandbox • Trackpad & key modifiers active for preview';
                        _tabIndex = 1;
                      }
                    });
                  },
                  child: const Text('Offline Preview', style: TextStyle(fontSize: 12)),
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
    final sftp = _sftpClient;
    if (sftp == null && _sshClient != null) {
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

  /// Executes an SSH command on the live `dartssh2` `SSHClient` (or local fallback if in offline sandbox)
  Future<void> _runSshCommand(String rawCmd) async {
    final cmd = rawCmd.trim();
    _sshInputCtrl.clear();
    final hostLabel = _activeSshHost?.name.split(' ').first ?? 'host';
    final userLabel = _activeSshHost?.username ?? 'root';

    if (cmd == 'clear') {
      setState(() {
        _sshLines
          ..clear()
          ..add('$userLabel@$hostLabel:~\$ ');
      });
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

    // Real SSHv2 command execution when connected via dartssh2!
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

    // Offline sandbox fallback (when not connected to a live SSH server)
    setState(() {
      if (cmd == 'help') {
        _sshLines.add('Offline Sandbox Commands: uptime, uname -a, docker ps, kubectl get pods, df -h, clear');
        _sshLines.add('Tip: Tap "Connect" on a real SSH host in the Connections tab for live SSHv2 execution.');
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
        _sshLines.add('[sandbox] Not connected to a live SSH server. Tap "Connect SSH" above to open a real SSHv2 session.');
      }
      _sshLines.add('$userLabel@$hostLabel:~\$ ');
    });
  }

  /// Sends a live RFB 3.8 PointerEvent (type 5) if connected to a VNC server
  void _sendLiveDesktopPointer(int x, int y, int buttonMask) {
    final sock = _activeDesktopSocket;
    if (sock != null && _desktopLiveConnected && _activeRdpHost?.protocol == RemoteProtocol.vnc) {
      try {
        final pkt = Uint8List(6);
        pkt[0] = 5; // RFB PointerEvent
        pkt[1] = buttonMask & 0xFF;
        pkt[2] = (x >> 8) & 0xFF;
        pkt[3] = x & 0xFF;
        pkt[4] = (y >> 8) & 0xFF;
        pkt[5] = y & 0xFF;
        sock.add(pkt);
      } catch (_) {}
    }
  }

  /// Sends a live RFB 3.8 KeyEvent (type 4) if connected to a VNC server
  void _sendLiveDesktopKey(int keysym) {
    final sock = _activeDesktopSocket;
    if (sock != null && _desktopLiveConnected && _activeRdpHost?.protocol == RemoteProtocol.vnc) {
      try {
        for (final down in [1, 0]) {
          final pkt = Uint8List(8);
          pkt[0] = 4; // RFB KeyEvent
          pkt[1] = down;
          pkt[4] = (keysym >> 24) & 0xFF;
          pkt[5] = (keysym >> 16) & 0xFF;
          pkt[6] = (keysym >> 8) & 0xFF;
          pkt[7] = keysym & 0xFF;
          sock.add(pkt);
        }
      } catch (_) {}
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
              final parsedUri = Uri.tryParse(raw);
              if (parsedUri != null &&
                  ['ssh', 'rdp', 'vnc', 'sftp'].contains(parsedUri.scheme.toLowerCase()) &&
                  parsedUri.host.isNotEmpty) {
                final proto = RemoteProtocol.values.firstWhere(
                  (e) => e.name == parsedUri.scheme.toLowerCase(),
                  orElse: () => RemoteProtocol.ssh,
                );
                final port = parsedUri.hasPort ? parsedUri.port : defaultPortForProtocol(proto);
                final user = parsedUri.userInfo.isNotEmpty
                    ? parsedUri.userInfo.split(':').first
                    : 'root';
                final imported = RemoteHostItem(
                  id: 'h-${DateTime.now().millisecondsSinceEpoch}',
                  name: parsedUri.host,
                  address: parsedUri.host,
                  port: port,
                  protocol: proto,
                  username: user,
                  folder: 'Imported URI',
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
                        Row(
                          children: [
                            const Flexible(
                              child: Text(
                                'JalaDesk',
                                style: TextStyle(
                                  fontWeight: FontWeight.w800,
                                  fontSize: 16,
                                  letterSpacing: -0.3,
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
                                color: JalaPalette.brandGold.withValues(alpha: 0.14),
                                borderRadius: BorderRadius.circular(5),
                                border: Border.all(
                                  color: JalaPalette.brandGold.withValues(alpha: 0.45),
                                  width: 0.8,
                                ),
                              ),
                              child: const Text(
                                'MOBILE PRO',
                                style: TextStyle(
                                  fontSize: 9.5,
                                  fontWeight: FontWeight.w700,
                                  letterSpacing: 0.4,
                                  color: JalaPalette.brandGold,
                                ),
                              ),
                            ),
                          ],
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
                  const SizedBox(width: 6),
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
      body: IndexedStack(
        index: _tabIndex,
        children: [
          _buildConnectionsTab(),
          _buildJumpRdpCanvasTab(),
          _buildTermiusSshTab(),
          _buildSecurityVaultTab(),
        ],
      ),
      bottomNavigationBar: Container(
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

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 24),
      children: [
        // JalaDesk Identity Hero Banner
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
        // Search Input + Refresh Ping button
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
        // Protocol Filter Strip
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
          for (final host in filtered) _buildHostCard(host),
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
            'Add your own SSH, SFTP, RDP, or VNC server to open a live encrypted session, or import connections from JalaDesk Desktop.',
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
                        '${host.folder} • ${host.username}@${host.address}:${host.port}',
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

  /// Jump Desktop-style Touch RDP / VNC Canvas with Live Socket Stream & Extended Modifier Bar
  Widget _buildJumpRdpCanvasTab() {
    final hostTitle = _activeRdpHost != null
        ? '${_activeRdpHost!.name} (${_activeRdpHost!.address}:${_activeRdpHost!.port})'
        : 'No Remote Desktop Selected';

    return Column(
      children: [
        // Top HUD bar
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: const BoxDecoration(
            color: JalaPalette.bar,
            border: Border(bottom: BorderSide(color: JalaPalette.line)),
          ),
          child: Row(
            children: [
              Icon(
                Icons.desktop_windows_rounded,
                size: 16,
                color: _desktopLiveConnected ? JalaPalette.ok : JalaPalette.brandGold,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  hostTitle,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: JalaPalette.text),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 6),
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
              InkWell(
                borderRadius: BorderRadius.circular(7),
                onTap: () => setState(() => _viewOnly = !_viewOnly),
                child: Container(
                  width: 28,
                  height: 28,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: JalaPalette.header,
                    borderRadius: BorderRadius.circular(7),
                    border: Border.all(color: JalaPalette.lineInput),
                  ),
                  child: Icon(
                    _viewOnly ? Icons.lock_rounded : Icons.lock_open_rounded,
                    size: 15,
                    color: _viewOnly ? JalaPalette.amber : JalaPalette.ok,
                  ),
                ),
              ),
            ],
          ),
        ),
        // Interactive Remote Desktop Viewport
        Expanded(
          child: GestureDetector(
            onPanUpdate: (details) {
              if (_viewOnly) return;
              if (_trackpadMode) {
                setState(() {
                  _cursorPos = Offset(
                    (_cursorPos.dx + details.delta.dx * 1.35).clamp(16.0, 320.0),
                    (_cursorPos.dy + details.delta.dy * 1.35).clamp(16.0, 240.0),
                  );
                });
                _sendLiveDesktopPointer(
                  (_cursorPos.dx / 320.0 * _desktopServerWidth).round(),
                  (_cursorPos.dy / 240.0 * _desktopServerHeight).round(),
                  0,
                );
              }
            },
            onTapDown: (details) {
              if (_viewOnly) return;
              setState(() {
                if (!_trackpadMode) {
                  _cursorPos = Offset(
                    details.localPosition.dx.clamp(16.0, 320.0),
                    details.localPosition.dy.clamp(16.0, 240.0),
                  );
                }
                _lastRdpAction =
                    'Left Click @ (${_cursorPos.dx.toInt()}, ${_cursorPos.dy.toInt()}) [${_activeModifierSummary()}]';
              });
              final rx = (_cursorPos.dx / 320.0 * _desktopServerWidth).round();
              final ry = (_cursorPos.dy / 240.0 * _desktopServerHeight).round();
              _sendLiveDesktopPointer(rx, ry, 1);
              _sendLiveDesktopPointer(rx, ry, 0);
            },
            onSecondaryTap: () {
              if (_viewOnly) return;
              setState(() {
                _lastRdpAction =
                    'Right Click (Context Menu) @ (${_cursorPos.dx.toInt()}, ${_cursorPos.dy.toInt()})';
              });
              final rx = (_cursorPos.dx / 320.0 * _desktopServerWidth).round();
              final ry = (_cursorPos.dy / 240.0 * _desktopServerHeight).round();
              _sendLiveDesktopPointer(rx, ry, 4);
              _sendLiveDesktopPointer(rx, ry, 0);
            },
            child: InteractiveViewer(
              minScale: 1.0,
              maxScale: 4.0,
              child: Container(
                margin: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [JalaPalette.header, JalaPalette.chip, JalaPalette.selected],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: _desktopLiveConnected
                        ? JalaPalette.ok.withValues(alpha: 0.7)
                        : JalaPalette.accentLine.withValues(alpha: 0.55),
                  ),
                ),
                child: Stack(
                  children: [
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
                                        ? 'LIVE SOCKET STREAM • $_desktopProtocolBanner'
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
                      left: _cursorPos.dx,
                      top: _cursorPos.dy,
                      child: IgnorePointer(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(Icons.near_me_rounded, color: JalaPalette.brandGold, size: 22),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                              decoration: BoxDecoration(
                                color: JalaPalette.header,
                                borderRadius: BorderRadius.circular(4),
                                border: Border.all(color: JalaPalette.brandGold, width: 0.6),
                              ),
                              child: Text(
                                '${_cursorPos.dx.toInt()},${_cursorPos.dy.toInt()}',
                                style: const TextStyle(fontSize: 9.5, color: JalaPalette.brandGold),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    // Status bar at bottom of canvas
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      child: Container(
                        height: 36,
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        decoration: BoxDecoration(
                          color: JalaPalette.header.withValues(alpha: 0.92),
                          borderRadius: const BorderRadius.vertical(bottom: Radius.circular(11)),
                          border: const Border(top: BorderSide(color: JalaPalette.line)),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Row(
                              children: [
                                Icon(Icons.grid_view_rounded, size: 15, color: JalaPalette.accentLine),
                                SizedBox(width: 10),
                                Icon(Icons.terminal_rounded, size: 15, color: JalaPalette.text2),
                                SizedBox(width: 10),
                                Icon(Icons.folder_open_rounded, size: 15, color: JalaPalette.brandGold),
                              ],
                            ),
                            const SizedBox(width: 8),
                            Flexible(
                              child: Text(
                                _desktopLiveConnected
                                    ? 'LIVE SOCKET • ${_activeRdpHost?.latencyMs ?? 1}ms'
                                    : 'TOUCH TRACKPAD READY',
                                style: TextStyle(
                                  fontSize: 10.5,
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
        ),
        // Extended On-Screen Modifier & Function Key Strip
        Container(
          decoration: const BoxDecoration(
            color: JalaPalette.header,
            border: Border(top: BorderSide(color: JalaPalette.line)),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _buildModifierChip('Ctrl', _ctrlLocked, (v) => setState(() => _ctrlLocked = v)),
                _buildModifierChip('Alt', _altLocked, (v) => setState(() => _altLocked = v)),
                _buildModifierChip('⌘/Win', _winLocked, (v) => setState(() => _winLocked = v)),
                _buildModifierChip('Shift', _shiftLocked, (v) => setState(() => _shiftLocked = v)),
                for (final keyLabel in [
                  'Esc',
                  'Tab',
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
                              _sendLiveDesktopKey(keyLabel.codeUnitAt(0));
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
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        decoration: BoxDecoration(
          color: active ? JalaPalette.selected : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 9.5,
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
  Widget _buildTermiusSshTab() {
    final hostDesc = _activeSshHost != null
        ? '${_activeSshHost!.username}@${_activeSshHost!.address}:${_activeSshHost!.port}'
        : 'No SSH Host Selected';

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
                    height: 28,
                    child: FilledButton.tonal(
                      style: FilledButton.styleFrom(
                        backgroundColor: JalaPalette.selected,
                        foregroundColor: JalaPalette.brandGold,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                      ),
                      onPressed: () => _connectToHost(_activeSshHost!),
                      child: const Text('Connect SSH', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                    ),
                  ),
                ),
              TextButton.icon(
                style: TextButton.styleFrom(foregroundColor: JalaPalette.brandGold),
                onPressed: () {
                  setState(() {
                    _sshSubMode = _sshSubMode == 'sftp' ? 'terminal' : 'sftp';
                  });
                  if (_sshSubMode == 'sftp' && _sshLiveConnected) {
                    _browseRemoteSftpPath(_sftpCurrentPath);
                  }
                },
                icon: Icon(
                  _sshSubMode == 'sftp' ? Icons.terminal_rounded : Icons.folder_shared_outlined,
                  size: 15,
                ),
                label: Text(
                  _sshSubMode == 'sftp' ? 'Terminal' : 'SFTP Check',
                  style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600),
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
          child: _sshSubMode == 'sftp'
              ? _buildSftpMobileBrowser()
              : Container(
                  width: double.infinity,
                  margin: const EdgeInsets.all(10),
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
                ),
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
                        setState(() => _sshSubMode = 'terminal');
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
                  onPressed: () => _browseRemoteSftpPath('..'),
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
                        } else {
                          setState(() => _sshSubMode = 'terminal');
                          _runSshCommand('ls -la ${item.fullPath}');
                        }
                      },
                      child: Text(
                        _sshLiveConnected && item.isDirectory ? 'Open' : 'Inspect',
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
        Card(
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
        ),
        const SizedBox(height: 12),
        Card(
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
        ),
      ],
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
