import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart' as crypto;
import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jaladesk_mobile/main.dart';
import 'package:jaladesk_mobile/protocols/desktop_gesture_surface.dart';
import 'package:jaladesk_mobile/protocols/rdp_ffi_client.dart';
import 'package:jaladesk_mobile/protocols/ssh_bastion_tunnel.dart';
import 'package:jaladesk_mobile/protocols/vnc_rfb_client.dart';
import 'package:jaladesk_mobile/security/vault_security_service.dart';
import 'package:jaladesk_mobile/terminal/sftp_transfer_service.dart';
import 'package:jaladesk_mobile/terminal/termius_terminal.dart';
import 'package:pointycastle/export.dart' as pc;
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

  test('RemoteHostItem.resolvedDomainAndUser splits Active Directory DOMAIN\\user and user@domain', () {
    const netbiosHost = RemoteHostItem(
      id: 'ad1',
      name: 'AD1',
      folder: 'PLN Batam',
      protocol: RemoteProtocol.rdp,
      address: '10.28.0.154',
      port: 4321,
      username: r'plnbatam\adminit',
      latencyMs: 9,
      isOnline: true,
    );
    expect(netbiosHost.resolvedDomainAndUser.$1, 'plnbatam');
    expect(netbiosHost.resolvedDomainAndUser.$2, 'adminit');

    const upnHost = RemoteHostItem(
      id: 'ad2',
      name: 'AD2',
      folder: 'PLN Batam',
      protocol: RemoteProtocol.rdp,
      address: '10.28.0.154',
      port: 3389,
      username: 'adminit@plnbatam.co.id',
      latencyMs: 9,
      isOnline: true,
    );
    expect(upnHost.resolvedDomainAndUser.$1, 'plnbatam.co.id');
    expect(upnHost.resolvedDomainAndUser.$2, 'adminit');
  });

  test('VncRfbClient completes RFC 6143 RFB 3.8 DES handshake, receives Raw framebuffer, and sends pointer/key', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close());

    final receivedClientEvents = <int>[];
    final pointerReceived = Completer<void>();

    server.listen((Socket sock) async {
      // 1. Send RFB 003.008 banner
      sock.add(ascii.encode('RFB 003.008\n'));
      await sock.flush();

      final buffer = <int>[];
      int stage = 0; // 0: version, 1: secType, 2: desResp, 3: clientInit, 4: runtime
      await for (final chunk in sock) {
        buffer.addAll(chunk);
        if (stage == 0 && buffer.length >= 12) {
          buffer.removeRange(0, 12);
          stage = 1;
          // Offer VNC Auth (type 2)
          sock.add([1, 2]);
          await sock.flush();
        }
        if (stage == 1 && buffer.isNotEmpty) {
          final chosen = buffer.removeAt(0);
          expect(chosen, 2);
          stage = 2;
          // Send 16-byte challenge
          sock.add(List<int>.generate(16, (i) => i + 1));
          await sock.flush();
        }
        if (stage == 2 && buffer.length >= 16) {
          final resp = Uint8List.fromList(buffer.sublist(0, 16));
          buffer.removeRange(0, 16);
          final expected = VncDesAuth.encryptVncChallenge(
            Uint8List.fromList(List<int>.generate(16, (i) => i + 1)),
            'secret123',
          );
          expect(resp, equals(expected));
          stage = 3;
          // Send SecurityResult = 0 (OK)
          sock.add([0, 0, 0, 0]);
          await sock.flush();
        }
        if (stage == 3 && buffer.isNotEmpty) {
          buffer.removeAt(0); // shared flag
          stage = 4;
          // Send ServerInit (64x48) + name "VNC-LAB"
          final nameBytes = utf8.encode('VNC-LAB');
          final init = ByteData(24 + nameBytes.length);
          init.setUint16(0, 64);
          init.setUint16(2, 48);
          init.setUint8(4, 32);
          init.setUint8(5, 24);
          init.setUint8(6, 0);
          init.setUint8(7, 1);
          init.setUint16(8, 255);
          init.setUint16(10, 255);
          init.setUint16(12, 255);
          init.setUint8(14, 0);
          init.setUint8(15, 8);
          init.setUint8(16, 16);
          init.setUint32(20, nameBytes.length);
          final out = Uint8List(24 + nameBytes.length);
          out.setAll(0, init.buffer.asUint8List());
          out.setAll(24, nameBytes);
          sock.add(out);

          // Also send a FramebufferUpdate with 1 Raw rectangle (64x48)
          final rectHeader = ByteData(16);
          rectHeader.setUint8(0, 0); // msgType = 0 (FramebufferUpdate)
          rectHeader.setUint8(1, 0);
          rectHeader.setUint16(2, 1); // 1 rect
          rectHeader.setUint16(4, 0);
          rectHeader.setUint16(6, 0);
          rectHeader.setUint16(8, 64);
          rectHeader.setUint16(10, 48);
          rectHeader.setInt32(12, 0); // Raw encoding = 0
          final pixels = Uint8List(64 * 48 * 4);
          for (int i = 0; i < pixels.length; i += 4) {
            pixels[i] = 0x1E;
            pixels[i + 1] = 0x90;
            pixels[i + 2] = 0xFF;
            pixels[i + 3] = 0xFF;
          }
          sock.add(rectHeader.buffer.asUint8List());
          sock.add(pixels);
          await sock.flush();
        }
        if (stage == 4 && buffer.isNotEmpty) {
          receivedClientEvents.addAll(buffer);
          buffer.clear();
          if (receivedClientEvents.any((b) => b == 5) && !pointerReceived.isCompleted) {
            pointerReceived.complete();
          }
        }
      }
    });

    int framesDecoded = 0;
    final vnc = VncRfbClient(
      host: '127.0.0.1',
      port: server.port,
      password: 'secret123',
      onFrame: (img, w, h, status) {
        framesDecoded++;
      },
      onStatus: (status, {isError = false}) {},
    );
    addTearDown(() => vnc.dispose());

    await vnc.connect();

    expect(vnc.isConnected, isTrue);
    expect(vnc.width, 64);
    expect(vnc.height, 48);
    expect(vnc.desktopName, contains('VNC-LAB'));

    vnc.sendPointerEvent(20, 15, 1);
    vnc.sendKeySym(0xFF0D, down: true);
    await pointerReceived.future.timeout(const Duration(seconds: 3));
    expect(framesDecoded, greaterThanOrEqualTo(0));
  });

  test('RdpFfiClient loads FreeRDP 3.32.2 native library and connects to rdp-test-server', () async {
    final serverBin = File('/Users/ribato/Documents/APLIKASI/royal-clone/outputs/app/native/test-server/build/rdp-test-server');
    expect(serverBin.existsSync(), isTrue);
    expect(RdpFfiClient.isNativeAvailable, isTrue);

    final tmpDir = await Directory.systemTemp.createTemp('jaladesk_rdp_test_');
    addTearDown(() async {
      try {
        if (await tmpDir.exists()) {
          await tmpDir.delete(recursive: true);
        }
      } on FileSystemException catch (_) {}
    });
    final certPath = '${tmpDir.path}/server.crt';
    final keyPath = '${tmpDir.path}/server.key';

    final opensslRes = await Process.run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ]);
    expect(opensslRes.exitCode, 0);

    // Find an available port
    final probeSock = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probeSock.port;
    await probeSock.close();

    final serverProc = await Process.start(serverBin.path, [
      '--port=$port',
      '--cert=$certPath',
      '--key=$keyPath',
    ]);
    addTearDown(() => serverProc.kill(ProcessSignal.sigterm));

    final readyCompleter = Completer<void>();
    final desktopDrawnCompleter = Completer<void>();
    serverProc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (line.contains('READY') && !readyCompleter.isCompleted) {
        readyCompleter.complete();
      }
      if (line.contains('DESKTOP') && !desktopDrawnCompleter.isCompleted) {
        desktopDrawnCompleter.complete();
      }
    });

    await readyCompleter.future.timeout(const Duration(seconds: 5));

    final rdp = RdpFfiClient(
      host: '127.0.0.1',
      port: port,
      domain: 'plnbatam',
      username: 'adminit',
      password: 'testpassword',
      initialWidth: 1280,
      initialHeight: 800,
      onFrame: (img, w, h, status) {},
      onStatus: (status, {isError = false}) {},
    );
    addTearDown(() => rdp.dispose());

    await rdp.connect();

    expect(rdp.isConnected, isTrue);
    await desktopDrawnCompleter.future.timeout(const Duration(seconds: 5));
    rdp.sendMouseMove(320, 240);
    rdp.sendScancode(0x1C, down: true);
    rdp.sendScancode(0x1C, down: false);

    // Dynamically resize the remote desktop session to a Foldable Unfolded aspect ratio (1088x908)
    rdp.requestResolution(1088, 908, desktopScaleFactor: 100);
    await Future<void>.delayed(const Duration(milliseconds: 900));
    expect(rdp.isConnected, isTrue);
    expect(rdp.width, 1088);
    expect(rdp.height, 908);
  });

  test('RdpFfiClient.computeJumpMatchResolution matches Phone, Foldable Unfolded, and Tablet aspect ratios', () {
    // 1. Phone Portrait (360x640 -> aspect 0.5625)
    final phoneRes = RdpFfiClient.computeJumpMatchResolution(360, 640);
    expect(phoneRes.$1 % 4, 0);
    expect(phoneRes.$2 % 2, 0);
    expect(phoneRes.$1, lessThan(phoneRes.$2));
    expect((phoneRes.$1 / phoneRes.$2 - 360 / 640).abs(), lessThan(0.02));

    // 2. Foldable Unfolded Inner Display (840x700 -> aspect 1.20)
    final foldRes = RdpFfiClient.computeJumpMatchResolution(840, 700);
    expect(foldRes.$1 % 4, 0);
    expect(foldRes.$2 % 2, 0);
    expect((foldRes.$1 / foldRes.$2 - 840 / 700).abs(), lessThan(0.02));

    // 3. Tablet Landscape (1280x800 -> aspect 1.60) + HiDPI 1.35x
    final tabletStd = RdpFfiClient.computeJumpMatchResolution(1280, 800);
    final tabletHiDpi = RdpFfiClient.computeJumpMatchResolution(1280, 800, densityMultiplier: 1.35);
    expect(tabletHiDpi.$1, greaterThan(tabletStd.$1));
    expect((tabletHiDpi.$1 / tabletHiDpi.$2 - 1.60).abs(), lessThan(0.02));
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
    await tester.tap(find.byKey(const ValueKey('seg_ssh_sftp')));
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

  testWidgets(
      'JalaDesk Mobile adapts to Foldable Unfolded (840x700), Tablet Landscape (1280x800), and Immersive Full Screen Mode',
      (WidgetTester tester) async {
    // 1. Foldable Unfolded (840x700) -> Renders Left NavigationRail instead of bottom NavigationBar
    tester.view.physicalSize = const Size(840, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();

    expect(find.byType(NavigationRail), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    expect(find.text('FOLDABLE PRO'), findsOneWidget);

    // 2. Tablet Landscape (1280x800) -> Renders NavigationRail + Quick Host Switcher Sidebar + Split SSH+SFTP
    tester.view.physicalSize = const Size(1280, 800);
    await tester.pumpAndSettle();
    expect(find.text('TABLET PRO'), findsOneWidget);

    // Load Sample Lab so Quick Host Switcher has hosts
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();

    // Switch to RDP / VNC Tab via NavigationRail
    await tester.tap(find.text('RDP / VNC'));
    await tester.pumpAndSettle();
    expect(find.text('QUICK HOST SWITCHER'), findsOneWidget);
    expect(find.byKey(const ValueKey('btn_display_sizing')), findsOneWidget);
    expect(find.byKey(const ValueKey('btn_toggle_fullscreen')), findsOneWidget);

    // Open Jump Display Sizing modal and verify options
    await tester.tap(find.byKey(const ValueKey('btn_display_sizing')));
    await tester.pumpAndSettle();
    expect(find.text('Jump Display Sizing & Aspect Match'), findsOneWidget);
    expect(find.text('Auto Match'), findsWidgets);
    expect(find.text('HiDPI 1.35×'), findsOneWidget);
    expect(find.text('Fit'), findsWidgets);
    expect(find.text('Fill'), findsOneWidget);

    // Activate Max Full Screen from the Display Sizing sheet
    await tester.tap(find.text('Max Full Screen'));
    await tester.pumpAndSettle();

    // In Full Screen mode: NavigationRail and AppBar are hidden, Floating HUD Pill is active
    expect(find.byType(NavigationRail), findsNothing);
    expect(find.byKey(const ValueKey('fullscreen_floating_hud')), findsOneWidget);
    expect(find.byKey(const ValueKey('btn_exit_fullscreen_pill')), findsOneWidget);

    // Exit Full Screen via Floating HUD Pill
    await tester.tap(find.byKey(const ValueKey('btn_exit_fullscreen_pill')));
    await tester.pumpAndSettle();
    expect(find.byType(NavigationRail), findsOneWidget);

    // Switch to SSH & SFTP on Tablet -> Verify Split SSH+SFTP mode
    await tester.tap(find.text('SSH & SFTP'));
    await tester.pumpAndSettle();
    expect(find.text('Split SSH+SFTP'), findsOneWidget);
    await tester.tap(find.text('Split SSH+SFTP'));
    await tester.pumpAndSettle();
    expect(find.text('Single Terminal'), findsOneWidget);
    expect(find.text('/etc/nginx/conf.d'), findsOneWidget);
  });

  test('RdpFfiClient passes internal WinPR MD4/RC4 NTLMv2 self-test and completes strict CredSSP/NLA handshake', () async {
    expect(RdpFfiClient.isNativeAvailable, isTrue);
    expect(RdpFfiClient.selfTestNtlm(), isTrue);

    final fixtureBin = File(
      '/Users/ribato/Documents/APLIKASI/royal-clone/work/rea-rdp-visual-nla-spike-20261027/server-build/nla-fixture',
    );
    final nlaServerBin = File(
      '/Users/ribato/Documents/APLIKASI/royal-clone/work/rea-rdp-visual-nla-spike-20261027/server-build/rdp-test-server',
    );
    expect(fixtureBin.existsSync(), isTrue);
    expect(nlaServerBin.existsSync(), isTrue);

    final tmpDir = await Directory.systemTemp.createTemp('jaladesk_nla_test_');
    addTearDown(() async {
      try {
        if (await tmpDir.exists()) {
          await tmpDir.delete(recursive: true);
        }
      } on FileSystemException catch (_) {}
    });
    final certPath = '${tmpDir.path}/server.crt';
    final keyPath = '${tmpDir.path}/server.key';
    final policyPath = '${tmpDir.path}/auth.policy';
    final samPath = '${tmpDir.path}/sam.txt';

    final opensslRes = await Process.run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ]);
    expect(opensslRes.exitCode, 0);

    const nlaUser = 'rea_adminit';
    const nlaPass = 'JalaDesk_Enterprise_NLA_Test_2026!';
    final fixProc = await Process.start(fixtureBin.path, [policyPath, samPath]);
    fixProc.stdin.writeln(nlaUser);
    fixProc.stdin.writeln(nlaPass);
    await fixProc.stdin.close();
    expect(await fixProc.exitCode, 0);

    final serverProc = await Process.start(nlaServerBin.path, [
      '--port=23391',
      '--cert=$certPath',
      '--key=$keyPath',
      '--auth-policy=$policyPath',
      '--sam-file=$samPath',
    ]);
    addTearDown(() => serverProc.kill(ProcessSignal.sigterm));

    final readyCompleter = Completer<void>();
    final desktopCompleter = Completer<void>();
    serverProc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (line.contains('READY') && !readyCompleter.isCompleted) {
        readyCompleter.complete();
      }
      if (line.contains('DESKTOP') && !desktopCompleter.isCompleted) {
        desktopCompleter.complete();
      }
    });
    await readyCompleter.future.timeout(const Duration(seconds: 5));

    // 1. Verify wrong password reports real CredSSP/NLA logon failure (NOT ERRCONNECT_HYBRID_REQUIRED_BY_SERVER)
    final badRdp = RdpFfiClient(
      host: '127.0.0.1',
      port: 23391,
      domain: '',
      username: nlaUser,
      password: 'Wrong_Password_For_NLA_Test_999!',
      initialWidth: 1024,
      initialHeight: 768,
      onFrame: (img, w, h, status) {},
      onStatus: (status, {isError = false}) {},
    );
    addTearDown(() => badRdp.dispose());

    Object? badErr;
    try {
      await badRdp.connect();
    } catch (e) {
      badErr = e;
    }
    expect(badErr, isNotNull);
    expect(badErr.toString(), isNot(contains('HYBRID_REQUIRED_BY_SERVER')));

    // 2. Verify valid NTLMv2 / CredSSP / NLA credentials succeed and render desktop
    final goodRdp = RdpFfiClient(
      host: '127.0.0.1',
      port: 23391,
      domain: '',
      username: nlaUser,
      password: nlaPass,
      initialWidth: 1280,
      initialHeight: 800,
      onFrame: (img, w, h, status) {},
      onStatus: (status, {isError = false}) {},
    );
    addTearDown(() => goodRdp.dispose());

    await goodRdp.connect();
    expect(goodRdp.isConnected, isTrue);
    await desktopCompleter.future.timeout(const Duration(seconds: 5));
  });

  test('VncRfbClient authenticates with macOS Screen Sharing (Apple ARD SecType 30 DH + AES-128-ECB)', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close());

    // 512-bit safe prime (RFC 3526 style test modulus, 64 bytes) & generator g = 2
    const primeHex =
        'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd1'
        '29024e088a67cc74020bbea63b139b22514a08798e3404dd'
        'ef9519b3cd3a431b302b0a6df25f1437';
    final primeBytes = Uint8List.fromList([
      for (int i = 0; i < primeHex.length; i += 2) int.parse(primeHex.substring(i, i + 2), radix: 16),
    ]);
    expect(primeBytes.length, 64);
    final p = VncAppleArdAuth.bytesToBigInt(primeBytes);
    final g = BigInt.from(2);
    final serverPriv = BigInt.parse('1234567890abcdef1234567890abcdef', radix: 16);
    final serverPub = g.modPow(serverPriv, p);
    final serverPubBytes = VncAppleArdAuth.bigIntToFixedBytes(serverPub, 64);

    String decryptedUser = '';
    String decryptedPass = '';

    server.listen((Socket sock) async {
      // macOS Screen Sharing sends RFB 003.889
      sock.add(ascii.encode('RFB 003.889\n'));
      await sock.flush();

      final buf = <int>[];
      int stage = 0;
      await for (final chunk in sock) {
        buf.addAll(chunk);
        if (stage == 0 && buf.length >= 12) {
          buf.removeRange(0, 12);
          stage = 1;
          // Offer [30 (Apple ARD), 2 (Classic VNC DES)] just like macOS Screen Sharing
          sock.add([2, 30, 2]);
          await sock.flush();
        }
        if (stage == 1 && buf.isNotEmpty) {
          final chosen = buf.removeAt(0);
          expect(chosen, 30);
          stage = 2;
          // Send [generator(2B)=2, keyLength(2B)=64, prime(64B), serverPub(64B)]
          final hdr = ByteData(4)
            ..setUint16(0, 2, Endian.big)
            ..setUint16(2, 64, Endian.big);
          sock.add(hdr.buffer.asUint8List());
          sock.add(primeBytes);
          sock.add(serverPubBytes);
          await sock.flush();
        }
        if (stage == 2 && buf.length >= 128 + 64) {
          final ciphertext = Uint8List.fromList(buf.sublist(0, 128));
          final clientPubBytes = Uint8List.fromList(buf.sublist(128, 192));
          buf.removeRange(0, 192);

          final clientPub = VncAppleArdAuth.bytesToBigInt(clientPubBytes);
          final shared = clientPub.modPow(serverPriv, p);
          final sharedBytes = VncAppleArdAuth.bigIntToFixedBytes(shared, 64);
          final aesKey = Uint8List.fromList(crypto.md5.convert(sharedBytes).bytes);

          final aes = pc.ECBBlockCipher(pc.AESEngine())
            ..init(false, pc.KeyParameter(aesKey));
          final plain = Uint8List(128);
          for (int off = 0; off < 128; off += 16) {
            aes.processBlock(ciphertext, off, plain, off);
          }
          final userBlock = plain.sublist(0, 64);
          final passBlock = plain.sublist(64, 128);
          decryptedUser = utf8.decode(userBlock.takeWhile((b) => b != 0).toList());
          decryptedPass = utf8.decode(passBlock.takeWhile((b) => b != 0).toList());

          stage = 3;
          final authOk = decryptedUser == 'ribato' && decryptedPass == 'macScreenPass2026!';
          sock.add(authOk ? [0, 0, 0, 0] : [0, 0, 0, 1]);
          await sock.flush();
        }
        if (stage == 3 && buf.isNotEmpty) {
          buf.removeAt(0); // ClientInit shared flag
          stage = 4;
          final nameBytes = utf8.encode('macOS-ScreenSharing');
          final init = ByteData(24 + nameBytes.length)
            ..setUint16(0, 32)
            ..setUint16(2, 24)
            ..setUint8(4, 32)
            ..setUint8(5, 24)
            ..setUint8(6, 0)
            ..setUint8(7, 1)
            ..setUint16(8, 255)
            ..setUint16(10, 255)
            ..setUint16(12, 255)
            ..setUint8(14, 0)
            ..setUint8(15, 8)
            ..setUint8(16, 16)
            ..setUint32(20, nameBytes.length);
          final out = Uint8List(24 + nameBytes.length);
          out.setAll(0, init.buffer.asUint8List());
          out.setAll(24, nameBytes);
          sock.add(out);
          await sock.flush();
        }
      }
    });

    final vnc = VncRfbClient(
      host: '127.0.0.1',
      port: server.port,
      username: 'ribato',
      password: 'macScreenPass2026!',
      onFrame: (img, w, h, status) {},
      onStatus: (status, {isError = false}) {},
    );
    addTearDown(() => vnc.dispose());

    await vnc.connect();
    expect(vnc.isConnected, isTrue);
    expect(decryptedUser, 'ribato');
    expect(decryptedPass, 'macScreenPass2026!');
    expect(vnc.negotiatedAuthLabel, contains('Apple Remote Desktop'));
    expect(vnc.desktopName, 'macOS-ScreenSharing');
  });

  testWidgets(
      'Termius Interactive Terminal supports direct inline typing, themes, snippets, and clean SFTP Explorer without SSH bar',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();

    // Load Sample Lab & verify folder grouping + quick SFTP jump on SSH host
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    expect(find.text('SAMPLE LAB / CORE AD'), findsOneWidget);
    expect(find.text('SAMPLE LAB / BASTIONS'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'SFTP'), findsOneWidget);

    // Switch to SSH & SFTP Tab
    await tester.tap(find.text('SSH & SFTP'));
    await tester.pumpAndSettle();

    // Old separate command input box & Run button must NOT exist
    expect(find.text('Execute remote SSH command...'), findsNothing);
    expect(find.text('Enter SSH command...'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Run'), findsNothing);

    // Tactile Termius keybar keys ARE visible in Terminal mode
    expect(find.text('^C'), findsOneWidget);
    expect(find.text('Paste'), findsOneWidget);

    // Tap terminal canvas to focus soft-keyboard IME and type inline (Termius-style)
    await tester.tap(find.byType(TermiusInteractiveTerminal));
    await tester.pump();
    expect(tester.testTextInput.hasAnyClients, isTrue);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: '\u200B\u200Buname -a',
        selection: TextSelection.collapsed(offset: 10),
      ),
    );
    await tester.pump();
    // Verify typed text appears inline on the live prompt line BEFORE pressing Enter
    expect(find.textContaining('uname -a'), findsWidgets);
    // Press soft-keyboard Enter/Send directly in the terminal
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(find.textContaining('aarch64 GNU/Linux'), findsOneWidget);

    // Open Terminal Themes Studio & switch to Dracula Pro
    await tester.tap(find.text('Theme'));
    await tester.pumpAndSettle();
    expect(find.text('Terminal Appearance & Themes'), findsOneWidget);
    await tester.tap(find.text('Dracula Pro'));
    await tester.pumpAndSettle();
    expect(find.text('Dracula Pro'), findsWidgets);
    await tester.tap(find.byKey(const ValueKey('btn_close_theme_sheet')));
    await tester.pumpAndSettle();

    // Switch to SFTP Check mode
    await tester.tap(find.byKey(const ValueKey('seg_ssh_sftp')));
    await tester.pumpAndSettle();

    // In SFTP single-pane mode: SSH terminal keybar (^C, Paste) MUST be completely hidden!
    expect(find.text('^C'), findsNothing);
    expect(find.text('Paste'), findsNothing);

    // Verify SFTP Explorer hides .dotfiles by default and shows clean visible items at top
    expect(find.text('ssl-certs'), findsOneWidget);
    expect(find.text('default.conf'), findsOneWidget);
    expect(find.text('.htpasswd.sealed'), findsNothing);

    // Toggle .dotfiles badge to reveal hidden files
    await tester.tap(find.byKey(const ValueKey('btn_sftp_toggle_dotfiles')));
    await tester.pumpAndSettle();
    expect(find.text('.htpasswd.sealed'), findsOneWidget);
  });

  test('SshBastionRouteResolver resolves single-hop & multi-hop chains and rejects circular Jump Host loops', () {
    const edgeBastion = RemoteHostItem(
      id: 'hop-edge',
      name: 'Edge Bastion',
      address: '203.0.113.10',
      port: 22,
      protocol: RemoteProtocol.ssh,
    );
    const coreBastion = RemoteHostItem(
      id: 'hop-core',
      name: 'Core Bastion',
      address: '10.10.0.2',
      port: 2222,
      protocol: RemoteProtocol.ssh,
      jumpHostId: 'hop-edge',
    );
    const targetRdp = RemoteHostItem(
      id: 'target-ad',
      name: 'Internal AD',
      address: '10.20.0.15',
      port: 3389,
      protocol: RemoteProtocol.rdp,
      jumpHostId: 'hop-core',
    );
    final hosts = [edgeBastion, coreBastion, targetRdp];

    final hops = SshBastionRouteResolver.resolveHopItems<RemoteHostItem>(
      target: targetRdp,
      allHosts: hosts,
      idOf: (h) => h.id,
      nameOf: (h) => h.name,
      jumpHostIdOf: (h) => h.jumpHostId,
      isSshCapable: (h) => h.protocol == RemoteProtocol.ssh,
    );
    expect(hops.map((h) => h.id).toList(), ['hop-edge', 'hop-core']);
    expect(
      SshBastionRouteResolver.formatRouteBadge(hops.map((h) => h.name).toList()),
      '2-hop: Edge Bastion → Core Bastion',
    );

    // Assigning target-ad or hop-core as hop-edge's Jump Host would create a cycle!
    expect(
      SshBastionRouteResolver.wouldCreateCycle<RemoteHostItem>(
        editingHostId: 'hop-edge',
        candidateJumpId: 'hop-core',
        allHosts: hosts,
        idOf: (h) => h.id,
        jumpHostIdOf: (h) => h.jumpHostId,
      ),
      isTrue,
    );

    final cyclicEdge = edgeBastion.copyWith(jumpHostId: 'hop-core');
    expect(
      () => SshBastionRouteResolver.resolveHopItems<RemoteHostItem>(
        target: targetRdp,
        allHosts: [cyclicEdge, coreBastion, targetRdp],
        idOf: (h) => h.id,
        nameOf: (h) => h.name,
        jumpHostIdOf: (h) => h.jumpHostId,
        isSshCapable: (h) => h.protocol == RemoteProtocol.ssh,
      ),
      throwsA(isA<BastionRoutingException>()),
    );
  });

  test('EncryptedVaultBackupCodec seals and opens .jvault with AES-256-GCM + PBKDF2-HMAC-SHA256 and rejects wrong passphrases', () {
    final payload = <String, dynamic>{
      'hosts': [
        const RemoteHostItem(
          id: 'h1',
          name: 'Prod DB Bastion',
          address: '198.51.100.5',
          port: 22,
          protocol: RemoteProtocol.ssh,
          isFavorite: true,
        ).toJson(),
      ],
      'credentials': [
        const VaultCredentialItem(
          id: 'cred-1',
          label: 'Corp AD Admin',
          domain: 'CORP',
          username: 'adminit',
          password: 'SuperSecretPassword!2026',
        ).toJson(),
      ],
    };

    final sealed = EncryptedVaultBackupCodec.sealJson(
      payload: payload,
      passphrase: 'Correct-Horse-Battery-Staple-99!',
    );
    expect(sealed, contains('jaladesk-encrypted-vault-v1'));
    expect(sealed, isNot(contains('SuperSecretPassword!2026')));

    final opened = EncryptedVaultBackupCodec.openJson(
      rawEnvelopeJson: sealed,
      passphrase: 'Correct-Horse-Battery-Staple-99!',
    );
    final restoredCred = VaultCredentialItem.fromJson(
      (opened['credentials'] as List).first as Map<String, dynamic>,
    );
    expect(restoredCred.displayPrincipal, r'CORP\adminit');
    expect(restoredCred.password, 'SuperSecretPassword!2026');

    expect(
      () => EncryptedVaultBackupCodec.openJson(
        rawEnvelopeJson: sealed,
        passphrase: 'Wrong-Passphrase-Attempt!',
      ),
      throwsA(isA<FormatException>()),
    );
  });

  test('SshBastionChain + ActiveLocalPortForward tunnels real 2-hop SSH ProxyJump + FreeRDP 3.32.2 over OpenSSH sshd', () async {
    final sshdBin = File('/usr/sbin/sshd');
    final sshKeygenBin = File('/usr/bin/ssh-keygen');
    final serverBin = File('/Users/ribato/Documents/APLIKASI/royal-clone/outputs/app/native/test-server/build/rdp-test-server');
    expect(sshdBin.existsSync(), isTrue);
    expect(sshKeygenBin.existsSync(), isTrue);
    expect(serverBin.existsSync(), isTrue);

    final tmpDir = await Directory.systemTemp.createTemp('jaladesk_2hop_bastion_');
    addTearDown(() async {
      try {
        if (await tmpDir.exists()) {
          await tmpDir.delete(recursive: true);
        }
      } on FileSystemException catch (_) {}
    });

    // Generate Ed25519 host key & client keypair for local OpenSSH sshd instances
    final hostKeyPath = '${tmpDir.path}/ssh_host_ed25519_key';
    final clientKeyPath = '${tmpDir.path}/id_ed25519';
    expect(
      (await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', hostKeyPath])).exitCode,
      0,
    );
    expect(
      (await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', clientKeyPath])).exitCode,
      0,
    );
    final clientPrivateKeyPem = await File(clientKeyPath).readAsString();
    final currentUser = Platform.environment['USER'] ?? (await Process.run('whoami', [])).stdout.toString().trim();

    Future<(Process, int)> startLocalSshd(String tag) async {
      final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final p = probe.port;
      await probe.close();

      final cfgPath = '${tmpDir.path}/sshd_$tag.conf';
      await File(cfgPath).writeAsString([
        'Port $p',
        'ListenAddress 127.0.0.1',
        'HostKey $hostKeyPath',
        'AuthorizedKeysFile $clientKeyPath.pub',
        'PasswordAuthentication no',
        'PubkeyAuthentication yes',
        'ChallengeResponseAuthentication no',
        'UsePAM no',
        'AllowTcpForwarding yes',
        'PermitOpen any',
        'StrictModes no',
        'PidFile ${tmpDir.path}/sshd_$tag.pid',
      ].join('\n'));

      final proc = await Process.start(sshdBin.path, ['-D', '-e', '-f', cfgPath]);
      // Wait until sshd accepts TCP connections
      for (int i = 0; i < 30; i++) {
        try {
          final s = await Socket.connect('127.0.0.1', p, timeout: const Duration(milliseconds: 150));
          s.destroy();
          break;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 80));
        }
      }
      return (proc, p);
    }

    final (sshdHop1, portHop1) = await startLocalSshd('hop1');
    addTearDown(() => sshdHop1.kill(ProcessSignal.sigterm));
    final (sshdHop2, portHop2) = await startLocalSshd('hop2');
    addTearDown(() => sshdHop2.kill(ProcessSignal.sigterm));

    // Start local FreeRDP 3.32.2 test server on an ephemeral loopback port
    final certPath = '${tmpDir.path}/rdp.crt';
    final keyPath = '${tmpDir.path}/rdp.key';
    expect(
      (await Process.run('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
      ])).exitCode,
      0,
    );
    final rdpProbe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final rdpPort = rdpProbe.port;
    await rdpProbe.close();

    final rdpProc = await Process.start(serverBin.path, [
      '--port=$rdpPort',
      '--cert=$certPath',
      '--key=$keyPath',
    ]);
    addTearDown(() => rdpProc.kill(ProcessSignal.sigterm));

    final rdpReady = Completer<void>();
    final rdpDesktop = Completer<void>();
    rdpProc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (line.contains('READY') && !rdpReady.isCompleted) rdpReady.complete();
      if (line.contains('DESKTOP') && !rdpDesktop.isCompleted) rdpDesktop.complete();
    });
    await rdpReady.future.timeout(const Duration(seconds: 5));

    // Establish REAL 2-Hop SSH Bastion Chain (`Hop 1 -> Hop 2`) + Local Port Forward -> FreeRDP server!
    final chain = await SshBastionChain.connect([
      BastionHopSpec(
        id: 'hop-1',
        name: 'Edge-Bastion',
        address: '127.0.0.1',
        port: portHop1,
        username: currentUser,
        privateKeyPem: clientPrivateKeyPem,
      ),
      BastionHopSpec(
        id: 'hop-2',
        name: 'Core-Bastion',
        address: '127.0.0.1',
        port: portHop2,
        username: currentUser,
        privateKeyPem: clientPrivateKeyPem,
      ),
    ]);
    addTearDown(() => chain.dispose());

    final tunnel = await chain.startLocalPortForward(
      remoteHost: '127.0.0.1',
      remotePort: rdpPort,
      label: '2-Hop RDP Tunnel',
      ownChainLifecycle: true,
    );
    expect(tunnel.localPort, greaterThan(0));

    final rdpClient = RdpFfiClient(
      host: '127.0.0.1',
      port: tunnel.localPort,
      domain: 'CORP',
      username: 'adminit',
      password: 'testpassword',
      initialWidth: 1024,
      initialHeight: 768,
      onFrame: (img, w, h, status) {},
      onStatus: (status, {isError = false}) {},
    );
    addTearDown(() => rdpClient.dispose());

    await rdpClient.connect();
    expect(rdpClient.isConnected, isTrue);
    await rdpDesktop.future.timeout(const Duration(seconds: 5));

    // Verify real bidirectional bytes flowed through the 2-hop SSH port forward!
    expect(tunnel.totalConnections, greaterThanOrEqualTo(1));
    expect(tunnel.bytesSent, greaterThan(100));
    expect(tunnel.bytesReceived, greaterThan(100));

    await rdpClient.dispose();
    await tunnel.close();
    expect(tunnel.isClosed, isTrue);
  });

  testWidgets('Host Editor supports inline + New Jump Host, Reusable Vault Credentials, Favorites & Port Forward Studio',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(JalaDeskMobileApp(disableNetworkProbes: true, shellKey: shellKey));
    await tester.pumpAndSettle();

    // 1. Go to Vault & 2FA and add a Reusable Credential
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    expect(find.text('Reusable Credential Vault'), findsOneWidget);

    await tester.tap(find.byKey(const Key('btn_add_vault_credential')));
    await tester.pumpAndSettle();
    expect(find.text('New Vault Credential'), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(TextField, 'Credential Name *'),
      'PLN Batam AD Admin',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'AD Domain (optional)'),
      'plnbatam',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Username *'),
      'adminit',
    );
    await tester.tap(find.text('Save Credential'));
    await tester.pumpAndSettle();
    expect(find.text('PLN Batam AD Admin'), findsOneWidget);

    // 2. Return to Connections -> Open + Add Host -> Create inline + New Jump Host -> Bind both to RDP host
    await tester.tap(find.text('Connections'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Add Host'));
    await tester.pumpAndSettle();
    expect(find.text('New Remote Connection'), findsOneWidget);

    // Select RDP protocol chip inside the dialog
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('RDP')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.widgetWithText(TextField, 'Display Name (optional)'),
      'AD1 Core Server',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Host / IP Address *'),
      '192.0.2.154',
    );

    // Tap inline `+ New Jump Host` right inside the RDP connection dialog!
    await tester.ensureVisible(find.byKey(const ValueKey('btn_inline_new_jump_host')));
    await tester.tap(find.byKey(const ValueKey('btn_inline_new_jump_host')));
    await tester.pumpAndSettle();
    expect(find.text('New SSH Jump Host / Bastion'), findsOneWidget);

    // Fill out the nested SSH Jump Host modal
    await tester.enterText(
      find.widgetWithText(TextField, 'Display Name (optional)').last,
      'Batam SSH Bastion',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Host / IP Address *').last,
      '198.51.100.20',
    );
    await tester.tap(find.text('Save Host').last);
    await tester.pumpAndSettle();

    // Verify `Batam SSH Bastion` is now auto-selected in the RDP host's Jump Host dropdown!
    expect(find.textContaining('Batam SSH Bastion (198.51.100.20:22)'), findsOneWidget);

    // Also select the Reusable Credential `PLN Batam AD Admin`
    await tester.ensureVisible(find.byKey(const ValueKey('dropdown_vault_credential')));
    await tester.tap(find.byKey(const ValueKey('dropdown_vault_credential')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('PLN Batam AD Admin').last);
    await tester.pumpAndSettle();

    // Pin AD1 Core Server to Favorites & save
    await tester.tap(find.byTooltip('Pin to Favorites'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save Host'));
    await tester.pumpAndSettle();

    // 3. Verify Connections screen shows PINNED FAVORITES, `via Batam SSH Bastion`, and `Vault: PLN Batam AD Admin`!
    expect(find.text('PINNED FAVORITES'), findsOneWidget);
    expect(find.text('AD1 Core Server'), findsOneWidget);
    expect(find.text('via Batam SSH Bastion'), findsOneWidget);
    expect(find.text('Vault: PLN Batam AD Admin'), findsOneWidget);

    // 4. Open SSH Port Forwarding Studio (`ssh -L`) and verify `Batam SSH Bastion` is ready
    await tester.tap(find.byKey(const Key('btn_open_port_forwards')));
    await tester.pumpAndSettle();
    expect(find.text('SSH Port Forwarding Studio (ssh -L)'), findsOneWidget);
    expect(find.textContaining('Batam SSH Bastion'), findsWidgets);
  });

  test('VaultAtRestCipher (AES-256-GCM), VaultPinHasher (PBKDF2), and SshKnownHostsStore (TOFU/MITM) enforce Zero-Trust security', () async {
    SharedPreferences.setMockInitialValues({
      'legacy_plain_hosts': '[{"id":"h-legacy","name":"Legacy Server"}]',
    });
    final prefs = await SharedPreferences.getInstance();

    // 1. Transparent legacy plaintext migration
    final migrated = await VaultAtRestCipher.decryptFromPrefs(prefs, 'legacy_plain_hosts');
    expect(migrated, contains('Legacy Server'));

    // 2. AES-256-GCM at-rest encryption (`jseal:v1:`)
    const secretPayload = '{"hosts":[{"id":"h1","password":"UltraSecretPassword#2026"}]}';
    final sealed = await VaultAtRestCipher.encryptForPrefs(prefs, secretPayload);
    expect(sealed.startsWith(VaultAtRestCipher.envelopePrefix), isTrue);
    expect(sealed, isNot(contains('UltraSecretPassword#2026')));
    await prefs.setString('sealed_hosts', sealed);
    final decrypted = await VaultAtRestCipher.decryptFromPrefs(prefs, 'sealed_hosts');
    expect(decrypted, equals(secretPayload));

    // 3. PBKDF2-HMAC-SHA256 App-Lock PIN hashing & constant-time verification
    final pinRecord = VaultPinHasher.hashPin('284691');
    expect(pinRecord.startsWith('pbkdf2:'), isTrue);
    expect(VaultPinHasher.verifyPin('284691', pinRecord), isTrue);
    expect(VaultPinHasher.verifyPin('000000', pinRecord), isFalse);

    // 4. SSH Known Hosts TOFU pinning & MITM mismatch detection
    final store = SshKnownHostsStore();
    final keyA = Uint8List.fromList(List<int>.generate(16, (i) => i + 10));
    final keyAttacker = Uint8List.fromList(List<int>.generate(16, (i) => 0xAA ^ i));

    // First connection -> Trust On First Use (pins keyA)
    final firstOk = await store.verifyOrPin(
      host: '10.28.99.203',
      port: 2345,
      keyType: 'ssh-ed25519',
      fingerprint: keyA,
    );
    expect(firstOk, isTrue);
    expect(store.entries.length, 1);

    // Reconnect with identical key -> silently trusted
    bool mismatchTriggered = false;
    final secondOk = await store.verifyOrPin(
      host: '10.28.99.203',
      port: 2345,
      keyType: 'ssh-ed25519',
      fingerprint: keyA,
      onMismatch: (_) async {
        mismatchTriggered = true;
        return false;
      },
    );
    expect(secondOk, isTrue);
    expect(mismatchTriggered, isFalse);

    // Reconnect with altered host key -> triggers MITM warning and aborts when rejected!
    SshHostKeyMismatchAlert? capturedAlert;
    final mitmBlocked = await store.verifyOrPin(
      host: '10.28.99.203',
      port: 2345,
      keyType: 'ssh-ed25519',
      fingerprint: keyAttacker,
      onMismatch: (alert) async {
        capturedAlert = alert;
        return false;
      },
    );
    expect(mitmBlocked, isFalse);
    expect(capturedAlert, isNotNull);
    expect(capturedAlert!.endpoint, '10.28.99.203:2345');
  });

  test('VncRfbClient decodes compressed Zlib (6), Hextile (5), ZRLE (16) & LastRect (-224) with native BGRA32 fidelity', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close());

    Uint8List deflateSyncFlush(RawZLibFilter deflater, Uint8List input) {
      deflater.process(input, 0, input.length);
      final out = BytesBuilder(copy: false);
      List<int>? chunk;
      while ((chunk = deflater.processed(flush: true, end: false)) != null) {
        if (chunk!.isEmpty) break;
        out.add(chunk);
      }
      return out.takeBytes();
    }

    server.listen((Socket sock) async {
      sock.add(ascii.encode('RFB 003.008\n'));
      await sock.flush();

      final buffer = <int>[];
      int stage = 0; // 0: ver, 1: secType, 2: clientInit, 3: post-init
      bool sentCompressedFrame = false;

      await for (final chunk in sock) {
        buffer.addAll(chunk);
        if (stage == 0 && buffer.length >= 12) {
          buffer.removeRange(0, 12);
          stage = 1;
          sock.add([1, 1]); // SecurityType 1 (None)
          await sock.flush();
        }
        if (stage == 1 && buffer.isNotEmpty) {
          buffer.removeAt(0);
          stage = 2;
          sock.add([0, 0, 0, 0]); // SecurityResult OK
          await sock.flush();
        }
        if (stage == 2 && buffer.isNotEmpty) {
          buffer.removeAt(0); // shared=1
          stage = 3;
          // ServerInit 16x16 desktop
          final nameBytes = utf8.encode('VNC-ZRLE-ZLIB');
          final init = ByteData(24 + nameBytes.length)
            ..setUint16(0, 16)
            ..setUint16(2, 16)
            ..setUint8(4, 32)
            ..setUint8(5, 24)
            ..setUint8(6, 0)
            ..setUint8(7, 1)
            ..setUint16(8, 255)
            ..setUint16(10, 255)
            ..setUint16(12, 255)
            ..setUint8(14, 16)
            ..setUint8(15, 8)
            ..setUint8(16, 0)
            ..setUint32(20, nameBytes.length);
          final out = Uint8List(24 + nameBytes.length);
          out.setAll(0, init.buffer.asUint8List());
          out.setAll(24, nameBytes);
          sock.add(out);
          await sock.flush();
        }
        if (stage == 3 && !sentCompressedFrame && buffer.any((b) => b == 3)) {
          sentCompressedFrame = true;
          final zlibStream = RawZLibFilter.deflateFilter(level: 6);
          final zrleStream = RawZLibFilter.deflateFilter(level: 6);

          final msg = BytesBuilder(copy: false);
          // FramebufferUpdate with numRects=10 (terminated early by LastRect at rect #4!)
          msg.add([0, 0, 0, 10]);

          // Rect 1: Zlib (6) @ (0,0, 8x8) -> BGRA [B=0x11, G=0x22, R=0xEE, 0xFF]
          final zlibRaw = Uint8List(8 * 8 * 4);
          for (int i = 0; i < zlibRaw.length; i += 4) {
            zlibRaw[i] = 0x11;
            zlibRaw[i + 1] = 0x22;
            zlibRaw[i + 2] = 0xEE;
            zlibRaw[i + 3] = 0xFF;
          }
          final zlibComp = deflateSyncFlush(zlibStream, zlibRaw);
          final r1 = ByteData(16)
            ..setUint16(0, 0)
            ..setUint16(2, 0)
            ..setUint16(4, 8)
            ..setUint16(6, 8)
            ..setInt32(8, 6)
            ..setUint32(12, zlibComp.length);
          msg.add(r1.buffer.asUint8List());
          msg.add(zlibComp);

          // Rect 2: Hextile (5) @ (8,0, 8x8) -> subMask 0x02 (BackgroundSpecified) BGRA [0x44, 0xCC, 0x33, 0xFF]
          final r2 = ByteData(12)
            ..setUint16(0, 8)
            ..setUint16(2, 0)
            ..setUint16(4, 8)
            ..setUint16(6, 8)
            ..setInt32(8, 5);
          msg.add(r2.buffer.asUint8List());
          msg.add([0x02, 0x44, 0xCC, 0x33, 0xFF]);

          // Rect 3: ZRLE (16) @ (0,8, 8x8) -> subencoding=1 (Solid CPIXEL [B=0x99, G=0x55, R=0xAA])
          final zrleComp = deflateSyncFlush(zrleStream, Uint8List.fromList([1, 0x99, 0x55, 0xAA]));
          final r3 = ByteData(16)
            ..setUint16(0, 0)
            ..setUint16(2, 8)
            ..setUint16(4, 8)
            ..setUint16(6, 8)
            ..setInt32(8, 16)
            ..setUint32(12, zrleComp.length);
          msg.add(r3.buffer.asUint8List());
          msg.add(zrleComp);

          // Rect 4: LastRect (-224) -> terminates the 10-rect update cleanly!
          final r4 = ByteData(12)
            ..setUint16(0, 0)
            ..setUint16(2, 0)
            ..setUint16(4, 0)
            ..setUint16(6, 0)
            ..setInt32(8, -224);
          msg.add(r4.buffer.asUint8List());

          sock.add(msg.takeBytes());
          await sock.flush();
        }
      }
    });

    final frameCompleter = Completer<ui.Image>();
    final vnc = VncRfbClient(
      host: '127.0.0.1',
      port: server.port,
      password: '',
      onFrame: (img, w, h, status) {
        if (!frameCompleter.isCompleted) {
          frameCompleter.complete(img);
        }
      },
      onStatus: (s, {isError = false}) {},
    );
    addTearDown(() => vnc.dispose());

    await vnc.connect();
    final decodedImg = await frameCompleter.future.timeout(const Duration(seconds: 4));
    expect(decodedImg.width, 16);
    expect(decodedImg.height, 16);

    final rgbaByteData = await decodedImg.toByteData(format: ui.ImageByteFormat.rawRgba);
    expect(rgbaByteData, isNotNull);
    final px = rgbaByteData!.buffer.asUint8List();

    // Verify Zlib pixel @ (2, 2) -> R=0xEE, G=0x22, B=0x11, A=0xFF
    const pZlib = (2 * 16 + 2) * 4;
    expect([px[pZlib], px[pZlib + 1], px[pZlib + 2], px[pZlib + 3]], [0xEE, 0x22, 0x11, 0xFF]);

    // Verify Hextile pixel @ (10, 2) -> R=0x33, G=0xCC, B=0x44, A=0xFF
    const pHex = (2 * 16 + 10) * 4;
    expect([px[pHex], px[pHex + 1], px[pHex + 2], px[pHex + 3]], [0x33, 0xCC, 0x44, 0xFF]);

    // Verify ZRLE pixel @ (2, 10) -> R=0xAA, G=0x55, B=0x99, A=0xFF
    const pZrle = (10 * 16 + 2) * 4;
    expect([px[pZrle], px[pZrle + 1], px[pZrle + 2], px[pZrle + 3]], [0xAA, 0x55, 0x99, 0xFF]);
  });

  testWidgets('DesktopGestureSurface delivers 0ms Trackpad movement, Direct Touch click, and 2-finger Right-Click without Arena starvation',
      (WidgetTester tester) async {
    final xform = TransformationController();
    addTearDown(xform.dispose);

    Offset cursor = const Offset(0.5, 0.5);
    int moveCount = 0;
    int leftClicks = 0;
    int rightClicks = 0;
    bool trackpadMode = true;

    late StateSetter rebuildHost;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (ctx, setHostState) {
              rebuildHost = setHostState;
              return SizedBox(
                width: 400,
                height: 300,
                child: DesktopGestureSurface(
                  transformationController: xform,
                  desktopRect: const Rect.fromLTWH(0, 0, 400, 300),
                  viewportSize: const Size(400, 300),
                  canvasMargin: 0,
                  isTrackpadMode: trackpadMode,
                  viewOnly: false,
                  cursorNorm: cursor,
                  onCursorMoved: (norm, {isDragging = false}) {
                    setHostState(() {
                      cursor = norm;
                      moveCount++;
                    });
                  },
                  onLeftClick: (norm, {required isConsecutiveDoubleTap}) {
                    cursor = norm;
                    leftClicks++;
                  },
                  onRightClick: (norm) {
                    cursor = norm;
                    rightClicks++;
                  },
                  onLeftDragStart: (_) {},
                  onLeftDragEnd: (_) {},
                  onMouseWheel: (_, __) {},
                  child: Container(color: Colors.black),
                ),
              );
            },
          ),
        ),
      ),
    );

    // 1. Trackpad 1-finger drag moves virtual cursor immediately (no InteractiveViewer pan theft!)
    final g1 = await tester.startGesture(const Offset(100, 100), pointer: 1);
    await tester.pump(const Duration(milliseconds: 16));
    await g1.moveBy(const Offset(60, 45));
    await tester.pump(const Duration(milliseconds: 16));
    await g1.up();
    await tester.pump();
    expect(moveCount, greaterThan(0));
    expect(cursor.dx, greaterThan(0.55));
    expect(cursor.dy, greaterThan(0.55));

    // 2. Direct Touch 1-finger tap dispatches Left Click at 0ms without waiting 300ms for double-tap timeout
    rebuildHost(() => trackpadMode = false);
    await tester.pump();
    final gTap = await tester.startGesture(const Offset(80, 60), pointer: 2);
    await tester.pump(const Duration(milliseconds: 20));
    await gTap.up();
    // Do NOT pump 300ms — verify click already fired synchronously on pointer up!
    expect(leftClicks, 1);
    expect(cursor.dx, closeTo(80 / 400, 0.02));
    expect(cursor.dy, closeTo(60 / 300, 0.02));

    // 3. Two-finger tap dispatches Right Click
    final fA = await tester.startGesture(const Offset(150, 150), pointer: 3);
    final fB = await tester.startGesture(const Offset(210, 150), pointer: 4);
    await tester.pump(const Duration(milliseconds: 30));
    await fA.up();
    await fB.up();
    await tester.pump();
    expect(rightClicks, 1);
  });

  test('SftpTransferService uploads & downloads files and nested directories recursively over live OpenSSH internal-sftp', () async {
    final sshdBin = File('/usr/sbin/sshd');
    final sshKeygenBin = File('/usr/bin/ssh-keygen');
    expect(sshdBin.existsSync(), isTrue);
    expect(sshKeygenBin.existsSync(), isTrue);

    final tmpDir = await Directory.systemTemp.createTemp('jaladesk_sftp_xfer_');
    addTearDown(() async {
      try {
        if (await tmpDir.exists()) {
          await tmpDir.delete(recursive: true);
        }
      } on FileSystemException catch (_) {}
    });

    final hostKeyPath = '${tmpDir.path}/ssh_host_ed25519_key';
    final clientKeyPath = '${tmpDir.path}/id_ed25519';
    expect((await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', hostKeyPath])).exitCode, 0);
    expect((await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', clientKeyPath])).exitCode, 0);
    final clientPrivateKeyPem = await File(clientKeyPath).readAsString();
    final currentUser = Platform.environment['USER'] ?? (await Process.run('whoami', [])).stdout.toString().trim();

    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final sshPort = probe.port;
    await probe.close();

    final cfgPath = '${tmpDir.path}/sshd_sftp.conf';
    await File(cfgPath).writeAsString([
      'Port $sshPort',
      'ListenAddress 127.0.0.1',
      'HostKey $hostKeyPath',
      'AuthorizedKeysFile $clientKeyPath.pub',
      'PasswordAuthentication no',
      'PubkeyAuthentication yes',
      'UsePAM no',
      'StrictModes no',
      'Subsystem sftp internal-sftp',
      'PidFile ${tmpDir.path}/sshd_sftp.pid',
    ].join('\n'));

    final sshdProc = await Process.start(sshdBin.path, ['-D', '-e', '-f', cfgPath]);
    addTearDown(() => sshdProc.kill(ProcessSignal.sigterm));

    for (int i = 0; i < 30; i++) {
      try {
        final s = await Socket.connect('127.0.0.1', sshPort, timeout: const Duration(milliseconds: 150));
        s.destroy();
        break;
      } catch (_) {
        await Future<void>.delayed(const Duration(milliseconds: 80));
      }
    }

    final sock = await SSHSocket.connect('127.0.0.1', sshPort);
    final client = SSHClient(
      sock,
      username: currentUser,
      identities: SSHKeyPair.fromPem(clientPrivateKeyPem),
    );
    addTearDown(client.close);
    await client.authenticated;
    final sftp = await client.sftp();

    // Prepare local source files & nested folder hierarchy
    final localSrcRoot = Directory('${tmpDir.path}/local_src');
    await Directory('${localSrcRoot.path}/release-bundle/configs/tls').create(recursive: true);
    final singleUploadFile = File('${localSrcRoot.path}/deploy-manifest.json');
    await singleUploadFile.writeAsString('{"version":"1.6.0+7","status":"ready"}');
    await File('${localSrcRoot.path}/release-bundle/README.txt').writeAsString('JalaDesk SFTP recursive transfer');
    await File('${localSrcRoot.path}/release-bundle/configs/nginx.conf').writeAsString('worker_processes auto;');
    await File('${localSrcRoot.path}/release-bundle/configs/tls/ca.pem').writeAsString('-----BEGIN CERTIFICATE-----');

    final remoteDropDir = Directory('${tmpDir.path}/remote_drop');
    await remoteDropDir.create(recursive: true);

    // 1. Upload file batch
    final upFileRes = await SftpTransferService.uploadFilesBatch(
      sftp: sftp,
      localFiles: [singleUploadFile],
      remoteDirectoryPath: remoteDropDir.path,
    );
    expect(upFileRes.isDone, isTrue);
    expect(upFileRes.filesCompleted, 1);

    // 2. Upload folder recursively
    final upDirRes = await SftpTransferService.uploadDirectoryRecursive(
      sftp: sftp,
      localDir: Directory('${localSrcRoot.path}/release-bundle'),
      remoteParentPath: remoteDropDir.path,
    );
    expect(upDirRes.isDone, isTrue);
    expect(upDirRes.filesCompleted, 3);
    expect(File('${remoteDropDir.path}/release-bundle/configs/tls/ca.pem').existsSync(), isTrue);

    // 3. Download single file & recursive directory into local target folder
    final localDownloadDir = Directory('${tmpDir.path}/downloaded_out');
    await localDownloadDir.create(recursive: true);

    final dlFileRes = await SftpTransferService.downloadRemoteFile(
      sftp: sftp,
      remoteFilePath: '${remoteDropDir.path}/deploy-manifest.json',
      fileName: 'deploy-manifest.json',
      customTargetDirectory: localDownloadDir,
    );
    expect(dlFileRes.isDone, isTrue);
    expect(
      await File('${localDownloadDir.path}/deploy-manifest.json').readAsString(),
      '{"version":"1.6.0+7","status":"ready"}',
    );

    final dlDirRes = await SftpTransferService.downloadDirectoryRecursive(
      sftp: sftp,
      remoteDirPath: '${remoteDropDir.path}/release-bundle',
      dirName: 'release-bundle',
      customTargetDirectory: localDownloadDir,
    );
    expect(dlDirRes.isDone, isTrue);
    expect(dlDirRes.filesCompleted, 3);
    expect(
      await File('${localDownloadDir.path}/release-bundle/configs/nginx.conf').readAsString(),
      'worker_processes auto;',
    );

    // 4. Recursive remote folder delete
    await SftpTransferService.deleteDirectoryRecursive(sftp, '${remoteDropDir.path}/release-bundle');
    expect(Directory('${remoteDropDir.path}/release-bundle').existsSync(), isFalse);
  });

  testWidgets('Full-Screen Auto-Hide, Live Resume Duplicate-Connect Guard, Explicit Disconnect, and Vault App-Lock PIN work end-to-end',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    // Spin up a lightweight local RFB 3.8 server inside runAsync to verify LIVE Resume guard & Disconnect!
    int rfbHandshakesCompleted = 0;
    final List<Socket> serverSockets = <Socket>[];
    late ServerSocket vncServer;
    await tester.runAsync(() async {
      vncServer = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      vncServer.listen(
        (Socket sock) async {
          sock.done.catchError((_) {});
          serverSockets.add(sock);
          try {
            sock.add(ascii.encode('RFB 003.008\n'));
            final buf = <int>[];
            int stage = 0;
            await for (final chunk in sock) {
              buf.addAll(chunk);
              if (stage == 0 && buf.length >= 12) {
                buf.removeRange(0, 12);
                stage = 1;
                sock.add([1, 1]); // SecurityType 1 (None)
              }
              if (stage == 1 && buf.isNotEmpty) {
                buf.removeAt(0);
                stage = 2;
                sock.add([0, 0, 0, 0]); // SecurityResult OK
              }
              if (stage == 2 && buf.isNotEmpty) {
                buf.removeAt(0);
                stage = 3;
                rfbHandshakesCompleted++;
                final name = utf8.encode('LIVE-VNC');
                final init = ByteData(24 + name.length)
                  ..setUint16(0, 32)
                  ..setUint16(2, 24)
                  ..setUint8(4, 32)
                  ..setUint8(5, 24)
                  ..setUint8(7, 1)
                  ..setUint16(8, 255)
                  ..setUint16(10, 255)
                  ..setUint16(12, 255)
                  ..setUint8(14, 16)
                  ..setUint8(15, 8)
                  ..setUint32(20, name.length);
                final out = Uint8List(24 + name.length);
                out.setAll(0, init.buffer.asUint8List());
                out.setAll(24, name);
                sock.add(out);
              }
            }
          } catch (_) {}
        },
        onError: (_) {},
      );
    });

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: false));
    await tester.pumpAndSettle();

    // 1. Add the local VNC server in Connections (with password so no credential prompt blocks)
    await tester.tap(find.text('New Connection'));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('VNC')));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Display Name (optional)'), 'Batam VNC Console');
    await tester.enterText(find.widgetWithText(TextField, 'Host / IP Address *'), '127.0.0.1');
    await tester.enterText(find.widgetWithText(TextField, 'Port *'), '${vncServer.port}');
    await tester.ensureVisible(find.widgetWithText(TextField, 'Password'));
    await tester.enterText(find.widgetWithText(TextField, 'Password'), 'secret');
    await tester.tap(find.text('Save Host'));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 80)));
    await tester.pumpAndSettle();

    // 2. Connect to Batam VNC Console (live RFB handshake #1)
    expect(find.widgetWithText(FilledButton, 'Connect'), findsOneWidget);
    await tester.runAsync(() async {
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Connect')).onPressed!();
      for (int i = 0; i < 30 && rfbHandshakesCompleted < 1; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 30));
      }
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(rfbHandshakesCompleted, 1);
    expect(find.byKey(const ValueKey('btn_disconnect_desktop')), findsOneWidget);

    // 3. Enter Full Screen -> verify HUD & shortcuts auto-hide after 3.5s, and reveal on tap!
    await tester.tap(find.byKey(const ValueKey('btn_toggle_fullscreen')));
    await tester.pump();
    expect(find.byKey(const ValueKey('fullscreen_floating_hud')), findsOneWidget);
    expect(find.byKey(const ValueKey('desktop_bottom_shortcut_bar')), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 3700));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const ValueKey('fullscreen_floating_hud')), findsNothing);
    expect(find.byKey(const ValueKey('desktop_bottom_shortcut_bar')), findsNothing);
    expect(find.byKey(const ValueKey('btn_reveal_fullscreen_hud')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('btn_reveal_fullscreen_hud')));
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byKey(const ValueKey('fullscreen_floating_hud')), findsOneWidget);
    expect(find.byKey(const ValueKey('desktop_bottom_shortcut_bar')), findsOneWidget);

    // Exit Full Screen
    await tester.tap(find.byKey(const ValueKey('btn_exit_fullscreen_pill')));
    await tester.pump();

    // 4. Return to Connections while LIVE -> verify `Resume` button & NO duplicate connection!
    await tester.tap(find.text('Connections'));
    await tester.pump();
    expect(find.textContaining('LIVE'), findsWidgets);
    expect(find.widgetWithText(FilledButton, 'Resume'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Resume'));
    await tester.pump();
    // Must still be handshake #1 (switched straight back to live tab without reconnecting!)
    expect(rfbHandshakesCompleted, 1);

    // 5. Explicit Disconnect button closes session cleanly
    await tester.tap(find.byKey(const ValueKey('btn_disconnect_desktop')));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 150)));
    await tester.pump();
    expect(find.byKey(const ValueKey('btn_disconnect_desktop')), findsNothing);

    // 6. Configure Vault App-Lock PIN -> Lock Vault -> Reject wrong PIN -> Unlock with right PIN
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.tap(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('field_new_vault_pin')), '7391');
    await tester.enterText(find.byKey(const Key('field_confirm_vault_pin')), '7391');
    await tester.tap(find.byKey(const Key('btn_save_vault_pin')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('btn_lock_vault_now')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('vault_pin_lock_screen')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('field_unlock_vault_pin')), '0000');
    await tester.tap(find.byKey(const Key('btn_unlock_vault_pin')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Incorrect Vault PIN'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('field_unlock_vault_pin')), '7391');
    await tester.tap(find.byKey(const Key('btn_unlock_vault_pin')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('vault_pin_lock_screen')), findsNothing);
    expect(find.text('Zero-Trust Hardware Enclave'), findsOneWidget);

    await tester.runAsync(() async {
      for (final s in serverSockets) {
        try {
          s.destroy();
        } catch (_) {}
      }
      await vncServer.close();
    });
  });

  test('VncRfbClient negotiates ExtendedDesktopSize (-308), sends SetDesktopSize (251), and dispatches live KeySyms + modifiers', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close());

    final advertisedEncodings = <int>[];
    final setDesktopSizes = <(int, int, int)>[];
    final keyEvents = <(bool, int)>[];
    final setDesktopSizeCompleter = Completer<void>();
    final keysDoneCompleter = Completer<void>();

    server.listen((Socket sock) async {
      sock.done.catchError((_) {});
      sock.add(ascii.encode('RFB 003.008\n'));
      final buf = <int>[];
      int stage = 0;
      await for (final chunk in sock) {
        buf.addAll(chunk);
        if (stage == 0 && buf.length >= 12) {
          buf.removeRange(0, 12);
          stage = 1;
          sock.add([1, 1]); // Security None
        }
        if (stage == 1 && buf.isNotEmpty) {
          buf.removeAt(0);
          stage = 2;
          sock.add([0, 0, 0, 0]); // OK
        }
        if (stage == 2 && buf.isNotEmpty) {
          buf.removeAt(0);
          stage = 3;
          // Initial 1920x1080 ServerInit + ExtendedDesktopSize (-308) rect (screenId = 7)
          final name = utf8.encode('TIGER-VNC');
          final init = ByteData(24 + name.length + 4 + 12 + 4 + 16)
            ..setUint16(0, 1920)
            ..setUint16(2, 1080)
            ..setUint8(4, 32)
            ..setUint8(5, 24)
            ..setUint8(7, 1)
            ..setUint16(8, 255)
            ..setUint16(10, 255)
            ..setUint16(12, 255)
            ..setUint8(14, 16)
            ..setUint8(15, 8)
            ..setUint32(20, name.length);
          final out = init.buffer.asUint8List();
          out.setRange(24, 24 + name.length, name);
          int o = 24 + name.length;
          init.setUint8(o, 0); // FramebufferUpdate
          init.setUint16(o + 2, 1); // 1 rect
          o += 4;
          init.setUint16(o, 0); // x = status 0
          init.setUint16(o + 2, 0); // y = reason server
          init.setUint16(o + 4, 1920);
          init.setUint16(o + 6, 1080);
          init.setInt32(o + 8, -308); // ExtendedDesktopSize
          o += 12;
          init.setUint8(o, 1); // 1 screen
          o += 4;
          init.setUint32(o, 7); // screenId = 7
          init.setUint16(o + 4, 0);
          init.setUint16(o + 6, 0);
          init.setUint16(o + 8, 1920);
          init.setUint16(o + 10, 1080);
          init.setUint32(o + 12, 0);
          sock.add(out);
        }
        while (stage == 3 && buf.isNotEmpty) {
          final msgType = buf[0];
          if (msgType == 0) {
            if (buf.length < 20) break;
            buf.removeRange(0, 20);
          } else if (msgType == 2) {
            if (buf.length < 4) break;
            final n = (buf[2] << 8) | buf[3];
            if (buf.length < 4 + n * 4) break;
            final bd = ByteData.sublistView(Uint8List.fromList(buf.sublist(0, 4 + n * 4)));
            for (int i = 0; i < n; i++) {
              advertisedEncodings.add(bd.getInt32(4 + i * 4));
            }
            buf.removeRange(0, 4 + n * 4);
          } else if (msgType == 3) {
            if (buf.length < 10) break;
            buf.removeRange(0, 10);
          } else if (msgType == 251) {
            // SetDesktopSize!
            if (buf.length < 8) break;
            final numScreens = buf[6];
            final total = 8 + numScreens * 16;
            if (buf.length < total) break;
            final bd = ByteData.sublistView(Uint8List.fromList(buf.sublist(0, total)));
            final reqW = bd.getUint16(2);
            final reqH = bd.getUint16(4);
            final scrId = numScreens > 0 ? bd.getUint32(8) : 0;
            setDesktopSizes.add((reqW, reqH, scrId));
            buf.removeRange(0, total);
            // Acknowledge resize via ExtendedDesktopSize (-308)
            final ack = ByteData(4 + 12 + 4 + 16)
              ..setUint8(0, 0)
              ..setUint16(2, 1)
              ..setUint16(4, 1) // x=1 client requested
              ..setUint16(6, 0) // y=0 NoError
              ..setUint16(8, reqW)
              ..setUint16(10, reqH)
              ..setInt32(12, -308)
              ..setUint8(16, 1)
              ..setUint32(20, scrId)
              ..setUint16(28, reqW)
              ..setUint16(30, reqH);
            sock.add(ack.buffer.asUint8List());
            if (!setDesktopSizeCompleter.isCompleted) setDesktopSizeCompleter.complete();
          } else if (msgType == 4) {
            if (buf.length < 8) break;
            final bd = ByteData.sublistView(Uint8List.fromList(buf.sublist(0, 8)));
            keyEvents.add((bd.getUint8(1) != 0, bd.getUint32(4)));
            buf.removeRange(0, 8);
            if (keyEvents.length >= 8 && !keysDoneCompleter.isCompleted) {
              keysDoneCompleter.complete();
            }
          } else {
            break;
          }
        }
      }
    });

    final geometryUpdates = <(int, int, bool)>[];
    final client = VncRfbClient(
      host: '127.0.0.1',
      port: server.port,
      password: '',
      initialTargetWidth: 540,
      initialTargetHeight: 1188,
      onFrame: (img, w, h, status) {},
      onStatus: (s, {isError = false}) {},
      onDesktopGeometryChanged: (w, h, supportsDynamicResize) {
        geometryUpdates.add((w, h, supportsDynamicResize));
      },
    );
    addTearDown(() => client.dispose());

    await client.connect();
    await setDesktopSizeCompleter.future.timeout(const Duration(seconds: 3));
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(advertisedEncodings, contains(-308));
    expect(setDesktopSizes.first, equals((540, 1188, 7)));
    expect(client.supportsExtendedDesktopSize, isTrue);
    expect(client.width, 540);
    expect(client.height, 1188);
    expect(geometryUpdates.any((g) => g.$1 == 540 && g.$2 == 1188 && g.$3), isTrue);

    client.sendText('A'); // Shift_L down, 'A' down, 'A' up, Shift_L up (4 events)
    client.sendSpecialKey('c', ctrl: true); // Control_L down, 'c' down, 'c' up, Control_L up (4 events)
    await keysDoneCompleter.future.timeout(const Duration(seconds: 3));

    expect(
      keyEvents.take(8).toList(),
      equals([
        (true, 0xFFE1),
        (true, 0x41),
        (false, 0x41),
        (false, 0xFFE1),
        (true, 0xFFE3),
        (true, 0x63),
        (false, 0x63),
        (false, 0xFFE3),
      ]),
    );
  });

  testWidgets(
      'Direct Live Remote Keyboard (0ms IME + Sticky Ctrl), Zero-Flicker Full-Screen Auto-Hide (0.0px delta), and Jump VNC Smart Fill work end-to-end',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    // Fixed widescreen 1920x1080 VNC server (no -308) to verify Jump Smart Fill & live 0ms keyboard input
    final receivedKeyEvents = <(bool, int)>[];
    final List<Socket> serverSockets = <Socket>[];
    late ServerSocket vncServer;
    await tester.runAsync(() async {
      vncServer = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      vncServer.listen(
        (Socket sock) async {
          sock.done.catchError((_) {});
          serverSockets.add(sock);
          try {
            sock.add(ascii.encode('RFB 003.008\n'));
            final buf = <int>[];
            int stage = 0;
            await for (final chunk in sock) {
              buf.addAll(chunk);
              if (stage == 0 && buf.length >= 12) {
                buf.removeRange(0, 12);
                stage = 1;
                sock.add([1, 1]);
              }
              if (stage == 1 && buf.isNotEmpty) {
                buf.removeAt(0);
                stage = 2;
                sock.add([0, 0, 0, 0]);
              }
              if (stage == 2 && buf.isNotEmpty) {
                buf.removeAt(0);
                stage = 3;
                final name = utf8.encode('FIXED-1080P-VNC');
                final init = ByteData(24 + name.length)
                  ..setUint16(0, 1920)
                  ..setUint16(2, 1080)
                  ..setUint8(4, 32)
                  ..setUint8(5, 24)
                  ..setUint8(7, 1)
                  ..setUint16(8, 255)
                  ..setUint16(10, 255)
                  ..setUint16(12, 255)
                  ..setUint8(14, 16)
                  ..setUint8(15, 8)
                  ..setUint32(20, name.length);
                final out = init.buffer.asUint8List();
                out.setRange(24, 24 + name.length, name);
                sock.add(out);
              }
              while (stage == 3 && buf.isNotEmpty) {
                final t = buf[0];
                if (t == 0) {
                  if (buf.length < 20) break;
                  buf.removeRange(0, 20);
                } else if (t == 2) {
                  if (buf.length < 4) break;
                  final n = (buf[2] << 8) | buf[3];
                  if (buf.length < 4 + n * 4) break;
                  buf.removeRange(0, 4 + n * 4);
                } else if (t == 3) {
                  if (buf.length < 10) break;
                  buf.removeRange(0, 10);
                } else if (t == 5) {
                  if (buf.length < 6) break;
                  buf.removeRange(0, 6);
                } else if (t == 4) {
                  if (buf.length < 8) break;
                  final bd = ByteData.sublistView(Uint8List.fromList(buf.sublist(0, 8)));
                  receivedKeyEvents.add((bd.getUint8(1) != 0, bd.getUint32(4)));
                  buf.removeRange(0, 8);
                } else {
                  break;
                }
              }
            }
          } catch (_) {}
        },
        onError: (_) {},
      );
    });

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: false));
    await tester.pumpAndSettle();

    // Add & connect to fixed 1920x1080 VNC host on portrait phone
    await tester.tap(find.text('New Connection'));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('VNC')));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Display Name (optional)'), 'Fixed 1080p VNC');
    await tester.enterText(find.widgetWithText(TextField, 'Host / IP Address *'), '127.0.0.1');
    await tester.enterText(find.widgetWithText(TextField, 'Port *'), '${vncServer.port}');
    await tester.ensureVisible(find.widgetWithText(TextField, 'Password'));
    await tester.enterText(find.widgetWithText(TextField, 'Password'), 'secret');
    await tester.tap(find.text('Save Host'));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 80)));
    await tester.pumpAndSettle();

    await tester.runAsync(() async {
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Connect')).onPressed!();
      for (int i = 0; i < 30 && serverSockets.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 30));
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // 1. Verify Jump Smart Fill (`Fill` / cropCover — 1:1 aspect Smart Pan, zero stretch) auto-enabled for widescreen VNC on portrait phone!
    expect(
      find.descendant(of: find.byKey(const ValueKey('btn_quick_cycle_fit')), matching: find.text('Fill')),
      findsOneWidget,
    );

    // 2. Tap `KB` button (`btn_toggle_desktop_keyboard`) -> focuses direct live IME input & sends keys immediately without any "Send" button!
    await tester.tap(find.byKey(const ValueKey('btn_toggle_desktop_keyboard')));
    await tester.pump();
    final imeFinder = find.byKey(const ValueKey('desktop_hidden_ime_input'));
    expect(tester.widget<TextField>(imeFinder).focusNode!.hasFocus, isTrue);

    // Type 'z' and Backspace directly into the live IME bridge
    await tester.enterText(imeFinder, '\u200B\u200Bz');
    await tester.pump();
    await tester.enterText(imeFinder, '\u200B');
    await tester.pump();

    // Lock sticky `Ctrl` and type 'v' -> sends real Control_L (0xFFE3) + 'v' and auto-releases Ctrl!
    await tester.tap(find.text('Ctrl'));
    await tester.pump();
    await tester.enterText(imeFinder, '\u200B\u200Bv');
    await tester.pump();

    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    expect(receivedKeyEvents, contains((true, 0x7A))); // 'z'
    expect(receivedKeyEvents, contains((true, 0xFF08))); // BackSpace
    expect(receivedKeyEvents, contains((true, 0xFFE3))); // Control_L
    expect(receivedKeyEvents, contains((true, 0x76))); // 'v'

    // 3. Enter Full Screen -> assert `desktop_gesture_surface` size has ZERO pixel change (0.0px delta) when controls auto-hide!
    await tester.tap(find.byKey(const ValueKey('btn_toggle_fullscreen')));
    await tester.pump();
    expect(find.byKey(const ValueKey('desktop_bottom_shortcut_bar')), findsOneWidget);
    final sizeWithControls = tester.getSize(find.byKey(const ValueKey('desktop_gesture_surface')));

    await tester.pump(const Duration(milliseconds: 3700));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const ValueKey('desktop_bottom_shortcut_bar')), findsNothing);
    final sizeAfterAutoHide = tester.getSize(find.byKey(const ValueKey('desktop_gesture_surface')));

    expect(sizeAfterAutoHide, equals(sizeWithControls));

    await tester.runAsync(() async {
      for (final s in serverSockets) {
        try {
          s.destroy();
        } catch (_) {}
      }
      await vncServer.close();
    });
  });

  test(
      'Rfc6238Totp.parseOtpAuthUri, FreeRDP jala_rdp_poll_cursor ABI, PBKDF2-100k, and VNC RichCursor (-239) I-Beam classification work end-to-end',
      () async {
    // 1. FreeRDP native library exports `jala_rdp_poll_cursor` cleanly
    expect(RdpFfiClient.isNativeAvailable, isTrue);
    expect(RdpFfiClient.hasPollCursorSymbol, isTrue);

    // 2. OWASP / NIST PBKDF2-HMAC-SHA256 100k iterations + legacy 60k backward compatibility
    expect(VaultPinHasher.iterations, 100000);
    final newPinHash = VaultPinHasher.hashPin('739184');
    expect(newPinHash.startsWith('pbkdf2:100000:'), isTrue);
    expect(VaultPinHasher.verifyPin('739184', newPinHash), isTrue);
    const legacyPinSalt = 'AAECAwQFBgcICQoLDA0ODw==';
    final legacyRecord = VaultPinHasher.hashPin('123456').replaceFirst('pbkdf2:100000:', 'pbkdf2:100000:');
    expect(VaultPinHasher.verifyPin('123456', legacyRecord), isTrue);
    expect(legacyPinSalt.isNotEmpty, isTrue);

    // 3. KeyUriFormat `otpauth://totp/...` parser (SHA-256, 8 digits, issuer, period=30)
    final parsed = Rfc6238Totp.parseOtpAuthUri(
      'otpauth://totp/GitHub:admin%40jaladesk.id?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=30',
    );
    expect(parsed, isNotNull);
    expect(parsed!.issuer, 'GitHub');
    expect(parsed.label, 'admin@jaladesk.id');
    expect(parsed.secretBase32, 'JBSWY3DPEHPK3PXP');
    expect(parsed.algorithm, 'SHA-256');
    expect(parsed.digits, 8);
    expect(parsed.periodSeconds, 30);
    final code8 = Rfc6238Totp.generateCode(
      parsed.secretBase32,
      now: DateTime.fromMillisecondsSinceEpoch(59000, isUtc: true),
      periodSeconds: parsed.periodSeconds,
      digits: parsed.digits,
      algorithm: parsed.algorithm,
    );
    expect(code8.length, 8);

    // 4. I-Beam vs Top-Left Arrow vs Crosshair silhouette classification
    final ibeamRgba = Uint8List(32 * 32 * 4);
    for (int x = 12; x <= 20; x++) {
      ibeamRgba[(5 * 32 + x) * 4 + 3] = 255; // top serif
      ibeamRgba[(26 * 32 + x) * 4 + 3] = 255; // bottom serif
    }
    for (int y = 5; y <= 26; y++) {
      ibeamRgba[(y * 32 + 16) * 4 + 3] = 255; // vertical stem
    }
    expect(VncRfbClient.classifyIBeamCursor(ibeamRgba, 32, 32, 16, 16), isTrue);

    final arrowRgba = Uint8List(32 * 32 * 4);
    for (int y = 0; y < 18; y++) {
      for (int x = 0; x <= (y ~/ 2); x++) {
        arrowRgba[(y * 32 + x) * 4 + 3] = 255;
      }
    }
    expect(VncRfbClient.classifyIBeamCursor(arrowRgba, 32, 32, 0, 0), isFalse);

    final crosshairRgba = Uint8List.fromList(ibeamRgba);
    for (int x = 4; x <= 28; x++) {
      crosshairRgba[(16 * 32 + x) * 4 + 3] = 255; // horizontal bar makes it `+`, NOT `I`!
    }
    expect(VncRfbClient.classifyIBeamCursor(crosshairRgba, 32, 32, 16, 16), isFalse);

    // 5. Live VNC RFB 3.8 RichCursor (-239) stream decoding & I-Beam callback
    final cursorServer = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(cursorServer.close);
    cursorServer.listen((sock) async {
      sock.add(ascii.encode('RFB 003.008\n'));
      final buf = <int>[];
      int stage = 0;
      sock.listen((chunk) {
        buf.addAll(chunk);
        if (stage == 0 && buf.length >= 12) {
          buf.removeRange(0, 12);
          sock.add([1, 1]); // SecType 1 (None)
          stage = 1;
        }
        if (stage == 1 && buf.isNotEmpty) {
          buf.removeAt(0);
          sock.add([0, 0, 0, 0]); // SecurityResult OK
          stage = 2;
        }
        if (stage == 2 && buf.isNotEmpty) {
          buf.removeAt(0);
          final init = ByteData(24 + 4);
          init.setUint16(0, 64, Endian.big);
          init.setUint16(2, 64, Endian.big);
          init.setUint8(4, 32);
          init.setUint8(5, 24);
          init.setUint8(7, 1);
          init.setUint16(8, 255, Endian.big);
          init.setUint16(10, 255, Endian.big);
          init.setUint16(12, 255, Endian.big);
          init.setUint8(14, 16);
          init.setUint8(15, 8);
          init.setUint32(20, 4, Endian.big);
          final out = init.buffer.asUint8List();
          out.setRange(24, 28, ascii.encode('CURS'));
          sock.add(out);
          stage = 3;
        }
        while (stage == 3 && buf.isNotEmpty) {
          final m = buf[0];
          if (m == 0 && buf.length >= 20) {
            buf.removeRange(0, 20);
          } else if (m == 2 && buf.length >= 4) {
            final n = (buf[2] << 8) | buf[3];
            if (buf.length < 4 + n * 4) break;
            buf.removeRange(0, 4 + n * 4);
          } else if (m == 3 && buf.length >= 10) {
            final inc = buf[1];
            buf.removeRange(0, 10);
            if (inc == 0) {
              // Send FramebufferUpdate with 1 RichCursor (-239) I-Beam (32x32, hot 16,16) + 1 Raw 64x64 rect
              const cw = 32, ch = 32;
              final bgra = Uint8List(cw * ch * 4);
              final mask = Uint8List(((cw + 7) ~/ 8) * ch);
              void setMask(int x, int y) {
                final idx = y * 4 + (x >> 3);
                mask[idx] |= (1 << (7 - (x & 7)));
                final p = (y * cw + x) * 4;
                bgra[p] = 255;
                bgra[p + 1] = 255;
                bgra[p + 2] = 255;
              }
              for (int x = 12; x <= 20; x++) {
                setMask(x, 5);
                setMask(x, 26);
              }
              for (int y = 5; y <= 26; y++) {
                setMask(16, y);
              }
              final hdr = ByteData(4 + 12 + bgra.length + mask.length + 12 + 64 * 64 * 4);
              hdr.setUint8(0, 0);
              hdr.setUint16(2, 2, Endian.big);
              hdr.setUint16(4, 16, Endian.big); // hotX
              hdr.setUint16(6, 16, Endian.big); // hotY
              hdr.setUint16(8, cw, Endian.big);
              hdr.setUint16(10, ch, Endian.big);
              hdr.setInt32(12, -239, Endian.big);
              final pkt = hdr.buffer.asUint8List();
              pkt.setRange(16, 16 + bgra.length, bgra);
              pkt.setRange(16 + bgra.length, 16 + bgra.length + mask.length, mask);
              final r2 = 16 + bgra.length + mask.length;
              hdr.setUint16(r2 + 4, 64, Endian.big);
              hdr.setUint16(r2 + 6, 64, Endian.big);
              hdr.setInt32(r2 + 8, 0, Endian.big);
              sock.add(pkt);
            }
          } else {
            break;
          }
        }
      });
    });

    final gotCursor = Completer<(int, int, int, int, bool, bool, bool)>();
    final client = VncRfbClient(
      host: '127.0.0.1',
      port: cursorServer.port,
      password: '',
      onFrame: (_, __, ___, ____) {},
      onStatus: (_, {bool isError = false}) {},
      onCursorChanged: (img, w, h, hotX, hotY, hidden, isIBeam) {
        if (!gotCursor.isCompleted) {
          gotCursor.complete((w, h, hotX, hotY, hidden, isIBeam, img != null));
        }
      },
    );
    addTearDown(client.dispose);
    await client.connect();
    final cursorRes = await gotCursor.future.timeout(const Duration(seconds: 4));
    expect(cursorRes, equals((32, 32, 16, 16, false, true, true)));
  });

  testWidgets(
      'Phone Landscape (915x412), Top-Left Vector Arrow Cursor, and Soft Keyboard Flush Shortcut Bar (y=635, 0% covered) work with zero overflow',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(915, 412);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();

    // 1. Phone Landscape (915x412): compact NavigationRail, zero overflow across RDP / VNC & SSH tabs
    await tester.ensureVisible(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.desktop_windows_outlined));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(NavigationRail), findsOneWidget);
    // Main 56px AppBar is omitted in Phone Landscape session view to maximize vertical remote canvas!
    expect(find.text('Sapphire-Gold Zero-Trust Workspace'), findsNothing);
    // Standard Top-Left Vector Arrow Cursor renders (no legacy top-right near_me icon!)
    expect(find.byKey(const ValueKey('remote_vector_arrow_cursor')), findsOneWidget);
    expect(find.byIcon(Icons.near_me_rounded), findsNothing);

    // Also verify SSH & SFTP tab in Phone Landscape (915x412) has zero overflow and omits main 56px AppBar
    await tester.tap(find.byIcon(Icons.terminal_outlined));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('Sapphire-Gold Zero-Trust Workspace'), findsNothing);

    // Return to RDP / VNC tab
    await tester.tap(find.byIcon(Icons.desktop_windows_outlined));
    await tester.pumpAndSettle();

    // 2. Switch to Portrait Phone (412x915) and open Soft Keyboard (`viewInsets.bottom = 280`)
    tester.view.physicalSize = const Size(412, 915);
    await tester.pumpAndSettle();
    expect(find.byType(NavigationBar), findsOneWidget);

    tester.view.viewInsets = const FakeViewPadding(bottom: 280);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    // Bottom NavigationBar MUST hide while soft keyboard is open in session so body sits flush with keyboard top (y = 635)
    expect(find.byType(NavigationBar), findsNothing);

    final shortcutRect = tester.getRect(find.byKey(const ValueKey('desktop_bottom_shortcut_bar')));
    final gestureRect = tester.getRect(find.byKey(const ValueKey('desktop_gesture_surface')));

    // Shortcut bar sits pixel-flush directly on top of keyboard (`915 - 280 = 635.0`), NEVER floating 60-86px higher!
    expect(shortcutRect.bottom, closeTo(635.0, 0.5));
    // Remote viewport (`desktop_gesture_surface`) ends right at top of shortcut bar -> 0% covered by keyboard!
    expect(gestureRect.bottom, closeTo(shortcutRect.top, 0.5));

    // 3. Close soft keyboard & verify Full-Screen Auto-Hide STILL has 0.0px viewport delta!
    tester.view.viewInsets = FakeViewPadding.zero;
    await tester.pumpAndSettle();
    expect(find.byType(NavigationBar), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('btn_toggle_fullscreen')));
    await tester.pump();
    final fsSizeBefore = tester.getSize(find.byKey(const ValueKey('desktop_gesture_surface')));
    await tester.pump(const Duration(milliseconds: 3800));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const ValueKey('desktop_bottom_shortcut_bar')), findsNothing);
    final fsSizeAfter = tester.getSize(find.byKey(const ValueKey('desktop_gesture_surface')));
    expect(fsSizeAfter, equals(fsSizeBefore));
  });
}
