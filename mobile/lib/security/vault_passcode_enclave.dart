import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'vault_security_service.dart';

Future<bool> _verifyPinNonBlocking(String pin, String storedHash) =>
    NativePlatformBridge.verifyPinFast(pin, storedHash);

Future<String> _hashPinNonBlocking(String pin) =>
    NativePlatformBridge.hashPinFast(pin);

/// Zero-latency (`0.0ms` finger-down) keypad button driven directly by raw `Listener.onPointerDown`.
/// Eliminates `InkWell` `PointerUp` wait and `SingleChildScrollView` `100ms` gesture-arena disambiguation.
class _InstantPinKeyButton extends StatefulWidget {
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
    required this.height,
    this.borderRadius = 12,
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
          duration: _pressed ? Duration.zero : const Duration(milliseconds: 85),
          height: widget.height,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _pressed ? widget.pressedColor : widget.baseColor,
            borderRadius: BorderRadius.circular(widget.borderRadius),
            border: Border.all(
              color: _pressed ? widget.pressedBorderColor : widget.borderColor,
              width: _pressed ? 1.4 : 1.0,
            ),
          ),
          child: widget.child,
        ),
      ),
    );
  }
}

/// Pure UI Numpad Sapphire-Gold Vault Passcode Unlock Enclave:
/// - Animated PIN progress dots adapting cleanly to stored PIN length (`4`–`8` digits)
/// - Tactile `3×4` UI numeric keypad with `HapticFeedback.lightImpact()` & non-blocking `compute()` PBKDF2 auto-unlock
/// - Adaptive side-by-side Landscape layout (`915×412`) and centered Portrait layout with zero `TextField`s
/// - Subtle horizontal shake animation on wrong PIN + 5-attempt 15-second cooldown guard
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
  static const Color _splashBg = Color(0xFF0B1220);
  static const Color _header = Color(0xFF0E141A);
  static const Color _surface = Color(0xFF1F2833);
  static const Color _selected = Color(0xFF2A4560);
  static const Color _lineInput = Color(0xFF39495C);
  static const Color _brandGold = Color(0xFFF3C66F);
  static const Color _danger = Color(0xFFF26D6D);
  static const Color _text = Color(0xFFEDF2F7);
  static const Color _muted = Color(0xFF8C9AA8);

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
          _unlockError = 'Incorrect Vault PIN. Please try again.';
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
        Stack(
          alignment: Alignment.bottomRight,
          children: [
            widget.brandLogo,
            Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: _header,
                shape: BoxShape.circle,
                border: Border.all(color: _brandGold, width: 1.1),
              ),
              child: const Icon(Icons.shield_rounded, size: 12, color: _brandGold),
            ),
          ],
        ),
        SizedBox(height: compact ? 8 : 10),
        const Text(
          'JalaDesk Vault Locked',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: _text),
        ),
        const SizedBox(height: 3),
        Text(
          'Enter your $_effectivePinLen-digit Security PIN on the keypad to unseal your vault.',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 11.5, color: _muted, height: 1.3),
        ),
        SizedBox(height: compact ? 12 : 16),
        AnimatedBuilder(
          animation: _shakeCtrl,
          builder: (ctx, child) {
            final dx = math.sin(_shakeCtrl.value * math.pi * 4) * 10.0 * (1.0 - _shakeCtrl.value);
            return Transform.translate(offset: Offset(dx, 0), child: child);
          },
          child: Wrap(
            key: const ValueKey('vault_pin_progress_dots'),
            alignment: WrapAlignment.center,
            spacing: 10,
            runSpacing: 6,
            children: [
              for (int i = 0; i < dotCount; i++)
                AnimatedContainer(
                  duration: const Duration(milliseconds: 40),
                  width: i < currentLen ? 13 : 11,
                  height: i < currentLen ? 13 : 11,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: i < currentLen ? _brandGold : _header,
                    border: Border.all(
                      color: i < currentLen ? _brandGold : _lineInput,
                      width: 1.4,
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (_unlockError != null) ...[
          const SizedBox(height: 8),
          Text(
            _unlockError!,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              color: _danger,
            ),
          ),
        ] else if (_biometricBusy) ...[
          const SizedBox(height: 8),
          const Text(
            'Verifying biometrics...',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: _brandGold),
          ),
        ],
      ],
    );
  }

  Widget _buildNumericKeypad({required double buttonHeight}) {
    const rows = <List<String>>[
      <String>['1', '2', '3'],
      <String>['4', '5', '6'],
      <String>['7', '8', '9'],
    ];
    final disabled = _cooldownSecondsLeft > 0 || _verifyingPin;

    Widget buildDigitButton(String d) {
      return Expanded(
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: _InstantPinKeyButton(
            key: ValueKey('btn_pin_digit_$d'),
            height: buttonHeight,
            borderRadius: 12,
            baseColor: _header.withValues(alpha: 0.92),
            pressedColor: _selected.withValues(alpha: 0.85),
            borderColor: _lineInput.withValues(alpha: 0.78),
            pressedBorderColor: _brandGold,
            onTriggered: disabled ? null : () => _onKeypadDigit(d),
            child: Text(
              d,
              style: TextStyle(
                fontSize: buttonHeight <= 40 ? 17 : 19,
                fontWeight: FontWeight.w700,
                color: _text,
              ),
            ),
          ),
        ),
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in rows)
          Row(
            children: [
              for (final d in row) buildDigitButton(d),
            ],
          ),
        Row(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: _InstantPinKeyButton(
                  key: ValueKey(widget.biometricEnabled ? 'btn_pin_biometric' : 'btn_pin_clear'),
                  height: buttonHeight,
                  borderRadius: 12,
                  baseColor: _selected.withValues(alpha: 0.55),
                  pressedColor: _selected.withValues(alpha: 0.9),
                  borderColor: _brandGold.withValues(alpha: 0.42),
                  pressedBorderColor: _brandGold,
                  onTriggered: disabled
                      ? null
                      : (widget.biometricEnabled ? _triggerBiometricUnlock : _onKeypadClear),
                  child: widget.biometricEnabled
                      ? const Icon(Icons.fingerprint_rounded, size: 21, color: _brandGold)
                      : const Text(
                          'Clear',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w700,
                            color: _brandGold,
                          ),
                        ),
                ),
              ),
            ),
            buildDigitButton('0'),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: _InstantPinKeyButton(
                  key: const ValueKey('btn_pin_backspace'),
                  height: buttonHeight,
                  borderRadius: 12,
                  baseColor: _header.withValues(alpha: 0.92),
                  pressedColor: _selected.withValues(alpha: 0.85),
                  borderColor: _lineInput.withValues(alpha: 0.78),
                  pressedBorderColor: _brandGold,
                  onTriggered: disabled ? null : _onKeypadBackspace,
                  child: const Icon(Icons.backspace_outlined, size: 18, color: _brandGold),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final mediaPadding = MediaQuery.paddingOf(context);
    final symPadX = math.max(mediaPadding.left, mediaPadding.right) + 16.0;

    return Scaffold(
      key: const ValueKey('vault_pin_lock_screen'),
      backgroundColor: _splashBg,
      body: SafeArea(
        left: false,
        right: false,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final isCompactLandscape =
                constraints.maxWidth > constraints.maxHeight && constraints.maxHeight < 480;

            if (isCompactLandscape) {
              final landscapeBtnHeight = (constraints.maxHeight * 0.14).clamp(32.0, 42.0);
              final Widget landscapeCard = ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 640),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                  decoration: BoxDecoration(
                    color: _surface,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: _brandGold.withValues(alpha: 0.45)),
                    boxShadow: const [
                      BoxShadow(color: Colors.black54, blurRadius: 24, offset: Offset(0, 10)),
                    ],
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        flex: 5,
                        child: _buildHeaderAndDots(compact: true),
                      ),
                      const SizedBox(width: 18),
                      Expanded(
                        flex: 6,
                        child: _buildNumericKeypad(buttonHeight: landscapeBtnHeight),
                      ),
                    ],
                  ),
                ),
              );
              return Center(
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: symPadX, vertical: 8),
                  child: constraints.maxHeight < 280
                      ? FittedBox(fit: BoxFit.scaleDown, child: landscapeCard)
                      : landscapeCard,
                ),
              );
            }

            final portraitBtnHeight = (constraints.maxHeight * 0.082).clamp(36.0, 50.0);
            final Widget portraitCard = ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 356),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
                decoration: BoxDecoration(
                  color: _surface,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: _brandGold.withValues(alpha: 0.45)),
                  boxShadow: const [
                    BoxShadow(color: Colors.black54, blurRadius: 24, offset: Offset(0, 10)),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _buildHeaderAndDots(compact: false),
                    const SizedBox(height: 16),
                    _buildNumericKeypad(buttonHeight: portraitBtnHeight),
                  ],
                ),
              ),
            );
            return Center(
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: symPadX, vertical: 14),
                child: constraints.maxHeight < 280
                    ? FittedBox(fit: BoxFit.scaleDown, child: portraitCard)
                    : portraitCard,
              ),
            );
          },
        ),
      ),
    );
  }
}

