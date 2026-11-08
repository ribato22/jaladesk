import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jaladesk_mobile/main.dart';

void main() {
  testWidgets('JalaDesk Mobile renders Sapphire-Gold brand UI and executes RDP/SSH/Vault actions',
      (WidgetTester tester) async {
    await tester.pumpWidget(const JalaDeskMobileApp());

    // 1. Verify JalaDesk Brand Header & Connections Vault Tab
    expect(find.text('JalaDesk'), findsOneWidget);
    expect(find.text('MOBILE PRO'), findsOneWidget);
    expect(find.text('JalaDesk Enterprise Vault'), findsOneWidget);
    expect(find.text('brightad1 (Windows 11 Pro)'), findsOneWidget);
    expect(find.text('mitra-jump (Bastion Gateway)'), findsOneWidget);

    // 2. Switch to RDP / VNC Canvas Tab
    await tester.tap(find.text('RDP / VNC'));
    await tester.pumpAndSettle();
    expect(find.text('Trackpad'), findsOneWidget);
    expect(find.text('Direct Touch'), findsOneWidget);
    expect(find.text('Ctrl+Alt+Del'), findsOneWidget);

    // 3. Switch to SSH & SFTP Tab and run a command + toggle SFTP
    await tester.tap(find.text('SSH & SFTP'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('uptime'));
    await tester.pumpAndSettle();
    expect(find.textContaining('load average:'), findsOneWidget);

    // 4. Switch to Vault & 2FA Tab
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    expect(find.text('RFC 6238 TOTP 2FA Authenticator'), findsOneWidget);
    expect(find.textContaining('Biometric Enclave Unlock'), findsOneWidget);

    // 5. Open Zero-Trust QR Pairing modal
    await tester.tap(find.byIcon(Icons.qr_code_scanner));
    await tester.pumpAndSettle();
    expect(find.text('Pair with JalaDesk Desktop'), findsOneWidget);
    await tester.tap(find.text('Verify & Sync Vault'));
    await tester.pumpAndSettle();
  });
}
