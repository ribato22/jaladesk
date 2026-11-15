import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'jala_enterprise_components.dart';

const Color _kGuideCanvasTop = Color(0xFF090E17);
const Color _kGuideCanvasBottom = Color(0xFF0D1522);
const Color _kGuideCardBg = Color(0xFF131C28);
const Color _kGuideCardBorder = Color(0xFF253549);
const Color _kGuideChipBg = Color(0xFF0D141E);
const Color _kGuideAccentBlue = Color(0xFF58A6FF);
const Color _kGuideGold = Color(0xFFF3C66F);
const Color _kGuideOk = Color(0xFF7AD9A0);

class _GuideChipSpec {
  final IconData icon;
  final String labelId;
  final String labelEn;
  final String detailId;
  final String detailEn;

  const _GuideChipSpec({
    required this.icon,
    required this.labelId,
    required this.labelEn,
    required this.detailId,
    required this.detailEn,
  });
}

class _GuideBulletSpec {
  final String titleId;
  final String titleEn;
  final String bodyId;
  final String bodyEn;

  const _GuideBulletSpec({
    required this.titleId,
    required this.titleEn,
    required this.bodyId,
    required this.bodyEn,
  });
}

class _GuideSectionData {
  final String id;
  final IconData icon;
  final Color accent;
  final String badge;
  final String categoryLabelId;
  final String categoryLabelEn;
  final String titleId;
  final String titleEn;
  final String summaryId;
  final String summaryEn;
  final List<_GuideBulletSpec> bullets;
  final List<_GuideChipSpec> callouts;

  const _GuideSectionData({
    required this.id,
    required this.icon,
    required this.accent,
    required this.badge,
    required this.categoryLabelId,
    required this.categoryLabelEn,
    required this.titleId,
    required this.titleEn,
    required this.summaryId,
    required this.summaryEn,
    required this.bullets,
    this.callouts = const <_GuideChipSpec>[],
  });

  bool matchesQuery(String rawQuery) {
    final q = rawQuery.trim().toLowerCase();
    if (q.isEmpty) return true;
    final haystack = <String>[
      badge,
      categoryLabelId,
      categoryLabelEn,
      titleId,
      titleEn,
      summaryId,
      summaryEn,
      for (final b in bullets) ...[b.titleId, b.titleEn, b.bodyId, b.bodyEn],
      for (final c in callouts) ...[
        c.labelId,
        c.labelEn,
        c.detailId,
        c.detailEn,
      ],
    ].join(' ').toLowerCase();
    return haystack.contains(q);
  }
}

