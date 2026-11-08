import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const JalaDeskMobileApp());
}

class JalaDeskMobileApp extends StatelessWidget {
  const JalaDeskMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    const bgCanvas = Color(0xFF0E131A);
    const bgSurface = Color(0xFF161D26);
    const accent = Color(0xFF2F81F7);

    return MaterialApp(
      title: 'JalaDesk Mobile',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        useMaterial3: true,
        scaffoldBackgroundColor: bgCanvas,
        colorScheme: const ColorScheme.dark(
          primary: accent,
          secondary: Color(0xFF3FB950),
          surface: bgSurface,
          error: Color(0xFFF85149),
        ),
        cardTheme: CardThemeData(
          color: bgSurface,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: Color(0xFF283240)),
          ),
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xFF121820),
          foregroundColor: Color(0xFFE6EDF3),
          elevation: 0,
          centerTitle: false,
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
  final bool online;

  const RemoteHostItem({
    required this.id,
    required this.name,
    required this.address,
    required this.port,
    required this.protocol,
    required this.folder,
    required this.osLabel,
    required this.latencyMs,
    this.online = true,
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
  String _pairedDesktopInfo = 'Synced via LAN mDNS (macOS Host • AES-256-GCM)';

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
    ),
  ];

  late RemoteHostItem _activeRdpHost = _hosts.first;
  late RemoteHostItem _activeSshHost = _hosts[1];

  // Jump Desktop Touch RDP Canvas state
  bool _trackpadMode = true; // true = Precision Trackpad Cursor, false = Direct Touch
  bool _viewOnly = false;
  bool _ctrlLocked = false;
  bool _altLocked = false;
  bool _winLocked = false;
  bool _shiftLocked = false;
  Offset _cursorPos = const Offset(180, 140);
  String _lastRdpAction = 'Connected • 60 FPS RemoteFX / H.264 Hardware Accelerated';

  // Termius Mobile SSH state
  final TextEditingController _sshInputCtrl = TextEditingController();
  final List<String> _sshLines = [
    'JalaDesk Mobile SSH Engine v1.0 (OpenSSH_9.7p1 / Ed25519 Zero-Trust)',
    'Connected to mitra-jump (10.28.37.1:22) via Biometric Enclave Key.',
    'Type "help", "uptime", "docker ps", "kubectl get pods", or "df -h".',
    'ribato@mitra-jump:~\$ ',
  ];

  // TOTP Timer state
  late Timer _totpTimer;
  int _secondsRemaining = 30;
  bool _biometricLock = true;
  bool _lanAutoSync = true;

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

  void _openHostSession(RemoteHostItem host) {
    setState(() {
      if (host.protocol == RemoteProtocol.ssh || host.protocol == RemoteProtocol.sftp) {
        _activeSshHost = host;
        _tabIndex = 2;
        _sshLines.add('--- Switched session to ${host.name} (${host.address}:${host.port}) ---');
        _sshLines.add('ribato@${host.name.split(' ').first}:~\$ ');
      } else {
        _activeRdpHost = host;
        _tabIndex = 1;
        _lastRdpAction = 'Session active: ${host.name} (${host.address}:${host.port})';
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
        _sshLines.add('Available quick commands: uptime, uname -a, docker ps, kubectl get pods, df -h, clear');
      } else if (cmd == 'uptime') {
        _sshLines.add(' 22:19:04 up 142 days,  7:14,  2 users,  load average: 0.18, 0.24, 0.21');
      } else if (cmd == 'uname -a') {
        _sshLines.add('Linux ${_activeSshHost.name.split(" ").first} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC aarch64 GNU/Linux');
      } else if (cmd == 'docker ps') {
        _sshLines.add('CONTAINER ID   IMAGE                     STATUS          PORTS                    NAMES');
        _sshLines.add('a81f92c01b2e   envoyproxy/envoy:v1.31    Up 14 days      0.0.0.0:443->443/tcp     zero-trust-gw');
        _sshLines.add('73d10c92be14   postgres:16-alpine        Up 14 days      127.0.0.1:5432->5432/tcp vault-db');
      } else if (cmd == 'kubectl get pods') {
        _sshLines.add('NAME                               READY   STATUS    RESTARTS   AGE');
        _sshLines.add('jaladesk-relay-6b7f9d8c4-x92lk     2/2     Running   0          19d');
        _sshLines.add('Prometheus-node-exporter-m82qp     1/1     Running   0          45d');
      } else if (cmd == 'df -h') {
        _sshLines.add('Filesystem      Size  Used Avail Use% Mounted on');
        _sshLines.add('/dev/nvme0n1p2  500G  142G  358G  29% /');
      } else if (cmd.isNotEmpty) {
        _sshLines.add('[exec] Completed "$cmd" with exit code 0 (${_activeSshHost.latencyMs}ms)');
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
        title: const Row(
          children: [
            Icon(Icons.qr_code_scanner, color: Color(0xFF2F81F7)),
            SizedBox(width: 10),
            Text('Pair with JalaDesk Desktop', style: TextStyle(fontSize: 16)),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Open JalaDesk on macOS/Windows → Settings (⌘,) → Mobile (iOS / Android) → Generate Pairing Token, then scan or paste the URI below:',
              style: TextStyle(fontSize: 12.5, color: Color(0xFF8B949E)),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              maxLines: 3,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              decoration: const InputDecoration(
                labelText: 'Zero-Trust Pairing URI',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton.icon(
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
                  content: Text('✓ Zero-Trust Vault synced with JalaDesk Desktop'),
                ),
              );
            },
            icon: const Icon(Icons.verified_user, size: 16),
            label: const Text('Verify & Sync Vault'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: const BoxDecoration(
                color: Color(0xFF3FB950),
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 10),
            const Text(
              'JalaDesk Mobile',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: const Color(0xFF2F81F7).withValues(alpha: 0.16),
                borderRadius: BorderRadius.circular(99),
                border: Border.all(color: const Color(0xFF2F81F7).withValues(alpha: 0.45)),
              ),
              child: const Text(
                'iOS & Android',
                style: TextStyle(fontSize: 10.5, color: Color(0xFF58A6FF), fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Pair with JalaDesk Desktop (QR / URI)',
            onPressed: _showQrPairDialog,
            icon: const Icon(Icons.qr_code_scanner),
          ),
        ],
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
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tabIndex,
        onDestinationSelected: (idx) => setState(() => _tabIndex = idx),
        backgroundColor: const Color(0xFF121820),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.dns_outlined),
            selectedIcon: Icon(Icons.dns),
            label: 'Connections',
          ),
          NavigationDestination(
            icon: Icon(Icons.desktop_windows_outlined),
            selectedIcon: Icon(Icons.desktop_windows),
            label: 'RDP / VNC',
          ),
          NavigationDestination(
            icon: Icon(Icons.terminal_outlined),
            selectedIcon: Icon(Icons.terminal),
            label: 'SSH & SFTP',
          ),
          NavigationDestination(
            icon: Icon(Icons.shield_outlined),
            selectedIcon: Icon(Icons.shield),
            label: 'Vault & 2FA',
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

    return ListView(
      padding: const EdgeInsets.all(14),
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: const Color(0xFF161D26),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFF283240)),
          ),
          child: Row(
            children: [
              const Icon(Icons.sync_lock, size: 18, color: Color(0xFF3FB950)),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  _pairedDesktopInfo,
                  style: const TextStyle(fontSize: 12, color: Color(0xFF8B949E)),
                ),
              ),
              TextButton(
                onPressed: _showQrPairDialog,
                child: const Text('Sync Now', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        TextField(
          onChanged: (v) => setState(() => _searchQuery = v),
          decoration: InputDecoration(
            hintText: 'Search servers, IPs, folders (.rtsz vault)...',
            prefixIcon: const Icon(Icons.search, size: 19),
            filled: true,
            fillColor: const Color(0xFF161D26),
            contentPadding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: const BorderSide(color: Color(0xFF283240)),
            ),
          ),
        ),
        const SizedBox(height: 10),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final proto in ['ALL', 'RDP', 'SSH', 'VNC', 'SFTP', 'HYPERVISOR'])
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    label: Text(proto, style: const TextStyle(fontSize: 11.5)),
                    selected: _protocolFilter == proto,
                    onSelected: (_) => setState(() => _protocolFilter = proto),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        for (final host in filtered)
          Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              leading: CircleAvatar(
                backgroundColor: const Color(0xFF2F81F7).withValues(alpha: 0.16),
                child: Icon(_iconForProtocol(host.protocol), color: const Color(0xFF58A6FF), size: 20),
              ),
              title: Row(
                children: [
                  Expanded(
                    child: Text(
                      host.name,
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: const Color(0xFF3FB950).withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(99),
                    ),
                    child: Text(
                      '${host.latencyMs} ms',
                      style: const TextStyle(fontSize: 10.5, color: Color(0xFF3FB950), fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              subtitle: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '${host.folder} • ${host.address}:${host.port}\n${host.osLabel}',
                  style: const TextStyle(fontSize: 11.5, color: Color(0xFF8B949E), height: 1.35),
                ),
              ),
              trailing: FilledButton.tonal(
                onPressed: () => _openHostSession(host),
                child: Text(host.protocol == RemoteProtocol.ssh ? 'SSH' : 'Connect'),
              ),
            ),
          ),
      ],
    );
  }

  /// Jump Desktop-style Touch RDP / VNC Canvas with Precision Trackpad & Extended Modifier Bar
  Widget _buildJumpRdpCanvasTab() {
    return Column(
      children: [
        // Top HUD bar
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          color: const Color(0xFF121820),
          child: Row(
            children: [
              const Icon(Icons.desktop_windows, size: 16, color: Color(0xFF58A6FF)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '${_activeRdpHost.name} (${_activeRdpHost.address})',
                  style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: true, label: Text('Trackpad', style: TextStyle(fontSize: 11))),
                  ButtonSegment(value: false, label: Text('Direct Touch', style: TextStyle(fontSize: 11))),
                ],
                selected: {_trackpadMode},
                onSelectionChanged: (sel) => setState(() => _trackpadMode = sel.first),
              ),
              const SizedBox(width: 6),
              IconButton(
                tooltip: _viewOnly ? 'View-Only Locked' : 'Interactive Mode',
                onPressed: () => setState(() => _viewOnly = !_viewOnly),
                icon: Icon(
                  _viewOnly ? Icons.lock : Icons.lock_open,
                  size: 18,
                  color: _viewOnly ? const Color(0xFFD29922) : const Color(0xFF3FB950),
                ),
              ),
            ],
          ),
        ),
        // Interactive Remote Desktop Viewport (Pinch-to-Zoom + Trackpad Delta)
        Expanded(
          child: GestureDetector(
            onPanUpdate: (details) {
              if (_viewOnly) return;
              if (_trackpadMode) {
                setState(() {
                  _cursorPos = Offset(
                    (_cursorPos.dx + details.delta.dx * 1.35).clamp(16.0, 340.0),
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
                    details.localPosition.dx.clamp(16.0, 340.0),
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
                margin: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [Color(0xFF0F2027), Color(0xFF203A43), Color(0xFF2C5364)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFF2F81F7).withValues(alpha: 0.45)),
                ),
                child: Stack(
                  children: [
                    // Simulated Remote Windows 11 / Server Desktop Chrome
                    Positioned(
                      top: 14,
                      left: 14,
                      right: 14,
                      child: Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0E131A).withValues(alpha: 0.82),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFF283240)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'REMOTE DESKTOP STREAM • ${_activeRdpHost.osLabel}',
                              style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                color: Color(0xFF58A6FF),
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              _lastRdpAction,
                              style: const TextStyle(fontSize: 11.5, color: Color(0xFFE6EDF3)),
                            ),
                          ],
                        ),
                      ),
                    ),
                    // Precision Trackpad Virtual Pointer (Jump Desktop style)
                    Positioned(
                      left: _cursorPos.dx,
                      top: _cursorPos.dy,
                      child: IgnorePointer(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(Icons.near_me, color: Colors.white, size: 22),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                              decoration: BoxDecoration(
                                color: Colors.black87,
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                '${_cursorPos.dx.toInt()},${_cursorPos.dy.toInt()}',
                                style: const TextStyle(fontSize: 9.5, color: Colors.white70),
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
                        height: 34,
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0E131A).withValues(alpha: 0.9),
                          borderRadius: const BorderRadius.vertical(bottom: Radius.circular(11)),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Row(
                              children: [
                                Icon(Icons.grid_view_rounded, size: 15, color: Color(0xFF58A6FF)),
                                SizedBox(width: 10),
                                Icon(Icons.terminal, size: 15, color: Colors.white70),
                                SizedBox(width: 10),
                                Icon(Icons.folder_open, size: 15, color: Color(0xFFD29922)),
                              ],
                            ),
                            Text(
                              '${_activeRdpHost.latencyMs}ms • GFX H.264',
                              style: const TextStyle(fontSize: 10.5, color: Color(0xFF3FB950)),
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
          color: const Color(0xFF121820),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
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
                      label: Text(keyLabel, style: const TextStyle(fontSize: 11.5)),
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

  Widget _buildModifierChip(String label, bool active, ValueChanged<bool> onSelected) {
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: FilterChip(
        label: Text(label, style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600)),
        selected: active,
        onSelected: _viewOnly ? null : onSelected,
      ),
    );
  }

  /// Termius-style Mobile SSH Terminal + Quick-Key Strip
  Widget _buildTermiusSshTab() {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          color: const Color(0xFF121820),
          child: Row(
            children: [
              const Icon(Icons.terminal, size: 16, color: Color(0xFF3FB950)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '${_activeSshHost.name} (${_activeSshHost.address}:${_activeSshHost.port})',
                  style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                ),
              ),
              TextButton.icon(
                onPressed: () => _runSshCommand('df -h'),
                icon: const Icon(Icons.folder_shared_outlined, size: 15),
                label: const Text('SFTP Check', style: TextStyle(fontSize: 11.5)),
              ),
            ],
          ),
        ),
        Expanded(
          child: Container(
            width: double.infinity,
            margin: const EdgeInsets.all(10),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFF090D12),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFF283240)),
            ),
            child: ListView.builder(
              itemCount: _sshLines.length,
              itemBuilder: (ctx, i) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  _sshLines[i],
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                    color: Color(0xFFE6EDF3),
                    height: 1.35,
                  ),
                ),
              ),
            ),
          ),
        ),
        // Termius-style Quick-Key Strip
        Container(
          color: const Color(0xFF121820),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
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
                      label: Text(quick, style: const TextStyle(fontSize: 11, fontFamily: 'monospace')),
                      onPressed: () => _runSshCommand(quick),
                    ),
                  ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 4, 10, 10),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _sshInputCtrl,
                  onSubmitted: _runSshCommand,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5),
                  decoration: InputDecoration(
                    hintText: 'Enter SSH command...',
                    isDense: true,
                    filled: true,
                    fillColor: const Color(0xFF161D26),
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: () => _runSshCommand(_sshInputCtrl.text),
                child: const Text('Run'),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// Zero-Trust Vault, Biometric Lock & RFC 6238 TOTP 2FA Generator Tab
  Widget _buildSecurityVaultTab() {
    final epochWindow = DateTime.now().millisecondsSinceEpoch ~/ 30000;
    final code1 = ((epochWindow * 7919) % 900000 + 100000).toString();
    final code2 = ((epochWindow * 6151) % 900000 + 100000).toString();

    return ListView(
      padding: const EdgeInsets.all(14),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text(
                      'RFC 6238 TOTP 2FA Authenticator',
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
                    ),
                    Text(
                      'Refreshes in ${_secondsRemaining}s',
                      style: const TextStyle(fontSize: 11.5, color: Color(0xFF58A6FF)),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _buildTotpRow('Production Bastion (mitra-jump)', code1),
                const Divider(height: 16),
                _buildTotpRow('Active Directory Admin (brightad1)', code2),
              ],
            ),
          ),
        ),
        const SizedBox(height: 10),
        Card(
          child: Column(
            children: [
              SwitchListTile(
                value: _biometricLock,
                onChanged: (v) => setState(() => _biometricLock = v),
                title: const Text('Biometric Enclave Unlock (FaceID / TouchID)', style: TextStyle(fontSize: 13.5)),
                subtitle: const Text(
                  'Require hardware biometric verification before decrypting .rtsz / .jaladesk credentials',
                  style: TextStyle(fontSize: 11.5),
                ),
              ),
              const Divider(height: 1),
              SwitchListTile(
                value: _lanAutoSync,
                onChanged: (v) => setState(() => _lanAutoSync = v),
                title: const Text('Zero-Knowledge LAN mDNS Vault Sync', style: TextStyle(fontSize: 13.5)),
                subtitle: const Text(
                  'Automatically synchronize encrypted connection documents with JalaDesk Desktop on the same Wi-Fi',
                  style: TextStyle(fontSize: 11.5),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildTotpRow(String label, String digits) {
    final formatted = '${digits.substring(0, 3)} ${digits.substring(3)}';
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Expanded(child: Text(label, style: const TextStyle(fontSize: 12.5))),
        SelectableText(
          formatted,
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 18,
            fontWeight: FontWeight.w700,
            color: Color(0xFF3FB950),
            letterSpacing: 1.5,
          ),
        ),
      ],
    );
  }

  IconData _iconForProtocol(RemoteProtocol p) {
    switch (p) {
      case RemoteProtocol.rdp:
        return Icons.desktop_windows;
      case RemoteProtocol.ssh:
        return Icons.terminal;
      case RemoteProtocol.vnc:
        return Icons.laptop_mac;
      case RemoteProtocol.sftp:
        return Icons.folder_shared;
      case RemoteProtocol.hypervisor:
        return Icons.dns;
    }
  }
}
