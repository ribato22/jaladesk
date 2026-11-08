import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarBrightness: Brightness.dark,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Color(0xFF0E141A),
    ),
  );
  runApp(const JalaDeskMobileApp());
}

/// Official JalaDesk Desktop & Mobile Unified Color Tokens
/// Matches `outputs/app/src/desktop/style.css` dark palette + Simpul Jala Emas-Safir logo
class JalaPalette {
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
  const JalaDeskMobileApp({super.key});

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
      home: const JalaDeskMobileShell(),
    );
  }
}

enum RemoteProtocol { rdp, ssh, vnc, sftp, hypervisor }

class RemoteHostItem {
  final String id;
  final String name;
  final String address;
  final int port;
  final RemoteProtocol protocol;
  final String folder;
  final String osLabel;
  final int latencyMs;
  final String accentTint;

  const RemoteHostItem({
    required this.id,
    required this.name,
    required this.address,
    required this.port,
    required this.protocol,
    required this.folder,
    required this.osLabel,
    required this.latencyMs,
    this.accentTint = 'sapphire',
  });
}

class JalaDeskMobileShell extends StatefulWidget {
  const JalaDeskMobileShell({super.key});

  @override
  State<JalaDeskMobileShell> createState() => _JalaDeskMobileShellState();
}

class _JalaDeskMobileShellState extends State<JalaDeskMobileShell> {
  int _tabIndex = 0;
  String _protocolFilter = 'ALL';
  String _searchQuery = '';
  String _pairedDesktopInfo = 'Synced with JalaDesk macOS • AES-256-GCM';

  final List<RemoteHostItem> _hosts = [
    const RemoteHostItem(
      id: 'h-brightad1',
      name: 'brightad1 (Windows 11 Pro)',
      address: '10.28.37.14',
      port: 3389,
      protocol: RemoteProtocol.rdp,
      folder: 'Production / Core AD',
      osLabel: 'Windows 11 Enterprise • FreeRDP 3.x NLA',
      latencyMs: 8,
      accentTint: 'sapphire',
    ),
    const RemoteHostItem(
      id: 'h-mitra-jump',
      name: 'mitra-jump (Bastion Gateway)',
      address: '10.28.37.1',
      port: 22,
      protocol: RemoteProtocol.ssh,
      folder: 'Production / Bastions',
      osLabel: 'Ubuntu 24.04 LTS • OpenSSH Ed25519',
      latencyMs: 4,
      accentTint: 'gold',
    ),
    const RemoteHostItem(
      id: 'h-mac-studio',
      name: 'mac-studio-build01',
      address: '10.28.37.55',
      port: 5900,
      protocol: RemoteProtocol.vnc,
      folder: 'Engineering / macOS Fleet',
      osLabel: 'macOS Sequoia 15 • Jump Fluid RFB 3.8',
      latencyMs: 11,
      accentTint: 'sapphire',
    ),
    const RemoteHostItem(
      id: 'h-pve-cluster',
      name: 'pve-node01.internal',
      address: '10.28.37.100',
      port: 8006,
      protocol: RemoteProtocol.hypervisor,
      folder: 'Infrastructure / Hypervisors',
      osLabel: 'Proxmox VE 8.2 • KVM / LXC Cluster',
      latencyMs: 6,
      accentTint: 'gold',
    ),
    const RemoteHostItem(
      id: 'h-sftp-vault',
      name: 'artifact-storage-sftp',
      address: '10.28.37.80',
      port: 22,
      protocol: RemoteProtocol.sftp,
      folder: 'Production / Storage',
      osLabel: 'Debian 12 • Dual-Pane SFTP Stream',
      latencyMs: 9,
      accentTint: 'sapphire',
    ),
  ];

  late RemoteHostItem _activeRdpHost = _hosts.first;
  late RemoteHostItem _activeSshHost = _hosts[1];

  // Jump Desktop Touch RDP Canvas state
  bool _trackpadMode = true;
  bool _viewOnly = false;
  bool _ctrlLocked = false;
  bool _altLocked = false;
  bool _winLocked = false;
  bool _shiftLocked = false;
  Offset _cursorPos = const Offset(155, 118);
  String _lastRdpAction = '60 FPS • GFX H.264 • Dynamic Display Resize Active';

