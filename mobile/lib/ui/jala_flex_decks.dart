import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'jala_enterprise_components.dart';

/// Lightweight TOTP entry DTO passed into Flex decks for zero-obstruction
/// inline 2FA Auto-Type without ever covering the top remote display.
@immutable
class JalaFlexTotpEntry {
  final String id;
  final String issuer;
  final String account;
  final String code;
  final int remainingSeconds;

  const JalaFlexTotpEntry({
    required this.id,
    required this.issuer,
    required this.account,
    required this.code,
    required this.remainingSeconds,
  });
}

/// Lightweight terminal snippet DTO for 1-tap execution from the SSH Flex deck.
@immutable
class JalaFlexSnippetEntry {
  final String id;
  final String label;
  final String command;
  final String? category;

  const JalaFlexSnippetEntry({
    required this.id,
    required this.label,
    required this.command,
    this.category,
  });
}

class _FlexDeckColors {
  static const Color deckBg = Color(0xFF0A0F18);
  static const Color panelBg = Color(0xFF101826);
  static const Color panelBorder = Color(0xFF233246);
  static const Color trackpadBg = Color(0xFF0D1420);
  static const Color trackpadBorder = Color(0xFF283A52);
  static const Color keycapBg = Color(0xFF152031);
  static const Color keycapBorder = Color(0xFF2A3C54);
  static const Color keycapActiveBg = Color(0xFF1D3554);
  static const Color keycapDangerBg = Color(0xFF2C161B);
  static const Color keycapDangerBorder = Color(0xFF6B2A34);
  static const Color chipBg = Color(0xFF131D2C);
  static const Color chipSelectedBg = Color(0xFF1C304A);
}

/// Mini-Laptop bottom control deck for RDP & VNC Tabletop Flex Mode.
///
/// Renders a precision multi-touch trackpad + hardware mouse buttons + sticky
/// modifier/shortcut/F1-F12/arrow deck + inline 2FA auto-type drawer, and
/// automatically collapses into a single overflow-proof `44dp` utility ribbon
/// above the soft keyboard whenever [viewInsetsBottom] > 0.
class JalaFlexDesktopTrackpadDeck extends StatefulWidget {
  final String hostTitle;
  final String protocolLabel;
  final bool isLiveConnected;
  final bool isFullScreen;
  final double viewInsetsBottom;
  final bool ctrlLatched;
  final bool altLatched;
  final bool winLatched;
  final bool shiftLatched;
  final bool dragLockActive;
  final String fitModeLabel;
  final List<JalaFlexTotpEntry> totpEntries;
  final int activeTabIndex;

  final ValueChanged<int> onSelectTab;
  final ValueChanged<Offset> onPointerMoveDelta;
  final VoidCallback onLeftClick;
  final VoidCallback onMiddleClick;
  final VoidCallback onRightClick;
  final VoidCallback onToggleDragLock;
  final ValueChanged<double> onScrollDelta;
  final ValueChanged<double> onPinchScale;
  final ValueChanged<String> onSpecialKey;
  final ValueChanged<String> onToggleModifier;
  final VoidCallback onToggleSoftKeyboard;
  final VoidCallback onCycleFitMode;
  final VoidCallback onOpenDisplaySizing;
  final VoidCallback onPasteClipboard;
  final ValueChanged<String> onAutoTypeTotp;
  final VoidCallback onToggleFlexOverride;
  final VoidCallback onDisconnect;
  final VoidCallback onConnect;

  const JalaFlexDesktopTrackpadDeck({
    super.key,
    required this.hostTitle,
    required this.protocolLabel,
    required this.isLiveConnected,
    required this.isFullScreen,
    required this.viewInsetsBottom,
    required this.ctrlLatched,
    required this.altLatched,
    required this.winLatched,
    required this.shiftLatched,
    required this.dragLockActive,
    required this.fitModeLabel,
    required this.totpEntries,
    this.activeTabIndex = 1,
    required this.onSelectTab,
    required this.onPointerMoveDelta,
    required this.onLeftClick,
    required this.onMiddleClick,
    required this.onRightClick,
    required this.onToggleDragLock,
    required this.onScrollDelta,
    required this.onPinchScale,
    required this.onSpecialKey,
    required this.onToggleModifier,
    required this.onToggleSoftKeyboard,
    required this.onCycleFitMode,
    required this.onOpenDisplaySizing,
    required this.onPasteClipboard,
    required this.onAutoTypeTotp,
    required this.onToggleFlexOverride,
    required this.onDisconnect,
    required this.onConnect,
  });

  @override
  State<JalaFlexDesktopTrackpadDeck> createState() =>
      _JalaFlexDesktopTrackpadDeckState();
}

