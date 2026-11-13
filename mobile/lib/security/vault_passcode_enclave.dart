import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'vault_security_service.dart';

Future<bool> _verifyPinNonBlocking(String pin, String storedHash) =>
    NativePlatformBridge.verifyPinFast(pin, storedHash);

Future<String> _hashPinNonBlocking(String pin) =>
    NativePlatformBridge.hashPinFast(pin);

const Color _kCanvasTop = Color(0xFF090E17);
const Color _kCanvasBottom = Color(0xFF0D1522);
const Color _kKeySurface = Color(0xFF16202E);
const Color _kKeyBorder = Color(0xFF263548);
const Color _kKeyPressed = Color(0xFF253B56);
const Color _kDotEmptyFill = Color(0xFF101927);
const Color _kDotEmptyRing = Color(0xFF2A3748);
const Color _kBrandGold = Color(0xFFF3C66F);
const Color _kDanger = Color(0xFFF26D6D);
const Color _kTextPrimary = Color(0xFFEDF2F7);
const Color _kTextSecondary = Color(0xFF9AA8B8);

/// Zero-latency (`0.0ms` finger-down) sculpted tactile keypad key driven by raw `Listener.onPointerDown`.
/// Eliminates `InkWell` `PointerUp` wait and `SingleChildScrollView` `100ms` gesture-arena disambiguation.
class _InstantPinKeyButton extends StatefulWidget {
  final double? width;
  final double height;
  final double borderRadius;
  final Color baseColor;
  final Color pressedColor;
  final Color borderColor;
  final Color pressedBorderColor;
  final VoidCallback? onTriggered;
  final Widget child;

  const _InstantPinKeyButton({
    super.key,
    this.width,
    required this.height,
    required this.borderRadius,
    required this.baseColor,
    required this.pressedColor,
    required this.borderColor,
    required this.pressedBorderColor,
    required this.onTriggered,
    required this.child,
  });

  @override
  State<_InstantPinKeyButton> createState() => _InstantPinKeyButtonState();
}

class _InstantPinKeyButtonState extends State<_InstantPinKeyButton> {
  int? _activePointerId;
  bool _pressed = false;

  @override
  void didUpdateWidget(covariant _InstantPinKeyButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.onTriggered == null && (_pressed || _activePointerId != null)) {
      _pressed = false;
      _activePointerId = null;
    }
  }

  void _handlePointerDown(PointerDownEvent event) {
    final cb = widget.onTriggered;
    if (cb == null || _activePointerId != null) return;
    _activePointerId = event.pointer;
    setState(() => _pressed = true);
    cb();
  }

  void _handlePointerEnd(PointerEvent event) {
    if (event.pointer != _activePointerId) return;
    _activePointerId = null;
    if (_pressed && mounted) {
      setState(() => _pressed = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTriggered != null;
    return Semantics(
      button: true,
      enabled: enabled,
      child: Listener(
        behavior: HitTestBehavior.opaque,
        onPointerDown: enabled ? _handlePointerDown : null,
        onPointerUp: _handlePointerEnd,
        onPointerCancel: _handlePointerEnd,
        child: AnimatedContainer(
          duration: _pressed ? Duration.zero : const Duration(milliseconds: 90),
          width: widget.width,
          height: widget.height,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _pressed ? widget.pressedColor : widget.baseColor,
            borderRadius: BorderRadius.circular(widget.borderRadius),
            border: Border.all(
              color: _pressed ? widget.pressedBorderColor : widget.borderColor,
              width: _pressed ? 1.35 : 1.0,
            ),
          ),
          child: widget.child,
        ),
      ),
    );
  }
}

/// Edge-to-Edge Full-Screen Vault Passcode Unlock Screen:
/// - Full-screen obsidian-navy canvas (`#090E17` -> `#0D1522`) with zero boxed dialog frames
/// - Animated PIN progress dots (`11px` empty -> `13px` gold filled) with horizontal error shake
/// - Fixed `24px` status/error slot preventing vertical keypad jump
/// - Sculpted circular `0ms` `Listener.onPointerDown` numpad in Portrait and 2-column Landscape (`915×412`)
class VaultPinLockView extends StatefulWidget {
  final String pinHash;
  final int pinLength;
  final bool biometricEnabled;
  final Widget brandLogo;
  final VoidCallback onUnlocked;