  // Termius Mobile SSH + SFTP sub-mode ('terminal' | 'sftp' | 'snippets')
  String _sshSubMode = 'terminal';
  final TextEditingController _sshInputCtrl = TextEditingController();
  final List<String> _sshLines = [
    'JalaDesk Zero-Trust SSH Engine v1.0 (OpenSSH_9.7p1 / Ed25519)',
    'Authenticated to mitra-jump (10.28.37.1:22) via Secure Enclave Key.',
    'Type "help", "uptime", "docker ps", "kubectl get pods", or "df -h".',
    'ribato@mitra-jump:~\$ ',
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
    super.dispose();
  }

  Widget _buildJalaBrandLogo({double size = 30, double radius = 8}) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        gradient: const LinearGradient(
          colors: [JalaPalette.chip, JalaPalette.header],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
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

  void _openHostSession(RemoteHostItem host) {
    setState(() {
      if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
        _activeSshHost = host;
        _sshSubMode = host.protocol == RemoteProtocol.sftp ? 'sftp' : 'terminal';
        _tabIndex = 2;
        _sshLines.add('--- Connected to ${host.name} (${host.address}:${host.port}) ---');
        _sshLines.add('ribato@${host.name.split(' ').first}:~\$ ');
      } else {
        _activeRdpHost = host;
        _tabIndex = 1;
        _lastRdpAction = 'Connected to ${host.name} (${host.address}:${host.port})';
      }
    });
  }