const List<_GuideSectionData> _kGuideSections = <_GuideSectionData>[
  _GuideSectionData(
    id: 'connections',
    icon: Icons.dns_rounded,
    accent: _kGuideAccentBlue,
    badge: '01 • PROTOCOLS',
    categoryLabelId: 'Koneksi',
    categoryLabelEn: 'Connections',
    titleId: 'Koneksi & Protokol',
    titleEn: 'Connections & Protocols',
    summaryId:
        'Kelola server Windows, macOS, Linux, dan cluster virtualisasi dari satu direktori terenkripsi.',
    summaryEn:
        'Manage Windows, macOS, Linux, and hypervisor endpoints from a single encrypted directory.',
    callouts: <_GuideChipSpec>[
      _GuideChipSpec(
        icon: Icons.desktop_windows_rounded,
        labelId: 'RDP :3389',
        labelEn: 'RDP :3389',
        detailId: 'Windows NLA & Dynamic Display',
        detailEn: 'Windows NLA & Dynamic Display',
      ),
      _GuideChipSpec(
        icon: Icons.laptop_mac_rounded,
        labelId: 'VNC :5900',
        labelEn: 'VNC :5900',
        detailId: 'macOS ARD & Linux RFB 3.8',
        detailEn: 'macOS ARD & Linux RFB 3.8',
      ),
      _GuideChipSpec(
        icon: Icons.terminal_rounded,
        labelId: 'SSH / SFTP :22',
        labelEn: 'SSH / SFTP :22',
        detailId: 'PTY Shell & Transfer Berkas',
        detailEn: 'PTY Shell & File Browser',
      ),
      _GuideChipSpec(
        icon: Icons.hub_rounded,
        labelId: 'Hypervisor :8006',
        labelEn: 'Hypervisor :8006',
        detailId: 'Proxmox VE & VMware ESXi',
        detailEn: 'Proxmox VE & VMware ESXi',
      ),
    ],
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        titleId: 'Tambah Koneksi Baru (+)',
        titleEn: 'Create New Connection (+)',
        bodyId:
            'Ketuk tombol + di bilah atas lalu pilih New Connection. Pilih protokol dalam satu baris (RDP, SSH, VNC, SFTP, atau Hypervisor) dan port bawaan akan terisi otomatis.',
        bodyEn:
            'Tap + in the top bar and choose New Connection. Pick a protocol on the single-row selector (RDP, SSH, VNC, SFTP, or Hypervisor) to auto-fill its standard port.',
      ),
      _GuideBulletSpec(
        titleId: 'Pinned Favorites (★) & Folder',
        titleEn: 'Pinned Favorites (★) & Folders',
        bodyId:
            'Ketuk ikon bintang ★ di kanan atas dialog koneksi untuk menyematkan server penting di bagian atas, dan kelompokkan server ke dalam Folder sesuai lingkungan.',
        bodyEn:
            'Tap the ★ star icon in the connection header to pin critical hosts at the top, and group servers into Folders by environment.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'jumphost',
    icon: Icons.alt_route_rounded,
    accent: _kGuideGold,
    badge: '02 • BASTION ROUTING',
    categoryLabelId: 'Jump Host',
    categoryLabelEn: 'Jump Host',
    titleId: 'Jump Host & Routing Folder',
    titleEn: 'Jump Host & Bastion Routing',
    summaryId:
        'Jangkau jaringan privat tanpa VPN terpisah menggunakan SSH Bastion ProxyJump otomatis.',
    summaryEn:
        'Reach private networks without external VPNs using automated SSH Bastion ProxyJump tunnels.',
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        titleId: 'New Jump Host vs New Connection',
        titleEn: 'New Jump Host vs New Connection',
        bodyId:
            'New Jump Host mendaftarkan server SSH perantara (bastion publik) dengan autentikasi SSH Key, Password, atau Vault Key, sedangkan New Connection adalah server tujuan.',
        bodyEn:
            'New Jump Host registers a public SSH bastion relay (authenticated via SSH Key, Password, or Vault Key), whereas New Connection is your destination host.',
      ),
      _GuideBulletSpec(
        titleId: '1 Jump Host untuk Seluruh Folder',
        titleEn: 'Folder-Wide Jump Host Inheritance',
        bodyId:
            'Buka New Folder / Folder Settings lalu pilih Folder Default Jump Host. Semua koneksi RDP, VNC, SSH, SFTP, dan Hypervisor di folder tersebut otomatis melewati bastion tersebut.',
        bodyEn:
            'Open New Folder / Folder Settings and assign a Folder Default Jump Host. Every RDP, VNC, SSH, SFTP, and Hypervisor host in that folder inherits the route automatically.',
      ),
      _GuideBulletSpec(
        titleId: 'Multi-Hop Chain & Port Forward Studio (ssh -L)',
        titleEn: 'Multi-Hop Chain & Port Forward Studio (ssh -L)',
        bodyId:
            'Rangkai beberapa bastion berantai (Hop 1 -> Hop 2) bebas siklus, atau buka Port Forward Studio untuk mengekspos database/web internal ke 127.0.0.1 di perangkat Anda.',
        bodyEn:
            'Chain multiple bastions (Hop 1 -> Hop 2) with cycle protection, or open Port Forward Studio to bind private databases and consoles onto local 127.0.0.1 ports.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'gestures',
    icon: Icons.touch_app_rounded,
    accent: _kGuideOk,
    badge: '03 • DESKTOP & TOUCH',
    categoryLabelId: 'Layar & Gestur',
    categoryLabelEn: 'Display & Gestures',
    titleId: 'Layar Desktop & Gestur Sentuh',
    titleEn: 'Desktop Display & Touch Gestures',
    summaryId:
        'Kendali kursor presisi tinggi dan rasio layar proporsional bebas distorsi di ponsel maupun tablet.',
    summaryEn:
        'Precision pointer control and distortion-free proportional scaling across phones and tablets.',
    callouts: <_GuideChipSpec>[
      _GuideChipSpec(
        icon: Icons.ads_click_rounded,
        labelId: '1 Jari Ketuk',
        labelEn: '1-Finger Tap',
        detailId: 'Klik Kiri (Left Click)',
        detailEn: 'Left Mouse Click',
      ),
      _GuideChipSpec(
        icon: Icons.double_arrow_rounded,
        labelId: 'Ketuk 2x Cepat',
        labelEn: 'Double Tap',
        detailId: 'Double Click',
        detailEn: 'Double Click',
      ),
      _GuideChipSpec(
        icon: Icons.pan_tool_alt_rounded,
        labelId: 'Tahan / 2 Jari Ketuk',
        labelEn: 'Long Press / 2-Finger Tap',
        detailId: 'Klik Kanan (Right Click)',
        detailEn: 'Right Mouse Click',
      ),
      _GuideChipSpec(
        icon: Icons.swap_vert_rounded,
        labelId: '2 Jari Geser',
        labelEn: '2-Finger Drag',
        detailId: 'Mouse Wheel Scroll',
        detailEn: 'Mouse Wheel Scroll',
      ),
      _GuideChipSpec(
        icon: Icons.pinch_rounded,
        labelId: 'Cubit 2 Jari',
        labelEn: '2-Finger Pinch',
        detailId: 'Pinch Zoom Kanvas',
        detailEn: 'Smooth Canvas Zoom',
      ),
    ],
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        titleId: 'Direct Touch vs Virtual Trackpad',
        titleEn: 'Direct Touch vs Virtual Trackpad',
        bodyId:
            'Gunakan Direct Touch untuk mengetuk tombol secara langsung seperti tablet, atau aktifkan Virtual Trackpad untuk menggerakkan kursor Windows/macOS dengan presisi tinggi.',
        bodyEn:
            'Use Direct Touch to tap targets directly like a tablet, or switch to Virtual Trackpad for pixel-accurate Windows/macOS cursor movement.',
      ),
      _GuideBulletSpec(
        titleId: 'Mode Layar Fit, Fill, 1:1 & Auto Match',
        titleEn: 'Fit, Fill, 1:1 & Auto Match Display Modes',
        bodyId:
            'Fit menampilkan seluruh desktop secara proporsional; Fill memenuhi 100% layar tanpa garis hitam & tanpa distorsi dengan auto-pan mengikuti kursor; 1:1 menampilkan piksel asli; Auto Match menyelaraskan resolusi server.',
        bodyEn:
            'Fit frames the entire desktop proportionally; Fill covers 100% of your screen with zero black bars, zero stretch, and smooth cursor-follow pan; 1:1 renders native pixels; Auto Match syncs remote resolution.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'ssh',
    icon: Icons.terminal_rounded,
    accent: Color(0xFFB392F0),
    badge: '04 • TERMINAL & SFTP',
    categoryLabelId: 'SSH & SFTP',
    categoryLabelEn: 'SSH & SFTP',
    titleId: 'Terminal SSH & SFTP Workspace',
    titleEn: 'SSH & SFTP Workspace',
    summaryId:
        'Terminal interaktif berkecepatan tinggi dengan penjelajah berkas SFTP terpadu dalam satu sesi.',
    summaryEn:
        'High-throughput interactive PTY shell paired with an integrated SFTP file manager.',
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        titleId: 'Mode Term, SFTP & Split',
        titleEn: 'Term, SFTP & Split Views',
        bodyId:
            'Beralih seketika antara layar penuh Terminal (Term), penjelajah berkas jarak jauh (SFTP), atau tampilan berdampingan (Split) tanpa membuka ulang koneksi SSH.',
        bodyEn:
            'Switch seamlessly between full Terminal (Term), remote file explorer (SFTP), or side-by-side Split view over the same active SSH connection.',
      ),
      _GuideBulletSpec(
        titleId: 'Command Snippets & Tema Terminal',
        titleEn: 'Command Snippets & Terminal Themes',
        bodyId:
            'Jalankan perintah administrasi rutin dalam sekali ketuk lewat panel Snippets, sesuaikan ukuran font & tema warna, serta lindungi sesi dengan TOFU Host Key Pinning.',
        bodyEn:
            'Execute routine ops commands in one tap via Snippets, customize terminal font size & color palettes, and verify server identity via TOFU Host Key Pinning.',
      ),
    ],
  ),
  _GuideSectionData(
    id: 'vault',
    icon: Icons.shield_rounded,
    accent: _kGuideGold,
    badge: '05 • ZERO-TRUST VAULT',
    categoryLabelId: 'Vault & Sync',
    categoryLabelEn: 'Vault & Sync',
    titleId: 'Keamanan Vault, 2FA & Cloud Sync',
    titleEn: 'Vault Security, 2FA & Cloud Sync',
    summaryId:
        'Perlindungan enkripsi AES-256-GCM lokal dan sinkronisasi lintas perangkat Zero-Knowledge E2EE.',
    summaryEn:
        'Local AES-256-GCM enclave protection with Zero-Knowledge E2EE multi-device cloud sync.',
    bullets: <_GuideBulletSpec>[
      _GuideBulletSpec(
        titleId: 'Full-Screen PIN & Auto-Lock',
        titleEn: 'Full-Screen PIN & Auto-Lock',
        bodyId:
            'Aktifkan kode PIN 4 atau 6 digit dengan penguncian otomatis (0s, 15s, 1m, 5m, 15m), Biometric Unlock, dan perlindungan tangkapan layar (Block Screenshots).',
        bodyEn:
            'Enable a 4- or 6-digit PIN keypad with configurable Auto-Lock (0s, 15s, 1m, 5m, 15m), Biometric Unlock, and screenshot blocking.',
      ),
      _GuideBulletSpec(
        titleId: 'Authenticator 2FA & Auto-Type ke Sesi Aktif',
        titleEn: '2FA Authenticator & Live Session Auto-Type',
        bodyId:
            'Simpan kunci OTP RFC 6238 (SHA-1/256/512, 6/8 digit) dan ketuk ikon ketik untuk mengirimkan kode OTP langsung ke sesi RDP atau terminal SSH yang sedang aktif.',
        bodyEn:
            'Store RFC 6238 TOTP seeds (SHA-1/256/512, 6/8 digits) and tap Auto-Type to inject live OTP digits directly into your active RDP or SSH session.',
      ),
      _GuideBulletSpec(
        titleId: 'Encrypted Backup (.jvault) & E2EE Cloud Sync',
        titleEn: 'Encrypted Backup (.jvault) & E2EE Cloud Sync',
        bodyId:
            'Ekspor cadangan terenkripsi .jvault atau sinkronkan otomatis menggunakan Sync Passphrase ke Google Drive (AppData tersembunyi), SFTP Pribadi, WebDAV, maupun GitHub Secret Gist.',
        bodyEn:
            'Export sealed .jvault snapshots or sync automatically with your Sync Passphrase via Google Drive (hidden AppData), Private SFTP, WebDAV, or GitHub Secret Gist.',
      ),
    ],
  ),
];

