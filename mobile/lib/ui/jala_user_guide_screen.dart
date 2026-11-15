import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'jala_enterprise_components.dart';

const Color _kGuideCanvas = Color(0xFF090E17);
const Color _kGuideHeaderBg = JalaEnterpriseTokens.headerBg; // #0D141F
const Color _kGuideCardBg = JalaEnterpriseTokens.dialogSurface; // #141D29
const Color _kGuideCardBorder = Color(0xFF26364A);
const Color _kGuidePillBg = JalaEnterpriseTokens.footerBg; // #0A1018
const Color _kGuideAccentBlue = Color(0xFF58A6FF);
const Color _kGuideGold = Color(0xFFF3C66F);
const Color _kGuideOk = Color(0xFF7AD9A0);
const Color _kGuidePurple = Color(0xFFB392F0);
const Color _kGuideCyan = Color(0xFF63D2DC);

class _GuideChipSpec {
  final IconData icon;
  final String label;
  final String detail;

  const _GuideChipSpec({
    required this.icon,
    required this.label,
    required this.detail,
  });
}

class _GuideBulletSpec {
  final String title;
  final String body;

  const _GuideBulletSpec({
    required this.title,
    required this.body,
  });
}

class _GuideSectionData {
  final String id;
  final IconData icon;
  final Color accent;
  final String categoryLabel;
  final String title;
  final String summary;
  final List<_GuideBulletSpec> bullets;
  final List<_GuideChipSpec> callouts;

  const _GuideSectionData({
    required this.id,
    required this.icon,
    required this.accent,
    required this.categoryLabel,
    required this.title,
    required this.summary,
    required this.bullets,
    this.callouts = const <_GuideChipSpec>[],
  });

  bool matchesQuery(String rawQuery) {
    final q = rawQuery.trim().toLowerCase();
    if (q.isEmpty) return true;
    final haystack = <String>[
      categoryLabel,
      title,
      summary,
      for (final b in bullets) ...[b.title, b.body],
      for (final c in callouts) ...[c.label, c.detail],
    ].join(' ').toLowerCase();
    return haystack.contains(q);
  }
}

