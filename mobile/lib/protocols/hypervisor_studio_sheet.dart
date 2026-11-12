import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'proxmox_ve_client.dart';

class HypervisorStudioSheet extends StatefulWidget {
  final String hostName;
  final String hostAddress;
  final int hostPort;
  final String initialUsername;
  final String initialPassword;
  final String routeLabel;
  final ProxmoxVeClient client;
  final HypervisorClusterSnapshot initialSnapshot;
  final void Function(String targetAddress, String suggestedName) onHandoffSsh;
  final void Function(String targetAddress, String suggestedName) onHandoffVnc;

  const HypervisorStudioSheet({
    super.key,
    required this.hostName,
    required this.hostAddress,
    required this.hostPort,
    required this.initialUsername,
    required this.initialPassword,
    required this.routeLabel,
    required this.client,
    required this.initialSnapshot,
    required this.onHandoffSsh,
    required this.onHandoffVnc,
  });

  @override
  State<HypervisorStudioSheet> createState() => _HypervisorStudioSheetState();
}

class _HypervisorStudioSheetState extends State<HypervisorStudioSheet> {
  static const Color _bgSurface = Color(0xFF141A21);
  static const Color _cardSurface = Color(0xFF1F2833);
  static const Color _headerBg = Color(0xFF0E141A);
  static const Color _selectedBg = Color(0xFF2A4560);
  static const Color _line = Color(0xFF2B3746);
  static const Color _lineInput = Color(0xFF39495C);
  static const Color _brandGold = Color(0xFFF3C66F);
  static const Color _accent = Color(0xFF1A56DB);
  static const Color _ok = Color(0xFF2DC58C);
  static const Color _amber = Color(0xFFF5A524);
  static const Color _danger = Color(0xFFF26D6D);
  static const Color _text = Color(0xFFEDF2F7);
  static const Color _text2 = Color(0xFFC4CFD9);
  static const Color _muted = Color(0xFF8C9AA8);

  late HypervisorClusterSnapshot _snapshot;
  late final TextEditingController _userCtrl;
  late final TextEditingController _passCtrl;
  final TextEditingController _otpCtrl = TextEditingController();
  final TextEditingController _searchCtrl = TextEditingController();

  String _typeFilter = 'ALL'; // ALL, QEMU, LXC, RUNNING
  String _searchQuery = '';
  bool _refreshing = false;
  String? _busyVmKey;
  String? _statusFeedback;
  bool _statusIsError = false;

  @override
  void initState() {
    super.initState();
    _snapshot = widget.initialSnapshot;
    _userCtrl = TextEditingController(
      text: widget.initialUsername.trim().isEmpty ? 'root@pam' : widget.initialUsername.trim(),
    );
    _passCtrl = TextEditingController(text: widget.initialPassword);
  }

  @override
  void dispose() {
    _userCtrl.dispose();
    _passCtrl.dispose();
    _otpCtrl.dispose();
    _searchCtrl.dispose();
    super.dispose();
  }

