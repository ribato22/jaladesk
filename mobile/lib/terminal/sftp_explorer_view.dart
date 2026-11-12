import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'sftp_transfer_service.dart';

class SftpFileEntry {
  final String name;
  final String permissions;
  final int sizeBytes;
  final String sizeLabel;
  final bool isDirectory;
  final DateTime? modifiedAt;

  const SftpFileEntry({
    required this.name,
    required this.permissions,
    required this.sizeBytes,
    required this.sizeLabel,
    required this.isDirectory,
    this.modifiedAt,
  });

  bool get isHidden => name.startsWith('.');
}

enum SftpSortMode { name, size }

/// World-class Termius / Transmit-grade SFTP File Manager view.
class SftpExplorerView extends StatefulWidget {
  final String currentPath;
  final bool isLiveSftp;
  final bool isLoading;
  final List<SftpFileEntry> entries;
  final ValueChanged<String> onNavigatePath;
  final VoidCallback onNavigateUp;
  final VoidCallback onRefresh;
  final Future<void> Function(String folderName)? onCreateFolder;
  final Future<void> Function(String fileName, String content)? onWriteTextFile;
  final Future<String> Function(SftpFileEntry entry)? onReadTextFile;
  final Future<void> Function(SftpFileEntry entry, String newName)? onRenameEntry;
  final Future<void> Function(SftpFileEntry entry)? onDeleteEntry;
  final Future<void> Function()? onUploadFiles;
  final Future<void> Function()? onUploadFolder;
  final Future<void> Function()? onOpenLocalWorkspaceTransfer;
  final Future<void> Function(SftpFileEntry entry)? onDownloadEntry;
  final SftpTransferProgress? activeTransfer;

  const SftpExplorerView({
    super.key,
    required this.currentPath,
    required this.isLiveSftp,
    this.isLoading = false,
    required this.entries,
    required this.onNavigatePath,
    required this.onNavigateUp,
    required this.onRefresh,
    this.onCreateFolder,
    this.onWriteTextFile,
    this.onReadTextFile,
    this.onRenameEntry,
    this.onDeleteEntry,
    this.onUploadFiles,
    this.onUploadFolder,
    this.onOpenLocalWorkspaceTransfer,
    this.onDownloadEntry,
    this.activeTransfer,
  });

  @override
  State<SftpExplorerView> createState() => _SftpExplorerViewState();
}

class _SftpExplorerViewState extends State<SftpExplorerView> {
  final TextEditingController _searchController = TextEditingController();
  String _query = '';
  bool _showDotfiles = false;
  bool _showSearchField = false;
  SftpSortMode _sortMode = SftpSortMode.name;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  List<({String label, String targetPath})> _buildBreadcrumbs() {
    final p = widget.currentPath.trim();
    if (p.isEmpty || p == '.') {
      return [(label: '~ (Home)', targetPath: '.')];
    }
    if (p.startsWith('./')) {
      final parts = p.substring(2).split('/').where((s) => s.isNotEmpty).toList();
      final crumbs = <({String label, String targetPath})>[
        (label: '~', targetPath: '.'),
      ];
      String acc = '.';
      for (final seg in parts) {
        acc = '$acc/$seg';
        crumbs.add((label: seg, targetPath: acc));
      }
      return crumbs;
    }
    if (p.startsWith('/')) {
      final parts = p.split('/').where((s) => s.isNotEmpty).toList();
      final crumbs = <({String label, String targetPath})>[
        (label: '/', targetPath: '/'),
      ];
      String acc = '';
      for (final seg in parts) {
        acc = '$acc/$seg';
        crumbs.add((label: seg, targetPath: acc));
      }
      return crumbs;
    }
    return [(label: p, targetPath: p)];
  }

  String _joinChildPath(String childName) {
    if (childName.startsWith('/')) return childName;
    final base = widget.currentPath.trim();
    if (base.isEmpty || base == '.') return './$childName';
    if (base == '/') return '/$childName';
    return '$base/$childName';
  }