const List<_GuideSectionData> _kGuideSections = <_GuideSectionData>[
  _GuideSectionData(
    id: 'protocols',
    icon: Icons.dns_rounded,
    accent: _kGuideAccentBlue,
    categoryLabel: 'Protocols',
    title: 'Quick Start & Protocol Matrix',
    summary:
        'Manage Windows, macOS, Linux, and hypervisor infrastructure from one hardware-encrypted workspace.',
    callouts: <_GuideChipSpec>[
      _GuideChipSpec(
        icon: Icons.desktop_windows_rounded,
        label: 'RDP :3389',
        detail: 'FreeRDP 3.x NLA & DVC Display',
      ),
      _GuideChipSpec(
        icon: Icons.laptop_mac_rounded,
        label: 'VNC :5900',
        detail: 'macOS ARD & Linux RFB 3.8',
      ),
      _GuideChipSpec(
        icon: Icons.terminal_rounded,
        label: 'SSH :22',
        detail: 'Interactive PTY Shell',
      ),
      _GuideChipSpec(
        icon: Icons.folder_copy_outlined,
        label: 'SFTP :22',
        detail: 'Remote File Manager',
      ),
      _GuideChipSpec(
        icon: Icons.hub_rounded,
        label: 'Proxmox / Hypervisor :8006',
        detail: 'PVE & ESXi Cluster Nodes',
      ),
    ],
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        title: 'Create New Connection (+)',
        body:
            'Tap + in the Connections header and pick New Connection. Select RDP, SSH, VNC, SFTP, or Hypervisor on the single-row protocol bar to auto-fill default ports.',
      ),
      _GuideBulletSpec(
        title: 'Pinned Favorites & Environment Folders',
        body:
            'Star critical production hosts to keep them pinned at the top, and group servers into Folders with live TCP latency badges.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'jumphost',
    icon: Icons.alt_route_rounded,
    accent: _kGuideGold,
    categoryLabel: 'Jump Host',
    title: 'Jump Host (SSH Bastion) & Folder Routing',
    summary:
        'Reach private VPC subnets without external VPN clients using automated SSH Bastion ProxyJump relays.',
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        title: 'Dedicated Bastion Gateways',
        body:
            'Choose New Jump Host from the + menu to register a public SSH relay authenticated via Ed25519/RSA Private Key, Password, or a reusable Vault Credential.',
      ),
      _GuideBulletSpec(
        title: 'Folder-Wide Route Inheritance',
        body:
            'Assign a Default Jump Host inside Folder Settings so every RDP, VNC, SSH, SFTP, and Hypervisor target in that folder tunnels through the bastion automatically.',
      ),
      _GuideBulletSpec(
        title: 'Multi-Hop Bastion Chains',
        body:
            'Chain multiple SSH gateways (Hop 1 -> Hop 2 -> Target) with built-in loop detection and pooled multiplexed connections.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'desktop',
    icon: Icons.touch_app_rounded,
    accent: _kGuideOk,
    categoryLabel: 'Desktop & Gestures',
    title: 'RDP & VNC Gestures, Display Sizing & Modifiers',
    summary:
        'Precision pointer accuracy and distortion-free aspect scaling across phones, foldables, and tablets.',
    callouts: <_GuideChipSpec>[
      _GuideChipSpec(
        icon: Icons.ads_click_rounded,
        label: '1-Finger Tap',
        detail: 'Left Click',
      ),
      _GuideChipSpec(
        icon: Icons.double_arrow_rounded,
        label: 'Double Tap',
        detail: 'Double Click / Drag',
      ),
      _GuideChipSpec(
        icon: Icons.pan_tool_alt_rounded,
        label: 'Long Press / 2-Finger Tap',
        detail: 'Right Click',
      ),
      _GuideChipSpec(
        icon: Icons.swap_vert_rounded,
        label: '2-Finger Drag',
        detail: 'Mouse Wheel Scroll',
      ),
      _GuideChipSpec(
        icon: Icons.pinch_rounded,
        label: '2-Finger Pinch',
        detail: 'Smooth Canvas Zoom',
      ),
      _GuideChipSpec(
        icon: Icons.keyboard_alt_outlined,
        label: '3-Finger Tap',
        detail: 'Toggle Soft Keyboard',
      ),
    ],
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        title: 'Auto Match, Fit, Fill & 1:1 Display Sizing',
        body:
            'Auto Match dynamically resizes remote Windows desktops via FreeRDP DisplayControl DVC. Fit frames the full desktop proportionally, Fill covers 100% of the screen with cursor-follow pan, and 1:1 renders native server pixels.',
      ),
      _GuideBulletSpec(
        title: 'Virtual Trackpad, Direct Touch & Sticky Modifiers',
        body:
            'Switch between relative Virtual Trackpad and absolute Direct Touch in the session bar, and latch Ctrl, Alt, Win, Shift, or Ctrl+Alt+Del on the bottom modifier deck.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'ssh_sftp',
    icon: Icons.terminal_rounded,
    accent: _kGuidePurple,
    categoryLabel: 'SSH & SFTP',
    title: 'Interactive SSH Terminal, SFTP Explorer & Snippets',
    summary:
        'Low-latency xterm-256color PTY shell paired with a side-by-side SFTP file browser over one multiplexed session.',
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        title: 'Terminal, SFTP & Split Workspace',
        body:
            'Switch effortlessly between full-screen Terminal, remote SFTP Explorer, or side-by-side Split mode on wide screens without opening a second SSH socket.',
      ),
      _GuideBulletSpec(
        title: 'SFTP Transfers, Inline Editing & Dotfiles',
        body:
            'Browse paths, upload files or folders, inspect permissions, toggle hidden .dotfiles, and edit remote config files inline with atomic saves.',
      ),
      _GuideBulletSpec(
        title: 'Command Snippets & Terminal Palettes',
        body:
            'Run frequent DevOps commands in one tap from Snippets Studio, adjust font sizing, and pick high-contrast terminal themes.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'port_forward',
    icon: Icons.swap_calls_rounded,
    accent: _kGuideCyan,
    categoryLabel: 'Port Forward',
    title: 'Local Port Forwarding Studio (ssh -L)',
    summary:
        'Expose private databases, Kubernetes APIs, and internal web dashboards securely onto local loopback ports.',
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        title: 'Bind Local 127.0.0.1 Tunnels',
        body:
            'Open Start Local Port Forward (ssh -L) from any SSH host menu or the SSH studio bar, specify local bind port and remote target host:port, and activate the live listener.',
      ),
      _GuideBulletSpec(
        title: 'Active Listener Telemetry & One-Tap Stop',
        body:
            'Monitor active forwarded sockets and byte counters in real time, copy the local 127.0.0.1 endpoint, and tear down tunnels cleanly when finished.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'vault_2fa',
    icon: Icons.shield_rounded,
    accent: _kGuideGold,
    categoryLabel: 'Vault & 2FA',
    title: 'Security Vault, PIN, Biometrics & 2FA Authenticator',
    summary:
        'Hardware-backed AES-256-GCM storage, zero-trust screen locking, and built-in RFC 6238 TOTP generation.',
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        title: 'Full-Screen PIN, Auto-Lock & Privacy Shields',
        body:
            'Protect your vault with a 4- or 6-digit PIN keypad, configurable Auto-Lock (0s, 15s, 1m, 5m, 15m), Biometric Unlock, Block Screenshots, and 30s Clipboard Auto-Clear.',
      ),
      _GuideBulletSpec(
        title: 'RFC 6238 2FA Authenticator & Live Auto-Type',
        body:
            'Import Base32 secrets or otpauth:// URIs (SHA-1, SHA-256, SHA-512; 6 or 8 digits) and tap Auto-Type to stream live OTP codes straight into an active RDP or SSH session.',
      ),
      _GuideBulletSpec(
        title: 'TOFU SSH Host Key Pinning',
        body:
            'Inspect and manage trusted SHA-256 server fingerprints under Trusted SSH Keys to prevent man-in-the-middle spoofing.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'cloud_sync',
    icon: Icons.cloud_done_rounded,
    accent: _kGuideOk,
    categoryLabel: 'Cloud Sync',
    title: 'Zero-Knowledge Cloud Sync',
    summary:
        'Keep hosts, folders, credentials, and 2FA tokens synchronized across devices with client-side AES-256-GCM encryption.',
    callouts: <_GuideChipSpec>[
      _GuideChipSpec(
        icon: Icons.add_to_drive_rounded,
        label: 'Google Drive AppData',
        detail: '1-Tap Account-Bound E2EE',
      ),
      _GuideChipSpec(
        icon: Icons.dns_outlined,
        label: 'Private SFTP',
        detail: 'Self-Hosted SSH Storage',
      ),
      _GuideChipSpec(
        icon: Icons.cloud_outlined,
        label: 'WebDAV',
        detail: 'Nextcloud & Enterprise DAV',
      ),
      _GuideChipSpec(
        icon: Icons.code_rounded,
        label: 'GitHub Secret Gist',
        detail: 'Personal Access Token Sync',
      ),
    ],
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        title: '1-Tap Google Drive AppData Binding',
        body:
            'Tap Sign in with Google to bind your account immediately using an account-bound PBKDF2-HMAC-SHA256 + AES-256-GCM key, or toggle an optional custom passphrase for extra separation.',
      ),
      _GuideBulletSpec(
        title: 'Smart Merge, Pull Only & Push Overwrite',
        body:
            'Smart Merge reconciles per-item timestamps and deletion tombstones automatically, while Pull Only and Push Overwrite give you full manual control.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'backup_troubleshooting',
    icon: Icons.verified_user_outlined,
    accent: _kGuideAccentBlue,
    categoryLabel: 'Backup & Help',
    title: '.jvault Encrypted Backup & Troubleshooting',
    summary:
        'Create portable offline snapshots and resolve common network, NLA, or cloud API issues.',
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        title: 'Portable .jvault Offline Snapshots',
        body:
            'Use Export and Import under Vault & 2FA to generate passphrase-sealed .jvault archives for air-gapped backups or device migration.',
      ),
      _GuideBulletSpec(
        title: 'RDP NLA, SSH Auth & Google Drive API Checks',
        body:
            'If RDP NLA rejects login, verify DOMAIN\\username or UPN format via Update Credentials & Reconnect. If Google Drive reports HTTP 403, enable the Google Drive API in your Google Cloud project and tap Sync Now.',
      ),
    ],
  ),
];