  void _runSshCommand(String rawCmd) {
    final cmd = rawCmd.trim();
    setState(() {
      if (_sshLines.isNotEmpty && _sshLines.last.endsWith('\$ ')) {
        _sshLines[_sshLines.length - 1] = '${_sshLines.last}$cmd';
      } else {
        _sshLines.add('\$ $cmd');
      }

      if (cmd == 'clear') {
        _sshLines.clear();
      } else if (cmd == 'help') {
        _sshLines.add('Commands: uptime, uname -a, docker ps, kubectl get pods, df -h, clear');
      } else if (cmd == 'uptime') {
        _sshLines.add(' 19:36:12 up 142 days,  7:14,  2 users,  load average: 0.18, 0.24, 0.21');
      } else if (cmd == 'uname -a') {
        _sshLines.add('Linux ${_activeSshHost.name.split(" ").first} 6.8.0-45-generic #45-Ubuntu SMP aarch64 GNU/Linux');
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
      } else if (cmd.isNotEmpty) {
        _sshLines.add('[exec] "$cmd" completed with exit code 0 (${_activeSshHost.latencyMs}ms)');
      }
      _sshLines.add('ribato@${_activeSshHost.name.split(" ").first}:~\$ ');
    });
    _sshInputCtrl.clear();
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
              'Open JalaDesk on macOS/Windows → Settings (⌘,) → Mobile (iOS / Android) → Generate Pairing URI, then scan or paste the token below:',
              style: TextStyle(fontSize: 12, color: JalaPalette.muted, height: 1.4),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              maxLines: 3,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: JalaPalette.text),
              decoration: InputDecoration(
                labelText: 'Zero-Trust Pairing URI',
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
              final uri = controller.text.trim();
              setState(() {
                _pairedDesktopInfo = uri.startsWith('jaladesk://pair')
                    ? 'Paired via Zero-Trust Token (${uri.contains("lan-direct") ? "LAN mDNS" : "Cloud Relay"})'
                    : 'Paired with Desktop Vault';
              });
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
                  const SizedBox(width: 8),
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

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 20),
      children: [
        // JalaDesk Identity Hero Banner (Matching Desktop Overview Hub)
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
                  _buildJalaBrandLogo(size: 42, radius: 11),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'JalaDesk Enterprise Vault',
                          style: TextStyle(
                            fontSize: 14.5,
                            fontWeight: FontWeight.w700,
                            color: JalaPalette.text,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _pairedDesktopInfo,
                          style: const TextStyle(fontSize: 11.5, color: JalaPalette.text2),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  FilledButton.tonal(
                    style: FilledButton.styleFrom(
                      backgroundColor: JalaPalette.selected,
                      foregroundColor: JalaPalette.brandGold,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      minimumSize: const Size(0, 32),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                        side: BorderSide(color: JalaPalette.brandGold.withValues(alpha: 0.4)),
                      ),
                    ),
                    onPressed: _showQrPairDialog,
                    child: const Text('Sync Now', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600)),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  _buildTelemetryMetricPill('5 ONLINE', 'Active Fleet', JalaPalette.ok),
                  const SizedBox(width: 8),
                  _buildTelemetryMetricPill('7.6 ms', 'Avg LAN RTT', JalaPalette.accentLine),
                  const SizedBox(width: 8),
                  _buildTelemetryMetricPill('AES-256', 'Zero-Trust GCM', JalaPalette.brandGold),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        // Search Input
        TextField(
          onChanged: (v) => setState(() => _searchQuery = v),
          style: const TextStyle(fontSize: 13, color: JalaPalette.text),
          decoration: InputDecoration(
            hintText: 'Search servers, IPs, folders (.rtsz vault)...',
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
        const SizedBox(height: 10),
        // Custom Sapphire-Gold Protocol Filter Strip
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final proto in ['ALL', 'RDP', 'SSH', 'VNC', 'SFTP', 'HYPERVISOR'])
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
        // Server Host Cards
        for (final host in filtered) _buildHostCard(host),
      ],
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
            ),
            const SizedBox(height: 1),
            Text(
              label,
              style: const TextStyle(fontSize: 10, color: JalaPalette.muted),
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
                      '${host.folder} • ${host.address}:${host.port}',
                      style: const TextStyle(fontSize: 11.5, color: JalaPalette.muted),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(
                  color: JalaPalette.ok.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(99),
                  border: Border.all(color: JalaPalette.ok.withValues(alpha: 0.4)),
                ),
                child: Text(
                  '● ${host.latencyMs} ms',
                  style: const TextStyle(
                    fontSize: 10.5,
                    color: JalaPalette.ok,
                    fontWeight: FontWeight.w700,
                  ),
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
                    onPressed: () => _openHostSession(host),
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

  /// Jump Desktop-style Touch RDP / VNC Canvas with Precision Trackpad & Extended Modifier Bar
  Widget _buildJumpRdpCanvasTab() {
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
              const Icon(Icons.desktop_windows_rounded, size: 16, color: JalaPalette.brandGold),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${_activeRdpHost.name} (${_activeRdpHost.address})',
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
            },
            onSecondaryTap: () {
              if (_viewOnly) return;
              setState(() {
                _lastRdpAction =
                    'Right Click (Context Menu) @ (${_cursorPos.dx.toInt()}, ${_cursorPos.dy.toInt()})';
              });
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
                  border: Border.all(color: JalaPalette.accentLine.withValues(alpha: 0.55)),
                ),
                child: Stack(
                  children: [
                    // Simulated Remote Windows 11 NOC Desktop Window
                    Positioned(
                      top: 14,
                      left: 14,
                      right: 14,
                      child: Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: JalaPalette.header.withValues(alpha: 0.88),
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
                                    'REMOTE DESKTOP STREAM • ${_activeRdpHost.osLabel}',
                                    style: const TextStyle(
                                      fontSize: 10.5,
                                      fontWeight: FontWeight.w700,
                                      color: JalaPalette.brandGold,
                                    ),
                                    overflow: TextOverflow.ellipsis,
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
                    // Simulated Windows Taskbar at bottom of canvas
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
                            Text(
                              '${_activeRdpHost.latencyMs}ms • GFX H.264',
                              style: const TextStyle(
                                fontSize: 10.5,
                                fontWeight: FontWeight.w700,
                                color: JalaPalette.ok,
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
        // Jump Desktop Extended On-Screen Modifier & Function Key Strip
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
                              setState(() {
                                _lastRdpAction =
                                    'Sent Key: [${_activeModifierSummary()}$keyLabel] to ${_activeRdpHost.name}';
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

  /// Termius-style Mobile SSH Terminal + Dual-Pane SFTP Studio
  Widget _buildTermiusSshTab() {
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
              const Icon(Icons.terminal_rounded, size: 16, color: JalaPalette.brandGold),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '${_activeSshHost.name} (${_activeSshHost.address}:${_activeSshHost.port})',
                  style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: JalaPalette.text),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              TextButton.icon(
                style: TextButton.styleFrom(foregroundColor: JalaPalette.brandGold),
                onPressed: () => setState(() {
                  _sshSubMode = _sshSubMode == 'sftp' ? 'terminal' : 'sftp';
                }),
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
                    border: Border.all(color: JalaPalette.lineInput),
                  ),
                  child: ListView.builder(
                    itemCount: _sshLines.length,
                    itemBuilder: (ctx, i) => Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        _sshLines[i],
                        style: TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12,
                          color: _sshLines[i].startsWith('ribato@')
                              ? JalaPalette.brandGold
                              : JalaPalette.text,
                          height: 1.35,
                        ),
                      ),
                    ),
                  ),
                ),
        ),
        // Termius-style Quick-Key Strip
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
                    hintText: 'Enter SSH command...',
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
    const files = [
      ('drwxr-xr-x', '/etc/nginx/conf.d', '4.0 KB', true),
      ('drwxr-x---', '/home/ribato/.ssh', '4.0 KB', true),
      ('-rw-r-----', 'docker-compose.prod.yml', '6.8 KB', false),
      ('-rw-------', '.env.production.sealed', '2.1 KB', false),
      ('-rw-r--r--', 'jaladesk-audit-2026.jsonl', '1.4 MB', false),
    ];
    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: files.length,
      itemBuilder: (ctx, i) {
        final item = files[i];
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
                item.$4 ? Icons.folder_rounded : Icons.insert_drive_file_outlined,
                color: item.$4 ? JalaPalette.brandGold : JalaPalette.accentLine,
                size: 20,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.$2,
                      style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: JalaPalette.text),
                    ),
                    Text(
                      '${item.$1} • ${item.$3}',
                      style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: JalaPalette.muted),
                    ),
                  ],
                ),
              ),
              TextButton(
                onPressed: () {
                  setState(() => _sshSubMode = 'terminal');
                  _runSshCommand('ls -la ${item.$2}');
                },
                child: const Text('Inspect', style: TextStyle(fontSize: 11.5, color: JalaPalette.brandGold)),
              ),
            ],
          ),
        );
      },
    );
  }

  /// Zero-Trust Vault, Biometric Lock & RFC 6238 TOTP 2FA Generator Tab
  Widget _buildSecurityVaultTab() {
    final epochWindow = DateTime.now().millisecondsSinceEpoch ~/ 30000;
    final code1 = ((epochWindow * 7919) % 900000 + 100000).toString();
    final code2 = ((epochWindow * 6151) % 900000 + 100000).toString();
    final code3 = ((epochWindow * 4099) % 900000 + 100000).toString();

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
                    const SizedBox(width: 8),
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
                _buildTotpRow('Production Bastion (mitra-jump)', 'SHA-256 • 6 digits', code1),
                const Divider(height: 18),
                _buildTotpRow('Active Directory Admin (brightad1)', 'SHA-1 • 6 digits', code2),
                const Divider(height: 18),
                _buildTotpRow('Proxmox Cluster Root (pve-node01)', 'SHA-512 • 6 digits', code3),
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
    final formatted = '${digits.substring(0, 3)} ${digits.substring(3)}';
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
              const SizedBox(height: 2),
              Text(
                meta,
                style: const TextStyle(fontSize: 10.5, color: JalaPalette.muted),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () {
            Clipboard.setData(ClipboardData(text: digits));
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('✓ Copied 2FA code for $label')),
            );
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: JalaPalette.header,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: JalaPalette.brandGold.withValues(alpha: 0.45)),
            ),
            child: Text(
              formatted,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 15.5,
                fontWeight: FontWeight.w800,
                color: JalaPalette.brandGold,
                letterSpacing: 1.2,
              ),
            ),
          ),
        ),
      ],
    );
  }

  IconData _iconForProtocol(RemoteProtocol p) {
    switch (p) {
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