/// Full-Screen Interactive Bilingual User Guide (`ID` & `EN`) for JalaDesk Mobile (`v1.15.0+17`).
class JalaUserGuideScreen extends StatefulWidget {
  final String initialLanguage;

  const JalaUserGuideScreen({
    super.key = const Key('jala_user_guide_screen'),
    this.initialLanguage = 'id',
  });

  @override
  State<JalaUserGuideScreen> createState() => _JalaUserGuideScreenState();
}

class _JalaUserGuideScreenState extends State<JalaUserGuideScreen> {
  late String _lang;
  String _selectedCategory = 'all';
  String _searchQuery = '';
  late final TextEditingController _searchCtrl;

  @override
  void initState() {
    super.initState();
    _lang = widget.initialLanguage == 'en' ? 'en' : 'id';
    _searchCtrl = TextEditingController();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  bool get _isId => _lang == 'id';

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
    final String title = _isId ? sec.titleId : sec.titleEn;
    final String summary = _isId ? sec.summaryId : sec.summaryEn;

    return Container(
      key: ValueKey('guide_card_${sec.id}'),
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: _kGuideCardBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _kGuideCardBorder, width: 1.0),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: sec.accent.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(color: sec.accent.withValues(alpha: 0.42)),
                ),
                child: Icon(sec.icon, size: 18, color: sec.accent),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      sec.badge,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.5,
                        color: sec.accent,
                      ),
                    ),
                    const SizedBox(height: 1.5),
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w700,
                        color: JalaEnterpriseTokens.textPrimary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 9),
          Text(
            summary,
            style: const TextStyle(
              fontSize: 12,
              height: 1.38,
              color: JalaEnterpriseTokens.textSecondary,
            ),
          ),
          if (sec.callouts.isNotEmpty) ...[
            const SizedBox(height: 11),
            Wrap(
              spacing: 7,
              runSpacing: 7,
              children: [
                for (final c in sec.callouts)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 9,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: _kGuideChipBg,
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
                            '${_isId ? c.labelId : c.labelEn} • ${_isId ? c.detailId : c.detailEn}',
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
          const SizedBox(height: 10),
          for (int i = 0; i < sec.bullets.length; i++) ...[
            if (i > 0) const SizedBox(height: 9),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 4),
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
                        _isId
                            ? sec.bullets[i].titleId
                            : sec.bullets[i].titleEn,
                        style: const TextStyle(
                          fontSize: 12.2,
                          fontWeight: FontWeight.w700,
                          color: JalaEnterpriseTokens.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 2.5),
                      Text(
                        _isId ? sec.bullets[i].bodyId : sec.bullets[i].bodyEn,
                        style: const TextStyle(
                          fontSize: 11.5,
                          height: 1.4,
                          color: JalaEnterpriseTokens.textMuted,
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
    );
  }

  @override
  Widget build(BuildContext context) {
    final EdgeInsets mediaPadding = MediaQuery.paddingOf(context);
    final EdgeInsets viewInsets = MediaQuery.viewInsetsOf(context);
    final double symPadX = math.max(mediaPadding.left, mediaPadding.right) + 14.0;
    final List<_GuideSectionData> visible = _filteredSections;

    return Scaffold(
      backgroundColor: _kGuideCanvasTop,
      appBar: AppBar(
        backgroundColor: _kGuideCanvasTop,
        elevation: 0,
        automaticallyImplyLeading: false,
        titleSpacing: symPadX,
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
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _isId ? 'Panduan JalaDesk' : 'JalaDesk Guide',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w700,
                      color: JalaEnterpriseTokens.textPrimary,
                    ),
                  ),
                  Text(
                    _isId
                        ? 'Referensi koneksi, bastion, gestur & keamanan'
                        : 'Connections, bastion routing, gestures & security',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 10.5,
                      color: JalaEnterpriseTokens.textMuted,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              width: 86,
              child: JalaSegmentedBar<String>(
                key: const Key('guide_lang_bar'),
                height: 28,
                fontSize: 11,
                selectedValue: _lang,
                options: const <JalaSegmentedOption<String>>[
                  JalaSegmentedOption<String>(
                    value: 'id',
                    label: 'ID',
                    segmentKey: ValueKey('guide_lang_id'),
                  ),
                  JalaSegmentedOption<String>(
                    value: 'en',
                    label: 'EN',
                    segmentKey: ValueKey('guide_lang_en'),
                  ),
                ],
                onChanged: (next) => setState(() => _lang = next),
              ),
            ),
          ],
        ),
        actions: [
          Padding(
            padding: EdgeInsets.only(right: math.max(mediaPadding.right, 6)),
            child: IconButton(
              key: const Key('btn_close_user_guide'),
              tooltip: _isId ? 'Tutup Panduan' : 'Close Guide',
              onPressed: () => Navigator.of(context).pop(),
              icon: const Icon(
                Icons.close_rounded,
                color: JalaEnterpriseTokens.textSecondary,
              ),
            ),
          ),
        ],
      ),
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: <Color>[_kGuideCanvasTop, _kGuideCanvasBottom],
          ),
        ),
        child: LayoutBuilder(
          builder: (ctx, constraints) {
            final bool twoColumn = constraints.maxWidth >= 720;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  decoration: const BoxDecoration(
                    border: Border(
                      bottom: BorderSide(color: _kGuideCardBorder, width: 1.0),
                    ),
                  ),
                  padding: EdgeInsets.fromLTRB(symPadX, 4, symPadX, 11),
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
                          label: _isId
                              ? 'Cari topik panduan...'
                              : 'Search guide topics...',
                          hint: _isId
                              ? 'mis. Jump Host, Trackpad, Fill, Google Drive, 2FA'
                              : 'e.g. Jump Host, Trackpad, Fill, Google Drive, 2FA',
                          icon: Icons.search_rounded,
                          suffixIcon: _searchQuery.isEmpty
                              ? null
                              : IconButton(
                                  key: const Key('btn_clear_guide_search'),
                                  visualDensity: VisualDensity.compact,
                                  tooltip: _isId ? 'Hapus' : 'Clear',
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
                              label: _isId ? 'Semua Topik' : 'All Topics',
                              icon: Icons.apps_rounded,
                            ),
                            for (final sec in _kGuideSections)
                              _buildCategoryChip(
                                id: sec.id,
                                label: _isId
                                    ? sec.categoryLabelId
                                    : sec.categoryLabelEn,
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
                              _isId
                                  ? 'Tidak ada topik yang cocok dengan pencarian "$_searchQuery".'
                                  : 'No guide topics matched "$_searchQuery".',
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 12.5,
                                color: JalaEnterpriseTokens.textMuted,
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
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
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
                                            child:
                                                _buildSectionCard(visible[i]),
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
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: [
                                    for (int i = 0;
                                        i < visible.length;
                                        i++) ...[
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
      ),
    );
  }
}