  String _formatBytes(int bytes) {
    if (bytes <= 0) return '0 MB';
    final gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1.0) return '${gb.toStringAsFixed(1)} GB';
    final mb = bytes / (1024 * 1024);
    return '${mb.round()} MB';
  }

  String _formatUptime(int seconds) {
    if (seconds <= 0) return 'stopped';
    final d = seconds ~/ 86400;
    final h = (seconds % 86400) ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    if (d > 0) return '${d}d ${h}h';
    if (h > 0) return '${h}h ${m}m';
    return '${m}m';
  }

  Future<void> _refreshCluster({bool withCredentials = false}) async {
    if (_refreshing) return;
    setState(() {
      _refreshing = true;
      _statusFeedback = null;
    });
    try {
      final snap = await widget.client.connectAndInspect(
        username: _userCtrl.text.trim(),
        password: withCredentials || widget.client.isAuthenticated ? _passCtrl.text : '',
        otp: _otpCtrl.text.trim().isEmpty ? null : _otpCtrl.text.trim(),
      );
      if (!mounted) return;
      setState(() {
        _snapshot = snap;
        _refreshing = false;
        if (snap.authError != null && withCredentials) {
          _statusFeedback = snap.authError;
          _statusIsError = true;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _refreshing = false;
        _statusFeedback = e.toString();
        _statusIsError = true;
      });
    }
  }

  Future<void> _confirmAndRunPowerAction(ProxmoxResourceItem item, String action) async {
    if (action == 'shutdown' || action == 'reboot' || action == 'stop') {
      final label = action[0].toUpperCase() + action.substring(1);
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: _cardSurface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: _lineInput),
          ),
          title: Text(
            '$label ${item.type.toUpperCase()} ${item.vmid} (${item.name})?',
            style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: _text),
          ),
          content: Text(
            'Dispatch live Proxmox VE "$action" command to ${item.name} on node "${item.node}"?',
            style: const TextStyle(fontSize: 12, color: _text2),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel', style: TextStyle(color: _muted)),
            ),
            FilledButton(
              key: ValueKey('btn_confirm_hv_${action}_${item.vmid}'),
              style: FilledButton.styleFrom(
                backgroundColor: action == 'reboot' ? _amber : _danger,
                foregroundColor: Colors.white,
              ),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(label),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }

    final vmKey = '${item.node}:${item.type}:${item.vmid}';
    setState(() {
      _busyVmKey = vmKey;
      _statusFeedback = null;
    });
    try {
      HapticFeedback.mediumImpact();
      final upid = await widget.client.performPowerAction(
        node: item.node,
        type: item.type,
        vmid: item.vmid,
        action: action,
      );
      if (!mounted) return;
      setState(() {
        _busyVmKey = null;
        _statusIsError = false;
        _statusFeedback =
            'Sent "${action.toUpperCase()}" to ${item.name} (#${item.vmid}) • Task $upid';
      });
      await _refreshCluster();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busyVmKey = null;
        _statusIsError = true;
        _statusFeedback = e.toString();
      });
    }
  }

  List<ProxmoxResourceItem> get _filteredResources {
    return _snapshot.resources.where((r) {
      if (_typeFilter == 'QEMU' && !r.isQemu) return false;
      if (_typeFilter == 'LXC' && !r.isLxc) return false;
      if (_typeFilter == 'RUNNING' && !r.isRunning) return false;
      if (_searchQuery.isNotEmpty) {
        final q = _searchQuery.toLowerCase();
        final match = r.name.toLowerCase().contains(q) ||
            r.vmid.toString().contains(q) ||
            r.node.toLowerCase().contains(q);
        if (!match) return false;
      }
      return true;
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final filtered = _filteredResources;

    return FractionallySizedBox(
      heightFactor: 0.90,
      child: Container(
        key: const ValueKey('hypervisor_studio_sheet'),
        padding: EdgeInsets.only(bottom: bottomInset),
        decoration: const BoxDecoration(
          color: _bgSurface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
          border: Border(top: BorderSide(color: _lineInput)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header
              Container(
                padding: const EdgeInsets.fromLTRB(16, 12, 12, 10),
                decoration: const BoxDecoration(
                  color: _headerBg,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
                  border: Border(bottom: BorderSide(color: _line)),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(
                        color: _selectedBg,
                        borderRadius: BorderRadius.circular(9),
                        border: Border.all(color: _brandGold.withValues(alpha: 0.5)),
                      ),
                      child: const Icon(Icons.dns_rounded, size: 18, color: _brandGold),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.hostName,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w800,
                              color: _text,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          Text(
                            'https://${widget.hostAddress}:${widget.hostPort} • ${_snapshot.productBanner}${widget.routeLabel.isNotEmpty ? " • ${widget.routeLabel}" : ""}',
                            style: const TextStyle(
                              fontSize: 11,
                              fontFamily: 'monospace',
                              color: _brandGold,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      key: const ValueKey('btn_refresh_hypervisor_studio'),
                      tooltip: 'Refresh Cluster',
                      onPressed: _refreshing ? null : () => _refreshCluster(),
                      icon: const Icon(Icons.refresh_rounded, size: 19, color: _brandGold),
                    ),
                    IconButton(
                      key: const ValueKey('btn_close_hypervisor_studio'),
                      tooltip: 'Close',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close_rounded, size: 19, color: _muted),
                    ),
                  ],
                ),
              ),
              if (_refreshing)
                const LinearProgressIndicator(
                  minHeight: 2,
                  color: _brandGold,
                  backgroundColor: _headerBg,
                ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(14),
                  children: [
                    // TLS & Quick Handoff Bar
                    Container(
                      padding: const EdgeInsets.all(11),
                      decoration: BoxDecoration(
                        color: _cardSurface,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: _line),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Icon(
                                _snapshot.authenticated ? Icons.verified_user_rounded : Icons.https_rounded,
                                size: 15,
                                color: _snapshot.authenticated ? _ok : _brandGold,
                              ),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  _snapshot.authenticated
                                      ? 'Authenticated as ${_snapshot.authenticatedUser} • ${_snapshot.versionText}'
                                      : '${_snapshot.versionText} • TLS Verified',
                                  style: const TextStyle(
                                    fontSize: 11.5,
                                    fontWeight: FontWeight.w700,
                                    color: _text,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          if (_snapshot.tlsFingerprintSha256.isNotEmpty) ...[
                            const SizedBox(height: 4),
                            Text(
                              'TLS Cert: ${_snapshot.tlsFingerprintSha256}',
                              style: const TextStyle(
                                fontSize: 10,
                                fontFamily: 'monospace',
                                color: _muted,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 8,
                            runSpacing: 6,
                            children: [
                              OutlinedButton.icon(
                                key: const ValueKey('btn_hv_handoff_ssh'),
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: _brandGold,
                                  side: BorderSide(color: _brandGold.withValues(alpha: 0.5)),
                                  visualDensity: VisualDensity.compact,
                                ),
                                onPressed: () {
                                  Navigator.of(context).pop();
                                  widget.onHandoffSsh(widget.hostAddress, '${widget.hostName} (SSH)');
                                },
                                icon: const Icon(Icons.terminal_rounded, size: 14),
                                label: const Text('Open SSH', style: TextStyle(fontSize: 11.5)),
                              ),
                              OutlinedButton.icon(
                                key: const ValueKey('btn_hv_handoff_vnc'),
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: _text,
                                  side: const BorderSide(color: _lineInput),
                                  visualDensity: VisualDensity.compact,
                                ),
                                onPressed: () {
                                  Navigator.of(context).pop();
                                  widget.onHandoffVnc(widget.hostAddress, '${widget.hostName} (VNC)');
                                },
                                icon: const Icon(Icons.desktop_windows_rounded, size: 14),
                                label: const Text('Open VNC', style: TextStyle(fontSize: 11.5)),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    if (_statusFeedback != null) ...[
                      const SizedBox(height: 10),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
                        decoration: BoxDecoration(
                          color: (_statusIsError ? _danger : _ok).withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(
                            color: (_statusIsError ? _danger : _ok).withValues(alpha: 0.5),
                          ),
                        ),
                        child: Text(
                          _statusFeedback!,
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w600,
                            color: _statusIsError ? _danger : _ok,
                          ),
                        ),
                      ),
                    ],
                    // Proxmox Auth Prompt Card if not yet authenticated
                    if (_snapshot.isProxmoxVe && !_snapshot.authenticated) ...[
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.all(13),
                        decoration: BoxDecoration(
                          color: _cardSurface,
                          borderRadius: BorderRadius.circular(11),
                          border: Border.all(color: _brandGold.withValues(alpha: 0.45)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'Sign In to Proxmox VE API',
                              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: _text),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              _snapshot.authError ??
                                  'Authenticate with PAM or PVE realm credentials to inspect & control QEMU VMs and LXC Containers.',
                              style: const TextStyle(fontSize: 11.5, color: _muted),
                            ),
                            const SizedBox(height: 10),
                            TextField(
                              key: const ValueKey('field_hv_username'),
                              controller: _userCtrl,
                              style: const TextStyle(fontSize: 12.5, color: _text),
                              decoration: InputDecoration(
                                labelText: 'Username (auto-appends @pam)',
                                labelStyle: const TextStyle(fontSize: 11.5, color: _text2),
                                isDense: true,
                                filled: true,
                                fillColor: _headerBg,
                                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                Expanded(
                                  flex: 2,
                                  child: TextField(
                                    key: const ValueKey('field_hv_password'),
                                    controller: _passCtrl,
                                    obscureText: true,
                                    style: const TextStyle(fontSize: 12.5, color: _text),
                                    decoration: InputDecoration(
                                      labelText: 'Password *',
                                      labelStyle: const TextStyle(fontSize: 11.5, color: _text2),
                                      isDense: true,
                                      filled: true,
                                      fillColor: _headerBg,
                                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: TextField(
                                    key: const ValueKey('field_hv_otp'),
                                    controller: _otpCtrl,
                                    keyboardType: TextInputType.number,
                                    style: const TextStyle(fontSize: 12.5, color: _text),
                                    decoration: InputDecoration(
                                      labelText: '2FA OTP',
                                      labelStyle: const TextStyle(fontSize: 11.5, color: _muted),
                                      isDense: true,
                                      filled: true,
                                      fillColor: _headerBg,
                                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            Align(
                              alignment: Alignment.centerRight,
                              child: FilledButton.icon(
                                key: const ValueKey('btn_hypervisor_authenticate'),
                                style: FilledButton.styleFrom(
                                  backgroundColor: _accent,
                                  foregroundColor: Colors.white,
                                ),
                                onPressed: _refreshing ? null : () => _refreshCluster(withCredentials: true),
                                icon: const Icon(Icons.login_rounded, size: 15),
                                label: const Text('Authenticate PVE'),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    // Cluster Nodes Summary
                    if (_snapshot.nodes.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      const Text(
                        'CLUSTER NODES',
                        style: TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.5,
                          color: _brandGold,
                        ),
                      ),
                      const SizedBox(height: 6),
                      for (final node in _snapshot.nodes)
                        Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.all(11),
                          decoration: BoxDecoration(
                            color: _cardSurface,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: _line),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const Icon(Icons.memory_rounded, size: 15, color: _ok),
                                  const SizedBox(width: 6),
                                  Text(
                                    'Node ${node.node}',
                                    style: const TextStyle(
                                      fontSize: 12.5,
                                      fontWeight: FontWeight.w700,
                                      color: _text,
                                    ),
                                  ),
                                  const Spacer(),
                                  Text(
                                    '${node.status.toUpperCase()} • up ${_formatUptime(node.uptimeSeconds)}',
                                    style: const TextStyle(
                                      fontSize: 10.5,
                                      fontFamily: 'monospace',
                                      color: _ok,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 7),
                              Row(
                                children: [
                                  Expanded(
                                    child: _buildMetricBar(
                                      label:
                                          'CPU ${(node.cpu * 100).toStringAsFixed(1)}% (${node.maxCpu} vCPU)',
                                      ratio: node.cpu.clamp(0.0, 1.0),
                                      color: _brandGold,
                                    ),
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: _buildMetricBar(
                                      label:
                                          'RAM ${_formatBytes(node.memBytes)} / ${_formatBytes(node.maxMemBytes)}',
                                      ratio: node.memRatio,
                                      color: _ok,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                    ],
                    // Workloads Section (QEMU VMs & LXC Containers)
                    if (_snapshot.authenticated) ...[
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Text(
                            'WORKLOADS (${filtered.length}/${_snapshot.resources.length})',
                            style: const TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.5,
                              color: _brandGold,
                            ),
                          ),
                          const Spacer(),
                          for (final f in const <String>['ALL', 'QEMU', 'LXC', 'RUNNING'])
                            Padding(
                              padding: const EdgeInsets.only(left: 4),
                              child: ChoiceChip(
                                label: Text(f, style: const TextStyle(fontSize: 10)),
                                selected: _typeFilter == f,
                                visualDensity: VisualDensity.compact,
                                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                selectedColor: _selectedBg,
                                backgroundColor: _headerBg,
                                labelStyle: TextStyle(
                                  fontWeight: FontWeight.w700,
                                  color: _typeFilter == f ? _brandGold : _muted,
                                ),
                                side: BorderSide(
                                  color: _typeFilter == f ? _brandGold : _lineInput,
                                ),
                                onSelected: (_) => setState(() => _typeFilter = f),
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      TextField(
                        key: const ValueKey('field_search_hypervisor_vms'),
                        controller: _searchCtrl,
                        onChanged: (v) => setState(() => _searchQuery = v.trim()),
                        style: const TextStyle(fontSize: 12.5, color: _text),
                        decoration: InputDecoration(
                          hintText: 'Search QEMU VM or LXC Container by name, VMID, or node...',
                          hintStyle: const TextStyle(fontSize: 11.5, color: _muted),
                          prefixIcon: const Icon(Icons.search_rounded, size: 17, color: _brandGold),
                          isDense: true,
                          filled: true,
                          fillColor: _headerBg,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(9),
                            borderSide: const BorderSide(color: _lineInput),
                          ),
                        ),
                      ),
                      const SizedBox(height: 10),
                      if (filtered.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 20),
                          child: Center(
                            child: Text(
                              'No QEMU VMs or LXC Containers match the current filter.',
                              style: TextStyle(fontSize: 12, color: _muted),
                            ),
                          ),
                        )
                      else
                        for (final vm in filtered) _buildResourceCard(vm),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildMetricBar({
    required String label,
    required double ratio,
    required Color color,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 10, fontFamily: 'monospace', color: _text2),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 3),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            minHeight: 5,
            value: ratio.clamp(0.0, 1.0),
            color: color,
            backgroundColor: _headerBg,
          ),
        ),
      ],
    );
  }

  Widget _buildResourceCard(ProxmoxResourceItem vm) {
    final vmKey = '${vm.node}:${vm.type}:${vm.vmid}';
    final isBusy = _busyVmKey == vmKey;
    final statusColor = vm.isRunning ? _ok : _muted;

    return Container(
      key: ValueKey('hv_resource_${vm.type}_${vm.vmid}'),
      margin: const EdgeInsets.only(bottom: 9),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _cardSurface,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(
          color: vm.isRunning ? _ok.withValues(alpha: 0.45) : _lineInput,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: _headerBg,
                  borderRadius: BorderRadius.circular(5),
                  border: Border.all(color: _brandGold.withValues(alpha: 0.45)),
                ),
                child: Text(
                  '${vm.type.toUpperCase()} #${vm.vmid}',
                  style: const TextStyle(
                    fontSize: 10,
                    fontFamily: 'monospace',
                    fontWeight: FontWeight.w800,
                    color: _brandGold,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  vm.name,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: _text,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(99),
                  border: Border.all(color: statusColor.withValues(alpha: 0.4)),
                ),
                child: Text(
                  '${vm.status.toUpperCase()} • ${vm.node}',
                  style: TextStyle(
                    fontSize: 9.5,
                    fontFamily: 'monospace',
                    fontWeight: FontWeight.w700,
                    color: statusColor,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: _buildMetricBar(
                  label: 'CPU ${(vm.cpu * 100).toStringAsFixed(1)}% (${vm.maxCpu}c)',
                  ratio: vm.cpu.clamp(0.0, 1.0),
                  color: _brandGold,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _buildMetricBar(
                  label: 'RAM ${_formatBytes(vm.memBytes)} / ${_formatBytes(vm.maxMemBytes)}',
                  ratio: vm.memRatio,
                  color: _ok,
                ),
              ),
            ],
          ),
          const SizedBox(height: 9),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              if (!vm.isRunning)
                FilledButton.tonalIcon(
                  key: ValueKey('btn_hv_start_${vm.vmid}'),
                  style: FilledButton.styleFrom(
                    backgroundColor: _ok.withValues(alpha: 0.18),
                    foregroundColor: _ok,
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 9),
                  ),
                  onPressed: isBusy ? null : () => _confirmAndRunPowerAction(vm, 'start'),
                  icon: const Icon(Icons.play_arrow_rounded, size: 15),
                  label: const Text('Start', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                ),
              if (vm.isRunning) ...[
                OutlinedButton.icon(
                  key: ValueKey('btn_hv_reboot_${vm.vmid}'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: _amber,
                    side: BorderSide(color: _amber.withValues(alpha: 0.55)),
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 9),
                  ),
                  onPressed: isBusy ? null : () => _confirmAndRunPowerAction(vm, 'reboot'),
                  icon: const Icon(Icons.restart_alt_rounded, size: 14),
                  label: const Text('Reboot', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                ),
                OutlinedButton.icon(
                  key: ValueKey('btn_hv_shutdown_${vm.vmid}'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: _danger,
                    side: BorderSide(color: _danger.withValues(alpha: 0.55)),
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 9),
                  ),
                  onPressed: isBusy ? null : () => _confirmAndRunPowerAction(vm, 'shutdown'),
                  icon: const Icon(Icons.power_settings_new_rounded, size: 14),
                  label: const Text('Shutdown', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