  const VaultPinLockView({
    super.key,
    required this.pinHash,
    this.pinLength = 6,
    this.biometricEnabled = false,
    required this.brandLogo,
    required this.onUnlocked,
  });

  @override
  State<VaultPinLockView> createState() => _VaultPinLockViewState();
}

class _VaultPinLockViewState extends State<VaultPinLockView> with SingleTickerProviderStateMixin {
  String _enteredPin = '';
  late final AnimationController _shakeCtrl;
  String? _unlockError;
  bool _biometricBusy = false;
  bool _verifyingPin = false;
  int _failedAttempts = 0;
  int _cooldownSecondsLeft = 0;
  Timer? _cooldownTimer;
  Timer? _autoBioTimer;

  int get _effectivePinLen => widget.pinLength.clamp(4, 12);

  @override
  void initState() {
    super.initState();
    _shakeCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 380),
    );
    if (widget.biometricEnabled) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _autoCheckAndPromptBiometric();
      });
    }
  }

  @override
  void dispose() {
    _autoBioTimer?.cancel();
    _cooldownTimer?.cancel();
    _shakeCtrl.dispose();
    super.dispose();
  }

  void _autoCheckAndPromptBiometric() {
    if (!mounted || !widget.biometricEnabled || _enteredPin.isNotEmpty) return;
    _autoBioTimer?.cancel();
    _autoBioTimer = Timer(const Duration(milliseconds: 120), () async {
      if (!mounted || !widget.biometricEnabled || _enteredPin.isNotEmpty || _verifyingPin) return;
      final available = await NativePlatformBridge.isBiometricAvailable();
      if (!mounted || !available || _enteredPin.isNotEmpty || _verifyingPin) return;
      await _triggerBiometricUnlock();
    });
  }

  Future<void> _triggerBiometricUnlock() async {
    if (_biometricBusy || _verifyingPin || _cooldownSecondsLeft > 0) return;
    setState(() {
      _biometricBusy = true;
      _unlockError = null;
    });
    final verified = await NativePlatformBridge.authenticateBiometric();
    if (!mounted) return;
    setState(() => _biometricBusy = false);
    if (verified) {
      NativePlatformBridge.performPinHaptic('confirm');
      widget.onUnlocked();
    }
  }

  void _startCooldown() {
    _cooldownTimer?.cancel();
    setState(() {
      _cooldownSecondsLeft = 15;
      _unlockError = 'Too many failed attempts. Cooldown active (${_cooldownSecondsLeft}s).';
    });
    _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      if (_cooldownSecondsLeft <= 1) {
        t.cancel();
        setState(() {
          _cooldownSecondsLeft = 0;
          _failedAttempts = 0;
          _unlockError = null;
        });
      } else {
        setState(() {
          _cooldownSecondsLeft--;
          _unlockError = 'Too many failed attempts. Cooldown active (${_cooldownSecondsLeft}s).';
        });
      }
    });
  }

  Future<void> _tryUnlock(String pin) async {
    if (_cooldownSecondsLeft > 0 || _verifyingPin || pin.isEmpty) return;
    setState(() => _verifyingPin = true);

    final matched = await _verifyPinNonBlocking(pin, widget.pinHash);
    if (!mounted) return;

    if (matched) {
      NativePlatformBridge.performPinHaptic('confirm');
      _verifyingPin = false;
      _failedAttempts = 0;
      widget.onUnlocked();
    } else {
      NativePlatformBridge.performPinHaptic('reject');
      _shakeCtrl.forward(from: 0.0);
      _failedAttempts++;
      setState(() {
        _verifyingPin = false;
        _enteredPin = '';
      });
      if (_failedAttempts >= 5) {
        _startCooldown();
      } else {
        setState(() {
          _unlockError = 'Incorrect Vault PIN. Try again.';
        });
      }
    }
  }

  void _onKeypadDigit(String digit) {
    if (_cooldownSecondsLeft > 0 || _verifyingPin) return;
    if (_enteredPin.length >= _effectivePinLen) return;
    _autoBioTimer?.cancel();
    NativePlatformBridge.performPinHaptic('tap');
    final next = '$_enteredPin$digit';
    setState(() {
      _unlockError = null;
      _enteredPin = next;
    });
    if (next.length == _effectivePinLen) {
      unawaited(_tryUnlock(next));
    }
  }

  void _onKeypadBackspace() {
    if (_cooldownSecondsLeft > 0 || _verifyingPin || _enteredPin.isEmpty) return;
    NativePlatformBridge.performPinHaptic('backspace');
    setState(() {
      _enteredPin = _enteredPin.substring(0, _enteredPin.length - 1);
    });
  }

  void _onKeypadClear() {
    if (_cooldownSecondsLeft > 0 || _verifyingPin || _enteredPin.isEmpty) return;
    NativePlatformBridge.performPinHaptic('backspace');
    setState(() => _enteredPin = '');
  }

  Widget _buildHeaderAndDots({required bool compact}) {
    final currentLen = _enteredPin.length;
    final dotCount = math.max(_effectivePinLen, currentLen).clamp(4, 12);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 44,
          height: 44,
          child: FittedBox(fit: BoxFit.contain, child: widget.brandLogo),
        ),
        SizedBox(height: compact ? 10 : 16),
        Text(
          'Unlock JalaDesk',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: compact ? 20 : 22,
            fontWeight: FontWeight.w700,
            letterSpacing: -0.3,
            color: _kTextPrimary,
          ),
        ),
        const SizedBox(height: 5),
        Text(
          'Enter $_effectivePinLen-digit PIN',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 13, color: _kTextSecondary),
        ),
        SizedBox(height: compact ? 16 : 24),
        AnimatedBuilder(
          animation: _shakeCtrl,
          builder: (ctx, child) {
            final dx = math.sin(_shakeCtrl.value * math.pi * 4) * 10.0 * (1.0 - _shakeCtrl.value);
            return Transform.translate(offset: Offset(dx, 0), child: child);
          },
          child: Wrap(
            key: const ValueKey('vault_pin_progress_dots'),
            alignment: WrapAlignment.center,
            spacing: 14,
            runSpacing: 8,
            children: [
              for (int i = 0; i < dotCount; i++)
                AnimatedContainer(
                  duration: const Duration(milliseconds: 45),
                  width: i < currentLen ? 13 : 11,
                  height: i < currentLen ? 13 : 11,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: i < currentLen ? _kBrandGold : _kDotEmptyFill,
                    border: Border.all(
                      color: i < currentLen ? _kBrandGold : _kDotEmptyRing,
                      width: 1.5,
                    ),
                    boxShadow: i < currentLen
                        ? [
                            BoxShadow(
                              color: _kBrandGold.withValues(alpha: 0.28),
                              blurRadius: 8,
                              offset: const Offset(0, 2),
                            ),
                          ]
                        : null,
                  ),
                ),
            ],
          ),
        ),
        SizedBox(height: compact ? 8 : 12),
        SizedBox(
          height: 24,
          child: Center(
            child: _unlockError != null
                ? Text(
                    _unlockError!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: _kDanger,
                    ),
                  )
                : (_biometricBusy
                    ? const Text(
                        'Verifying biometrics...',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: _kBrandGold,
                        ),
                      )
                    : const SizedBox.shrink()),
          ),
        ),
      ],
    );
  }

  Widget _buildNumericKeypad({required double keyHeight, required bool circular}) {
    const rows = <List<String>>[
      <String>['1', '2', '3'],
      <String>['4', '5', '6'],
      <String>['7', '8', '9'],
    ];
    final disabled = _cooldownSecondsLeft > 0 || _verifyingPin;
    final double keyDiameter = keyHeight;
    final double radius = circular ? keyDiameter / 2.0 : 999.0;
    final double gapY = circular ? 12.0 : 8.0;
    final double numeralSize = keyHeight >= 64 ? 26.0 : (keyHeight >= 48 ? 21.0 : 17.5);

    Widget buildSlot(Widget button) {
      if (circular) {
        return Expanded(
          child: Center(child: button),
        );
      }
      return Expanded(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 5),
          child: button,
        ),
      );
    }

    Widget buildDigitButton(String d) {
      return buildSlot(
        _InstantPinKeyButton(
          key: ValueKey('btn_pin_digit_$d'),
          width: circular ? keyDiameter : null,
          height: keyHeight,
          borderRadius: radius,
          baseColor: _kKeySurface,
          pressedColor: _kKeyPressed,
          borderColor: _kKeyBorder,
          pressedBorderColor: _kBrandGold,
          onTriggered: disabled ? null : () => _onKeypadDigit(d),
          child: Text(
            d,
            style: TextStyle(
              fontSize: numeralSize,
              fontWeight: FontWeight.w600,
              fontFeatures: const [FontFeature.tabularFigures()],
              color: _kTextPrimary,
            ),
          ),
        ),
      );
    }

    final bool showBio = widget.biometricEnabled;
    final bool canClear = _enteredPin.isNotEmpty;

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 308),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final row in rows) ...[
            Row(
              children: [
                for (final d in row) buildDigitButton(d),
              ],
            ),
            SizedBox(height: gapY),
          ],
          Row(
            children: [
              buildSlot(
                _InstantPinKeyButton(
                  key: ValueKey(showBio ? 'btn_pin_biometric' : 'btn_pin_clear'),
                  width: circular ? keyDiameter : null,
                  height: keyHeight,
                  borderRadius: radius,
                  baseColor: Colors.transparent,
                  pressedColor: _kKeyPressed.withValues(alpha: 0.55),
                  borderColor: Colors.transparent,
                  pressedBorderColor: _kBrandGold.withValues(alpha: 0.55),
                  onTriggered: disabled
                      ? null
                      : (showBio ? _triggerBiometricUnlock : (canClear ? _onKeypadClear : null)),
                  child: showBio
                      ? const Icon(Icons.fingerprint_rounded, size: 25, color: _kBrandGold)
                      : Opacity(
                          opacity: canClear ? 1.0 : 0.35,
                          child: const Text(
                            'Clear',
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: _kTextSecondary,
                            ),
                          ),
                        ),
                ),
              ),
              buildDigitButton('0'),
              buildSlot(
                _InstantPinKeyButton(
                  key: const ValueKey('btn_pin_backspace'),
                  width: circular ? keyDiameter : null,
                  height: keyHeight,
                  borderRadius: radius,
                  baseColor: Colors.transparent,
                  pressedColor: _kKeyPressed.withValues(alpha: 0.55),
                  borderColor: Colors.transparent,
                  pressedBorderColor: _kBrandGold.withValues(alpha: 0.55),
                  onTriggered: (disabled || _enteredPin.isEmpty) ? null : _onKeypadBackspace,
                  child: Opacity(
                    opacity: _enteredPin.isNotEmpty ? 1.0 : 0.35,
                    child: const Icon(Icons.backspace_outlined, size: 22, color: _kTextPrimary),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final mediaPadding = MediaQuery.paddingOf(context);

    return Scaffold(
      key: const ValueKey('vault_pin_lock_screen'),
      backgroundColor: _kCanvasTop,
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            colors: [_kCanvasTop, _kCanvasBottom],
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
          ),
        ),
        child: SafeArea(
          left: false,
          right: false,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final isCompactLandscape =
                  constraints.maxWidth > constraints.maxHeight && constraints.maxHeight < 500;

              if (isCompactLandscape) {
                final symPadX = math.max(mediaPadding.left, mediaPadding.right) + 24.0;
                final availH = (constraints.maxHeight - 24.0).clamp(160.0, 600.0);
                final btnH = ((availH - 24.0) / 4.0).clamp(36.0, 58.0);
                final circular = btnH >= 54.0 && (constraints.maxWidth / 2.0) >= 260.0;
                final content = Row(
                  children: [
                    Expanded(
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 320),
                          child: _buildHeaderAndDots(compact: true),
                        ),
                      ),
                    ),
                    const SizedBox(width: 24),
                    Expanded(
                      child: Center(
                        child: _buildNumericKeypad(keyHeight: btnH, circular: circular),
                      ),
                    ),
                  ],
                );
                return Padding(
                  padding: EdgeInsets.symmetric(horizontal: symPadX, vertical: 12),
                  child: constraints.maxHeight < 250
                      ? Center(child: FittedBox(fit: BoxFit.scaleDown, child: SizedBox(width: 640, child: content)))
                      : content,
                );
              }

              final symPadX = math.max(mediaPadding.left, mediaPadding.right) + 24.0;
              final availH = constraints.maxHeight;
              final double keyDiameter = ((availH - 250.0) / 4.6).clamp(42.0, 72.0);
              final bool circular = keyDiameter >= 56.0 && (constraints.maxWidth - symPadX * 2) >= 260.0;

              final portraitBody = Column(
                mainAxisAlignment: MainAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _buildHeaderAndDots(compact: availH < 640),
                  SizedBox(height: availH >= 740 ? 28 : 14),
                  _buildNumericKeypad(keyHeight: keyDiameter, circular: circular),
                ],
              );

              return SizedBox.expand(
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: symPadX, vertical: 16),
                  child: Center(
                    child: availH < 430
                        ? FittedBox(fit: BoxFit.scaleDown, child: portraitBody)
                        : portraitBody,
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

/// Edge-to-Edge Full-Screen Passcode Setup / Change / Remove View:
/// - Presented as an opaque full-screen route (`PageRouteBuilder(fullscreenDialog: true)`)
/// - Zero `TextField`s and zero `SingleChildScrollView`
/// - Quick segmented toggle for `4 Digits` (`chip_pin_len_4`) and `6 Digits` (`chip_pin_len_6`)
/// - Horizontal shake animation + fixed `24px` error slot so keypad never shifts
class VaultPinSetupSheet extends StatefulWidget {
  final String existingPinHash;
  final int initialPinLength;
  final void Function(String newPinHash, int pinLength) onSavePin;
  final VoidCallback onRemovePin;

  const VaultPinSetupSheet({
    super.key,
    required this.existingPinHash,
    this.initialPinLength = 6,
    required this.onSavePin,
    required this.onRemovePin,
  });

  @override
  State<VaultPinSetupSheet> createState() => _VaultPinSetupSheetState();
}

class _VaultPinSetupSheetState extends State<VaultPinSetupSheet> with SingleTickerProviderStateMixin {
  String _currentPin = '';
  String _newPin = '';
  String _confirmPin = '';

  late int _targetPinLen;
  late int _stage; // 0 = Enter Current PIN, 1 = Create PIN, 2 = Confirm PIN
  late final AnimationController _shakeCtrl;
  bool _currentVerified = false;
  bool _busy = false;
  String? _errorMsg;

  bool get _hasExisting => widget.existingPinHash.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _targetPinLen = widget.initialPinLength == 4 ? 4 : 6;
    _stage = _hasExisting ? 0 : 1;
    _currentVerified = !_hasExisting;
    _shakeCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 380),
    );
  }

  @override
  void dispose() {
    _shakeCtrl.dispose();
    super.dispose();
  }

  String get _activePin {
    if (_stage == 0) return _currentPin;
    if (_stage == 1) return _newPin;
    return _confirmPin;
  }

  void _setActivePin(String value) {
    if (_stage == 0) {
      _currentPin = value;
    } else if (_stage == 1) {
      _newPin = value;
    } else {
      _confirmPin = value;
    }
  }

  int get _activeTargetLen =>
      _stage == 0 ? widget.initialPinLength.clamp(4, 12) : _targetPinLen;

  String get _stepPillLabel {
    if (_stage == 0) return 'Verify';
    if (_stage == 1) return '1 / 2';
    return '2 / 2';
  }

  String get _stageTitle {
    if (_stage == 0) return 'Enter Current PIN';
    if (_stage == 1) {
      return _hasExisting ? 'Create New PIN' : 'Create Passcode';
    }
    return 'Confirm Passcode';
  }

  String get _stageSubtitle {
    if (_stage == 0) {
      return 'Verify your current PIN to continue';
    }
    if (_stage == 1) {
      return 'Choose a $_targetPinLen-digit PIN';
    }
    return 'Re-enter your $_targetPinLen-digit PIN';
  }

  Future<void> _onSetupKeypadDigit(String d) async {
    if (_busy) return;
    final current = _activePin;
    final maxTarget = _activeTargetLen;
    if (current.length >= maxTarget) return;

    NativePlatformBridge.performPinHaptic('tap');
    final next = '$current$d';
    setState(() {
      _errorMsg = null;
      _setActivePin(next);
    });

    if (next.length < maxTarget) return;

    if (_stage == 0) {
      setState(() => _busy = true);
      final ok = await _verifyPinNonBlocking(next, widget.existingPinHash);
      if (!mounted) return;
      if (ok) {
        NativePlatformBridge.performPinHaptic('confirm');
        setState(() {
          _busy = false;
          _currentVerified = true;
          _stage = 1;
          _errorMsg = null;
        });
      } else {
        NativePlatformBridge.performPinHaptic('reject');
        _shakeCtrl.forward(from: 0.0);
        setState(() {
          _busy = false;
          _currentPin = '';
          _errorMsg = 'Current PIN is incorrect.';
        });
      }
      return;
    }

    if (_stage == 1) {
      setState(() => _stage = 2);
      return;
    }

    if (next != _newPin) {
      NativePlatformBridge.performPinHaptic('reject');
      _shakeCtrl.forward(from: 0.0);
      setState(() {
        _confirmPin = '';
        _errorMsg = 'PIN confirmation does not match. Try again.';
      });
      return;
    }

    setState(() => _busy = true);
    final hashed = await _hashPinNonBlocking(_newPin);
    if (!mounted) return;
    NativePlatformBridge.performPinHaptic('confirm');
    Navigator.of(context).pop();
    widget.onSavePin(hashed, _targetPinLen);
  }

  void _onSetupBackspace() {
    if (_busy) return;
    final current = _activePin;
    if (current.isEmpty) {
      if (_stage == 2) {
        NativePlatformBridge.performPinHaptic('backspace');
        setState(() {
          _stage = 1;
          _newPin = '';
          _errorMsg = null;
        });
      }
      return;
    }
    NativePlatformBridge.performPinHaptic('backspace');
    setState(() {
      _setActivePin(current.substring(0, current.length - 1));
    });
  }

  void _onSetupClear() {
    if (_busy || _activePin.isEmpty) return;
    NativePlatformBridge.performPinHaptic('backspace');
    setState(() {
      _setActivePin('');
      _errorMsg = null;
    });
  }

  void _handleVerifiedRemovePin() {
    if (!_currentVerified || _busy) return;
    NativePlatformBridge.performPinHaptic('confirm');
    Navigator.of(context).pop();
    widget.onRemovePin();
  }

  Widget _buildTopBar() {
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: _kKeySurface,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: _kKeyBorder),
          ),
          child: Text(
            _stepPillLabel,
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              fontFeatures: [FontFeature.tabularFigures()],
              color: _kBrandGold,
            ),
          ),
        ),
        const Spacer(),
        IconButton(
          key: const ValueKey('btn_cancel_vault_pin'),
          tooltip: 'Close',
          style: IconButton.styleFrom(
            backgroundColor: _kKeySurface,
            foregroundColor: _kTextPrimary,
            side: const BorderSide(color: _kKeyBorder),
            minimumSize: const Size(36, 36),
            padding: EdgeInsets.zero,
          ),
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          icon: const Icon(Icons.close_rounded, size: 18),
        ),
      ],
    );
  }

  Widget _buildLengthSelector() {
    if (_stage == 0) return const SizedBox.shrink();
    Widget buildSegment(int len, String label, ValueKey<String> key) {
      final selected = _targetPinLen == len;
      return InkWell(
        key: key,
        borderRadius: BorderRadius.circular(999),
        onTap: _busy
            ? null
            : () => setState(() {
                  _targetPinLen = len;
                  _newPin = '';
                  _confirmPin = '';
                  _stage = 1;
                  _errorMsg = null;
                }),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          decoration: BoxDecoration(
            color: selected ? _kKeyPressed : Colors.transparent,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: selected ? _kBrandGold.withValues(alpha: 0.7) : Colors.transparent,
            ),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: selected ? _kBrandGold : _kTextSecondary,
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: _kKeySurface,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: _kKeyBorder),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          buildSegment(4, '4 Digits', const ValueKey('chip_pin_len_4')),
          const SizedBox(width: 2),
          buildSegment(6, '6 Digits', const ValueKey('chip_pin_len_6')),
        ],
      ),
    );
  }

  Widget _buildInfoColumn({required bool compact}) {
    final activeLen = _activePin.length;
    final dotTarget = _activeTargetLen.clamp(4, 12);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: _kKeySurface,
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: _kKeyBorder),
          ),
          child: const Icon(Icons.lock_outline_rounded, size: 21, color: _kBrandGold),
        ),
        SizedBox(height: compact ? 8 : 14),
        Text(
          _stageTitle,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: compact ? 19 : 21,
            fontWeight: FontWeight.w700,
            letterSpacing: -0.3,
            color: _kTextPrimary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          _stageSubtitle,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 13, color: _kTextSecondary),
        ),
        if (_stage != 0) ...[
          SizedBox(height: compact ? 10 : 14),
          _buildLengthSelector(),
        ],
        SizedBox(height: compact ? 12 : 18),
        AnimatedBuilder(
          animation: _shakeCtrl,
          builder: (ctx, child) {
            final dx = math.sin(_shakeCtrl.value * math.pi * 4) * 10.0 * (1.0 - _shakeCtrl.value);
            return Transform.translate(offset: Offset(dx, 0), child: child);
          },
          child: Wrap(
            alignment: WrapAlignment.center,
            spacing: 14,
            runSpacing: 8,
            children: [
              for (int i = 0; i < dotTarget; i++)
                AnimatedContainer(
                  duration: const Duration(milliseconds: 45),
                  width: 12,
                  height: 12,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: i < activeLen ? _kBrandGold : _kDotEmptyFill,
                    border: Border.all(
                      color: i < activeLen ? _kBrandGold : _kDotEmptyRing,
                      width: 1.5,
                    ),
                    boxShadow: i < activeLen
                        ? [
                            BoxShadow(
                              color: _kBrandGold.withValues(alpha: 0.28),
                              blurRadius: 8,
                              offset: const Offset(0, 2),
                            ),
                          ]
                        : null,
                  ),
                ),
            ],
          ),
        ),
        SizedBox(height: compact ? 6 : 10),
        SizedBox(
          height: 24,
          child: Center(
            child: _errorMsg != null
                ? Text(
                    _errorMsg!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 12,
                      color: _kDanger,
                      fontWeight: FontWeight.w600,
                    ),
                  )
                : const SizedBox.shrink(),
          ),
        ),
        if (_hasExisting && _currentVerified) ...[
          SizedBox(height: compact ? 4 : 6),
          OutlinedButton.icon(
            key: const ValueKey('btn_remove_vault_pin'),
            style: OutlinedButton.styleFrom(
              foregroundColor: _kDanger,
              side: BorderSide(color: _kDanger.withValues(alpha: 0.55)),
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            ),
            onPressed: _busy ? null : _handleVerifiedRemovePin,
            icon: const Icon(Icons.lock_open_rounded, size: 15),
            label: const Text(
              'Remove PIN',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildSetupKeypad({required double keyHeight, required bool circular}) {
    final double keyDiameter = keyHeight;
    final double radius = circular ? keyDiameter / 2.0 : 999.0;
    final double gapY = circular ? 11.0 : 7.0;
    final double numeralSize = keyHeight >= 64 ? 26.0 : (keyHeight >= 48 ? 21.0 : 17.5);
    final bool hasDigits = _activePin.isNotEmpty;

    Widget buildSlot(Widget button) {
      if (circular) {
        return Expanded(child: Center(child: button));
      }
      return Expanded(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 5),
          child: button,
        ),
      );
    }

    Widget buildSetupDigitButton(String d) {
      return buildSlot(
        _InstantPinKeyButton(
          key: ValueKey('btn_setup_pin_digit_$d'),
          width: circular ? keyDiameter : null,
          height: keyHeight,
          borderRadius: radius,
          baseColor: _kKeySurface,
          pressedColor: _kKeyPressed,
          borderColor: _kKeyBorder,
          pressedBorderColor: _kBrandGold,
          onTriggered: _busy ? null : () => _onSetupKeypadDigit(d),
          child: Text(
            d,
            style: TextStyle(
              fontSize: numeralSize,
              fontWeight: FontWeight.w600,
              fontFeatures: const [FontFeature.tabularFigures()],
              color: _kTextPrimary,
            ),
          ),
        ),
      );
    }

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 308),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final row in const <List<String>>[
            <String>['1', '2', '3'],
            <String>['4', '5', '6'],
            <String>['7', '8', '9'],
          ]) ...[
            Row(
              children: [
                for (final d in row) buildSetupDigitButton(d),
              ],
            ),
            SizedBox(height: gapY),
          ],
          Row(
            children: [
              buildSlot(
                _InstantPinKeyButton(
                  key: const ValueKey('btn_setup_pin_clear'),
                  width: circular ? keyDiameter : null,
                  height: keyHeight,
                  borderRadius: radius,
                  baseColor: Colors.transparent,
                  pressedColor: _kKeyPressed.withValues(alpha: 0.55),
                  borderColor: Colors.transparent,
                  pressedBorderColor: _kBrandGold.withValues(alpha: 0.55),
                  onTriggered: (_busy || !hasDigits) ? null : _onSetupClear,
                  child: Opacity(
                    opacity: hasDigits ? 1.0 : 0.35,
                    child: const Text(
                      'Clear',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: _kTextSecondary,
                      ),
                    ),
                  ),
                ),
              ),
              buildSetupDigitButton('0'),
              buildSlot(
                _InstantPinKeyButton(
                  key: const ValueKey('btn_setup_pin_backspace'),
                  width: circular ? keyDiameter : null,
                  height: keyHeight,
                  borderRadius: radius,
                  baseColor: Colors.transparent,
                  pressedColor: _kKeyPressed.withValues(alpha: 0.55),
                  borderColor: Colors.transparent,
                  pressedBorderColor: _kBrandGold.withValues(alpha: 0.55),
                  onTriggered: (_busy || (!hasDigits && _stage != 2)) ? null : _onSetupBackspace,
                  child: Opacity(
                    opacity: (hasDigits || _stage == 2) ? 1.0 : 0.35,
                    child: const Icon(Icons.backspace_outlined, size: 22, color: _kTextPrimary),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final mediaPadding = MediaQuery.paddingOf(context);

    return Scaffold(
      backgroundColor: _kCanvasTop,
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            colors: [_kCanvasTop, _kCanvasBottom],
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
          ),
        ),
        child: SafeArea(
          left: false,
          right: false,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final isCompactLandscape =
                  constraints.maxWidth > constraints.maxHeight && constraints.maxHeight < 500;
              final symPadX = math.max(mediaPadding.left, mediaPadding.right) + 24.0;

              if (isCompactLandscape) {
                final bodyH = (constraints.maxHeight - 56.0).clamp(140.0, 520.0);
                final btnH = ((bodyH - 22.0) / 4.0).clamp(34.0, 56.0);
                final circular = btnH >= 52.0 && (constraints.maxWidth / 2.0) >= 260.0;

                final rowContent = Row(
                  children: [
                    Expanded(
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 320),
                          child: _buildInfoColumn(compact: true),
                        ),
                      ),
                    ),
                    const SizedBox(width: 24),
                    Expanded(
                      child: Center(
                        child: _buildSetupKeypad(keyHeight: btnH, circular: circular),
                      ),
                    ),
                  ],
                );

                return Padding(
                  padding: EdgeInsets.fromLTRB(symPadX, 8, symPadX, 10),
                  child: Column(
                    children: [
                      _buildTopBar(),
                      Expanded(
                        child: constraints.maxHeight < 280
                            ? Center(
                                child: FittedBox(
                                  fit: BoxFit.scaleDown,
                                  child: SizedBox(width: 640, child: rowContent),
                                ),
                              )
                            : rowContent,
                      ),
                    ],
                  ),
                );
              }

              final bodyH = (constraints.maxHeight - 64.0).clamp(240.0, 960.0);
              final double keyDiameter = ((bodyH - 285.0) / 4.6).clamp(42.0, 72.0);
              final bool circular = keyDiameter >= 56.0 && (constraints.maxWidth - symPadX * 2) >= 260.0;

              final portraitInner = Column(
                mainAxisAlignment: MainAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _buildInfoColumn(compact: bodyH < 580),
                  SizedBox(height: bodyH >= 680 ? 22 : 12),
                  _buildSetupKeypad(keyHeight: keyDiameter, circular: circular),
                ],
              );

              return Padding(
                padding: EdgeInsets.fromLTRB(symPadX, 10, symPadX, 16),
                child: Column(
                  children: [
                    _buildTopBar(),
                    Expanded(
                      child: Center(
                        child: bodyH < 450
                            ? FittedBox(fit: BoxFit.scaleDown, child: portraitInner)
                            : portraitInner,
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