/// Pure UI Numpad Guided Passcode Setup Sheet / Dialog:
/// - Zero `TextField`s — 100% tactile `3×4` UI keypad interaction
/// - Quick selector between `6 Digits` (`chip_pin_len_6`) and `4 Digits` (`chip_pin_len_4`)
/// - Guided stages (`Enter Current PIN` -> `Create Security PIN` / `Remove PIN` -> `Confirm Security PIN`)
/// - Non-blocking `compute()` PBKDF2-HMAC-SHA256 verification and hashing + responsive Landscape layout
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

class _VaultPinSetupSheetState extends State<VaultPinSetupSheet> {
  static const Color _header = Color(0xFF0E141A);
  static const Color _surface = Color(0xFF1F2833);
  static const Color _selected = Color(0xFF2A4560);
  static const Color _lineInput = Color(0xFF39495C);
  static const Color _brandGold = Color(0xFFF3C66F);
  static const Color _danger = Color(0xFFF26D6D);
  static const Color _text = Color(0xFFEDF2F7);
  static const Color _text2 = Color(0xFFC4CFD9);
  static const Color _muted = Color(0xFF8C9AA8);

  String _currentPin = '';
  String _newPin = '';
  String _confirmPin = '';

  late int _targetPinLen;
  late int _stage; // 0 = Enter Current PIN, 1 = Create PIN, 2 = Confirm PIN
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

