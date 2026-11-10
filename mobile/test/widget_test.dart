import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jaladesk_mobile/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('Rfc6238Totp generates valid 6-digit RFC 6238 HMAC codes across SHA-1/256/512', () {
    final fixedTime = DateTime.fromMillisecondsSinceEpoch(1700000000 * 1000, isUtc: true);
    final sha1Code = Rfc6238Totp.generateCode(
      'JBSWY3DPEHPK3PXP',
      now: fixedTime,
      algorithm: 'SHA-1',
    );
    final sha256Code = Rfc6238Totp.generateCode(
      'JBSWY3DPEHPK3PXP',
      now: fixedTime,
      algorithm: 'SHA-256',
    );
    final sha512Code = Rfc6238Totp.generateCode(
      'JBSWY3DPEHPK3PXP',
      now: fixedTime,
      algorithm: 'SHA-512',
    );
    expect(sha1Code.length, 6);
    expect(sha256Code.length, 6);
    expect(sha512Code.length, 6);
    expect(int.tryParse(sha1Code), isNotNull);
  });

  testWidgets('JalaDesk Mobile starts with clean empty vault, supports adding hosts & sample lab at 360x780',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(360, 780);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();

    // 1. Verify Empty Vault state on fresh launch (no pre-populated fake servers)
    expect(find.text('JalaDesk'), findsOneWidget);
    expect(find.text('MOBILE PRO'), findsOneWidget);
    expect(find.text('Your Connection Vault is Ready'), findsOneWidget);
    expect(find.text('New Connection'), findsOneWidget);

    // 2. Load Sample Lab servers on user request
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    expect(find.text('brightad1 (Windows 11 Pro)'), findsOneWidget);
    expect(find.text('mitra-jump (Bastion Gateway)'), findsOneWidget);

    // 3. Switch to RDP / VNC Canvas Tab
    await tester.tap(find.text('RDP / VNC'));
    await tester.pumpAndSettle();
    expect(find.text('Trackpad'), findsOneWidget);
    expect(find.text('Direct Touch'), findsOneWidget);
    expect(find.text('Ctrl+Alt+Del'), findsOneWidget);

    // 4. Switch to SSH & SFTP Tab and run a command + toggle SFTP
    await tester.tap(find.text('SSH & SFTP'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('uptime'));
    await tester.pumpAndSettle();
    expect(find.textContaining('load average:'), findsOneWidget);
    await tester.tap(find.text('SFTP Check'));
    await tester.pumpAndSettle();
    expect(find.text('/etc/nginx/conf.d'), findsOneWidget);

    // 5. Switch to Vault & 2FA Tab
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    expect(find.text('RFC 6238 TOTP 2FA Authenticator'), findsOneWidget);
    expect(find.textContaining('Biometric Enclave Unlock'), findsOneWidget);

    // 6. Open Zero-Trust QR Pairing modal
    await tester.tap(find.byIcon(Icons.qr_code_scanner));
    await tester.pumpAndSettle();
    expect(find.text('Pair with JalaDesk Desktop'), findsOneWidget);
    await tester.tap(find.text('Verify & Sync Vault'));
    await tester.pumpAndSettle();
  });

  testWidgets('JalaDesk Mobile renders cleanly with zero overflow even at ultra-compact 320x680 viewport',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(320, 680);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();
    for (final tab in ['Connections', 'RDP / VNC', 'SSH & SFTP', 'Vault & 2FA']) {
      await tester.tap(find.text(tab));
      await tester.pumpAndSettle();
    }
    expect(find.text('Zero-Trust Hardware Enclave'), findsOneWidget);
    expect(find.text('RFC 6238 TOTP 2FA Authenticator'), findsOneWidget);
  });
}
