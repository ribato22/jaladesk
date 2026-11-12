import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'vault_security_service.dart';

/// Fintech-grade Sapphire-Gold Vault Passcode Unlock Enclave with:
/// - Animated PIN progress dots adapting cleanly to stored PIN length (`4`–`8` digits)
/// - Tactile `3×4` numeric keypad with `HapticFeedback.lightImpact()` & instant auto-unlock
/// - Subtle horizontal shake animation on wrong PIN + 5-attempt 15-second cooldown guard
/// - Synced accessible `TextField` (`field_unlock_vault_pin`) & button (`btn_unlock_vault_pin`)
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
  static const Color _accent = Color(0xFF1A56DB);
  static const Color _danger = Color(0xFFF26D6D);
  static const Color _text = Color(0xFFEDF2F7);
  static const Color _muted = Color(0xFF8C9AA8);

  final TextEditingController _pinCtrl = TextEditingController();
  late final AnimationController _shakeCtrl;
  String? _unlockError;
  bool _biometricBusy = false;
  bool _showCustomInputField = false;
  int _failedAttempts = 0;
  int _cooldownSecondsLeft = 0;
  Timer? _cooldownTimer;

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
    _cooldownTimer?.cancel();
    _shakeCtrl.dispose();
    _pinCtrl.dispose();
    super.dispose();
  }

  Future<void> _autoCheckAndPromptBiometric() async {
    if (!mounted || !widget.biometricEnabled) return;
    final available = await NativePlatformBridge.isBiometricAvailable();
    if (!mounted || !available) return;
    await _triggerBiometricUnlock();
  }

  Future<void> _triggerBiometricUnlock() async {
    if (_biometricBusy || _cooldownSecondsLeft > 0) return;
    setState(() {
      _biometricBusy = true;
      _unlockError = null;
    });
    final verified = await NativePlatformBridge.authenticateBiometric();
    if (!mounted) return;
    setState(() => _biometricBusy = false);
    if (verified) {
      HapticFeedback.mediumImpact();
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

  void _tryUnlock() {
    if (_cooldownSecondsLeft > 0) return;
    final pin = _pinCtrl.text.trim();
    if (pin.isEmpty) return;

    if (VaultPinHasher.verifyPin(pin, widget.pinHash)) {
      HapticFeedback.mediumImpact();
      _failedAttempts = 0;
      widget.onUnlocked();
    } else {
      HapticFeedback.heavyImpact();
      _shakeCtrl.forward(from: 0.0);
      _failedAttempts++;
      _pinCtrl.clear();
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
    if (_cooldownSecondsLeft > 0) return;
    HapticFeedback.lightImpact();
    final next = '${_pinCtrl.text}$digit';
    if (next.length > 12) return;
    setState(() {
      _unlockError = null;
      _pinCtrl.value = TextEditingValue(
        text: next,
        selection: TextSelection.collapsed(offset: next.length),
      );
    });
    if (next.length == _effectivePinLen) {
      _tryUnlock();
    }
  }

  void _onKeypadBackspace() {
    if (_cooldownSecondsLeft > 0 || _pinCtrl.text.isEmpty) return;
    HapticFeedback.selectionClick();
    final next = _pinCtrl.text.substring(0, _pinCtrl.text.length - 1);
    setState(() {
      _pinCtrl.value = TextEditingValue(
        text: next,
        selection: TextSelection.collapsed(offset: next.length),
      );
    });
  }

  void _onKeypadClear() {
    if (_cooldownSecondsLeft > 0 || _pinCtrl.text.isEmpty) return;
    HapticFeedback.selectionClick();
    setState(() => _pinCtrl.clear());
  }

  @override
  Widget build(BuildContext context) {
    final currentLen = _pinCtrl.text.length;
    final dotCount = math.max(_effectivePinLen, currentLen).clamp(4, 8);

    return Scaffold(
      key: const ValueKey('vault_pin_lock_screen'),
      backgroundColor: _splashBg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 360),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
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
                    // Sapphire-Gold Shield Emblem + Brand Logo
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
                    const SizedBox(height: 10),
                    const Text(
                      'JalaDesk Vault Locked',
                      style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: _text),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'Enter your $_effectivePinLen-digit Security PIN to unseal servers, SSH keys & 2FA.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 11.5, color: _muted, height: 1.3),
                    ),
                    const SizedBox(height: 14),
                    // Animated PIN Progress Dots with subtle horizontal shake on wrong PIN
                    AnimatedBuilder(
                      animation: _shakeCtrl,
                      builder: (ctx, child) {
                        final dx = math.sin(_shakeCtrl.value * math.pi * 4) *
                            10.0 *
                            (1.0 - _shakeCtrl.value);
                        return Transform.translate(offset: Offset(dx, 0), child: child);
                      },
                      child: Row(
                        key: const ValueKey('vault_pin_progress_dots'),
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          for (int i = 0; i < dotCount; i++)
                            AnimatedContainer(
                              duration: const Duration(milliseconds: 140),
                              margin: const EdgeInsets.symmetric(horizontal: 5),
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
                    ],
                    const SizedBox(height: 14),
                    // Tactile 3x4 Numeric Keypad
                    _buildNumericKeypad(),
                    const SizedBox(height: 10),
                    // Synced Accessible TextField (compact/collapsible for custom-length PINs & automated tests)
                    SizedBox(
                      height: _showCustomInputField ? 40 : 1,
                      child: Opacity(
                        opacity: _showCustomInputField ? 1.0 : 0.02,
                        child: TextField(
                          key: const ValueKey('field_unlock_vault_pin'),
                          controller: _pinCtrl,
                          obscureText: true,
                          keyboardType: TextInputType.number,
                          textAlign: TextAlign.center,
                          onChanged: (_) => setState(() => _unlockError = null),
                          onSubmitted: (_) => _tryUnlock(),
                          style: const TextStyle(
                            fontSize: 14,
                            fontFamily: 'monospace',
                            letterSpacing: 3,
                            fontWeight: FontWeight.w700,
                            color: _brandGold,
                          ),
                          decoration: InputDecoration(
                            hintText: 'Custom PIN',
                            isDense: true,
                            contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                            filled: true,
                            fillColor: _header,
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8),
                              borderSide: const BorderSide(color: _lineInput),
                            ),
                          ),
                        ),
                      ),
                    ),
                    if (_showCustomInputField) const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: FilledButton.icon(
                            key: const ValueKey('btn_unlock_vault_pin'),
                            style: FilledButton.styleFrom(
                              backgroundColor: _accent,
                              foregroundColor: Colors.white,
                              visualDensity: VisualDensity.compact,
                              padding: const EdgeInsets.symmetric(vertical: 10),
                            ),
                            onPressed: _cooldownSecondsLeft > 0 ? null : _tryUnlock,
                            icon: const Icon(Icons.lock_open_rounded, size: 16),
                            label: const Text(
                              'Unlock Vault',
                              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        IconButton(
                          tooltip: _showCustomInputField ? 'Hide Keyboard Field' : 'Type Custom PIN',
                          onPressed: () => setState(() => _showCustomInputField = !_showCustomInputField),
                          style: IconButton.styleFrom(
                            backgroundColor: _header,
                            side: const BorderSide(color: _lineInput),
                            visualDensity: VisualDensity.compact,
                          ),
                          icon: const Icon(Icons.keyboard_alt_outlined, size: 16, color: _brandGold),
                        ),
                      ],
                    ),
                    if (widget.biometricEnabled) ...[
                      const SizedBox(height: 6),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          key: const ValueKey('btn_unlock_vault_biometric'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: _brandGold,
                            side: BorderSide(color: _brandGold.withValues(alpha: 0.55)),
                            visualDensity: VisualDensity.compact,
                            padding: const EdgeInsets.symmetric(vertical: 8),
                          ),
                          onPressed: (_biometricBusy || _cooldownSecondsLeft > 0)
                              ? null
                              : _triggerBiometricUnlock,
                          icon: const Icon(Icons.fingerprint_rounded, size: 17),
                          label: Text(
                            _biometricBusy ? 'Verifying Biometrics...' : 'Biometric Unlock',
                            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildNumericKeypad() {
    const rows = <List<String>>[
      <String>['1', '2', '3'],
      <String>['4', '5', '6'],
      <String>['7', '8', '9'],
    ];

    Widget buildDigitButton(String d) {
      return Expanded(
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: Material(
            color: _header.withValues(alpha: 0.90),
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              key: ValueKey('btn_pin_digit_$d'),
              borderRadius: BorderRadius.circular(12),
              onTap: _cooldownSecondsLeft > 0 ? null : () => _onKeypadDigit(d),
              child: Container(
                height: 44,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: _lineInput.withValues(alpha: 0.75)),
                ),
                child: Text(
                  d,
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                    color: _text,
                  ),
                ),
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
                child: Material(
                  color: _selected.withValues(alpha: 0.55),
                  borderRadius: BorderRadius.circular(12),
                  child: InkWell(
                    key: ValueKey(widget.biometricEnabled ? 'btn_keypad_biometric' : 'btn_pin_clear'),
                    borderRadius: BorderRadius.circular(12),
                    onTap: _cooldownSecondsLeft > 0
                        ? null
                        : (widget.biometricEnabled ? _triggerBiometricUnlock : _onKeypadClear),
                    child: Container(
                      height: 44,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: _brandGold.withValues(alpha: 0.4)),
                      ),
                      child: widget.biometricEnabled
                          ? const Icon(Icons.fingerprint_rounded, size: 20, color: _brandGold)
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
              ),
            ),
            buildDigitButton('0'),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: Material(
                  color: _header.withValues(alpha: 0.90),
                  borderRadius: BorderRadius.circular(12),
                  child: InkWell(
                    key: const ValueKey('btn_pin_backspace'),
                    borderRadius: BorderRadius.circular(12),
                    onTap: _cooldownSecondsLeft > 0 ? null : _onKeypadBackspace,
                    child: Container(
                      height: 44,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: _lineInput.withValues(alpha: 0.75)),
                      ),
                      child: const Icon(Icons.backspace_outlined, size: 18, color: _brandGold),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// World-Class Passcode Setup Modal Sheet / Dialog supporting:
/// - Quick selector between 6-Digit PIN (Recommended) and 4-Digit PIN
/// - Step-by-step guided stages (`Verify Current PIN` -> `Create Security PIN` -> `Confirm Security PIN`)
/// - Tactile `3×4` keypad + animated Sapphire-Gold progress dots + synced accessible `TextField`s
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
  static const Color _accent = Color(0xFF1A56DB);
  static const Color _danger = Color(0xFFF26D6D);
  static const Color _text = Color(0xFFEDF2F7);
  static const Color _text2 = Color(0xFFC4CFD9);
  static const Color _muted = Color(0xFF8C9AA8);

  final TextEditingController _currentCtrl = TextEditingController();
  final TextEditingController _newPinCtrl = TextEditingController();
  final TextEditingController _confirmCtrl = TextEditingController();

  late int _targetPinLen;
  late int _stage; // 0 = verify current, 1 = create new, 2 = confirm new
  String? _errorMsg;

  bool get _hasExisting => widget.existingPinHash.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _targetPinLen = widget.initialPinLength == 4 ? 4 : 6;
    _stage = _hasExisting ? 0 : 1;
  }

  @override
  void dispose() {
    _currentCtrl.dispose();
    _newPinCtrl.dispose();
    _confirmCtrl.dispose();
    super.dispose();
  }

  TextEditingController get _activeController {
    if (_stage == 0) return _currentCtrl;
    if (_stage == 1) return _newPinCtrl;
    return _confirmCtrl;
  }

  String get _stageTitle {
    if (_stage == 0) return 'Step 1 • Verify Current PIN';
    if (_stage == 1) return _hasExisting ? 'Step 2 • Create New PIN' : 'Step 1 • Create Security PIN';
    return _hasExisting ? 'Step 3 • Confirm New PIN' : 'Step 2 • Confirm Security PIN';
  }

  void _handleSave() {
    if (_hasExisting &&
        !VaultPinHasher.verifyPin(_currentCtrl.text.trim(), widget.existingPinHash)) {
      setState(() {
        _stage = 0;
        _errorMsg = 'Current PIN is incorrect.';
      });
      return;
    }
    final pin = _newPinCtrl.text.trim();
    if (pin.length < 4 || pin.length > 12) {
      setState(() {
        _stage = 1;
        _errorMsg = 'PIN must be between 4 and 12 digits.';
      });
      return;
    }
    if (pin != _confirmCtrl.text.trim()) {
      setState(() {
        _stage = 2;
        _confirmCtrl.clear();
        _errorMsg = 'PIN confirmation does not match.';
      });
      return;
    }
    HapticFeedback.mediumImpact();
    final hashed = VaultPinHasher.hashPin(pin);
    Navigator.of(context).pop();
    widget.onSavePin(hashed, pin.length);
  }

  void _handleRemove() {
    if (!VaultPinHasher.verifyPin(_currentCtrl.text.trim(), widget.existingPinHash)) {
      setState(() {
        _stage = 0;
        _errorMsg = 'Current PIN is incorrect.';
      });
      return;
    }
    HapticFeedback.mediumImpact();
    Navigator.of(context).pop();
    widget.onRemovePin();
  }

  void _onSetupKeypadDigit(String d) {
    HapticFeedback.lightImpact();
    final ctrl = _activeController;
    final maxTarget = _stage == 0 ? widget.initialPinLength.clamp(4, 12) : _targetPinLen;
    if (ctrl.text.length >= 12) return;
    final next = '${ctrl.text}$d';
    setState(() {
      _errorMsg = null;
      ctrl.value = TextEditingValue(
        text: next,
        selection: TextSelection.collapsed(offset: next.length),
      );
    });

    if (_stage == 0 && next.length == maxTarget) {
      if (VaultPinHasher.verifyPin(next, widget.existingPinHash)) {
        setState(() => _stage = 1);
      } else {
        HapticFeedback.heavyImpact();
        setState(() {
          _currentCtrl.clear();
          _errorMsg = 'Current PIN is incorrect.';
        });
      }
    } else if (_stage == 1 && next.length == _targetPinLen) {
      setState(() => _stage = 2);
    } else if (_stage == 2 && next.length == _targetPinLen) {
      _handleSave();
    }
  }

  void _onSetupBackspace() {
    final ctrl = _activeController;
    if (ctrl.text.isEmpty) return;
    HapticFeedback.selectionClick();
    final next = ctrl.text.substring(0, ctrl.text.length - 1);
    setState(() {
      ctrl.value = TextEditingValue(
        text: next,
        selection: TextSelection.collapsed(offset: next.length),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final activeText = _activeController.text;
    final dotTarget = _stage == 0 ? widget.initialPinLength.clamp(4, 8) : _targetPinLen;

    return Dialog(
      backgroundColor: _surface,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: _brandGold.withValues(alpha: 0.45)),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 400),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                children: [
                  const Icon(Icons.shield_outlined, size: 20, color: _brandGold),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _hasExisting ? 'Manage Vault Security PIN' : 'Setup Vault Security PIN',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w800,
                        color: _text,
                      ),
                    ),
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded, size: 18, color: _muted),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              // Quick 6-Digit vs 4-Digit selector (Wrap prevents horizontal overflow on narrow phones/fonts)
              Wrap(
                spacing: 8,
                runSpacing: 6,
                alignment: WrapAlignment.center,
                children: [
                  ChoiceChip(
                    key: const ValueKey('chip_pin_len_6'),
                    label: const Text('6-Digit (Rec.)', style: TextStyle(fontSize: 11)),
                    selected: _targetPinLen == 6,
                    visualDensity: VisualDensity.compact,
                    selectedColor: _selected,
                    backgroundColor: _header,
                    labelStyle: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: _targetPinLen == 6 ? _brandGold : _text2,
                    ),
                    side: BorderSide(color: _targetPinLen == 6 ? _brandGold : _lineInput),
                    onSelected: (_) => setState(() {
                      _targetPinLen = 6;
                      _newPinCtrl.clear();
                      _confirmCtrl.clear();
                      if (_stage > 1) _stage = 1;
                    }),
                  ),
                  ChoiceChip(
                    key: const ValueKey('chip_pin_len_4'),
                    label: const Text('4-Digit', style: TextStyle(fontSize: 11)),
                    selected: _targetPinLen == 4,
                    visualDensity: VisualDensity.compact,
                    selectedColor: _selected,
                    backgroundColor: _header,
                    labelStyle: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: _targetPinLen == 4 ? _brandGold : _text2,
                    ),
                    side: BorderSide(color: _targetPinLen == 4 ? _brandGold : _lineInput),
                    onSelected: (_) => setState(() {
                      _targetPinLen = 4;
                      _newPinCtrl.clear();
                      _confirmCtrl.clear();
                      if (_stage > 1) _stage = 1;
                    }),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                _stageTitle,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                  color: _brandGold,
                ),
              ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (int i = 0; i < dotTarget; i++)
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 140),
                      margin: const EdgeInsets.symmetric(horizontal: 5),
                      width: i < activeText.length ? 12 : 10,
                      height: i < activeText.length ? 12 : 10,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i < activeText.length ? _brandGold : _header,
                        border: Border.all(
                          color: i < activeText.length ? _brandGold : _lineInput,
                          width: 1.3,
                        ),
                      ),
                    ),
                ],
              ),
              if (_errorMsg != null) ...[
                const SizedBox(height: 6),
                Text(
                  _errorMsg!,
                  style: const TextStyle(fontSize: 11.5, color: _danger, fontWeight: FontWeight.w600),
                ),
              ],
              const SizedBox(height: 10),
              // Tactile 3x4 Setup Keypad
              for (final row in const <List<String>>[
                <String>['1', '2', '3'],
                <String>['4', '5', '6'],
                <String>['7', '8', '9'],
              ])
                Row(
                  children: [
                    for (final d in row)
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.all(3),
                          child: InkWell(
                            key: ValueKey('btn_setup_pin_digit_$d'),
                            borderRadius: BorderRadius.circular(10),
                            onTap: () => _onSetupKeypadDigit(d),
                            child: Container(
                              height: 38,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: _header,
                                borderRadius: BorderRadius.circular(10),
                                border: Border.all(color: _lineInput),
                              ),
                              child: Text(
                                d,
                                style: const TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.w700,
                                  color: _text,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              Row(
                children: [
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.all(3),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: () => setState(() => _activeController.clear()),
                        child: Container(
                          height: 38,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: _header,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: _lineInput),
                          ),
                          child: const Text(
                            'Clear',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _muted),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.all(3),
                      child: InkWell(
                        key: const ValueKey('btn_setup_pin_digit_0'),
                        borderRadius: BorderRadius.circular(10),
                        onTap: () => _onSetupKeypadDigit('0'),
                        child: Container(
                          height: 38,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: _header,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: _lineInput),
                          ),
                          child: const Text(
                            '0',
                            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: _text),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.all(3),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: _onSetupBackspace,
                        child: Container(
                          height: 38,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: _header,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: _lineInput),
                          ),
                          child: const Icon(Icons.backspace_outlined, size: 16, color: _brandGold),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              // Accessible synced fields for direct custom entry & automated widget test compatibility
              if (_hasExisting) ...[
                TextField(
                  key: const ValueKey('field_current_vault_pin'),
                  controller: _currentCtrl,
                  obscureText: true,
                  keyboardType: TextInputType.number,
                  onTap: () => setState(() => _stage = 0),
                  onChanged: (_) => setState(() => _errorMsg = null),
                  style: const TextStyle(fontSize: 12, color: _text),
                  decoration: InputDecoration(
                    labelText: 'Current PIN *',
                    labelStyle: const TextStyle(fontSize: 11, color: _brandGold),
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                    filled: true,
                    fillColor: _header,
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                  ),
                ),
                const SizedBox(height: 6),
              ],
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const ValueKey('field_new_vault_pin'),
                      controller: _newPinCtrl,
                      obscureText: true,
                      keyboardType: TextInputType.number,
                      onTap: () => setState(() => _stage = 1),
                      onChanged: (_) => setState(() => _errorMsg = null),
                      style: const TextStyle(fontSize: 12, color: _text),
                      decoration: InputDecoration(
                        labelText: _hasExisting ? 'New PIN' : 'Security PIN *',
                        labelStyle: const TextStyle(fontSize: 11, color: _text2),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                        filled: true,
                        fillColor: _header,
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: TextField(
                      key: const ValueKey('field_confirm_vault_pin'),
                      controller: _confirmCtrl,
                      obscureText: true,
                      keyboardType: TextInputType.number,
                      onTap: () => setState(() => _stage = 2),
                      onChanged: (_) => setState(() => _errorMsg = null),
                      style: const TextStyle(fontSize: 12, color: _text),
                      decoration: InputDecoration(
                        labelText: 'Confirm PIN *',
                        labelStyle: const TextStyle(fontSize: 11, color: _text2),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                        filled: true,
                        fillColor: _header,
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                    ),
                  ),
                ],
              ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel', style: TextStyle(fontSize: 12, color: _muted)),
                  ),
                  if (_hasExisting)
                    TextButton(
                      key: const ValueKey('btn_remove_vault_pin'),
                      onPressed: _handleRemove,
                      child: const Text(
                        'Remove PIN',
                        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: _danger),
                      ),
                    ),
                  const SizedBox(width: 4),
                  FilledButton(
                    key: const ValueKey('btn_save_vault_pin'),
                    style: FilledButton.styleFrom(
                      backgroundColor: _accent,
                      foregroundColor: Colors.white,
                      visualDensity: VisualDensity.compact,
                    ),
                    onPressed: _handleSave,
                    child: const Text('Save PIN', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