  String get _stageTitle {
    if (_stage == 0) return 'Step 1 • Enter Current PIN';
    if (_stage == 1) {
      return _hasExisting ? 'Create New PIN' : 'Step 1 • Create Security PIN';
    }
    return _hasExisting ? 'Confirm New PIN' : 'Step 2 • Confirm Security PIN';
  }

  String get _stageSubtitle {
    if (_stage == 0) {
      return 'Verify your current ${widget.initialPinLength.clamp(4, 12)}-digit PIN to remove or replace it.';
    }
    if (_stage == 1) {
      return _hasExisting
          ? 'Current PIN verified. Remove PIN below or enter a new $_targetPinLen-digit PIN.'
          : 'Tap $_targetPinLen digits on the keypad below.';
    }
    return 'Re-enter the same $_targetPinLen digits to activate Vault App-Lock.';
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

  Widget _buildLengthSelector() {
    if (_stage == 0) return const SizedBox.shrink();
    return Wrap(
      spacing: 8,
      runSpacing: 6,
      alignment: WrapAlignment.center,
      children: [
        ChoiceChip(
          key: const ValueKey('chip_pin_len_4'),
          label: const Text('4 Digits', style: TextStyle(fontSize: 11)),
          selected: _targetPinLen == 4,
          visualDensity: VisualDensity.compact,
          selectedColor: _selected,
          backgroundColor: _header,
          labelStyle: TextStyle(
            fontWeight: FontWeight.w700,
            color: _targetPinLen == 4 ? _brandGold : _text2,
          ),
          side: BorderSide(color: _targetPinLen == 4 ? _brandGold : _lineInput),
          onSelected: _busy
              ? null
              : (_) => setState(() {
                    _targetPinLen = 4;
                    _newPin = '';
                    _confirmPin = '';
                    _stage = 1;
                    _errorMsg = null;
                  }),
        ),
        ChoiceChip(
          key: const ValueKey('chip_pin_len_6'),
          label: const Text('6 Digits', style: TextStyle(fontSize: 11)),
          selected: _targetPinLen == 6,
          visualDensity: VisualDensity.compact,
          selectedColor: _selected,
          backgroundColor: _header,
          labelStyle: TextStyle(
            fontWeight: FontWeight.w700,
            color: _targetPinLen == 6 ? _brandGold : _text2,
          ),
          side: BorderSide(color: _targetPinLen == 6 ? _brandGold : _lineInput),
          onSelected: _busy
              ? null
              : (_) => setState(() {
                    _targetPinLen = 6;
                    _newPin = '';
                    _confirmPin = '';
                    _stage = 1;
                    _errorMsg = null;
                  }),
        ),
      ],
    );
  }

  Widget _buildInfoColumn({required bool compact}) {
    final activeLen = _activePin.length;
    final dotTarget = _activeTargetLen.clamp(4, 12);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _buildLengthSelector(),
        if (_stage != 0) SizedBox(height: compact ? 6 : 10),
        Text(
          _stageTitle,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w800,
            color: _brandGold,
          ),
        ),
        const SizedBox(height: 3),
        Text(
          _stageSubtitle,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 11, color: _muted, height: 1.3),
        ),
        SizedBox(height: compact ? 8 : 12),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: 10,
          runSpacing: 6,
          children: [
            for (int i = 0; i < dotTarget; i++)
              AnimatedContainer(
                duration: const Duration(milliseconds: 40),
                width: i < activeLen ? 12.5 : 10.5,
                height: i < activeLen ? 12.5 : 10.5,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: i < activeLen ? _brandGold : _header,
                  border: Border.all(
                    color: i < activeLen ? _brandGold : _lineInput,
                    width: 1.3,
                  ),
                ),
              ),
          ],
        ),
        if (_errorMsg != null) ...[
          const SizedBox(height: 7),
          Text(
            _errorMsg!,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 11.5, color: _danger, fontWeight: FontWeight.w600),
          ),
        ],
        if (_hasExisting && _currentVerified) ...[
          SizedBox(height: compact ? 8 : 10),
          OutlinedButton.icon(
            key: const ValueKey('btn_remove_vault_pin'),
            style: OutlinedButton.styleFrom(
              foregroundColor: _danger,
              side: BorderSide(color: _danger.withValues(alpha: 0.65)),
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            ),
            onPressed: _busy ? null : _handleVerifiedRemovePin,
            icon: const Icon(Icons.lock_open_rounded, size: 15),
            label: const Text(
              'Remove PIN',
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildSetupKeypad({required double buttonHeight}) {
    Widget buildSetupDigitButton(String d) {
      return Expanded(
        child: Padding(
          padding: const EdgeInsets.all(3),
          child: _InstantPinKeyButton(
            key: ValueKey('btn_setup_pin_digit_$d'),
            height: buttonHeight,
            borderRadius: 10,
            baseColor: _header,
            pressedColor: _selected.withValues(alpha: 0.85),
            borderColor: _lineInput,
            pressedBorderColor: _brandGold,
            onTriggered: _busy ? null : () => _onSetupKeypadDigit(d),
            child: Text(
              d,
              style: const TextStyle(
                fontSize: 16.5,
                fontWeight: FontWeight.w700,
                color: _text,
              ),
            ),
          ),
        ),
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in const <List<String>>[
          <String>['1', '2', '3'],
          <String>['4', '5', '6'],
          <String>['7', '8', '9'],
        ])
          Row(
            children: [
              for (final d in row) buildSetupDigitButton(d),
            ],
          ),
        Row(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(3),
                child: _InstantPinKeyButton(
                  key: const ValueKey('btn_setup_pin_clear'),
                  height: buttonHeight,
                  borderRadius: 10,
                  baseColor: _header,
                  pressedColor: _selected.withValues(alpha: 0.85),
                  borderColor: _lineInput,
                  pressedBorderColor: _brandGold,
                  onTriggered: _busy ? null : _onSetupClear,
                  child: const Text(
                    'Clear',
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _muted),
                  ),
                ),
              ),
            ),
            buildSetupDigitButton('0'),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(3),
                child: _InstantPinKeyButton(
                  key: const ValueKey('btn_setup_pin_backspace'),
                  height: buttonHeight,
                  borderRadius: 10,
                  baseColor: _header,
                  pressedColor: _selected.withValues(alpha: 0.85),
                  borderColor: _lineInput,
                  pressedBorderColor: _brandGold,
                  onTriggered: _busy ? null : _onSetupBackspace,
                  child: const Icon(Icons.backspace_outlined, size: 16, color: _brandGold),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final screenSize = MediaQuery.sizeOf(context);
    final isLandscape = screenSize.width > screenSize.height && screenSize.height < 480;

    return Dialog(
      backgroundColor: _surface,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: _brandGold.withValues(alpha: 0.45)),
      ),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: isLandscape ? 600 : 380),
        child: Padding(
          padding: EdgeInsets.fromLTRB(18, isLandscape ? 10 : 14, 18, isLandscape ? 10 : 14),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  const Icon(Icons.shield_outlined, size: 19, color: _brandGold),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _hasExisting ? 'Manage Vault Security PIN' : 'Setup Vault Security PIN',
                      style: const TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w800,
                        color: _text,
                      ),
                    ),
                  ),
                  TextButton(
                    key: const ValueKey('btn_cancel_vault_pin'),
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    onPressed: _busy ? null : () => Navigator.of(context).pop(),
                    child: const Text('Cancel', style: TextStyle(fontSize: 11.5, color: _muted)),
                  ),
                ],
              ),
              SizedBox(height: isLandscape ? 6 : 8),
              Flexible(
                child: SingleChildScrollView(
                  child: isLandscape
                      ? Row(
                          children: [
                            Expanded(
                              flex: 5,
                              child: _buildInfoColumn(compact: true),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              flex: 6,
                              child: _buildSetupKeypad(buttonHeight: 35),
                            ),
                          ],
                        )
                      : Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            _buildInfoColumn(compact: false),
                            const SizedBox(height: 12),
                            _buildSetupKeypad(buttonHeight: 42),
                          ],
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