class _JalaFlexDesktopTrackpadDeckState
    extends State<JalaFlexDesktopTrackpadDeck> {
  bool _showFnRow = false;
  bool _showTotpDrawer = false;

  // Multi-touch trackpad gesture state.
  final Map<int, Offset> _activePointers = <int, Offset>{};
  final Map<int, Offset> _initialPointers = <int, Offset>{};
  int _gestureMaxPointers = 0;
  DateTime? _gestureStartTime;
  double _gestureTotalTravel = 0.0;
  double? _lastTwoFingerSpan;
  Offset? _lastTwoFingerCenter;
  String _trackpadHint = '1F Move/Tap · 2F Scroll/Pinch/Right · 3F KB';

  void _triggerHaptic() {
    HapticFeedback.selectionClick();
  }

  void _handleTrackpadDown(PointerDownEvent event) {
    if (_activePointers.isEmpty) {
      _gestureMaxPointers = 0;
      _gestureStartTime = DateTime.now();
      _gestureTotalTravel = 0.0;
      _lastTwoFingerSpan = null;
      _lastTwoFingerCenter = null;
    }
    _activePointers[event.pointer] = event.localPosition;
    _initialPointers[event.pointer] = event.localPosition;
    if (_activePointers.length > _gestureMaxPointers) {
      _gestureMaxPointers = _activePointers.length;
    }
    if (_activePointers.length == 2) {
      final pts = _activePointers.values.toList(growable: false);
      _lastTwoFingerSpan = (pts[0] - pts[1]).distance;
      _lastTwoFingerCenter = (pts[0] + pts[1]) / 2.0;
    }
  }

  void _handleTrackpadMove(PointerMoveEvent event) {
    final prev = _activePointers[event.pointer];
    if (prev == null) return;
    final next = event.localPosition;
    final delta = next - prev;
    _activePointers[event.pointer] = next;
    _gestureTotalTravel += delta.distance;

    if (_activePointers.length == 1 && _gestureMaxPointers == 1) {
      // Smooth ballistic pointer acceleration for desktop precision.
      final speed = delta.distance;
      final gain = (1.15 + math.min(speed * 0.045, 1.45)).clamp(1.15, 2.6);
      widget.onPointerMoveDelta(Offset(delta.dx * gain, delta.dy * gain));
    } else if (_activePointers.length == 2) {
      final pts = _activePointers.values.toList(growable: false);
      final span = (pts[0] - pts[1]).distance;
      final center = (pts[0] + pts[1]) / 2.0;

      if (_lastTwoFingerSpan != null && _lastTwoFingerSpan! > 24.0) {
        final ratio = span / _lastTwoFingerSpan!;
        if ((ratio - 1.0).abs() > 0.015) {
          widget.onPinchScale(ratio.clamp(0.85, 1.18));
        }
      }
      if (_lastTwoFingerCenter != null) {
        final dy = center.dy - _lastTwoFingerCenter!.dy;
        if (dy.abs() > 0.5) {
          widget.onScrollDelta(dy);
        }
      }
      _lastTwoFingerSpan = span;
      _lastTwoFingerCenter = center;
    }
  }

  void _handleTrackpadUp(PointerUpEvent event) {
    _activePointers.remove(event.pointer);
    if (_activePointers.length < 2) {
      _lastTwoFingerSpan = null;
      _lastTwoFingerCenter = null;
    }

    if (_activePointers.isEmpty) {
      final elapsedMs = _gestureStartTime == null
          ? 9999
          : DateTime.now().difference(_gestureStartTime!).inMilliseconds;
      final maxFingers = _gestureMaxPointers;
      final travel = _gestureTotalTravel;
      _initialPointers.clear();
      _gestureMaxPointers = 0;
      _gestureStartTime = null;

      if (maxFingers == 1 && elapsedMs <= 260 && travel <= 12.0) {
        _triggerHaptic();
        widget.onLeftClick();
        setState(() => _trackpadHint = 'Left Click');
      } else if (maxFingers == 2 && elapsedMs <= 320 && travel <= 20.0) {
        _triggerHaptic();
        widget.onRightClick();
        setState(() => _trackpadHint = 'Right Click');
      } else if (maxFingers >= 3 && elapsedMs <= 360 && travel <= 28.0) {
        _triggerHaptic();
        widget.onToggleSoftKeyboard();
        setState(() => _trackpadHint = 'Soft Keyboard Toggled');
      }
    }
  }

  void _handleTrackpadCancel(PointerCancelEvent event) {
    _activePointers.remove(event.pointer);
    _initialPointers.remove(event.pointer);
    if (_activePointers.isEmpty) {
      _gestureMaxPointers = 0;
      _gestureStartTime = null;
      _lastTwoFingerSpan = null;
      _lastTwoFingerCenter = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('flex_desktop_bottom_deck'),
      color: _FlexDeckColors.deckBg,
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (widget.viewInsetsBottom > 0) {
            return _buildSoftKeyboardSafeRibbon(constraints.maxHeight);
          }

          final isWide = constraints.maxWidth >= 520.0;
          return SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _buildTopUtilityBar(),
                  const SizedBox(height: 6),
                  Expanded(
                    child: isWide
                        ? Row(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Expanded(
                                flex: 6,
                                child: _buildTrackpadColumn(compact: false),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                flex: 4,
                                child: _showTotpDrawer
                                    ? _buildInlineTotpDrawer()
                                    : _buildShortcutDeck(compact: false),
                              ),
                            ],
                          )
                        : Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Expanded(
                                flex: 5,
                                child: _buildTrackpadColumn(compact: true),
                              ),
                              const SizedBox(height: 6),
                              Expanded(
                                flex: 5,
                                child: _showTotpDrawer
                                    ? _buildInlineTotpDrawer()
                                    : _buildShortcutDeck(compact: true),
                              ),
                            ],
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

  /// Overflow-proof 44dp utility ribbon anchored directly above the soft IME
  /// without ever shrinking the top remote display pane.
  Widget _buildSoftKeyboardSafeRibbon(double maxHeight) {
    final ribbonHeight = math.min(44.0, math.max(0.0, maxHeight));
    final bottomInset = math.min(
      widget.viewInsetsBottom,
      math.max(0.0, maxHeight - ribbonHeight),
    );

    return Align(
      alignment: Alignment.bottomCenter,
      child: Padding(
        padding: EdgeInsets.only(bottom: bottomInset),
        child: Container(
          key: const Key('flex_desktop_ime_ribbon'),
          height: ribbonHeight,
          width: double.infinity,
          decoration: const BoxDecoration(
            color: JalaEnterpriseTokens.headerBg,
            border: Border(
              top: BorderSide(
                color: JalaEnterpriseTokens.headerBorder,
                width: 1.0,
              ),
            ),
          ),
          child: _showTotpDrawer
              ? _buildCompactInlineTotpStrip()
              : SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 5,
                  ),
                  child: Row(
                    children: [
                      _FlexKeycap(
                        label: 'Esc',
                        onTap: () => widget.onSpecialKey('Esc'),
                      ),
                      const SizedBox(width: 5),
                      _FlexKeycap(
                        label: 'Tab',
                        onTap: () => widget.onSpecialKey('Tab'),
                      ),
                      const SizedBox(width: 5),
                      _FlexKeycap(
                        label: 'Ctrl',
                        active: widget.ctrlLatched,
                        onTap: () => widget.onToggleModifier('Ctrl'),
                      ),
                      const SizedBox(width: 5),
                      _FlexKeycap(
                        label: 'Alt',
                        active: widget.altLatched,
                        onTap: () => widget.onToggleModifier('Alt'),
                      ),
                      const SizedBox(width: 5),
                      _FlexKeycap(
                        label: 'Win',
                        active: widget.winLatched,
                        onTap: () => widget.onToggleModifier('Win'),
                      ),
                      const SizedBox(width: 5),
                      _FlexKeycap(
                        key: const Key('btn_flex_totp_picker'),
                        label: '2FA',
                        icon: Icons.verified_user_outlined,
                        active: _showTotpDrawer,
                        accentColor: JalaEnterpriseTokens.segmentGold,
                        onTap: () =>
                            setState(() => _showTotpDrawer = !_showTotpDrawer),
                      ),
                      const SizedBox(width: 5),
                      _FlexKeycap(
                        key: const Key('btn_flex_toggle_kb'),
                        label: 'Hide KB',
                        icon: Icons.keyboard_hide_rounded,
                        accentColor: JalaEnterpriseTokens.accentPrimary,
                        onTap: widget.onToggleSoftKeyboard,
                      ),
                    ],
                  ),
                ),
        ),
      ),
    );
  }

  Widget _buildCompactInlineTotpStrip() {
    return SingleChildScrollView(
      key: const Key('flex_totp_inline_drawer'),
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      child: Row(
        children: [
          _FlexKeycap(
            label: 'Back',
            icon: Icons.arrow_back_rounded,
            onTap: () => setState(() => _showTotpDrawer = false),
          ),
          const SizedBox(width: 6),
          if (widget.totpEntries.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 8),
              child: Text(
                'No 2FA entries in Vault',
                style: TextStyle(
                  fontSize: 12,
                  color: JalaEnterpriseTokens.textSecondary,
                ),
              ),
            )
          else
            for (final entry in widget.totpEntries) ...[
              _FlexKeycap(
                label: '${entry.issuer}: ${entry.code}',
                accentColor: JalaEnterpriseTokens.segmentGold,
                onTap: () {
                  _triggerHaptic();
                  widget.onAutoTypeTotp(entry.code);
                  setState(() => _showTotpDrawer = false);
                },
              ),
              const SizedBox(width: 6),
            ],
        ],
      ),
    );
  }

  Widget _buildTopUtilityBar() {
    final statusColor = widget.isLiveConnected
        ? JalaEnterpriseTokens.statusOk
        : JalaEnterpriseTokens.statusWarn;
    final cleanHost = widget.hostTitle.trim().isEmpty
        ? 'Desktop Session'
        : widget.hostTitle.trim();

    return Container(
      height: 36,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(
        color: _FlexDeckColors.panelBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: _FlexDeckColors.panelBorder, width: 1.0),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            _FlexTabPill(
              key: const Key('btn_flex_tab_0'),
              label: 'Hosts',
              selected: widget.activeTabIndex == 0,
              onTap: () => widget.onSelectTab(0),
            ),
            const SizedBox(width: 4),
            _FlexTabPill(
              key: const Key('btn_flex_tab_1'),
              label: 'RDP',
              selected: widget.activeTabIndex == 1,
              onTap: () => widget.onSelectTab(1),
            ),
            const SizedBox(width: 4),
            _FlexTabPill(
              key: const Key('btn_flex_tab_2'),
              label: 'SSH',
              selected: widget.activeTabIndex == 2,
              onTap: () => widget.onSelectTab(2),
            ),
            const SizedBox(width: 4),
            _FlexTabPill(
              key: const Key('btn_flex_tab_3'),
              label: 'Vault',
              selected: widget.activeTabIndex == 3,
              onTap: () => widget.onSelectTab(3),
            ),
            const SizedBox(width: 10),
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(
                color: statusColor,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 150),
              child: Text(
                '$cleanHost · ${widget.protocolLabel}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: JalaEnterpriseTokens.textPrimary,
                ),
              ),
            ),
            const SizedBox(width: 10),
            _FlexActionPill(
              key: const Key('btn_flex_fit_mode'),
              label: widget.fitModeLabel,
              icon: Icons.fit_screen_rounded,
              onTap: widget.onCycleFitMode,
            ),
            const SizedBox(width: 4),
            _FlexActionPill(
              key: const Key('btn_flex_display_sizing'),
              label: 'Display',
              icon: Icons.aspect_ratio_rounded,
              onTap: widget.onOpenDisplaySizing,
            ),
            const SizedBox(width: 4),
            _FlexActionPill(
              key: const Key('btn_flex_override_toggle'),
              label: 'Flex Off',
              icon: Icons.unfold_less_rounded,
              onTap: widget.onToggleFlexOverride,
            ),
            const SizedBox(width: 4),
            if (widget.isLiveConnected)
              _FlexActionPill(
                key: const Key('btn_flex_disconnect'),
                label: 'Disconnect',
                icon: Icons.power_settings_new_rounded,
                danger: true,
                onTap: widget.onDisconnect,
              )
            else
              _FlexActionPill(
                key: const Key('btn_flex_connect'),
                label: 'Connect',
                icon: Icons.play_arrow_rounded,
                accentColor: JalaEnterpriseTokens.statusOk,
                onTap: widget.onConnect,
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildTrackpadColumn({required bool compact}) {
    final buttonHeight = compact ? 34.0 : 38.0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: Listener(
            behavior: HitTestBehavior.opaque,
            onPointerDown: _handleTrackpadDown,
            onPointerMove: _handleTrackpadMove,
            onPointerUp: _handleTrackpadUp,
            onPointerCancel: _handleTrackpadCancel,
            child: Container(
              key: const Key('flex_trackpad_surface'),
              decoration: BoxDecoration(
                color: _FlexDeckColors.trackpadBg,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: widget.dragLockActive
                      ? JalaEnterpriseTokens.segmentGold
                      : _FlexDeckColors.trackpadBorder,
                  width: widget.dragLockActive ? 1.4 : 1.0,
                ),
              ),
              child: Stack(
                children: [
                  Center(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            widget.dragLockActive
                                ? Icons.pan_tool_alt_rounded
                                : Icons.touch_app_rounded,
                            size: compact ? 18 : 22,
                            color: widget.dragLockActive
                                ? JalaEnterpriseTokens.segmentGold
                                : JalaEnterpriseTokens.textMuted,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            widget.dragLockActive
                                ? 'Drag-Lock Active'
                                : 'Precision Trackpad',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: widget.dragLockActive
                                  ? JalaEnterpriseTokens.segmentGold
                                  : JalaEnterpriseTokens.textSecondary,
                            ),
                          ),
                          if (!compact) ...[
                            const SizedBox(height: 2),
                            Text(
                              _trackpadHint,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 11,
                                color: JalaEnterpriseTokens.textMuted,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                  if (widget.ctrlLatched ||
                      widget.altLatched ||
                      widget.winLatched ||
                      widget.shiftLatched)
                    Positioned(
                      top: 8,
                      right: 8,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: _FlexDeckColors.keycapActiveBg,
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(
                            color: JalaEnterpriseTokens.accentPrimary,
                          ),
                        ),
                        child: Text(
                          [
                            if (widget.ctrlLatched) 'Ctrl',
                            if (widget.altLatched) 'Alt',
                            if (widget.winLatched) 'Win',
                            if (widget.shiftLatched) 'Shift',
                          ].join('+'),
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            color: JalaEnterpriseTokens.textPrimary,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: 6),
        SizedBox(
          height: buttonHeight,
          child: Row(
            children: [
              Expanded(
                flex: 3,
                child: _FlexMouseButton(
                  key: const Key('btn_flex_mouse_left'),
                  label: 'Left',
                  onTap: () {
                    _triggerHaptic();
                    widget.onLeftClick();
                  },
                ),
              ),
              const SizedBox(width: 5),
              Expanded(
                flex: 2,
                child: _FlexMouseButton(
                  key: const Key('btn_flex_mouse_mid'),
                  label: 'Mid',
                  onTap: () {
                    _triggerHaptic();
                    widget.onMiddleClick();
                  },
                ),
              ),
              const SizedBox(width: 5),
              Expanded(
                flex: 3,
                child: _FlexMouseButton(
                  key: const Key('btn_flex_mouse_draglock'),
                  label: 'Drag-Lock',
                  active: widget.dragLockActive,
                  accentColor: JalaEnterpriseTokens.segmentGold,
                  onTap: () {
                    _triggerHaptic();
                    widget.onToggleDragLock();
                  },
                ),
              ),
              const SizedBox(width: 5),
              Expanded(
                flex: 3,
                child: _FlexMouseButton(
                  key: const Key('btn_flex_mouse_right'),
                  label: 'Right',
                  onTap: () {
                    _triggerHaptic();
                    widget.onRightClick();
                  },
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildShortcutDeck({required bool compact}) {
    return Container(
      padding: EdgeInsets.all(compact ? 6 : 8),
      decoration: BoxDecoration(
        color: _FlexDeckColors.panelBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _FlexDeckColors.panelBorder, width: 1.0),
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Row 1: Sticky modifiers
            Row(
              children: [
                Expanded(
                  child: _FlexKeycap(
                    label: 'Ctrl',
                    active: widget.ctrlLatched,
                    onTap: () => widget.onToggleModifier('Ctrl'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Alt',
                    active: widget.altLatched,
                    onTap: () => widget.onToggleModifier('Alt'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Win',
                    active: widget.winLatched,
                    onTap: () => widget.onToggleModifier('Win'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Shift',
                    active: widget.shiftLatched,
                    onTap: () => widget.onToggleModifier('Shift'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 5),
            // Row 2: Essential desktop navigation & system keys
            Row(
              children: [
                Expanded(
                  child: _FlexKeycap(
                    label: 'Esc',
                    onTap: () => widget.onSpecialKey('Esc'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Tab',
                    onTap: () => widget.onSpecialKey('Tab'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Del',
                    onTap: () => widget.onSpecialKey('Del'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Win+D',
                    onTap: () => widget.onSpecialKey('Win+D'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 5),
            // Row 3: Power actions (Ctrl+Alt+Del, Paste, 2FA, KB, Fn)
            Row(
              children: [
                Expanded(
                  flex: 2,
                  child: _FlexKeycap(
                    key: const Key('btn_flex_cad'),
                    label: 'Ctrl+Alt+Del',
                    danger: true,
                    onTap: () => widget.onSpecialKey('Ctrl+Alt+Del'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Paste',
                    onTap: widget.onPasteClipboard,
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    key: const Key('btn_flex_totp_picker'),
                    label: '2FA',
                    active: _showTotpDrawer,
                    accentColor: JalaEnterpriseTokens.segmentGold,
                    onTap: () =>
                        setState(() => _showTotpDrawer = !_showTotpDrawer),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    key: const Key('btn_flex_toggle_kb'),
                    label: 'KB',
                    accentColor: JalaEnterpriseTokens.accentPrimary,
                    onTap: widget.onToggleSoftKeyboard,
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    key: const Key('btn_flex_fn_toggle'),
                    label: 'F1-12',
                    active: _showFnRow,
                    onTap: () => setState(() => _showFnRow = !_showFnRow),
                  ),
                ),
              ],
            ),
            if (_showFnRow) ...[
              const SizedBox(height: 6),
              Container(
                key: const Key('flex_fn_strip'),
                padding: const EdgeInsets.all(5),
                decoration: BoxDecoration(
                  color: _FlexDeckColors.trackpadBg,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: _FlexDeckColors.panelBorder),
                ),
                child: Column(
                  children: [
                    Row(
                      children: [
                        for (int n = 1; n <= 6; n++) ...[
                          if (n > 1) const SizedBox(width: 4),
                          Expanded(
                            child: _FlexKeycap(
                              label: 'F$n',
                              height: 30,
                              onTap: () => widget.onSpecialKey('F$n'),
                            ),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        for (int n = 7; n <= 12; n++) ...[
                          if (n > 7) const SizedBox(width: 4),
                          Expanded(
                            child: _FlexKeycap(
                              label: 'F$n',
                              height: 30,
                              onTap: () => widget.onSpecialKey('F$n'),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 6),
            // Inverted-T Arrow Cluster + Navigation Cluster (Home/End/PgUp/PgDn)
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  flex: 5,
                  child: Column(
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: _FlexKeycap(
                              label: 'Home',
                              height: 31,
                              onTap: () => widget.onSpecialKey('Home'),
                            ),
                          ),
                          const SizedBox(width: 4),
                          Expanded(
                            child: _FlexKeycap(
                              label: 'PgUp',
                              height: 31,
                              onTap: () => widget.onSpecialKey('PgUp'),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Expanded(
                            child: _FlexKeycap(
                              label: 'End',
                              height: 31,
                              onTap: () => widget.onSpecialKey('End'),
                            ),
                          ),
                          const SizedBox(width: 4),
                          Expanded(
                            child: _FlexKeycap(
                              label: 'PgDn',
                              height: 31,
                              onTap: () => widget.onSpecialKey('PgDn'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  flex: 6,
                  child: _InvertedTArrows(
                    onUp: () => widget.onSpecialKey('↑'),
                    onLeft: () => widget.onSpecialKey('←'),
                    onDown: () => widget.onSpecialKey('↓'),
                    onRight: () => widget.onSpecialKey('→'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInlineTotpDrawer() {
    return _FlexInlineTotpDrawer(
      entries: widget.totpEntries,
      onClose: () => setState(() => _showTotpDrawer = false),
      onSelectCode: (code) {
        _triggerHaptic();
        widget.onAutoTypeTotp(code);
        setState(() => _showTotpDrawer = false);
      },
    );
  }
}

/// Mini-Laptop bottom control deck for SSH & SFTP Tabletop Flex Mode.
///
/// Supports full tactile terminal keys + 1-tap quick snippets + inline 2FA
/// auto-type drawer when [subMode] == `'terminal'`, an SFTP Action & Transfer
/// deck when [subMode] == `'sftp'`, and collapses cleanly into a single `44dp`
/// terminal utility ribbon whenever [viewInsetsBottom] > 0.
class JalaFlexTerminalDeck extends StatefulWidget {
  final String hostTitle;
  final bool isLiveConnected;
  final String subMode;
  final double viewInsetsBottom;
  final bool ctrlLatched;
  final bool altLatched;
  final List<JalaFlexSnippetEntry> snippets;
  final List<JalaFlexTotpEntry> totpEntries;
  final int activeTabIndex;

  final ValueChanged<int> onSelectTab;
  final ValueChanged<String> onSwitchSubMode;
  final ValueChanged<String> onSendKey;
  final ValueChanged<String> onToggleModifier;
  final ValueChanged<String> onRunSnippet;
  final VoidCallback onPasteClipboard;
  final ValueChanged<String> onAutoTypeTotp;
  final VoidCallback onToggleSoftKeyboard;
  final VoidCallback onOpenPortForward;
  final VoidCallback onOpenTheme;
  final VoidCallback onToggleFlexOverride;
  final VoidCallback onDisconnect;
  final VoidCallback onSftpUpload;
  final VoidCallback onSftpNewFolder;
  final VoidCallback onSftpRefresh;

  const JalaFlexTerminalDeck({
    super.key,
    required this.hostTitle,
    required this.isLiveConnected,
    required this.subMode,
    required this.viewInsetsBottom,
    required this.ctrlLatched,
    required this.altLatched,
    required this.snippets,
    required this.totpEntries,
    this.activeTabIndex = 2,
    required this.onSelectTab,
    required this.onSwitchSubMode,
    required this.onSendKey,
    required this.onToggleModifier,
    required this.onRunSnippet,
    required this.onPasteClipboard,
    required this.onAutoTypeTotp,
    required this.onToggleSoftKeyboard,
    required this.onOpenPortForward,
    required this.onOpenTheme,
    required this.onToggleFlexOverride,
    required this.onDisconnect,
    required this.onSftpUpload,
    required this.onSftpNewFolder,
    required this.onSftpRefresh,
  });

  @override
  State<JalaFlexTerminalDeck> createState() => _JalaFlexTerminalDeckState();
}

class _JalaFlexTerminalDeckState extends State<JalaFlexTerminalDeck> {
  bool _showTotpDrawer = false;

  static const List<String> _devSymbols = <String>[
    '-',
    '/',
    '|',
    '~',
    '_',
    '\\',
    '{',
    '}',
  ];

  void _sendRaw(String raw) {
    HapticFeedback.selectionClick();
    widget.onSendKey(raw);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('flex_terminal_bottom_deck'),
      color: _FlexDeckColors.deckBg,
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (widget.viewInsetsBottom > 0) {
            return _buildSoftKeyboardSafeRibbon(constraints.maxHeight);
          }

          final isWide = constraints.maxWidth >= 520.0;
          return SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _buildHeaderBar(),
                  const SizedBox(height: 6),
                  Expanded(
                    child: _showTotpDrawer
                        ? _FlexInlineTotpDrawer(
                            entries: widget.totpEntries,
                            onClose: () =>
                                setState(() => _showTotpDrawer = false),
                            onSelectCode: (code) {
                              HapticFeedback.selectionClick();
                              widget.onAutoTypeTotp(code);
                              setState(() => _showTotpDrawer = false);
                            },
                          )
                        : widget.subMode == 'sftp'
                        ? _buildSftpActionDeck()
                        : _buildTerminalMainArea(isWide: isWide),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildSoftKeyboardSafeRibbon(double maxHeight) {
    final ribbonHeight = math.min(44.0, math.max(0.0, maxHeight));
    final bottomInset = math.min(
      widget.viewInsetsBottom,
      math.max(0.0, maxHeight - ribbonHeight),
    );

    return Align(
      alignment: Alignment.bottomCenter,
      child: Padding(
        padding: EdgeInsets.only(bottom: bottomInset),
        child: Container(
          key: const Key('flex_terminal_ime_ribbon'),
          height: ribbonHeight,
          width: double.infinity,
          decoration: const BoxDecoration(
            color: JalaEnterpriseTokens.headerBg,
            border: Border(
              top: BorderSide(
                color: JalaEnterpriseTokens.headerBorder,
                width: 1.0,
              ),
            ),
          ),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
            child: Row(
              children: [
                _FlexKeycap(label: 'Esc', onTap: () => _sendRaw('\x1b')),
                const SizedBox(width: 5),
                _FlexKeycap(label: 'Tab', onTap: () => _sendRaw('\t')),
                const SizedBox(width: 5),
                _FlexKeycap(
                  label: 'Ctrl',
                  active: widget.ctrlLatched,
                  onTap: () => widget.onToggleModifier('Ctrl'),
                ),
                const SizedBox(width: 5),
                _FlexKeycap(
                  label: 'Alt',
                  active: widget.altLatched,
                  onTap: () => widget.onToggleModifier('Alt'),
                ),
                const SizedBox(width: 5),
                _FlexKeycap(
                  label: '^C',
                  danger: true,
                  onTap: () => _sendRaw('\x03'),
                ),
                const SizedBox(width: 5),
                _FlexKeycap(label: '↑', onTap: () => _sendRaw('\x1b[A')),
                const SizedBox(width: 4),
                _FlexKeycap(label: '↓', onTap: () => _sendRaw('\x1b[B')),
                const SizedBox(width: 4),
                _FlexKeycap(label: '←', onTap: () => _sendRaw('\x1b[D')),
                const SizedBox(width: 4),
                _FlexKeycap(label: '→', onTap: () => _sendRaw('\x1b[C')),
                const SizedBox(width: 5),
                _FlexKeycap(
                  key: const Key('btn_flex_toggle_kb'),
                  label: 'Hide KB',
                  icon: Icons.keyboard_hide_rounded,
                  accentColor: JalaEnterpriseTokens.accentPrimary,
                  onTap: widget.onToggleSoftKeyboard,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHeaderBar() {
    final statusColor = widget.isLiveConnected
        ? JalaEnterpriseTokens.statusOk
        : JalaEnterpriseTokens.statusWarn;
    final cleanHost = widget.hostTitle.trim().isEmpty
        ? 'SSH Session'
        : widget.hostTitle.trim();

    return Container(
      height: 36,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(
        color: _FlexDeckColors.panelBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: _FlexDeckColors.panelBorder, width: 1.0),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            _FlexTabPill(
              key: const Key('btn_flex_tab_0'),
              label: 'Hosts',
              selected: widget.activeTabIndex == 0,
              onTap: () => widget.onSelectTab(0),
            ),
            const SizedBox(width: 4),
            _FlexTabPill(
              key: const Key('btn_flex_tab_1'),
              label: 'RDP',
              selected: widget.activeTabIndex == 1,
              onTap: () => widget.onSelectTab(1),
            ),
            const SizedBox(width: 4),
            _FlexTabPill(
              key: const Key('btn_flex_tab_2'),
              label: 'SSH',
              selected: widget.activeTabIndex == 2,
              onTap: () => widget.onSelectTab(2),
            ),
            const SizedBox(width: 4),
            _FlexTabPill(
              key: const Key('btn_flex_tab_3'),
              label: 'Vault',
              selected: widget.activeTabIndex == 3,
              onTap: () => widget.onSelectTab(3),
            ),
            const SizedBox(width: 8),
            _FlexTabPill(
              key: const Key('btn_flex_ssh_mode_terminal'),
              label: 'Terminal',
              selected: widget.subMode != 'sftp',
              onTap: () => widget.onSwitchSubMode('terminal'),
            ),
            const SizedBox(width: 4),
            _FlexTabPill(
              key: const Key('btn_flex_ssh_mode_sftp'),
              label: 'SFTP',
              selected: widget.subMode == 'sftp',
              onTap: () => widget.onSwitchSubMode('sftp'),
            ),
            const SizedBox(width: 8),
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(
                color: statusColor,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 130),
              child: Text(
                cleanHost,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: JalaEnterpriseTokens.textPrimary,
                ),
              ),
            ),
            const SizedBox(width: 8),
            _FlexActionPill(
              key: const Key('btn_flex_totp_picker'),
              label: '2FA',
              icon: Icons.verified_user_outlined,
              accentColor: JalaEnterpriseTokens.segmentGold,
              active: _showTotpDrawer,
              onTap: () => setState(() => _showTotpDrawer = !_showTotpDrawer),
            ),
            const SizedBox(width: 4),
            _FlexActionPill(
              label: 'Port Fwd',
              icon: Icons.hub_outlined,
              onTap: widget.onOpenPortForward,
            ),
            const SizedBox(width: 4),
            _FlexActionPill(
              label: 'Theme',
              icon: Icons.palette_outlined,
              onTap: widget.onOpenTheme,
            ),
            const SizedBox(width: 4),
            _FlexActionPill(
              key: const Key('btn_flex_override_toggle'),
              label: 'Flex Off',
              icon: Icons.unfold_less_rounded,
              onTap: widget.onToggleFlexOverride,
            ),
            if (widget.isLiveConnected) ...[
              const SizedBox(width: 4),
              _FlexActionPill(
                key: const Key('btn_flex_disconnect'),
                label: 'Disconnect',
                icon: Icons.power_settings_new_rounded,
                danger: true,
                onTap: widget.onDisconnect,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildTerminalMainArea({required bool isWide}) {
    if (isWide) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(flex: 6, child: _buildTerminalKeyDeck()),
          const SizedBox(width: 8),
          Expanded(flex: 4, child: _buildSnippetsPanel()),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(flex: 6, child: _buildTerminalKeyDeck()),
        const SizedBox(height: 6),
        Expanded(flex: 4, child: _buildSnippetsPanel()),
      ],
    );
  }

  Widget _buildTerminalKeyDeck() {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: _FlexDeckColors.panelBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _FlexDeckColors.panelBorder, width: 1.0),
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Row 1: Modifiers & Control Signals
            Row(
              children: [
                Expanded(
                  child: _FlexKeycap(
                    label: 'Esc',
                    onTap: () => _sendRaw('\x1b'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(label: 'Tab', onTap: () => _sendRaw('\t')),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Ctrl',
                    active: widget.ctrlLatched,
                    onTap: () => widget.onToggleModifier('Ctrl'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Alt',
                    active: widget.altLatched,
                    onTap: () => widget.onToggleModifier('Alt'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: '^C',
                    danger: true,
                    onTap: () => _sendRaw('\x03'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: '^D',
                    onTap: () => _sendRaw('\x04'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 5),
            // Row 2: Signals, Clipboard & Keyboard
            Row(
              children: [
                Expanded(
                  child: _FlexKeycap(
                    label: '^Z',
                    onTap: () => _sendRaw('\x1a'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: '^L',
                    onTap: () => _sendRaw('\x0c'),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Paste',
                    onTap: widget.onPasteClipboard,
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    key: const Key('btn_flex_toggle_kb'),
                    label: 'KB',
                    accentColor: JalaEnterpriseTokens.accentPrimary,
                    onTap: widget.onToggleSoftKeyboard,
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _FlexKeycap(
                    label: 'Enter',
                    onTap: () => _sendRaw('\r'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 5),
            // Row 3: Dev Symbols Strip
            Row(
              children: [
                for (int i = 0; i < _devSymbols.length; i++) ...[
                  if (i > 0) const SizedBox(width: 4),
                  Expanded(
                    child: _FlexKeycap(
                      label: _devSymbols[i],
                      monospace: true,
                      height: 31,
                      onTap: () => _sendRaw(_devSymbols[i]),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 6),
            // Row 4: Navigation + Inverted-T Arrows
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  flex: 4,
                  child: Column(
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: _FlexKeycap(
                              label: 'Home',
                              height: 31,
                              onTap: () => _sendRaw('\x1b[H'),
                            ),
                          ),
                          const SizedBox(width: 4),
                          Expanded(
                            child: _FlexKeycap(
                              label: 'End',
                              height: 31,
                              onTap: () => _sendRaw('\x1b[F'),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Expanded(
                            child: _FlexKeycap(
                              label: 'PgUp',
                              height: 31,
                              onTap: () => _sendRaw('\x1b[5~'),
                            ),
                          ),
                          const SizedBox(width: 4),
                          Expanded(
                            child: _FlexKeycap(
                              label: 'PgDn',
                              height: 31,
                              onTap: () => _sendRaw('\x1b[6~'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  flex: 5,
                  child: _InvertedTArrows(
                    onUp: () => _sendRaw('\x1b[A'),
                    onLeft: () => _sendRaw('\x1b[D'),
                    onDown: () => _sendRaw('\x1b[B'),
                    onRight: () => _sendRaw('\x1b[C'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSnippetsPanel() {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: _FlexDeckColors.panelBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _FlexDeckColors.panelBorder, width: 1.0),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(
                Icons.bolt_rounded,
                size: 14,
                color: JalaEnterpriseTokens.segmentGold,
              ),
              const SizedBox(width: 5),
              const Expanded(
                child: Text(
                  'Quick Snippets',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: JalaEnterpriseTokens.textPrimary,
                  ),
                ),
              ),
              Text(
                '${widget.snippets.length}',
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: JalaEnterpriseTokens.textMuted,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Expanded(
            child: widget.snippets.isEmpty
                ? const Center(
                    child: Text(
                      'No snippets saved yet',
                      style: TextStyle(
                        fontSize: 12,
                        color: JalaEnterpriseTokens.textMuted,
                      ),
                    ),
                  )
                : GridView.builder(
                    itemCount: widget.snippets.length,
                    gridDelegate:
                        const SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 170,
                          mainAxisExtent: 46,
                          mainAxisSpacing: 6,
                          crossAxisSpacing: 6,
                        ),
                    itemBuilder: (context, index) {
                      final snip = widget.snippets[index];
                      return Material(
                        color: _FlexDeckColors.keycapBg,
                        borderRadius: BorderRadius.circular(8),
                        child: InkWell(
                          key: Key('btn_flex_snippet_${snip.id}'),
                          borderRadius: BorderRadius.circular(8),
                          onTap: () {
                            HapticFeedback.selectionClick();
                            widget.onRunSnippet(snip.command);
                          },
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 5,
                            ),
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: _FlexDeckColors.keycapBorder,
                              ),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Text(
                                  snip.label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 11.5,
                                    fontWeight: FontWeight.w700,
                                    color: JalaEnterpriseTokens.textPrimary,
                                  ),
                                ),
                                Text(
                                  snip.command,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                    color: JalaEnterpriseTokens.textMuted,
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

  Widget _buildSftpActionDeck() {
    return Container(
      key: const Key('flex_sftp_action_deck'),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: _FlexDeckColors.panelBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _FlexDeckColors.panelBorder, width: 1.0),
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Row(
              children: [
                Icon(
                  Icons.folder_open_rounded,
                  size: 16,
                  color: JalaEnterpriseTokens.accentPrimary,
                ),
                SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'SFTP File Transfer Controls',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: JalaEnterpriseTokens.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _FlexDeckBigAction(
                  key: const Key('btn_flex_sftp_refresh'),
                  icon: Icons.refresh_rounded,
                  label: 'Refresh',
                  onTap: widget.onSftpRefresh,
                ),
                _FlexDeckBigAction(
                  key: const Key('btn_flex_sftp_upload'),
                  icon: Icons.upload_file_rounded,
                  label: 'Upload File',
                  accentColor: JalaEnterpriseTokens.accentPrimary,
                  onTap: widget.onSftpUpload,
                ),
                _FlexDeckBigAction(
                  key: const Key('btn_flex_sftp_new_folder'),
                  icon: Icons.create_new_folder_outlined,
                  label: 'New Folder',
                  onTap: widget.onSftpNewFolder,
                ),
                _FlexDeckBigAction(
                  key: const Key('btn_flex_sftp_to_terminal'),
                  icon: Icons.terminal_rounded,
                  label: 'Switch to Terminal',
                  onTap: () => widget.onSwitchSubMode('terminal'),
                ),
                _FlexDeckBigAction(
                  icon: Icons.verified_user_outlined,
                  label: '2FA',
                  accentColor: JalaEnterpriseTokens.segmentGold,
                  onTap: () => setState(() => _showTotpDrawer = true),
                ),
                _FlexDeckBigAction(
                  icon: Icons.hub_outlined,
                  label: 'Port Forward',
                  onTap: widget.onOpenPortForward,
                ),
                _FlexDeckBigAction(
                  icon: Icons.unfold_less_rounded,
                  label: 'Flex Off',
                  onTap: widget.onToggleFlexOverride,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _FlexInlineTotpDrawer extends StatelessWidget {
  final List<JalaFlexTotpEntry> entries;
  final VoidCallback onClose;
  final ValueChanged<String> onSelectCode;

  const _FlexInlineTotpDrawer({
    required this.entries,
    required this.onClose,
    required this.onSelectCode,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('flex_totp_inline_drawer'),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: _FlexDeckColors.panelBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: JalaEnterpriseTokens.segmentGold.withValues(alpha: 0.6),
          width: 1.0,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(
                Icons.verified_user_outlined,
                size: 15,
                color: JalaEnterpriseTokens.segmentGold,
              ),
              const SizedBox(width: 6),
              const Expanded(
                child: Text(
                  '2FA Auto-Type',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: JalaEnterpriseTokens.textPrimary,
                  ),
                ),
              ),
              _FlexActionPill(
                key: const Key('btn_flex_totp_close'),
                label: 'Close',
                icon: Icons.close_rounded,
                onTap: onClose,
              ),
            ],
          ),
          const SizedBox(height: 6),
          Expanded(
            child: entries.isEmpty
                ? const Center(
                    child: Text(
                      'Add 2FA accounts in Vault to auto-type codes directly.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 12,
                        color: JalaEnterpriseTokens.textSecondary,
                      ),
                    ),
                  )
                : ListView.separated(
                    itemCount: entries.length,
                    separatorBuilder: (context, index) =>
                        const SizedBox(height: 5),
                    itemBuilder: (context, index) {
                      final entry = entries[index];
                      return Material(
                        color: _FlexDeckColors.keycapBg,
                        borderRadius: BorderRadius.circular(8),
                        child: InkWell(
                          key: Key('btn_flex_totp_item_${entry.id}'),
                          borderRadius: BorderRadius.circular(8),
                          onTap: () => onSelectCode(entry.code),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 8,
                            ),
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: _FlexDeckColors.keycapBorder,
                              ),
                            ),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        entry.issuer,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.w700,
                                          color:
                                              JalaEnterpriseTokens.textPrimary,
                                        ),
                                      ),
                                      Text(
                                        entry.account,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          fontSize: 11,
                                          color: JalaEnterpriseTokens.textMuted,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.end,
                                  children: [
                                    Text(
                                      entry.code,
                                      style: const TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.w800,
                                        fontFamily: 'monospace',
                                        color: JalaEnterpriseTokens.segmentGold,
                                      ),
                                    ),
                                    Text(
                                      '${entry.remainingSeconds}s',
                                      style: const TextStyle(
                                        fontSize: 11,
                                        color:
                                            JalaEnterpriseTokens.textSecondary,
                                      ),
                                    ),
                                  ],
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
}

class _InvertedTArrows extends StatelessWidget {
  final VoidCallback onUp;
  final VoidCallback onLeft;
  final VoidCallback onDown;
  final VoidCallback onRight;

  const _InvertedTArrows({
    required this.onUp,
    required this.onLeft,
    required this.onDown,
    required this.onRight,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            const Spacer(),
            Expanded(
              child: _FlexKeycap(label: '↑', height: 31, onTap: onUp),
            ),
            const Spacer(),
          ],
        ),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(
              child: _FlexKeycap(label: '←', height: 31, onTap: onLeft),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: _FlexKeycap(label: '↓', height: 31, onTap: onDown),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: _FlexKeycap(label: '→', height: 31, onTap: onRight),
            ),
          ],
        ),
      ],
    );
  }
}

class _FlexKeycap extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool active;
  final bool danger;
  final bool monospace;
  final double height;
  final Color? accentColor;
  final VoidCallback onTap;

  const _FlexKeycap({
    super.key,
    required this.label,
    this.icon,
    this.active = false,
    this.danger = false,
    this.monospace = false,
    this.height = 33.0,
    this.accentColor,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final borderColor = danger
        ? _FlexDeckColors.keycapDangerBorder
        : active
        ? (accentColor ?? JalaEnterpriseTokens.accentPrimary)
        : _FlexDeckColors.keycapBorder;
    final bgColor = danger
        ? _FlexDeckColors.keycapDangerBg
        : active
        ? _FlexDeckColors.keycapActiveBg
        : _FlexDeckColors.keycapBg;
    final fgColor = danger
        ? JalaEnterpriseTokens.statusDanger
        : active
        ? (accentColor ?? JalaEnterpriseTokens.textPrimary)
        : (accentColor ?? JalaEnterpriseTokens.textPrimary);

    return Material(
      color: bgColor,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          height: height,
          padding: const EdgeInsets.symmetric(horizontal: 7),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: borderColor, width: active ? 1.2 : 1.0),
          ),
          child: Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 14, color: fgColor),
                    const SizedBox(width: 4),
                  ],
                  Text(
                    label,
                    maxLines: 1,
                    softWrap: false,
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      fontFamily: monospace ? 'monospace' : null,
                      color: fgColor,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FlexMouseButton extends StatelessWidget {
  final String label;
  final bool active;
  final Color? accentColor;
  final VoidCallback onTap;

  const _FlexMouseButton({
    super.key,
    required this.label,
    this.active = false,
    this.accentColor,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final borderColor = active
        ? (accentColor ?? JalaEnterpriseTokens.accentPrimary)
        : _FlexDeckColors.keycapBorder;
    final bgColor = active
        ? _FlexDeckColors.keycapActiveBg
        : _FlexDeckColors.keycapBg;
    final fgColor = active
        ? (accentColor ?? JalaEnterpriseTokens.textPrimary)
        : JalaEnterpriseTokens.textPrimary;

    return Material(
      color: bgColor,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        borderRadius: BorderRadius.circular(9),
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: borderColor, width: active ? 1.3 : 1.0),
          ),
          child: Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Text(
                  label,
                  maxLines: 1,
                  softWrap: false,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w700,
                    color: fgColor,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FlexTabPill extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _FlexTabPill({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected
          ? _FlexDeckColors.chipSelectedBg
          : _FlexDeckColors.chipBg,
      borderRadius: BorderRadius.circular(7),
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: onTap,
        child: Container(
          height: 26,
          padding: const EdgeInsets.symmetric(horizontal: 9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(7),
            border: Border.all(
              color: selected
                  ? JalaEnterpriseTokens.accentPrimary
                  : _FlexDeckColors.panelBorder,
            ),
          ),
          child: Center(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                color: selected
                    ? JalaEnterpriseTokens.textPrimary
                    : JalaEnterpriseTokens.textSecondary,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FlexActionPill extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool danger;
  final bool active;
  final Color? accentColor;
  final VoidCallback onTap;

  const _FlexActionPill({
    super.key,
    required this.label,
    required this.icon,
    this.danger = false,
    this.active = false,
    this.accentColor,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final fg = danger
        ? JalaEnterpriseTokens.statusDanger
        : (accentColor ?? JalaEnterpriseTokens.textPrimary);
    final border = danger
        ? _FlexDeckColors.keycapDangerBorder
        : active
        ? (accentColor ?? JalaEnterpriseTokens.accentPrimary)
        : _FlexDeckColors.panelBorder;
    final bg = danger
        ? _FlexDeckColors.keycapDangerBg
        : active
        ? _FlexDeckColors.keycapActiveBg
        : _FlexDeckColors.chipBg;

    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(7),
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: onTap,
        child: Container(
          height: 26,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: border),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 13, color: fg),
              const SizedBox(width: 4),
              Text(
                label,
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                  color: fg,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FlexDeckBigAction extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color? accentColor;
  final VoidCallback onTap;

  const _FlexDeckBigAction({
    super.key,
    required this.icon,
    required this.label,
    this.accentColor,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final fg = accentColor ?? JalaEnterpriseTokens.textPrimary;
    return Material(
      color: _FlexDeckColors.keycapBg,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: _FlexDeckColors.keycapBorder),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 16, color: fg),
              const SizedBox(width: 6),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: fg,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