/// Full-Screen Pure-English Interactive User Guide for JalaDesk Mobile (`v1.16.0+18`).
class JalaUserGuideScreen extends StatefulWidget {
  final String? initialLanguage;

  const JalaUserGuideScreen({
    super.key = const Key('jala_user_guide_screen'),
    this.initialLanguage,
  });

  @override
  State<JalaUserGuideScreen> createState() => _JalaUserGuideScreenState();
}

class _JalaUserGuideScreenState extends State<JalaUserGuideScreen> {
  String _selectedCategory = 'all';
  String _searchQuery = '';
  late final TextEditingController _searchCtrl;

  @override
  void initState() {
    super.initState();
    _searchCtrl = TextEditingController();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  List<_GuideSectionData> get _filteredSections {
    return _kGuideSections.where((sec) {
      if (_selectedCategory != 'all' && sec.id != _selectedCategory) {
        return false;
      }
      return sec.matchesQuery(_searchQuery);
    }).toList();
  }

  Widget _buildCategoryChip({
    required String id,
    required String label,
    required IconData icon,
  }) {
    final bool selected = _selectedCategory == id;
    return Padding(
      padding: const EdgeInsets.only(right: 7),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          key: ValueKey('guide_cat_$id'),
          borderRadius: BorderRadius.circular(9),
          onTap: () => setState(() => _selectedCategory = id),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            curve: Curves.easeOutCubic,
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
            decoration: BoxDecoration(
              color: selected
                  ? JalaEnterpriseTokens.segmentSelectedBg
                  : _kGuideCardBg,
              borderRadius: BorderRadius.circular(9),
              border: Border.all(
                color: selected
                    ? _kGuideGold.withValues(alpha: 0.78)
                    : _kGuideCardBorder,
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  icon,
                  size: 14,
                  color: selected
                      ? _kGuideGold
                      : JalaEnterpriseTokens.textMuted,
                ),
                const SizedBox(width: 5.5),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
                    color: selected
                        ? JalaEnterpriseTokens.textPrimary
                        : JalaEnterpriseTokens.textSecondary,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSectionCard(_GuideSectionData sec) {
    return Container(
      key: ValueKey('guide_card_${sec.id}'),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: _kGuideCardBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _kGuideCardBorder, width: 1.0),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 12),
            decoration: const BoxDecoration(
              color: _kGuideHeaderBg,
              border: Border(
                bottom: BorderSide(color: _kGuideCardBorder, width: 1.0),
              ),
            ),
            child: Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: sec.accent.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(color: sec.accent.withValues(alpha: 0.4)),
                  ),
                  child: Icon(sec.icon, size: 17, color: sec.accent),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Text(
                    sec.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.15,
                      color: JalaEnterpriseTokens.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(15),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  sec.summary,
                  style: const TextStyle(
                    fontSize: 12,
                    height: 1.4,
                    color: JalaEnterpriseTokens.textSecondary,
                  ),
                ),
                if (sec.callouts.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 7,
                    runSpacing: 7,
                    children: [
                      for (final c in sec.callouts)
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 9.5,
                            vertical: 6,
                          ),
                          decoration: BoxDecoration(
                            color: _kGuidePillBg,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: _kGuideCardBorder),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(c.icon, size: 13.5, color: sec.accent),
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  '${c.label} • ${c.detail}',
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                    color: JalaEnterpriseTokens.textPrimary,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ],
                const SizedBox(height: 12),
                const Divider(height: 1, color: _kGuideCardBorder),
                const SizedBox(height: 11),
                for (int i = 0; i < sec.bullets.length; i++) ...[
                  if (i > 0) const SizedBox(height: 10),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 5),
                        child: Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(
                            color: sec.accent,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              sec.bullets[i].title,
                              style: const TextStyle(
                                fontSize: 12.5,
                                fontWeight: FontWeight.w700,
                                color: JalaEnterpriseTokens.textPrimary,
                              ),
                            ),
                            const SizedBox(height: 2.5),
                            Text(
                              sec.bullets[i].body,
                              style: const TextStyle(
                                fontSize: 11.5,
                                height: 1.42,
                                color: JalaEnterpriseTokens.textSecondary,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final EdgeInsets mediaPadding = MediaQuery.paddingOf(context);
    final EdgeInsets viewInsets = MediaQuery.viewInsetsOf(context);
    final double symPadX = math.max(mediaPadding.left, mediaPadding.right) + 14.0;
    final List<_GuideSectionData> visible = _filteredSections;

    return Scaffold(
      backgroundColor: _kGuideCanvas,
      appBar: AppBar(
        backgroundColor: _kGuideHeaderBg,
        elevation: 0,
        automaticallyImplyLeading: false,
        titleSpacing: symPadX,
        shape: const Border(
          bottom: BorderSide(color: _kGuideCardBorder, width: 1.0),
        ),
        title: Row(
          children: [
            Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(
                color: JalaEnterpriseTokens.headerBadgeBg,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: _kGuideGold.withValues(alpha: 0.45)),
              ),
              child: const Icon(
                Icons.menu_book_rounded,
                size: 16,
                color: _kGuideGold,
              ),
            ),
            const SizedBox(width: 10),
            const Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'JalaDesk Guide',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.2,
                      color: JalaEnterpriseTokens.textPrimary,
                    ),
                  ),
                  Text(
                    'Protocols, bastion tunnels, gestures & security reference',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      color: JalaEnterpriseTokens.textMuted,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          Padding(
            padding: EdgeInsets.only(right: math.max(mediaPadding.right, 6)),
            child: IconButton(
              key: const Key('btn_close_user_guide'),
              tooltip: 'Close Guide',
              onPressed: () => Navigator.of(context).pop(),
              icon: const Icon(
                Icons.close_rounded,
                color: JalaEnterpriseTokens.textSecondary,
              ),
            ),
          ),
        ],
      ),
      body: LayoutBuilder(
        builder: (ctx, constraints) {
          final bool twoColumn = constraints.maxWidth >= 720;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                decoration: const BoxDecoration(
                  color: _kGuideHeaderBg,
                  border: Border(
                    bottom: BorderSide(color: _kGuideCardBorder, width: 1.0),
                  ),
                ),
                padding: EdgeInsets.fromLTRB(symPadX, 10, symPadX, 11),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      key: const Key('field_guide_search'),
                      controller: _searchCtrl,
                      onChanged: (v) => setState(() => _searchQuery = v),
                      style: const TextStyle(
                        fontSize: 12.5,
                        color: JalaEnterpriseTokens.textPrimary,
                      ),
                      decoration: jalaEnterpriseInputDecoration(
                        label: 'Search documentation...',
                        hint: 'e.g. Jump Host, Trackpad, Fill, Google Drive, otpauth',
                        icon: Icons.search_rounded,
                        suffixIcon: _searchQuery.isEmpty
                            ? null
                            : IconButton(
                                key: const Key('btn_clear_guide_search'),
                                visualDensity: VisualDensity.compact,
                                tooltip: 'Clear',
                                onPressed: () {
                                  _searchCtrl.clear();
                                  setState(() => _searchQuery = '');
                                },
                                icon: const Icon(
                                  Icons.close_rounded,
                                  size: 16,
                                  color: JalaEnterpriseTokens.textMuted,
                                ),
                              ),
                      ),
                    ),
                    const SizedBox(height: 9),
                    SingleChildScrollView(
                      key: const Key('guide_category_bar'),
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          _buildCategoryChip(
                            id: 'all',
                            label: 'All Topics',
                            icon: Icons.apps_rounded,
                          ),
                          for (final sec in _kGuideSections)
                            _buildCategoryChip(
                              id: sec.id,
                              label: sec.categoryLabel,
                              icon: sec.icon,
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: visible.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            'No documentation topics matched "$_searchQuery".',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 12.5,
                              color: JalaEnterpriseTokens.textSecondary,
                            ),
                          ),
                        ),
                      )
                    : SingleChildScrollView(
                        padding: EdgeInsets.fromLTRB(
                          symPadX,
                          12,
                          symPadX,
                          16 + mediaPadding.bottom + viewInsets.bottom,
                        ),
                        child: twoColumn
                            ? Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  for (int i = 0;
                                      i < visible.length;
                                      i += 2) ...[
                                    if (i > 0) const SizedBox(height: 12),
                                    Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Expanded(
                                          child: _buildSectionCard(visible[i]),
                                        ),
                                        const SizedBox(width: 12),
                                        Expanded(
                                          child: i + 1 < visible.length
                                              ? _buildSectionCard(
                                                  visible[i + 1],
                                                )
                                              : const SizedBox.shrink(),
                                        ),
                                      ],
                                    ),
                                  ],
                                ],
                              )
                            : Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  for (int i = 0; i < visible.length; i++) ...[
                                    if (i > 0) const SizedBox(height: 11),
                                    _buildSectionCard(visible[i]),
                                  ],
                                ],
                              ),
                      ),
              ),
            ],
          );
        },
      ),
    );
  }
}