  Future<void> _promptJumpToPath() async {
    final ctrl = TextEditingController(text: widget.currentPath);
    final nextPath = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF121A28),
        title: const Text('Go to Remote Path'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
          decoration: const InputDecoration(
            labelText: 'Remote directory path',
            hintText: '/etc/nginx or /var/log',
          ),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('Open'),
          ),
        ],
      ),
    );
    if (nextPath != null && nextPath.isNotEmpty) {
      widget.onNavigatePath(nextPath);
    }
  }

  (IconData, Color) _iconForEntry(SftpFileEntry e) {
    if (e.isDirectory) {
      return (
        e.isHidden ? Icons.folder_special_outlined : Icons.folder_rounded,
        e.isHidden ? const Color(0xFFB39246) : const Color(0xFFE0B454),
      );
    }
    final lower = e.name.toLowerCase();
    if (lower.endsWith('.yml') ||
        lower.endsWith('.yaml') ||
        lower.endsWith('.json') ||
        lower.endsWith('.toml') ||
        lower.endsWith('.conf') ||
        lower.contains('.env')) {
      return (Icons.tune_rounded, const Color(0xFF56D4DD));
    }
    if (lower.endsWith('.sh') ||
        lower.endsWith('.py') ||
        lower.endsWith('.js') ||
        lower.endsWith('.ts') ||
        lower.endsWith('.dart') ||
        lower.endsWith('.go')) {
      return (Icons.code_rounded, const Color(0xFF5CA8FF));
    }
    if (lower.endsWith('.pem') ||
        lower.endsWith('.key') ||
        lower.endsWith('.pub') ||
        lower.endsWith('.crt')) {
      return (Icons.vpn_key_outlined, const Color(0xFFC792EA));
    }
    if (lower.endsWith('.gz') ||
        lower.endsWith('.tar') ||
        lower.endsWith('.zip') ||
        lower.endsWith('.deb')) {
      return (Icons.inventory_2_outlined, const Color(0xFF42D392));
    }
    if (lower.endsWith('.log') || lower.endsWith('.md') || lower.endsWith('.txt')) {
      return (Icons.article_outlined, const Color(0xFF9AB0CC));
    }
    return (Icons.insert_drive_file_outlined, const Color(0xFF889BB5));
  }

  Future<void> _promptCreateFolder() async {
    if (widget.onCreateFolder == null) return;
    final ctrl = TextEditingController();
    final created = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF121A28),
        title: const Text('Create Remote Directory'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Folder name',
            hintText: 'e.g. releases',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('Create'),
          ),
        ],
      ),
    );
    if (created != null && created.isNotEmpty) {
      await widget.onCreateFolder!(created);
    }
  }

  Future<void> _promptCreateOrEditFile({SftpFileEntry? existing}) async {
    String initialText = '';
    if (existing != null && widget.onReadTextFile != null) {
      try {
        initialText = await widget.onReadTextFile!(existing);
      } catch (e) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Unable to read ${existing.name}: $e')),
        );
        return;
      }
    }
    if (!mounted) return;

    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final bodyCtrl = TextEditingController(text: initialText);

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF0E1522),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) {
        final bottomInset = MediaQuery.of(ctx).viewInsets.bottom;
        return Padding(
          padding: EdgeInsets.fromLTRB(16, 14, 16, bottomInset + 16),
          child: SizedBox(
            height: MediaQuery.of(ctx).size.height * 0.72,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.edit_note_rounded, color: Color(0xFFE0B454), size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        existing != null ? existing.name : 'New Remote File',
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    IconButton(
                      tooltip: 'Copy Content',
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: bodyCtrl.text));
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('File content copied to clipboard.')),
                        );
                      },
                      icon: const Icon(Icons.copy_rounded, size: 18),
                    ),
                    if (widget.onWriteTextFile != null)
                      FilledButton.icon(
                        onPressed: () async {
                          final targetName = existing?.name ?? nameCtrl.text.trim();
                          if (targetName.isEmpty) return;
                          Navigator.pop(ctx);
                          await widget.onWriteTextFile!(targetName, bodyCtrl.text);
                        },
                        icon: const Icon(Icons.cloud_upload_outlined, size: 16),
                        label: const Text('Save'),
                      ),
                  ],
                ),
                if (existing == null) ...[
                  const SizedBox(height: 10),
                  TextField(
                    controller: nameCtrl,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                    decoration: const InputDecoration(
                      labelText: 'File name',
                      hintText: 'docker-compose.override.yml',
                      isDense: true,
                    ),
                  ),
                ],
                const SizedBox(height: 10),
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFF080D16),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0xFF22324A)),
                    ),
                    child: TextField(
                      controller: bodyCtrl,
                      maxLines: null,
                      expands: true,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12.5,
                        height: 1.4,
                        color: Color(0xFFE6EDF7),
                      ),
                      decoration: const InputDecoration(
                        contentPadding: EdgeInsets.all(12),
                        border: InputBorder.none,
                        hintText: '# Remote file content...',
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _showEntryActions(SftpFileEntry entry) {
    final fullPath = _joinChildPath(entry.name);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF101826),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ListTile(
                  dense: true,
                  leading: Icon(
                    entry.isDirectory ? Icons.folder_rounded : Icons.insert_drive_file_outlined,
                    color: const Color(0xFFE0B454),
                  ),
                  title: Text(
                    entry.name,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  subtitle: Text(
                    '${entry.permissions}  •  ${entry.sizeLabel}  •  $fullPath',
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
                  ),
                ),
                const Divider(height: 1, color: Color(0xFF1E2B40)),
                if (widget.onDownloadEntry != null)
                  ListTile(
                    leading: const Icon(
                      Icons.download_rounded,
                      color: Color(0xFF4ADE80),
                    ),
                    title: Text(
                      entry.isDirectory
                          ? 'Download Folder (Recursive)'
                          : 'Download File to Device',
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        color: Color(0xFFE6EDF7),
                      ),
                    ),
                    subtitle: Text(
                      entry.isDirectory
                          ? 'Saves entire directory tree to Downloads/JalaDesk/${entry.name}'
                          : 'Saves ${entry.sizeLabel} to Downloads/JalaDesk/${entry.name}',
                      style: const TextStyle(fontSize: 11, color: Color(0xFF8CA2C0)),
                    ),
                    onTap: () async {
                      Navigator.pop(ctx);
                      await widget.onDownloadEntry!(entry);
                    },
                  ),
                if (entry.isDirectory)
                  ListTile(
                    leading: const Icon(Icons.folder_open_rounded),
                    title: const Text('Open Directory'),
                    onTap: () {
                      Navigator.pop(ctx);
                      widget.onNavigatePath(fullPath);
                    },
                  )
                else if (widget.onReadTextFile != null)
                  ListTile(
                    leading: const Icon(Icons.edit_note_rounded),
                    title: const Text('Inspect / Edit Text File'),
                    onTap: () {
                      Navigator.pop(ctx);
                      _promptCreateOrEditFile(existing: entry);
                    },
                  ),
                ListTile(
                  leading: const Icon(Icons.copy_rounded),
                  title: const Text('Copy Remote Path'),
                  onTap: () {
                    Navigator.pop(ctx);
                    Clipboard.setData(ClipboardData(text: fullPath));
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Copied path: $fullPath')),
                    );
                  },
                ),
                if (widget.onRenameEntry != null)
                  ListTile(
                    leading: const Icon(Icons.drive_file_rename_outline_rounded),
                    title: const Text('Rename'),
                    onTap: () async {
                      Navigator.pop(ctx);
                      final renameCtrl = TextEditingController(text: entry.name);
                      final nextName = await showDialog<String>(
                        context: context,
                        builder: (dCtx) => AlertDialog(
                          backgroundColor: const Color(0xFF121A28),
                          title: const Text('Rename Remote Item'),
                          content: TextField(
                            controller: renameCtrl,
                            autofocus: true,
                            decoration: const InputDecoration(labelText: 'New name'),
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(dCtx),
                              child: const Text('Cancel'),
                            ),
                            FilledButton(
                              onPressed: () => Navigator.pop(dCtx, renameCtrl.text.trim()),
                              child: const Text('Rename'),
                            ),
                          ],
                        ),
                      );
                      if (nextName != null && nextName.isNotEmpty && nextName != entry.name) {
                        await widget.onRenameEntry!(entry, nextName);
                      }
                    },
                  ),
                if (widget.onDeleteEntry != null)
                  ListTile(
                    leading: const Icon(Icons.delete_outline_rounded, color: Color(0xFFF06A6A)),
                    title: const Text('Delete', style: TextStyle(color: Color(0xFFF06A6A))),
                    onTap: () async {
                      Navigator.pop(ctx);
                      final confirmed = await showDialog<bool>(
                        context: context,
                        builder: (dCtx) => AlertDialog(
                          backgroundColor: const Color(0xFF121A28),
                          title: const Text('Delete Remote Item?'),
                          content: Text('Permanently delete "${entry.name}" from remote server?'),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(dCtx, false),
                              child: const Text('Cancel'),
                            ),
                            FilledButton(
                              style: FilledButton.styleFrom(
                                backgroundColor: const Color(0xFFD64545),
                              ),
                              onPressed: () => Navigator.pop(dCtx, true),
                              child: const Text('Delete'),
                            ),
                          ],
                        ),
                      );
                      if (confirmed == true) {
                        await widget.onDeleteEntry!(entry);
                      }
                    },
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final hiddenCount = widget.entries.where((e) => e.isHidden).length;
    final visibleEntries = widget.entries.where((e) {
      if (!_showDotfiles && e.isHidden) return false;
      if (_query.isNotEmpty && !e.name.toLowerCase().contains(_query.toLowerCase())) {
        return false;
      }
      return true;
    }).toList();

    visibleEntries.sort((a, b) {
      if (a.isDirectory != b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      if (_sortMode == SftpSortMode.size && !a.isDirectory && !b.isDirectory) {
        final cmp = b.sizeBytes.compareTo(a.sizeBytes);
        if (cmp != 0) return cmp;
      }
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });

    final crumbs = _buildBreadcrumbs();
    final mediaPadding = MediaQuery.paddingOf(context);
    final symInsetX = math.max(mediaPadding.left, mediaPadding.right);

    return Container(
      color: const Color(0xFF0A0F19),
      child: Column(
        children: [
          // Top Path Breadcrumb & SFTP Control Bar
          Container(
            padding: EdgeInsets.fromLTRB(symInsetX + 10, 8, symInsetX + 10, 8),
            decoration: const BoxDecoration(
              color: Color(0xFF0F1724),
              border: Border(
                bottom: BorderSide(color: Color(0xFF1E2B40), width: 1),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    // Up button
                    InkWell(
                      borderRadius: BorderRadius.circular(6),
                      onTap: widget.onNavigateUp,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
                        decoration: BoxDecoration(
                          color: const Color(0xFF162133),
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: const Color(0xFF263852)),
                        ),
                        child: const Icon(
                          Icons.arrow_upward_rounded,
                          size: 15,
                          color: Color(0xFFE0B454),
                          semanticLabel: 'Parent Directory',
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    // Interactive Breadcrumbs + Full Path Display
                    Expanded(
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            for (int i = 0; i < crumbs.length; i++) ...[
                              if (i > 0)
                                const Padding(
                                  padding: EdgeInsets.symmetric(horizontal: 3),
                                  child: Icon(
                                    Icons.chevron_right_rounded,
                                    size: 15,
                                    color: Color(0xFF617591),
                                  ),
                                ),
                              InkWell(
                                borderRadius: BorderRadius.circular(5),
                                onTap: () => widget.onNavigatePath(crumbs[i].targetPath),
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
                                  child: Text(
                                    crumbs[i].label,
                                    style: TextStyle(
                                      fontFamily: 'monospace',
                                      fontSize: 12,
                                      fontWeight: i == crumbs.length - 1
                                          ? FontWeight.w700
                                          : FontWeight.w500,
                                      color: i == crumbs.length - 1
                                          ? const Color(0xFFE6EDF7)
                                          : const Color(0xFF8CA2C0),
                                    ),
                                  ),
                                ),
                              ),
                            ],
                            if (crumbs.length > 1 && widget.currentPath.startsWith('/')) ...[
                              const SizedBox(width: 8),
                              Text(
                                widget.currentPath,
                                style: const TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 10.5,
                                  color: Color(0xFF5D728F),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
                      padding: EdgeInsets.zero,
                      tooltip: 'Go to Path',
                      onPressed: _promptJumpToPath,
                      icon: const Icon(Icons.alt_route_rounded, size: 17, color: Color(0xFF9AB0CC)),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
                      padding: EdgeInsets.zero,
                      tooltip: 'Filter Files',
                      onPressed: () {
                        setState(() {
                          _showSearchField = !_showSearchField;
                          if (!_showSearchField) {
                            _searchController.clear();
                            _query = '';
                          }
                        });
                      },
                      icon: Icon(
                        Icons.search_rounded,
                        size: 17,
                        color: _showSearchField
                            ? const Color(0xFFE0B454)
                            : const Color(0xFF9AB0CC),
                      ),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
                      padding: EdgeInsets.zero,
                      tooltip: 'Refresh Directory',
                      onPressed: widget.onRefresh,
                      icon: const Icon(Icons.refresh_rounded, size: 17, color: Color(0xFF9AB0CC)),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                // Secondary utility strip: responsive Wrap so every action stays on-screen on 360px+ phones
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (widget.onUploadFiles != null ||
                        widget.onUploadFolder != null ||
                        widget.onOpenLocalWorkspaceTransfer != null)
                      _buildToolbarPill(
                        key: const ValueKey('btn_sftp_upload_menu'),
                        icon: Icons.cloud_upload_outlined,
                        label: 'Upload',
                        active: true,
                        onTap: _showUploadSourceSheet,
                      ),
                    if (widget.onCreateFolder != null)
                      _buildToolbarPill(
                        icon: Icons.create_new_folder_outlined,
                        label: 'New Folder',
                        onTap: _promptCreateFolder,
                      ),
                    if (widget.onWriteTextFile != null)
                      _buildToolbarPill(
                        icon: Icons.note_add_outlined,
                        label: 'New File',
                        onTap: () => _promptCreateOrEditFile(),
                      ),
                    _buildToolbarPill(
                      key: const ValueKey('btn_sftp_toggle_dotfiles'),
                      icon: _showDotfiles
                          ? Icons.visibility_rounded
                          : Icons.visibility_off_outlined,
                      label: hiddenCount > 0 ? '.dotfiles ($hiddenCount)' : '.dotfiles',
                      active: _showDotfiles,
                      onTap: () => setState(() => _showDotfiles = !_showDotfiles),
                    ),
                    _buildToolbarPill(
                      icon: Icons.swap_vert_rounded,
                      label: _sortMode == SftpSortMode.name ? 'Sort: Name' : 'Sort: Size',
                      onTap: () => setState(() {
                        _sortMode = _sortMode == SftpSortMode.name
                            ? SftpSortMode.size
                            : SftpSortMode.name;
                      }),
                    ),
                    Text(
                      '${visibleEntries.length} items',
                      style: const TextStyle(
                        fontSize: 11,
                        fontFeatures: [FontFeature.tabularFigures()],
                        color: Color(0xFF6E829F),
                      ),
                    ),
                  ],
                ),
                if (_showSearchField) ...[
                  const SizedBox(height: 8),
                  SizedBox(
                    height: 34,
                    child: TextField(
                      controller: _searchController,
                      autofocus: true,
                      style: const TextStyle(fontSize: 12.5),
                      onChanged: (v) => setState(() => _query = v.trim()),
                      decoration: InputDecoration(
                        hintText: 'Filter current directory...',
                        hintStyle: const TextStyle(fontSize: 12),
                        prefixIcon: const Icon(Icons.filter_list_rounded, size: 16),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 10),
                        filled: true,
                        fillColor: const Color(0xFF090E17),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: const BorderSide(color: Color(0xFF24344D)),
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),

          if (widget.isLoading)
            const LinearProgressIndicator(
              minHeight: 2,
              color: Color(0xFFE0B454),
              backgroundColor: Color(0xFF141E2E),
            ),

          if (widget.activeTransfer != null)
            _buildLiveTransferBanner(widget.activeTransfer!),

          // High-Density File & Directory List
          Expanded(
            child: visibleEntries.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.folder_open_outlined,
                            size: 36,
                            color: Color(0xFF516480),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            hiddenCount > 0 && !_showDotfiles
                                ? 'Only hidden dotfiles ($hiddenCount) in this folder.'
                                : 'No matching files in this directory.',
                            textAlign: TextAlign.center,
                            style: const TextStyle(color: Color(0xFF8CA2C0), fontSize: 13),
                          ),
                          if (hiddenCount > 0 && !_showDotfiles) ...[
                            const SizedBox(height: 10),
                            OutlinedButton.icon(
                              onPressed: () => setState(() => _showDotfiles = true),
                              icon: const Icon(Icons.visibility_rounded, size: 16),
                              label: Text('Show $hiddenCount Hidden Items'),
                            ),
                          ],
                        ],
                      ),
                    ),
                  )
                : ListView.separated(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    itemCount: visibleEntries.length,
                    separatorBuilder: (_, __) => const Divider(
                      height: 1,
                      indent: 48,
                      color: Color(0xFF152031),
                    ),
                    itemBuilder: (context, idx) {
                      final item = visibleEntries[idx];
                      final (iconData, iconColor) = _iconForEntry(item);
                      return InkWell(
                        onTap: () {
                          if (item.isDirectory) {
                            widget.onNavigatePath(_joinChildPath(item.name));
                          } else if (widget.onReadTextFile != null) {
                            _promptCreateOrEditFile(existing: item);
                          } else {
                            _showEntryActions(item);
                          }
                        },
                        onLongPress: () => _showEntryActions(item),
                        child: Padding(
                          padding: EdgeInsets.symmetric(horizontal: symInsetX + 12, vertical: 9),
                          child: Row(
                            children: [
                              Container(
                                width: 32,
                                height: 32,
                                decoration: BoxDecoration(
                                  color: iconColor.withValues(alpha: 0.12),
                                  borderRadius: BorderRadius.circular(7),
                                ),
                                child: Icon(iconData, size: 18, color: iconColor),
                              ),
                              const SizedBox(width: 11),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      item.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 13.5,
                                        fontWeight: item.isDirectory
                                            ? FontWeight.w600
                                            : FontWeight.w500,
                                        color: const Color(0xFFE6EDF7),
                                      ),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      item.isDirectory
                                          ? '${item.permissions}  •  Folder'
                                          : '${item.permissions}  •  ${item.sizeLabel}',
                                      style: const TextStyle(
                                        fontFamily: 'monospace',
                                        fontSize: 11,
                                        color: Color(0xFF7B90AD),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              if (item.isDirectory)
                                const Icon(
                                  Icons.chevron_right_rounded,
                                  size: 18,
                                  color: Color(0xFF607491),
                                )
                              else
                                Text(
                                  item.sizeLabel,
                                  style: const TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: 11,
                                    color: Color(0xFF8CA2C0),
                                  ),
                                ),
                              if (widget.onDownloadEntry != null) ...[
                                const SizedBox(width: 4),
                                IconButton(
                                  visualDensity: VisualDensity.compact,
                                  constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
                                  padding: EdgeInsets.zero,
                                  tooltip: item.isDirectory
                                      ? 'Download Folder (${item.name})'
                                      : 'Download File (${item.name})',
                                  icon: const Icon(
                                    Icons.download_rounded,
                                    size: 17,
                                    color: Color(0xFF8CA2C0),
                                  ),
                                  onPressed: () => widget.onDownloadEntry!(item),
                                ),
                              ],
                              const SizedBox(width: 2),
                              IconButton(
                                visualDensity: VisualDensity.compact,
                                constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                                padding: EdgeInsets.zero,
                                icon: const Icon(
                                  Icons.more_horiz_rounded,
                                  size: 18,
                                  color: Color(0xFF7B90AD),
                                ),
                                tooltip: 'Actions',
                                onPressed: () => _showEntryActions(item),
                              ),
                            ],
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

  void _showUploadSourceSheet() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF121A28),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                dense: true,
                leading: const Icon(Icons.cloud_upload_rounded, color: Color(0xFFE0B454)),
                title: const Text(
                  'Upload to Remote Server',
                  style: TextStyle(fontWeight: FontWeight.w700, color: Color(0xFFE6EDF7)),
                ),
                subtitle: Text(
                  'Destination: ${widget.currentPath}',
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: Color(0xFF8CA2C0)),
                ),
              ),
              const Divider(height: 1, color: Color(0xFF1E2B40)),
              if (widget.onUploadFiles != null)
                ListTile(
                  key: const ValueKey('btn_sftp_pick_files'),
                  leading: const Icon(Icons.upload_file_rounded, color: Color(0xFF60A5FA)),
                  title: const Text('Upload File(s) from Device'),
                  subtitle: const Text(
                    'Select one or multiple files via system picker (64KB streaming)',
                    style: TextStyle(fontSize: 11.5, color: Color(0xFF8CA2C0)),
                  ),
                  onTap: () {
                    Navigator.pop(ctx);
                    widget.onUploadFiles!();
                  },
                ),
              if (widget.onUploadFolder != null)
                ListTile(
                  key: const ValueKey('btn_sftp_pick_folder'),
                  leading: const Icon(Icons.drive_folder_upload_rounded, color: Color(0xFFE0B454)),
                  title: const Text('Upload Entire Folder (Recursive)'),
                  subtitle: const Text(
                    'Select a local folder and upload all nested subdirectories & files',
                    style: TextStyle(fontSize: 11.5, color: Color(0xFF8CA2C0)),
                  ),
                  onTap: () {
                    Navigator.pop(ctx);
                    widget.onUploadFolder!();
                  },
                ),
              if (widget.onOpenLocalWorkspaceTransfer != null)
                ListTile(
                  key: const ValueKey('btn_sftp_local_workspace'),
                  leading: const Icon(Icons.folder_copy_outlined, color: Color(0xFF4ADE80)),
                  title: const Text('Local JalaDesk Transfer Workspace'),
                  subtitle: const Text(
                    'Browse or stage local files & folders directly inside app storage',
                    style: TextStyle(fontSize: 11.5, color: Color(0xFF8CA2C0)),
                  ),
                  onTap: () {
                    Navigator.pop(ctx);
                    widget.onOpenLocalWorkspaceTransfer!();
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLiveTransferBanner(SftpTransferProgress tx) {
    final isUpload = tx.direction == SftpTransferDirection.upload;
    final pct = tx.fraction != null ? '${(tx.fraction! * 100).round()}%' : '';
    final accent = tx.errorMessage != null
        ? const Color(0xFFF06A6A)
        : (tx.isDone ? const Color(0xFF4ADE80) : const Color(0xFFE0B454));

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      decoration: const BoxDecoration(
        color: Color(0xFF111B2B),
        border: Border(bottom: BorderSide(color: Color(0xFF22334D))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                tx.errorMessage != null
                    ? Icons.error_outline_rounded
                    : (tx.isDone
                        ? Icons.check_circle_outline_rounded
                        : (isUpload ? Icons.upload_rounded : Icons.download_rounded)),
                size: 15,
                color: accent,
              ),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  tx.errorMessage != null
                      ? 'Transfer failed: ${tx.errorMessage}'
                      : (tx.isDone
                          ? '${isUpload ? "Uploaded" : "Downloaded"} ${tx.rootName}${tx.savedDestination != null ? " → ${tx.savedDestination}" : ""}'
                          : '${isUpload ? "Uploading" : "Downloading"} ${tx.rootName} • ${tx.currentItem}'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFFE6EDF7),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${tx.filesCompleted}/${tx.totalFiles} • ${SftpTransferProgress.formatBytes(tx.bytesTransferred)} $pct',
                style: TextStyle(
                  fontSize: 10.5,
                  fontFamily: 'monospace',
                  fontFeatures: const [FontFeature.tabularFigures()],
                  color: accent,
                ),
              ),
            ],
          ),
          if (!tx.isDone && tx.errorMessage == null) ...[
            const SizedBox(height: 5),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: tx.fraction,
                minHeight: 3,
                color: accent,
                backgroundColor: const Color(0xFF1B2940),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildToolbarPill({
    Key? key,
    required IconData icon,
    required String label,
    required VoidCallback onTap,
    bool active = false,
  }) {
    return InkWell(
      key: key,
      borderRadius: BorderRadius.circular(6),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: active ? const Color(0xFF292316) : const Color(0xFF141E2E),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(
            color: active ? const Color(0xFFE0B454) : const Color(0xFF25354D),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 13,
              color: active ? const Color(0xFFE0B454) : const Color(0xFF9AB0CC),
            ),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: active ? const Color(0xFFE0B454) : const Color(0xFFD0DCEB),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
