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
import 'package:jaladesk_mobile/protocols/proxmox_ve_client.dart';
import 'package:jaladesk_mobile/protocols/rdp_ffi_client.dart';
import 'package:jaladesk_mobile/protocols/ssh_bastion_tunnel.dart';
import 'package:jaladesk_mobile/protocols/vnc_rfb_client.dart';
import 'package:jaladesk_mobile/security/vault_cloud_sync.dart';
import 'package:jaladesk_mobile/security/vault_passcode_enclave.dart';
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
    expect(find.text('Authenticator'), findsOneWidget);
    expect(find.textContaining('Biometric Unlock'), findsOneWidget);

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
    expect(find.text('Security Vault'), findsOneWidget);
    expect(find.text('Authenticator'), findsOneWidget);
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

    // Load Sample Lab & verify folder grouping + quick icon-only SFTP jump on SSH host
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    expect(find.text('SAMPLE LAB / CORE AD'), findsOneWidget);
    expect(find.text('SAMPLE LAB / BASTIONS'), findsOneWidget);
    expect(find.byKey(const Key('btn_host_sftp_sample-ssh-bastion')), findsOneWidget);
    expect(find.byTooltip('Open SFTP'), findsWidgets);

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
    expect(find.text('Saved Credentials'), findsOneWidget);

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

    // 2. Return to Connections -> Open AppBar + menu -> New Connection -> Create inline + New Jump Host -> Bind both to RDP host
    await tester.tap(find.text('Connections'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_connection')));
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
    expect(find.byKey(const Key('dialog_jump_host_editor')), findsOneWidget);
    expect(find.text('New Jump Host Gateway'), findsOneWidget);

    // Fill out the dedicated SSH Jump Host Gateway modal
    await tester.enterText(
      find.byKey(const Key('jump_editor_name')),
      'Batam SSH Bastion',
    );
    await tester.enterText(
      find.byKey(const Key('jump_editor_host')),
      '198.51.100.20',
    );
    await tester.tap(find.byKey(const Key('btn_save_jump_gateway')));
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
    expect(find.byTooltip('Connect'), findsOneWidget);
    await tester.runAsync(() async {
      tester.widget<IconButton>(find.widgetWithIcon(IconButton, Icons.play_arrow_rounded)).onPressed!();
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

    // 4. Return to Connections while LIVE -> verify icon-only `Resume Session` button & NO duplicate connection!
    await tester.tap(find.text('Connections'));
    await tester.pump();
    expect(find.textContaining('LIVE'), findsWidgets);
    expect(find.byTooltip('Resume Session'), findsOneWidget);

    await tester.tap(find.byTooltip('Resume Session'));
    await tester.pump();
    // Must still be handshake #1 (switched straight back to live tab without reconnecting!)
    expect(rfbHandshakesCompleted, 1);

    // 5. Explicit Disconnect button closes session cleanly
    await tester.tap(find.byKey(const ValueKey('btn_disconnect_desktop')));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 150)));
    await tester.pump();
    expect(find.byKey(const ValueKey('btn_disconnect_desktop')), findsNothing);

    // 6. Configure Vault App-Lock PIN via pure UI numpad -> Lock Vault -> Reject wrong PIN -> Unlock with right PIN
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.tap(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();

    expect(find.descendant(of: find.byType(VaultPinSetupSheet), matching: find.byType(TextField)), findsNothing);
    await tester.tap(find.byKey(const ValueKey('chip_pin_len_4')));
    await tester.pumpAndSettle();
    for (final d in ['7', '3', '9', '1']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    for (final d in ['7', '3', '9', '1']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('btn_lock_vault_now')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('vault_pin_lock_screen')), findsOneWidget);
    expect(find.descendant(of: find.byType(VaultPinLockView), matching: find.byType(TextField)), findsNothing);

    for (final d in ['0', '0', '0', '0']) {
      await tester.tap(find.byKey(ValueKey('btn_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.textContaining('Incorrect Vault PIN'), findsOneWidget);

    for (final d in ['7', '3', '9', '1']) {
      await tester.tap(find.byKey(ValueKey('btn_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('vault_pin_lock_screen')), findsNothing);
    expect(find.text('Security Vault'), findsOneWidget);

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
      tester.widget<IconButton>(find.widgetWithIcon(IconButton, Icons.play_arrow_rounded)).onPressed!();
      for (int i = 0; i < 30 && serverSockets.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 30));
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // 1. Verify VNC starts cleanly in `Fit` (`aspectFit` — 100% symmetric desktop visible) and cycles `Fit` -> `Fill` -> `1:1` (all proportional, zero stretch)!
    expect(
      find.descendant(of: find.byKey(const ValueKey('btn_quick_cycle_fit')), matching: find.text('Fit')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('btn_quick_cycle_fit')));
    await tester.pump();
    expect(
      find.descendant(of: find.byKey(const ValueKey('btn_quick_cycle_fit')), matching: find.text('Fill')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('btn_quick_cycle_fit')));
    await tester.pump();
    expect(
      find.descendant(of: find.byKey(const ValueKey('btn_quick_cycle_fit')), matching: find.text('1:1')),
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

    // 1. Phone Landscape (915x412): ZERO NavigationRail on ALL tabs (compact top navigation pills on Tab 0 & Tab 3)
    await tester.ensureVisible(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    expect(find.byType(NavigationRail), findsNothing);
    expect(find.byKey(const ValueKey('landscape_nav_tab_0')), findsOneWidget);
    expect(find.byKey(const ValueKey('landscape_nav_tab_1')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('landscape_nav_tab_1')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(NavigationRail), findsNothing);
    expect(find.byKey(const ValueKey('btn_landscape_back_hosts')), findsOneWidget);
    // Main AppBar is omitted in Phone Landscape session view to maximize vertical remote canvas!
    expect(find.text('Sapphire-Gold Zero-Trust Workspace'), findsNothing);
    // Standard Top-Left Vector Arrow Cursor renders (no legacy top-right near_me icon!)
    expect(find.byKey(const ValueKey('remote_vector_arrow_cursor')), findsOneWidget);
    expect(find.byIcon(Icons.near_me_rounded), findsNothing);

    // Return to Connections via `btn_landscape_back_hosts`, then enter SSH & SFTP tab
    await tester.tap(find.byKey(const ValueKey('btn_landscape_back_hosts')));
    await tester.pumpAndSettle();
    expect(find.byType(NavigationRail), findsNothing);
    expect(find.byKey(const ValueKey('landscape_nav_tab_2')), findsOneWidget);

    // Verify SSH & SFTP tab in Phone Landscape (915x412) fills 100% width with zero NavigationRail and zero overflow
    await tester.tap(find.byKey(const ValueKey('landscape_nav_tab_2')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(NavigationRail), findsNothing);
    expect(find.byKey(const ValueKey('btn_ssh_landscape_back_hosts')), findsOneWidget);
    expect(find.text('Sapphire-Gold Zero-Trust Workspace'), findsNothing);

    // Return to Connections then RDP / VNC tab
    await tester.tap(find.byKey(const ValueKey('btn_ssh_landscape_back_hosts')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('landscape_nav_tab_1')));
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

  testWidgets(
      'Oppo Find X9 Pro 20:9 Landscape (915x412) renders 100% edge-to-edge canvas, top-centered Full-Screen HUD, and Fit/Fill/Pan/1:1 cycle',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(915, 412);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();

    // Enter RDP / VNC tab in 20:9 Phone Landscape -> 0px left strip, 100% width canvas (915.0px)
    await tester.tap(find.byIcon(Icons.desktop_windows_outlined));
    await tester.pumpAndSettle();
    expect(find.byType(NavigationRail), findsNothing);
    final canvasRect = tester.getRect(find.byKey(const ValueKey('desktop_gesture_surface')));
    expect(canvasRect.left, closeTo(0.0, 0.5));
    expect(canvasRect.width, closeTo(915.0, 0.5));

    // Verify quick fit cycle: Fit -> Fill -> 1:1 -> Fit (zero non-uniform stretch modes!)
    final cycleBtn = find.byKey(const ValueKey('btn_quick_cycle_fit'));
    await tester.ensureVisible(cycleBtn);
    await tester.pumpAndSettle();
    expect(find.descendant(of: cycleBtn, matching: find.text('Fit')), findsOneWidget);
    await tester.tap(cycleBtn);
    await tester.pump();
    expect(find.descendant(of: cycleBtn, matching: find.text('Fill')), findsOneWidget);
    await tester.tap(cycleBtn);
    await tester.pump();
    expect(find.descendant(of: cycleBtn, matching: find.text('1:1')), findsOneWidget);
    await tester.tap(cycleBtn);
    await tester.pump();
    expect(find.descendant(of: cycleBtn, matching: find.text('Fit')), findsOneWidget);

    // Toggle Full Screen -> verify `fullscreen_floating_hud` is TOP-CENTERED (never pushed to right edge!)
    await tester.tap(find.byKey(const ValueKey('btn_toggle_fullscreen')));
    await tester.pump();
    final hudRect = tester.getRect(find.byKey(const ValueKey('fullscreen_floating_hud')));
    expect(hudRect.center.dx, closeTo(915.0 / 2.0, 4.0));
    expect(hudRect.right, lessThan(800.0));

    // Exit Full Screen -> return to Connections -> verify SSH Full-Screen HUD is ALSO top-centered
    await tester.tap(find.byKey(const ValueKey('btn_exit_fullscreen_pill')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('btn_landscape_back_hosts')));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.terminal_outlined));
    await tester.pumpAndSettle();
    final sshFsBtn = find.byKey(const ValueKey('btn_ssh_toggle_fullscreen'));
    await tester.ensureVisible(sshFsBtn);
    await tester.pumpAndSettle();
    await tester.tap(sshFsBtn);
    await tester.pump();
    final sshHudRect = tester.getRect(find.byKey(const ValueKey('ssh_fullscreen_floating_hud')));
    expect(sshHudRect.center.dx, closeTo(915.0 / 2.0, 4.0));
  });

  test(
      'VncRfbClient sends ExtendedDesktopSize (-308) first, fires onDesktopGeometryChanged, and retries scaled-down SetDesktopSize on rx=1 reject',
      () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close());

    final receivedEncodings = <int>[];
    final requestedResizes = <(int, int, int, int)>[];
    final secondResizeReceived = Completer<void>();

    server.listen((sock) {
      sock.add(ascii.encode('RFB 003.008\n'));
      final buf = <int>[];
      int stage = 0;
      sock.listen((chunk) {
        buf.addAll(chunk);
        if (stage == 0 && buf.length >= 12) {
          buf.removeRange(0, 12);
          stage = 1;
          sock.add([1, 1]); // SecType None
        }
        if (stage == 1 && buf.isNotEmpty) {
          buf.removeAt(0); // Client selected SecType 1
          sock.add([0, 0, 0, 0]); // SecurityResult OK
          stage = 2;
        }
        if (stage == 2 && buf.isNotEmpty) {
          buf.removeAt(0);
          stage = 3;
          final name = utf8.encode('PVE-QEMU-VNC');
          final init = ByteData(24 + name.length)
            ..setUint16(0, 1024)
            ..setUint16(2, 768)
            ..setUint8(4, 32)
            ..setUint8(5, 24)
            ..setUint8(6, 0)
            ..setUint8(7, 1)
            ..setUint16(8, 255)
            ..setUint16(10, 255)
            ..setUint16(12, 255)
            ..setUint8(13, 16)
            ..setUint8(14, 8)
            ..setUint8(15, 0)
            ..setUint32(20, name.length);
          final out = init.buffer.asUint8List();
          out.setRange(24, 24 + name.length, name);
          sock.add(out);

          // Immediately advertise ExtendedDesktopSize (-308) with screenId=7, flags=3
          final ext = ByteData(4 + 12 + 4 + 16)
            ..setUint8(0, 0)
            ..setUint16(2, 1)
            ..setUint16(4, 0) // rx = 0 (server layout)
            ..setUint16(6, 0) // ry = 0
            ..setUint16(8, 1024)
            ..setUint16(10, 768)
            ..setInt32(12, -308)
            ..setUint8(16, 1) // 1 screen
            ..setUint32(20, 7) // id = 7
            ..setUint16(24, 0)
            ..setUint16(26, 0)
            ..setUint16(28, 1024)
            ..setUint16(30, 768)
            ..setUint32(32, 3); // flags = 3
          sock.add(ext.buffer.asUint8List());
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
            final bd = ByteData.sublistView(Uint8List.fromList(buf.sublist(4, 4 + n * 4)));
            for (int i = 0; i < n; i++) {
              receivedEncodings.add(bd.getInt32(i * 4));
            }
            buf.removeRange(0, 4 + n * 4);
          } else if (t == 3) {
            if (buf.length < 10) break;
            buf.removeRange(0, 10);
          } else if (t == 251) {
            if (buf.length < 8) break;
            final numScreens = buf[6];
            final totalLen = 8 + numScreens * 16;
            if (buf.length < totalLen) break;
            final bd = ByteData.sublistView(Uint8List.fromList(buf.sublist(0, totalLen)));
            final w = bd.getUint16(2);
            final h = bd.getUint16(4);
            final sid = bd.getUint32(8);
            final sflags = bd.getUint32(20);
            requestedResizes.add((w, h, sid, sflags));
            buf.removeRange(0, totalLen);

            if (requestedResizes.length == 1) {
              // Reject tall 1264x2780 request with rx=1, ry=3 (out-of-bounds)
              final rej = ByteData(4 + 12 + 4 + 16)
                ..setUint8(0, 0)
                ..setUint16(2, 1)
                ..setUint16(4, 1) // rx = 1 (client request)
                ..setUint16(6, 3) // ry = 3 (rejected)
                ..setUint16(8, 1024)
                ..setUint16(10, 768)
                ..setInt32(12, -308)
                ..setUint8(16, 1)
                ..setUint32(20, 7)
                ..setUint16(28, 1024)
                ..setUint16(30, 768)
                ..setUint32(32, 3);
              sock.add(rej.buffer.asUint8List());
            } else if (!secondResizeReceived.isCompleted) {
              secondResizeReceived.complete();
            }
          } else {
            break;
          }
        }
      });
    });

    int geometryEvents = 0;
    bool lastExtSupported = false;
    final client = VncRfbClient(
      host: '127.0.0.1',
      port: server.port,
      password: '',
      onFrame: (img, w, h, status) {},
      onStatus: (status, {isError = false}) {},
      onDesktopGeometryChanged: (w, h, extSupported) {
        geometryEvents++;
        lastExtSupported = extSupported;
      },
    );
    addTearDown(() => client.dispose());

    await client.connect();
    for (int i = 0; i < 30 && !client.supportsExtendedDesktopSize; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(receivedEncodings.first, equals(-308));
    expect(client.supportsExtendedDesktopSize, isTrue);
    expect(geometryEvents, greaterThanOrEqualTo(1));
    expect(lastExtSupported, isTrue);

    // Request tall 1264x2780 resize -> server rejects with rx=1, ry=3 -> client auto-retries scaled to maxEdge=1280!
    client.requestDesktopResize(1264, 2780);
    await secondResizeReceived.future.timeout(const Duration(seconds: 3));
    expect(requestedResizes.length, equals(2));
    expect(requestedResizes[0], equals((1264, 2780, 7, 3)));
    expect(requestedResizes[1].$2, equals(1280));
    expect(requestedResizes[1].$1, closeTo(582, 2));
    expect(requestedResizes[1].$3, equals(7));
    expect(requestedResizes[1].$4, equals(3));
  });

  test(
      'ProxmoxVeClient authenticates (@pam -> @pve fallback), inspects QEMU/LXC cluster resources, dispatches power actions, and gracefully handles ESXi /ui/',
      () async {
    final prevHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    addTearDown(() => HttpOverrides.global = prevHttpOverrides);

    final tmpDir = await Directory.systemTemp.createTemp('jaladesk_pve_tls_');
    addTearDown(() => tmpDir.delete(recursive: true));

    final certPath = '${tmpDir.path}/cert.pem';
    final keyPath = '${tmpDir.path}/key.pem';
    final genRes = await Process.run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=pve-lab.local',
    ]);
    expect(genRes.exitCode, equals(0));

    final secCtx = SecurityContext()
      ..useCertificateChain(certPath)
      ..usePrivateKey(keyPath);

    final authRealmsTried = <String>[];
    String? powerActionCookie;
    String? powerActionCsrf;
    String? powerActionPath;

    final pveServer = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, secCtx);
    addTearDown(() => pveServer.close(force: true));

    pveServer.listen((HttpRequest req) async {
      final path = req.uri.path;
      final bodyText = await utf8.decoder.bind(req).join();
      req.response.headers.set('server', 'pve-api-daemon/3.0');
      req.response.headers.contentType = ContentType.json;

      if (path == '/api2/json/access/ticket' && req.method == 'POST') {
        final params = Uri.splitQueryString(bodyText);
        final user = params['username'] ?? '';
        authRealmsTried.add(user);
        if (user.endsWith('@pam')) {
          req.response.statusCode = 401;
          req.response.write(jsonEncode({'data': null}));
        } else {
          req.response.statusCode = 200;
          req.response.write(jsonEncode({
            'data': {
              'ticket': 'PVE:ops@pve:6733ABCD::MOCK_TICKET',
              'CSRFPreventionToken': '6733ABCD:CSRF_TOKEN_OK',
              'username': user,
            }
          }));
        }
      } else if (path == '/api2/json/version') {
        req.response.statusCode = 200;
        req.response.write(jsonEncode({
          'data': {'version': '8.3.2', 'release': '8.3'}
        }));
      } else if (path == '/api2/json/nodes') {
        req.response.statusCode = 200;
        req.response.write(jsonEncode({
          'data': [
            {
              'node': 'pve-node-01',
              'status': 'online',
              'cpu': 0.18,
              'maxcpu': 16,
              'mem': 17179869184,
              'maxmem': 68719476736,
              'uptime': 86400,
            }
          ]
        }));
      } else if (path == '/api2/json/cluster/resources') {
        req.response.statusCode = 200;
        req.response.write(jsonEncode({
          'data': [
            {
              'type': 'qemu',
              'vmid': 101,
              'name': 'prod-k8s-master',
              'node': 'pve-node-01',
              'status': 'stopped',
              'cpu': 0.0,
              'maxcpu': 4,
              'mem': 0,
              'maxmem': 8589934592,
              'uptime': 0,
            },
            {
              'type': 'lxc',
              'vmid': 202,
              'name': 'redis-cache',
              'node': 'pve-node-01',
              'status': 'running',
              'cpu': 0.07,
              'maxcpu': 2,
              'mem': 536870912,
              'maxmem': 2147483648,
              'uptime': 14200,
            },
          ]
        }));
      } else if (path.startsWith('/api2/json/nodes/') && req.method == 'POST') {
        powerActionPath = path;
        powerActionCookie = req.headers.value(HttpHeaders.cookieHeader);
        powerActionCsrf = req.headers.value('CSRFPreventionToken');
        req.response.statusCode = 200;
        req.response.write(jsonEncode({'data': 'UPID:pve-node-01:00001A2B:qmstart:101:ops@pve:'}));
      } else {
        req.response.statusCode = 200;
        req.response.write(jsonEncode({'data': []}));
      }
      await req.response.close();
    });

    final pveClient = ProxmoxVeClient(host: '127.0.0.1', port: pveServer.port);
    final snapshot = await pveClient.connectAndInspect(username: 'ops', password: 'secret');
    expect(authRealmsTried, equals(['ops@pam', 'ops@pve']));
    expect(snapshot.isProxmoxVe, isTrue);
    expect(snapshot.authenticated, isTrue);
    expect(snapshot.versionText, contains('8.3'));
    expect(snapshot.nodes.single.node, equals('pve-node-01'));
    expect(snapshot.resources.length, equals(2));
    expect(snapshot.tlsFingerprintSha256, startsWith('SHA256:'));

    final upid = await pveClient.performPowerAction(
      node: 'pve-node-01',
      type: 'qemu',
      vmid: 101,
      action: 'start',
    );
    expect(upid, contains('UPID:pve-node-01'));
    expect(powerActionPath, equals('/api2/json/nodes/pve-node-01/qemu/101/status/start'));
    expect(powerActionCookie, contains('PVEAuthCookie='));
    expect(powerActionCsrf, equals('6733ABCD:CSRF_TOKEN_OK'));

    // Also verify non-PVE VMware ESXi HTTPS endpoint graceful fallback
    final esxiServer = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, secCtx);
    addTearDown(() => esxiServer.close(force: true));
    esxiServer.listen((HttpRequest req) async {
      req.response.headers.set('server', 'VMware-ESXi-HTTPD');
      if (req.uri.path.startsWith('/api2/json')) {
        req.response.statusCode = 404;
        req.response.write('Not Found');
      } else {
        req.response.statusCode = 200;
        req.response.write('<html><title>VMware ESXi Host Client</title></html>');
      }
      await req.response.close();
    });

    final esxiClient = ProxmoxVeClient(host: '127.0.0.1', port: esxiServer.port);
    final esxiSnap = await esxiClient.connectAndInspect(username: 'root', password: 'pw');
    expect(esxiSnap.isProxmoxVe, isFalse);
    expect(esxiSnap.productBanner, contains('VMware ESXi'));
  });

  testWidgets(
      'Vault Local-Only Known Hosts clarity, Auto-Lock 0s lifecycle lock, and tactile Sapphire-Gold PIN keypad + 5-attempt cooldown work end-to-end',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(430, 932);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();

    // Load Sample Lab -> verify `10.28.99.203` is NEVER seeded into Trusted SSH Host Keys
    await tester.ensureVisible(find.text('Load Sample Lab'));
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Trusted SSH Keys'));
    expect(find.text('Trusted SSH Keys'), findsOneWidget);
    expect(find.text('LOCAL DEVICE ONLY • NOT GLOBAL'), findsNothing);
    expect(find.textContaining('never synced globally'), findsNothing);
    expect(find.textContaining('10.28.99.203'), findsNothing);

    // Select `Immediately` (`chip_autolock_0`) auto-lock timeout
    await tester.ensureVisible(find.byKey(const ValueKey('chip_autolock_0')));
    await tester.tap(find.byKey(const ValueKey('chip_autolock_0')));
    await tester.pumpAndSettle();

    // Setup a 4-digit PIN using the tactile setup keypad (`btn_setup_pin_digit_*`)
    await tester.ensureVisible(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.tap(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('chip_pin_len_4')));
    await tester.pumpAndSettle();
    for (final d in ['2', '5', '8', '0']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    for (final d in ['2', '5', '8', '0']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('chip_pin_len_4')), findsNothing); // Setup dialog auto-saved & closed!

    // Simulate valid Flutter lifecycle sequence (`inactive` -> `hidden` -> `paused` -> `hidden` -> `inactive` -> `resumed`) with `0s` (`Immediately`) auto-lock -> locks immediately!
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('vault_pin_lock_screen')), findsOneWidget);

    // Trigger 5 wrong PIN attempts via keypad -> activates 15s cooldown guard!
    for (int attempt = 0; attempt < 5; attempt++) {
      for (final d in ['9', '9', '9', '9']) {
        await tester.tap(find.byKey(ValueKey('btn_pin_digit_$d')));
        await tester.pump();
      }
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(find.textContaining('Too many failed attempts'), findsOneWidget);

    // Advance 15 seconds past cooldown -> enter `2580` on tactile keypad -> instant auto-unlock on 4th digit!
    await tester.pump(const Duration(seconds: 16));
    for (final d in ['2', '5', '8', '0']) {
      await tester.tap(find.byKey(ValueKey('btn_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('vault_pin_lock_screen')), findsNothing);
  });

  testWidgets(
      'v1.10.0+11 Oppo Find X9 Pro Live Polish: Cutout-Safe Landscape (915x412, left=44), Symmetric VNC Fit, Adaptive Cursor Size, Pure Numpad PIN & Zero-Lag Auto-Lock',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(915, 412);
    tester.view.devicePixelRatio = 1.0;
    tester.view.viewPadding = const FakeViewPadding(left: 44, right: 0, top: 0, bottom: 14);
    tester.view.padding = const FakeViewPadding(left: 44, right: 0, top: 0, bottom: 14);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewPadding);
    addTearDown(tester.view.resetPadding);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();

    // 1. Phone Landscape (915x412 with 44dp left punch-hole cutout): ZERO NavigationRail on ALL 4 tabs!
    expect(find.byType(NavigationRail), findsNothing);
    await tester.ensureVisible(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Load Sample Lab'));
    await tester.pumpAndSettle();
    expect(find.byType(NavigationRail), findsNothing);

    // Tab 3 (Vault & 2FA) via compact top pill (`landscape_nav_tab_3`)
    await tester.tap(find.byKey(const ValueKey('landscape_nav_tab_3')));
    await tester.pumpAndSettle();
    expect(find.byType(NavigationRail), findsNothing);
    expect(find.text('LOCAL DEVICE ONLY • NOT GLOBAL'), findsNothing);

    // 2. Instant Auto-Lock ChoiceChip switching via ValueNotifier + scalar SharedPreferences persistence
    await tester.ensureVisible(find.byKey(const ValueKey('chip_autolock_60')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('chip_autolock_60')));
    await tester.pump();
    ChoiceChip chip60 = tester.widget<ChoiceChip>(find.byKey(const ValueKey('chip_autolock_60')));
    expect(chip60.selected, isTrue);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getInt('jaladesk_vault_autolock_sec_v1'), 60);

    // 3. Pure UI Numpad PIN Setup & PIN Removal + Landscape Lock View (ZERO TextFields anywhere!)
    await tester.ensureVisible(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byType(VaultPinSetupSheet), matching: find.byType(TextField)), findsNothing);
    await tester.tap(find.byKey(const ValueKey('chip_pin_len_4')));
    await tester.pumpAndSettle();
    for (final d in ['1', '3', '5', '7']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    for (final d in ['1', '3', '5', '7']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    // Lock in 915x412 Landscape -> side-by-side layout with ZERO TextField & ZERO overflow
    await tester.tap(find.byKey(const Key('btn_lock_vault_now')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(VaultPinLockView), findsOneWidget);
    expect(find.descendant(of: find.byType(VaultPinLockView), matching: find.byType(TextField)), findsNothing);
    for (final d in ['1', '3', '5', '7']) {
      await tester.tap(find.byKey(ValueKey('btn_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.byType(VaultPinLockView), findsNothing);

    // Verify PIN Removal flow on pure Numpad (`Enter Current PIN` -> `btn_remove_vault_pin`)
    await tester.tap(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('btn_remove_vault_pin')), findsNothing);
    for (final d in ['1', '3', '5', '7']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('btn_remove_vault_pin')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('btn_remove_vault_pin')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('btn_lock_vault_now')), findsNothing);

    // 4. Switch to Tab 1 (RDP / VNC) -> verify full-bleed `desktop_bottom_shortcut_bar` & Symmetric Cutout-Safe `Fit`
    await tester.tap(find.byKey(const ValueKey('landscape_nav_tab_1')));
    await tester.pumpAndSettle();
    expect(find.byType(NavigationRail), findsNothing);
    final barRect = tester.getRect(find.byKey(const ValueKey('desktop_bottom_shortcut_bar')));
    expect(barRect.left, closeTo(0.0, 0.01));
    expect(barRect.width, closeTo(915.0, 0.01));

    final shellState = tester.state<JalaDeskMobileShellState>(find.byType(JalaDeskMobileShell));
    // Ultrawide 21:9 VNC server (2560x1080) inside 915x320 viewport with left=44 cutout
    shellState.setServerDimensionsForVerification(2560, 1080);
    shellState.setDisplayModeForVerification(fit: JumpCanvasFitMode.aspectFit);
    await tester.pump();

    final fitRect = shellState.computeRenderedDesktopRectForVerification(
      const Size(915, 348),
      safePadding: const EdgeInsets.only(left: 44, right: 0),
      applySymmetricCutoutInset: true,
    );
    final leftMargin = fitRect.left;
    final rightMargin = 915.0 - fitRect.right;
    expect(leftMargin, closeTo(rightMargin, 0.001));
    expect(leftMargin, greaterThanOrEqualTo(44.0));
    expect(fitRect.top, closeTo(348.0 - fitRect.bottom, 0.001));

    // 5. Adaptive Proportional & Zoom-Aware Cursor Size
    // (a) Zoomed-out 4K desktop (`3840x2160`) -> compact cursor (`~13.5dp` height)
    shellState.setServerDimensionsForVerification(3840, 2160);
    await tester.pump();
    final smallCursorPaint = tester.widget<CustomPaint>(find.byKey(const ValueKey('remote_vector_arrow_cursor')));
    expect(smallCursorPaint.size.height, closeTo(13.5, 0.2));

    // (b) 1:1 / Matched desktop (`800x340`) -> larger natural cursor (`~24-25dp` height)
    shellState.setServerDimensionsForVerification(800, 340);
    await tester.pump();
    final matchedCursorPaint = tester.widget<CustomPaint>(find.byKey(const ValueKey('remote_vector_arrow_cursor')));
    expect(matchedCursorPaint.size.height, greaterThan(smallCursorPaint.size.height + 6.0));
    expect(matchedCursorPaint.size.height, lessThanOrEqualTo(25.01));

    // (c) 3.5x Pinch-Zoom -> pre-transform cursor shrinks by `1 / 3.5` so on-screen size caps cleanly at `25.0dp`!
    shellState.setZoomScaleForVerification(3.5, tx: -120.0, ty: -40.0);
    await tester.pump();
    final zoomedCursorPaint = tester.widget<CustomPaint>(find.byKey(const ValueKey('remote_vector_arrow_cursor')));
    expect(zoomedCursorPaint.size.height * 3.5, closeTo(25.0, 0.2));

    // Switching back to `Fit` via `setDisplayModeForVerification` resets leftover pan/zoom Matrix4 to identity!
    shellState.setDisplayModeForVerification(fit: JumpCanvasFitMode.aspectFit);
    await tester.pump();
    final resetCursorPaint = tester.widget<CustomPaint>(find.byKey(const ValueKey('remote_vector_arrow_cursor')));
    expect(resetCursorPaint.size.height, closeTo(matchedCursorPaint.size.height, 0.2));
  });

  testWidgets(
      'v1.10.1+12 Zero-Latency PIN Enclave: 0ms PointerDown digit registration before PointerUp, zero ScrollView arena, and warm pre-mounted shell instant unlock',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const JalaDeskMobileApp(disableNetworkProbes: true));
    await tester.pumpAndSettle();

    // Open Vault & 2FA tab and configure a 6-digit PIN (`147258`)
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    expect(find.text('Security Vault'), findsOneWidget);

    await tester.ensureVisible(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();

    for (final d in ['1', '4', '7', '2', '5', '8']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    for (final d in ['1', '4', '7', '2', '5', '8']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();

    // Lock the Vault
    await tester.tap(find.byKey(const Key('btn_lock_vault_now')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('vault_pin_lock_screen')), findsOneWidget);

    // 1. ZERO SingleChildScrollView inside VaultPinLockView (zero 100ms scroll-arena delay!)
    expect(
      find.descendant(
        of: find.byType(VaultPinLockView),
        matching: find.byType(SingleChildScrollView),
      ),
      findsNothing,
    );

    // 2. Warm Shell Curtain: underlying shell is completely hidden from UI/hit-testing/finder,
    //    yet stays warm & mounted offstage so unlock has 0ms cold-mount spike!
    expect(find.text('Security Vault'), findsNothing);
    expect(find.text('Security Vault', skipOffstage: false), findsOneWidget);

    // 3. True 0ms Finger-Down (`PointerDown`) Registration:
    //    Press finger down on `btn_pin_digit_1` WITHOUT calling `gesture1.up()` yet!
    final dotsFinder = find.descendant(
      of: find.byKey(const ValueKey('vault_pin_progress_dots')),
      matching: find.byType(AnimatedContainer),
    );
    expect(tester.widgetList<AnimatedContainer>(dotsFinder).first.constraints?.maxWidth, 11.0);

    final TestGesture gesture1 = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('btn_pin_digit_1'))),
    );
    await tester.pump(); // Finger is STILL DOWN — `gesture1.up()` has NOT been called!
    final firstDotWhileDown = tester.widgetList<AnimatedContainer>(dotsFinder).first;
    expect(firstDotWhileDown.constraints?.maxWidth, 13.0);
    expect(
      (firstDotWhileDown.decoration as BoxDecoration).color,
      equals(const Color(0xFFF3C66F)),
    );
    await gesture1.up();
    await tester.pump();

    // Enter digits 2..5 (`4`, `7`, `2`, `5`)
    for (final d in ['4', '7', '2', '5']) {
      await tester.tap(find.byKey(ValueKey('btn_pin_digit_$d')));
      await tester.pump();
    }
    expect(find.byKey(const ValueKey('vault_pin_lock_screen')), findsOneWidget);

    // 4. Instant Unlock on the 6th `PointerDown` (`8`) BEFORE `gesture6.up()` is even released!
    final TestGesture gesture6 = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('btn_pin_digit_8'))),
    );
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey('vault_pin_lock_screen')), findsNothing);
    expect(find.text('Security Vault'), findsOneWidget);
    await gesture6.up();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'v1.11.0+13 Test A: Dedicated Jump Host Gateway Editor & Gateway Section without non-SSH protocol clutter',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(JalaDeskMobileApp(disableNetworkProbes: true, shellKey: shellKey));
    await tester.pumpAndSettle();

    // Open dedicated Jump Host Gateway dialog from unified AppBar + menu
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_jump_host')));
    await tester.pumpAndSettle();

    final dialogFinder = find.byKey(const Key('dialog_jump_host_editor'));
    expect(dialogFinder, findsOneWidget);
    expect(find.text('New Jump Host Gateway'), findsOneWidget);

    // Gateway-focused fields exist
    expect(find.byKey(const Key('jump_editor_name')), findsOneWidget);
    expect(find.byKey(const Key('jump_editor_host')), findsOneWidget);
    expect(find.byKey(const Key('jump_editor_port')), findsOneWidget);
    expect(find.byKey(const Key('jump_editor_user')), findsOneWidget);
    expect(find.byKey(const Key('jump_editor_key')), findsOneWidget);
    expect(find.byKey(const Key('btn_test_jump_gateway')), findsOneWidget);
    expect(find.byKey(const Key('btn_save_jump_gateway')), findsOneWidget);

    // Confusing regular-host protocol chips (RDP/VNC/HYPERVISOR) & AD Domain clutter are absent,
    // while SSH bastion auth mode chips (SSH Key / Password) are cleanly exposed
    expect(find.descendant(of: dialogFinder, matching: find.widgetWithText(ChoiceChip, 'RDP')), findsNothing);
    expect(find.descendant(of: dialogFinder, matching: find.widgetWithText(ChoiceChip, 'VNC')), findsNothing);
    expect(find.descendant(of: dialogFinder, matching: find.widgetWithText(ChoiceChip, 'HYPERVISOR')), findsNothing);
    expect(find.descendant(of: dialogFinder, matching: find.text('AD Domain (optional)')), findsNothing);
    expect(find.descendant(of: dialogFinder, matching: find.text('SSH Key')), findsOneWidget);
    expect(find.descendant(of: dialogFinder, matching: find.text('Password')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('jump_editor_name')), 'PLN Public Jump');
    await tester.enterText(find.byKey(const Key('jump_editor_host')), '103.172.170.203');
    await tester.enterText(find.byKey(const Key('jump_editor_port')), '22022');
    await tester.enterText(find.byKey(const Key('jump_editor_user')), 'ribato');

    await tester.tap(find.byKey(const Key('btn_save_jump_gateway')));
    await tester.pumpAndSettle();

    // Verify `isJumpHost == true` and dedicated `section_jump_gateways` rendering
    final savedGateways = shellKey.currentState!.hosts;
    expect(savedGateways.length, 1);
    expect(savedGateways.single.name, 'PLN Public Jump');
    expect(savedGateways.single.address, '103.172.170.203');
    expect(savedGateways.single.port, 22022);
    expect(savedGateways.single.username, 'ribato');
    expect(savedGateways.single.protocol, RemoteProtocol.ssh);
    expect(savedGateways.single.isJumpHost, isTrue);

    final gatewaySection = find.byKey(const Key('section_jump_gateways'));
    expect(gatewaySection, findsOneWidget);
    expect(
      find.descendant(of: gatewaySection, matching: find.text('PLN Public Jump')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: gatewaySection, matching: find.textContaining('103.172.170.203:22022')),
      findsOneWidget,
    );

    // Verify encrypted/local vault persistence across cold remount
    final reloadedKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(
      JalaDeskMobileApp(
        key: const ValueKey('reloaded_app_test_a'),
        disableNetworkProbes: true,
        shellKey: reloadedKey,
      ),
    );
    await tester.pumpAndSettle();
    expect(reloadedKey.currentState!.hosts.single.isJumpHost, isTrue);
    expect(find.byKey(const Key('section_jump_gateways')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'v1.11.0+13 Test B: Royal TSX-Style Folder Jump Host Configuration, Inheritance & Direct Override',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(JalaDeskMobileApp(disableNetworkProbes: true, shellKey: shellKey));
    await tester.pumpAndSettle();

    // 1. Create `'PLN Public Jump'` gateway
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_jump_host')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('jump_editor_name')), 'PLN Public Jump');
    await tester.enterText(find.byKey(const Key('jump_editor_host')), '103.172.170.203');
    await tester.enterText(find.byKey(const Key('jump_editor_port')), '22022');
    await tester.tap(find.byKey(const Key('btn_save_jump_gateway')));
    await tester.pumpAndSettle();

    final gateway = shellKey.currentState!.hosts.singleWhere((h) => h.name == 'PLN Public Jump');

    // 2. Configure folder `'PLN Internal'` with `'PLN Public Jump'` as Folder Default Jump Host
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_folder')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dialog_folder_settings')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('folder_settings_name')), 'PLN Internal');
    await tester.tap(find.byKey(const Key('folder_settings_jump_dropdown')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('PLN Public Jump (103.172.170.203:22022)').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn_save_folder_settings')));
    await tester.pumpAndSettle();

    expect(shellKey.currentState!.folderConfigs['PLN Internal']?.jumpHostId, gateway.id);
    expect(find.byKey(const Key('btn_folder_settings_PLN Internal')), findsOneWidget);

    // 3. Add an RDP host inside `'PLN Internal'` keeping default folder inheritance (`jumpHostId` empty)
    await tester.ensureVisible(find.byKey(const Key('btn_folder_add_host_PLN Internal')));
    await tester.tap(find.byKey(const Key('btn_folder_add_host_PLN Internal')));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('RDP')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Inherit from Folder "PLN Internal" (via PLN Public Jump)'), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(TextField, 'Display Name (optional)'),
      'AD1 Internal',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Host / IP Address *'),
      '10.28.0.154',
    );
    await tester.tap(find.text('Save Host'));
    await tester.pumpAndSettle();

    final ad1 = shellKey.currentState!.hosts.singleWhere((h) => h.name == 'AD1 Internal');
    expect(ad1.jumpHostId, isNull);
    expect(shellKey.currentState!.effectiveJumpHostIdForVerification(ad1), gateway.id);
    expect(shellKey.currentState!.routeBadgeForVerification(ad1), 'via PLN Public Jump • Folder');
    expect(find.text('via PLN Public Jump • Folder'), findsOneWidget);

    // Connecting includes the inherited folder Jump Host route!
    await shellKey.currentState!.connectHostForVerification(ad1.id);
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Connected to AD1 Internal (10.28.0.154:3389 • via PLN Public Jump • Folder)'),
      findsOneWidget,
    );
    shellKey.currentState!.switchTabForVerification(0);
    await tester.pumpAndSettle();

    // 4. Add another host in `'PLN Internal'` with explicit `kDirectNoJumpOverride` (`'__direct__'`)
    await tester.ensureVisible(find.byKey(const Key('btn_folder_add_host_PLN Internal')));
    await tester.tap(find.byKey(const Key('btn_folder_add_host_PLN Internal')));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('RDP')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Display Name (optional)'),
      'Local Edge Host',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Host / IP Address *'),
      '10.28.0.10',
    );
    await tester.ensureVisible(find.byKey(const ValueKey('dropdown_jump_host')));
    await tester.tap(find.byKey(const ValueKey('dropdown_jump_host')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Direct Connection (Bypass Folder Jump Host)').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save Host'));
    await tester.pumpAndSettle();

    final directHost = shellKey.currentState!.hosts.singleWhere((h) => h.name == 'Local Edge Host');
    expect(directHost.jumpHostId, kDirectNoJumpOverride);
    expect(directHost.isDirectNoJumpOverride, isTrue);
    expect(shellKey.currentState!.effectiveJumpHostIdForVerification(directHost), isNull);
    expect(shellKey.currentState!.routeBadgeForVerification(directHost), isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'v1.11.0+13 Test C: Clean SSH Disconnect Auto-Returns to Connections & Shows Disconnected Empty State',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(JalaDeskMobileApp(disableNetworkProbes: true, shellKey: shellKey));
    await tester.pumpAndSettle();

    // Create `'PLN Public Jump'` and connect via its icon-only Open SSH Terminal button
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_jump_host')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('jump_editor_name')), 'PLN Public Jump');
    await tester.enterText(find.byKey(const Key('jump_editor_host')), '103.172.170.203');
    await tester.enterText(find.byKey(const Key('jump_editor_port')), '22022');
    await tester.tap(find.byKey(const Key('btn_save_jump_gateway')));
    await tester.pumpAndSettle();

    final gatewaySection = find.byKey(const Key('section_jump_gateways'));
    await tester.tap(find.descendant(of: gatewaySection, matching: find.byTooltip('Open SSH Terminal')));
    await tester.pumpAndSettle();

    // Confirm Tab 2 (SSH Terminal) is active & live/simulated terminal is shown
    expect(find.byType(TermiusInteractiveTerminal), findsOneWidget);
    expect(find.byKey(const Key('ssh_disconnected_empty_state')), findsNothing);
    expect(find.byKey(const ValueKey('btn_disconnect_ssh')), findsOneWidget);

    // Emit command output into terminal buffer before disconnecting
    shellKey.currentState!.sendTerminalRawForVerification('uname -a\r');
    await tester.pumpAndSettle();
    final activeTerm = tester.widget<TermiusInteractiveTerminal>(find.byType(TermiusInteractiveTerminal));
    expect(activeTerm.buffer.toPlainText(), contains('Connected to PLN Public Jump'));

    // Trigger Disconnect -> must auto-return to Tab 0 (`Connections`) and clear terminal buffer!
    await tester.tap(find.byKey(const ValueKey('btn_disconnect_ssh')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('section_jump_gateways')), findsOneWidget);
    expect(find.byType(TermiusInteractiveTerminal), findsNothing);
    expect(activeTerm.buffer.toPlainText().trim(), isEmpty);

    // Manually switch to Tab 2 (`SSH & SFTP`) -> verify clean `ssh_disconnected_empty_state`
    await tester.tap(find.text('SSH & SFTP'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('ssh_disconnected_empty_state')), findsOneWidget);
    expect(find.text('No Active SSH Session'), findsOneWidget);
    expect(find.text('Browse Connections'), findsOneWidget);
    expect(find.byKey(const Key('btn_reconnect_last_ssh')), findsOneWidget);
    expect(find.text('PLN Public Jump'), findsOneWidget);
    expect(find.text('Open Offline Scratch Shell'), findsNothing);
    expect(find.byType(TermiusInteractiveTerminal), findsNothing);

    // Quick-reconnect action restores the session cleanly
    await tester.tap(find.byKey(const Key('btn_reconnect_last_ssh')));
    await tester.pumpAndSettle();
    expect(find.byType(TermiusInteractiveTerminal), findsOneWidget);

    // Disconnect again, go to Tab 2, and tap `Browse Connections` -> returns to Tab 0
    await tester.tap(find.byKey(const ValueKey('btn_disconnect_ssh')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('SSH & SFTP'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Browse Connections'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('section_jump_gateways')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  test(
      'v1.11.0+13 Test D: FolderGatewayConfig JSON round-trip, NoDelaySshSocket TCP_NODELAY, Pre-Warmed Channel & BastionSessionPool',
      () async {
    // 1. FolderGatewayConfig serialization + copyWith semantics
    const cfg = FolderGatewayConfig(
      name: 'PLN Private Network',
      jumpHostId: 'jh-pln-01',
      credentialId: 'cred-ad-01',
      accentTint: 'sapphire',
    );
    expect(cfg.hasJumpHost, isTrue);
    expect(cfg.hasCredential, isTrue);
    final roundTripped = FolderGatewayConfig.fromJson(jsonDecode(jsonEncode(cfg.toJson())) as Map<String, dynamic>);
    expect(roundTripped.name, 'PLN Private Network');
    expect(roundTripped.jumpHostId, 'jh-pln-01');
    expect(roundTripped.credentialId, 'cred-ad-01');
    expect(roundTripped.accentTint, 'sapphire');

    final cleared = roundTripped.copyWith(clearJumpHost: true, clearCredential: true);
    expect(cleared.hasJumpHost, isFalse);
    expect(cleared.hasCredential, isFalse);

    // 2. BastionSessionPool signature isolation, in-flight coalescing, warm reuse & eviction
    const hopA = BastionHopSpec(
      id: 'jh-1',
      name: 'PLN Public Jump',
      address: '103.172.170.203',
      port: 22022,
      username: 'ribato',
      password: 'secret-a',
    );
    const hopADiffAuth = BastionHopSpec(
      id: 'jh-1',
      name: 'PLN Public Jump',
      address: '103.172.170.203',
      port: 22022,
      username: 'ribato',
      password: 'secret-b',
    );
    expect(
      BastionSessionPool.computeRouteSignature([hopA]),
      isNot(equals(BastionSessionPool.computeRouteSignature([hopADiffAuth]))),
    );

    final pool = BastionSessionPool();
    int connectCalls = 0;
    Future<SshBastionChain> fakeConnect(List<BastionHopSpec> hops) async {
      connectCalls++;
      await Future<void>.delayed(const Duration(milliseconds: 15));
      return SshBastionChain.testFake(hops);
    }

    // Concurrent calls coalesce into 1 handshake
    final concurrent = await Future.wait([
      pool.acquire([hopA], connectorOverride: fakeConnect),
      pool.acquire([hopA], connectorOverride: fakeConnect),
    ]);
    expect(connectCalls, 1);
    expect(identical(concurrent[0], concurrent[1]), isTrue);
    expect(pool.warmCount, 1);
    expect(pool.isHopWarm('jh-1'), isTrue);

    // Subsequent acquire hits warm pool (0 new handshakes)
    final stages = <String>[];
    final reused = await pool.acquire([hopA], onStage: stages.add, connectorOverride: fakeConnect);
    expect(identical(reused, concurrent[0]), isTrue);
    expect(connectCalls, 1);
    expect(stages.single, contains('warm Jump Host tunnel'));

    // Evicting hop disposes chain and resets warmCount
    await pool.evictHopId('jh-1');
    expect(pool.warmCount, 0);
    expect(reused.isDisposed, isTrue);

    // 3. NoDelaySshSocket TCP_NODELAY + Live OpenSSH Pre-Warmed Port-Forward Tunnel
    final echoServer = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(echoServer.close);
    echoServer.listen((Socket client) {
      client.setOption(SocketOption.tcpNoDelay, true);
      client.listen((data) => client.add(data), onDone: () => client.close());
    });

    final noDelaySock = await NoDelaySshSocket.connect('127.0.0.1', echoServer.port);
    expect(noDelaySock.tcpNoDelayApplied, isTrue);
    await noDelaySock.close();

    final sshdBin = File('/usr/sbin/sshd');
    final sshKeygenBin = File('/usr/bin/ssh-keygen');
    if (sshdBin.existsSync() && sshKeygenBin.existsSync()) {
      final tmpDir = await Directory.systemTemp.createTemp('jaladesk_pool_prewarm_');
      addTearDown(() async {
        try {
          if (await tmpDir.exists()) await tmpDir.delete(recursive: true);
        } on FileSystemException catch (_) {}
      });
      final hostKeyPath = '${tmpDir.path}/host_ed25519';
      final clientKeyPath = '${tmpDir.path}/id_ed25519';
      await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', hostKeyPath]);
      await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', clientKeyPath]);
      final pem = await File(clientKeyPath).readAsString();
      final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final sshPort = probe.port;
      await probe.close();

      final cfgPath = '${tmpDir.path}/sshd.conf';
      await File(cfgPath).writeAsString([
        'Port $sshPort',
        'ListenAddress 127.0.0.1',
        'HostKey $hostKeyPath',
        'AuthorizedKeysFile $clientKeyPath.pub',
        'PasswordAuthentication no',
        'PubkeyAuthentication yes',
        'UsePAM no',
        'AllowTcpForwarding yes',
        'PermitOpen any',
        'StrictModes no',
        'PidFile ${tmpDir.path}/sshd.pid',
      ].join('\n'));

      final sshdProc = await Process.start(sshdBin.path, ['-D', '-e', '-f', cfgPath]);
      addTearDown(() => sshdProc.kill());
      for (int i = 0; i < 30; i++) {
        try {
          final s = await Socket.connect('127.0.0.1', sshPort, timeout: const Duration(milliseconds: 100));
          s.destroy();
          break;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 60));
        }
      }

      final currentUser =
          Platform.environment['USER'] ?? (await Process.run('whoami', [])).stdout.toString().trim();
      final liveHop = BastionHopSpec(
        id: 'jh-live',
        name: 'Local Fast Jump',
        address: '127.0.0.1',
        port: sshPort,
        username: currentUser,
        privateKeyPem: pem,
      );

      final livePool = BastionSessionPool();
      addTearDown(livePool.disposeAll);
      final chain1 = await livePool.acquire([liveHop]);
      final chain2 = await livePool.acquire([liveHop]);
      expect(identical(chain1, chain2), isTrue);
      expect(SshBastionChain.cachedKeyCount, greaterThanOrEqualTo(1));

      final tunnel = await chain1.startLocalPortForward(
        remoteHost: '127.0.0.1',
        remotePort: echoServer.port,
        prewarmChannel: true,
      );
      final clientSock = await Socket.connect('127.0.0.1', tunnel.localPort);
      clientSock.setOption(SocketOption.tcpNoDelay, true);
      clientSock.add(utf8.encode('PING_FAST_BASTION'));
      final echoed = await clientSock.first.timeout(const Duration(seconds: 4));
      expect(utf8.decode(echoed), 'PING_FAST_BASTION');
      expect(tunnel.usedPrewarmedChannel, isTrue);

      await clientSock.close();
      await tunnel.close();
      await livePool.disposeAll();
      expect(livePool.warmCount, 0);
      expect(SshBastionChain.cachedKeyCount, 0);
    }
  });

  testWidgets(
      'v1.11.0+13 Test E: Multi-Viewport Zero-Overflow Check across 360x800 Portrait & 920x420 Oppo Find X9 Pro Cutout Landscape',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewPadding);
    addTearDown(tester.view.resetPadding);

    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1.0;

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(JalaDeskMobileApp(disableNetworkProbes: true, shellKey: shellKey));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    // Populate Jump Gateway + Routed Folder + Inherited RDP Host + SSH Disconnect state
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_jump_host')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.enterText(find.byKey(const Key('jump_editor_name')), 'PLN Public Jump Gateway');
    await tester.enterText(find.byKey(const Key('jump_editor_host')), '103.172.170.203');
    await tester.enterText(find.byKey(const Key('jump_editor_port')), '22022');
    await tester.tap(find.byKey(const Key('btn_save_jump_gateway')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_folder')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.enterText(find.byKey(const Key('folder_settings_name')), 'PLN Private Datacenter');
    await tester.tap(find.byKey(const Key('folder_settings_jump_dropdown')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('PLN Public Jump Gateway').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn_save_folder_settings')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    await tester.ensureVisible(find.byKey(const Key('btn_folder_add_host_PLN Private Datacenter')));
    await tester.tap(find.byKey(const Key('btn_folder_add_host_PLN Private Datacenter')));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('RDP')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Display Name (optional)'),
      'Windows Server 2025 Core SCADA',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Host / IP Address *'),
      '10.28.37.14',
    );
    await tester.tap(find.text('Save Host'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    // Connect & disconnect SSH once so `btn_reconnect_last_ssh` also renders in Empty State
    final gw = shellKey.currentState!.hosts.firstWhere((h) => h.isJumpHost);
    await shellKey.currentState!.connectHostForVerification(gw.id);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('btn_disconnect_ssh')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    Future<void> verifyAllSurfacesZeroOverflow() async {
      // 1. Connections Hub (Jump Gateways + Configured Folders + Hosts)
      shellKey.currentState!.switchTabForVerification(0);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('section_jump_gateways')), findsOneWidget);
      expect(tester.takeException(), isNull);

      // 2. Unified AppBar + Create Menu & Jump Host Gateway Editor Dialog
      await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('sheet_create_menu')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byKey(const Key('menu_add_jump_host')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('dialog_jump_host_editor')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      // 3. Folder Settings Dialog via Unified AppBar + Create Menu
      await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('menu_add_folder')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('dialog_folder_settings')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      // 4. Disconnected SSH Empty State (with Quick-Connect Rows + Browse Connections)
      shellKey.currentState!.switchTabForVerification(2);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('ssh_disconnected_empty_state')), findsOneWidget);
      expect(find.byKey(const Key('btn_reconnect_last_ssh')), findsOneWidget);
      expect(tester.takeException(), isNull);
    }

    // Check 1: Compact 360x800 Portrait
    tester.view.physicalSize = const Size(360, 800);
    tester.view.viewPadding = FakeViewPadding.zero;
    tester.view.padding = FakeViewPadding.zero;
    await tester.pumpAndSettle();
    await verifyAllSurfacesZeroOverflow();

    // Check 2: Oppo Find X9 Pro 920x420 Cutout Landscape (`left/right: 36px` safe padding)
    tester.view.physicalSize = const Size(920, 420);
    tester.view.viewPadding = const FakeViewPadding(left: 36, right: 36, top: 0, bottom: 12);
    tester.view.padding = const FakeViewPadding(left: 36, right: 36, top: 0, bottom: 12);
    await tester.pumpAndSettle();
    await verifyAllSurfacesZeroOverflow();
  });

  testWidgets(
      'v1.12.0+14 UX Simplification & No-Fake-Root-Shell: Unified + Icon Menu, Zero Duplicate Add Clutter, and Clean Disconnected SSH State',
      (WidgetTester tester) async {
    // Pre-populate encrypted/local Vault with saved SSH + Jump Host entries before launch
    final savedHostsJson = jsonEncode([
      const RemoteHostItem(
        id: 'jh-batam-01',
        name: 'PLN Batam Bastion',
        address: '103.172.170.203',
        port: 22022,
        protocol: RemoteProtocol.ssh,
        folder: 'Jump Gateways',
        osLabel: 'SSH Jump Gateway',
        username: 'ribato',
        accentTint: 'gold',
        isJumpHost: true,
      ).toJson(),
      const RemoteHostItem(
        id: 'ssh-prod-01',
        name: 'Core Linux App01',
        address: '10.28.37.88',
        port: 22,
        protocol: RemoteProtocol.ssh,
        folder: 'Production',
        osLabel: 'Ubuntu 24.04 LTS',
        username: 'ubuntu',
        accentTint: 'sapphire',
      ).toJson(),
    ]);
    SharedPreferences.setMockInitialValues(<String, Object>{
      'jaladesk_vault_hosts_v2': savedHostsJson,
    });

    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(JalaDeskMobileApp(disableNetworkProbes: true, shellKey: shellKey));
    await tester.pumpAndSettle();

    // 1. Connections Tab has ZERO duplicate Add buttons or Clear Vault clutter
    expect(find.text('Add Host'), findsNothing);
    expect(find.text('+ Jump Host'), findsNothing);
    expect(find.text('+ Folder'), findsNothing);
    expect(find.text('Add New Connection'), findsNothing);
    expect(find.text('Add Jump Host'), findsNothing);
    expect(find.text('Clear Vault'), findsNothing);
    expect(find.byKey(const Key('btn_header_add_jump_host')), findsNothing);
    expect(find.byKey(const Key('btn_add_jump_host_shortcut')), findsNothing);
    expect(find.byKey(const Key('btn_add_folder')), findsNothing);

    // Only the crisp AppBar `+` icon button (`btn_appbar_create_menu`) & icon-only quick actions appear
    expect(find.byKey(const Key('btn_appbar_create_menu')), findsOneWidget);
    expect(find.byKey(const Key('btn_quick_connect')), findsOneWidget);
    expect(find.byKey(const Key('btn_open_port_forwards')), findsOneWidget);
    expect(find.byKey(const Key('btn_refresh_latency')), findsOneWidget);
    expect(find.byKey(const Key('btn_host_sftp_ssh-prod-01')), findsOneWidget);
    expect(find.byKey(const Key('btn_gateway_terminal_jh-batam-01')), findsOneWidget);

    // 2. Unified AppBar `+` icon opens `sheet_create_menu` and launches all 3 flows cleanly
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sheet_create_menu')), findsOneWidget);
    expect(find.byKey(const Key('menu_add_connection')), findsOneWidget);
    expect(find.byKey(const Key('menu_add_jump_host')), findsOneWidget);
    expect(find.byKey(const Key('menu_add_folder')), findsOneWidget);

    // Launch New Connection -> verify username field is NOT pre-filled with 'root'
    await tester.tap(find.byKey(const Key('menu_add_connection')));
    await tester.pumpAndSettle();
    expect(find.text('New Remote Connection'), findsOneWidget);
    final hostUserField = tester.widget<TextField>(find.widgetWithText(TextField, 'Username'));
    expect(hostUserField.controller?.text, isEmpty);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    // Launch New Jump Host -> verify username field is NOT pre-filled with 'root'
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_jump_host')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dialog_jump_host_editor')), findsOneWidget);
    final jumpUserField = tester.widget<TextField>(find.byKey(const Key('jump_editor_user')));
    expect(jumpUserField.controller?.text, isEmpty);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    // Launch New Folder -> verify Folder Settings dialog opens cleanly
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_folder')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dialog_folder_settings')), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    // 3. Switch to `SSH & SFTP` BEFORE connecting -> MUST show `ssh_disconnected_empty_state`
    // with 1-tap quick-connect rows and ZERO `root@jaladesk` text anywhere!
    await tester.tap(find.text('SSH & SFTP'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('ssh_disconnected_empty_state')), findsOneWidget);
    expect(find.text('No Active SSH Session'), findsOneWidget);
    expect(find.byKey(const Key('btn_quick_ssh_jh-batam-01')), findsOneWidget);
    expect(find.byKey(const Key('btn_quick_ssh_ssh-prod-01')), findsOneWidget);
    expect(find.byType(TermiusInteractiveTerminal), findsNothing);
    expect(find.textContaining('root@jaladesk'), findsNothing);
    expect(find.text('Open Offline Scratch Shell'), findsNothing);

    // Tapping a 1-tap quick-connect row inside the empty state starts the session cleanly
    await tester.tap(find.byKey(const Key('btn_quick_ssh_ssh-prod-01')));
    await tester.pumpAndSettle();
    expect(find.byType(TermiusInteractiveTerminal), findsOneWidget);
    expect(find.textContaining('ubuntu@Core'), findsWidgets);
    expect(find.textContaining('root@jaladesk'), findsNothing);

    // 4. `Clear Vault` lives safely in `Vault & 2FA` with confirmation dialog
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('btn_vault_clear_all')));
    await tester.tap(find.byKey(const Key('btn_vault_clear_all')));
    await tester.pumpAndSettle();
    expect(find.text('Clear Saved Connections?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('btn_confirm_clear_vault')));
    await tester.pumpAndSettle();
    expect(shellKey.currentState!.hosts, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'v1.13.0+15 Test A: Proportional Fit & Fill guarantee 0.000 stretch across 1920x1080 & 1024x768 on Oppo Find X9 Pro 20:9 viewports + cursor-follow pan',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(915, 412);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(JalaDeskMobileApp(disableNetworkProbes: true, shellKey: shellKey));
    await tester.pumpAndSettle();
    final state = shellKey.currentState!;

    for (final (srcW, srcH) in const <(int, int)>[(1920, 1080), (1024, 768)]) {
      final expectedAspect = srcW / srcH;
      state.setServerDimensionsForVerification(srcW, srcH);

      for (final vp in const <Size>[Size(915, 412), Size(412, 915)]) {
        // 1. Fit (`aspectFit`) — 100% visible inside viewport, exact source aspect ratio
        state.setDisplayModeForVerification(fit: JumpCanvasFitMode.aspectFit);
        final fitRect = state.computeRenderedDesktopRectForVerification(vp);
        expect(fitRect.width / fitRect.height, closeTo(expectedAspect, 0.001));
        expect(fitRect.width, lessThanOrEqualTo(vp.width + 0.01));
        expect(fitRect.height, lessThanOrEqualTo(vp.height + 0.01));

        // 2. Fill (`cropCover`) — covers 100% of viewport with ZERO non-uniform distortion!
        state.setDisplayModeForVerification(fit: JumpCanvasFitMode.cropCover);
        state.setCursorNormForVerification(const Offset(0.5, 0.5));
        final fillCenter = state.computeRenderedDesktopRectForVerification(vp);
        expect(fillCenter.width / fillCenter.height, closeTo(expectedAspect, 0.001));
        expect(fillCenter.width, greaterThanOrEqualTo(vp.width - 0.01));
        expect(fillCenter.height, greaterThanOrEqualTo(vp.height - 0.01));

        // 3. Cursor-following pan reaches top-left (0, 0) and bottom-right cleanly
        state.setCursorNormForVerification(const Offset(0.0, 0.0));
        final fillTopLeft = state.computeRenderedDesktopRectForVerification(vp);
        expect(fillTopLeft.left, closeTo(0.0, 0.01));
        expect(fillTopLeft.top, closeTo(0.0, 0.01));

        state.setCursorNormForVerification(const Offset(1.0, 1.0));
        final fillBottomRight = state.computeRenderedDesktopRectForVerification(vp);
        expect(fillBottomRight.right, closeTo(vp.width, 0.01));
        expect(fillBottomRight.bottom, closeTo(vp.height, 0.01));
      }
    }
    expect(tester.takeException(), isNull);
  });

  test(
      'v1.13.0+15 Test B: Connection-level Jump Host without Folder Jump Host buffers VNC RFB server-first greeting & evicts stale pooled SSH sessions',
      () async {
    final sshdBin = File('/usr/sbin/sshd');
    final sshKeygenBin = File('/usr/bin/ssh-keygen');
    if (!sshdBin.existsSync() || !sshKeygenBin.existsSync()) return;

    // Server-speaks-first fake VNC RFB server: sends `RFB 003.008\n` immediately on TCP accept!
    final rfbServer = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(rfbServer.close);
    rfbServer.listen((Socket client) {
      client.setOption(SocketOption.tcpNoDelay, true);
      client.add(ascii.encode('RFB 003.008\n'));
      client.listen((data) => client.add(data), onDone: () => client.close());
    });

    final tmpDir = await Directory.systemTemp.createTemp('jaladesk_v113_jump_');
    addTearDown(() async {
      try {
        if (await tmpDir.exists()) await tmpDir.delete(recursive: true);
      } on FileSystemException catch (_) {}
    });
    final hostKeyPath = '${tmpDir.path}/host_ed25519';
    final clientKeyPath = '${tmpDir.path}/id_ed25519';
    await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', hostKeyPath]);
    await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', clientKeyPath]);
    final pem = await File(clientKeyPath).readAsString();
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final sshPort = probe.port;
    await probe.close();

    final cfgPath = '${tmpDir.path}/sshd.conf';
    await File(cfgPath).writeAsString([
      'Port $sshPort',
      'ListenAddress 127.0.0.1',
      'HostKey $hostKeyPath',
      'AuthorizedKeysFile $clientKeyPath.pub',
      'PasswordAuthentication no',
      'PubkeyAuthentication yes',
      'UsePAM no',
      'AllowTcpForwarding yes',
      'PermitOpen any',
      'StrictModes no',
      'PidFile ${tmpDir.path}/sshd.pid',
    ].join('\n'));

    final sshdProc = await Process.start(sshdBin.path, ['-D', '-e', '-f', cfgPath]);
    addTearDown(() => sshdProc.kill());
    for (int i = 0; i < 30; i++) {
      try {
        final s = await Socket.connect('127.0.0.1', sshPort, timeout: const Duration(milliseconds: 100));
        s.destroy();
        break;
      } catch (_) {
        await Future<void>.delayed(const Duration(milliseconds: 60));
      }
    }

    final currentUser =
        Platform.environment['USER'] ?? (await Process.run('whoami', [])).stdout.toString().trim();
    final hop = BastionHopSpec(
      id: 'jh-conn-only',
      name: 'Conn-Level Bastion',
      address: '127.0.0.1',
      port: sshPort,
      username: currentUser,
      privateKeyPem: pem,
    );

    final pool = BastionSessionPool();
    addTearDown(pool.disposeAll);

    // 1. Pre-warmed channel buffers immediate `RFB 003.008\n` server greeting with ZERO byte loss!
    final chain1 = await pool.acquire([hop]);
    final tunnel1 = await chain1.startLocalPortForward(
      remoteHost: '127.0.0.1',
      remotePort: rfbServer.port,
      prewarmChannel: true,
      verifyInitialChannel: true,
    );
    await Future<void>.delayed(const Duration(milliseconds: 60)); // Ensure RFB greeting arrived early
    final localClient = await Socket.connect('127.0.0.1', tunnel1.localPort);
    final greeting = await localClient.first.timeout(const Duration(seconds: 4));
    expect(ascii.decode(greeting), equals('RFB 003.008\n'));
    expect(tunnel1.usedPrewarmedChannel, isTrue);
    await localClient.close();
    await tunnel1.close();

    // 2. Stale/dead pooled SSH chain throws directly in `startLocalPortForward` & evicts cleanly!
    await chain1.dispose();
    await expectLater(
      chain1.startLocalPortForward(
        remoteHost: '127.0.0.1',
        remotePort: rfbServer.port,
        prewarmChannel: true,
        verifyInitialChannel: true,
      ),
      throwsA(anything),
    );
    await pool.evictByHops([hop]);
    final chain2 = await pool.acquire([hop]);
    expect(identical(chain1, chain2), isFalse);
    final tunnel2 = await chain2.startLocalPortForward(
      remoteHost: '127.0.0.1',
      remotePort: rfbServer.port,
      prewarmChannel: true,
      verifyInitialChannel: true,
    );
    final localClient2 = await Socket.connect('127.0.0.1', tunnel2.localPort);
    final greeting2 = await localClient2.first.timeout(const Duration(seconds: 4));
    expect(ascii.decode(greeting2), equals('RFB 003.008\n'));
    await localClient2.close();
    await tunnel2.close();
  });

  testWidgets(
      'v1.13.0+15 Test C: Connection-level Jump Host in unconfigured folder, Full-Screen VaultPinSetupSheet & VaultPinLockView (Portrait + Landscape), and Minimalist Vault Tab',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(JalaDeskMobileApp(disableNetworkProbes: true, shellKey: shellKey));
    await tester.pumpAndSettle();
    final state = shellKey.currentState!;

    // 1. Add connection inside `'Unconfigured Office'` (NO FolderGatewayConfig!) with inline `+ New Jump Host`
    await tester.tap(find.byKey(const Key('btn_appbar_create_menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu_add_connection')));
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextField, 'Display Name (optional)'), 'VNC via Jump Box');
    await tester.enterText(find.widgetWithText(TextField, 'Host / IP Address *'), '10.90.1.25');
    await tester.enterText(find.byKey(const Key('host_editor_folder')), 'Unconfigured Office');
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.byKey(const ValueKey('btn_inline_new_jump_host')));
    await tester.tap(find.byKey(const ValueKey('btn_inline_new_jump_host')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('jump_editor_name')), 'Edge Bastion');
    await tester.enterText(find.byKey(const Key('jump_editor_host')), '203.0.113.10');
    await tester.tap(find.byKey(const Key('btn_save_jump_gateway')));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Save Host'));
    await tester.pumpAndSettle();

    final savedHost = state.hosts.firstWhere((h) => h.name == 'VNC via Jump Box');
    final savedGateway = state.hosts.firstWhere((h) => h.name == 'Edge Bastion');
    expect(state.folderConfigs.containsKey('Unconfigured Office'), isFalse);
    expect(savedHost.jumpHostId, equals(savedGateway.id));
    expect(state.effectiveJumpHostIdForVerification(savedHost), equals(savedGateway.id));
    expect(state.routeBadgeForVerification(savedHost), contains('Edge Bastion'));

    // 2. Minimalist `Vault & 2FA` Tab — zero jargon walls!
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    expect(find.text('Security Vault'), findsOneWidget);
    expect(find.text('Authenticator'), findsOneWidget);
    expect(find.text('Saved Credentials'), findsOneWidget);
    expect(find.text('App Security'), findsOneWidget);
    expect(find.text('Backup & SSH Keys'), findsOneWidget);
    expect(find.text('Zero-Trust Hardware Enclave'), findsNothing);
    expect(find.text('RFC 6238 TOTP 2FA Authenticator'), findsNothing);
    expect(find.text('Screen Capture & Recents Shield (FLAG_SECURE)'), findsNothing);

    // 3. Full-Screen Edge-to-Edge `VaultPinSetupSheet` (zero AlertDialog/Dialog, zero TextField, zero SingleChildScrollView)
    await tester.ensureVisible(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.tap(find.byKey(const Key('btn_configure_vault_pin')));
    await tester.pumpAndSettle();

    final setupFinder = find.byType(VaultPinSetupSheet);
    expect(setupFinder, findsOneWidget);
    expect(tester.getSize(setupFinder), equals(const Size(412, 915)));
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.descendant(of: setupFinder, matching: find.byType(TextField)), findsNothing);
    expect(find.descendant(of: setupFinder, matching: find.byType(SingleChildScrollView)), findsNothing);

    // Verify Landscape (`915x412`) layout of `VaultPinSetupSheet` renders edge-to-edge with zero overflow!
    tester.view.physicalSize = const Size(915, 412);
    await tester.pumpAndSettle();
    expect(tester.getSize(setupFinder), equals(const Size(915, 412)));
    expect(tester.takeException(), isNull);

    for (final d in ['1', '3', '5', '7', '9', '2']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    for (final d in ['1', '3', '5', '7', '9', '2']) {
      await tester.tap(find.byKey(ValueKey('btn_setup_pin_digit_$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();

    // 4. Lock Vault & verify `VaultPinLockView` fills Landscape (`915x412`) AND Portrait (`412x915`) edge-to-edge!
    await tester.ensureVisible(find.byKey(const Key('btn_lock_vault_now')));
    await tester.tap(find.byKey(const Key('btn_lock_vault_now')));
    await tester.pumpAndSettle();

    final lockFinder = find.byKey(const ValueKey('vault_pin_lock_screen'));
    expect(lockFinder, findsOneWidget);
    expect(tester.getSize(lockFinder), equals(const Size(915, 412)));
    expect(find.descendant(of: lockFinder, matching: find.byType(TextField)), findsNothing);
    expect(find.descendant(of: lockFinder, matching: find.byType(SingleChildScrollView)), findsNothing);

    tester.view.physicalSize = const Size(412, 915);
    await tester.pumpAndSettle();
    expect(tester.getSize(lockFinder), equals(const Size(412, 915)));
    expect(tester.takeException(), isNull);
  });

  test(
      'v1.14.0+16 Test 1: VaultSyncPayloadMerger & Zero-Knowledge E2EE Multi-Device Sync (Tombstones, Edits & Zero Plaintext Leakage)',
      () async {
    const masterSyncPass = 'ZeroTrust-MasterSync#2026!';

    const host1 = RemoteHostItem(
      id: 'host-rdp-dc01',
      name: 'Core AD Controller',
      address: '10.28.44.10',
      port: 3389,
      protocol: RemoteProtocol.rdp,
      folder: 'Core Infrastructure',
      domain: 'corp',
      username: 'sysadmin',
      password: 'Sup3rS3cretRdpPassword#1',
      jumpHostId: 'gw-edge-01',
      updatedAtMs: 1000,
    );
    const jump1 = RemoteHostItem(
      id: 'gw-edge-01',
      name: 'Edge Jump v1',
      address: '203.0.113.77',
      port: 2222,
      protocol: RemoteProtocol.ssh,
      username: 'bastion_ops',
      privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET_BASTION_KEY_MATERIAL\n-----END OPENSSH PRIVATE KEY-----',
      isJumpHost: true,
      updatedAtMs: 1000,
    );
    const folderCfg = FolderGatewayConfig(
      name: 'Core Infrastructure',
      jumpHostId: 'gw-edge-01',
      accentTint: 'gold',
      updatedAtMs: 1000,
    );

    // 1. Device A builds initial payload, seals client-side on isolate, and uploads to cloud
    final deviceAPayload = VaultSyncPayloadMerger.normalizePayload(
      <String, dynamic>{
        'hosts': <Map<String, dynamic>>[host1.toJson(), jump1.toJson()],
        'credentials': const <Map<String, dynamic>>[],
        'folders': <Map<String, dynamic>>[folderCfg.toJson()],
        'totp': const <Map<String, dynamic>>[],
        'snippets': const <Map<String, dynamic>>[],
        'tombstones': const <String, int>{},
      },
      nowMs: 1050,
    );
    final cloudBytesV1 = await VaultCloudSyncCrypto.sealAsync(
      payload: deviceAPayload,
      passphrase: masterSyncPass,
    );

    // Verify ZERO plaintext leakage of IPs, usernames, passwords, keys, or folder names in cloud envelope!
    expect(cloudBytesV1, contains('jaladesk-encrypted-vault-v1'));
    expect(cloudBytesV1.contains('10.28.44.10'), isFalse);
    expect(cloudBytesV1.contains('203.0.113.77'), isFalse);
    expect(cloudBytesV1.contains('sysadmin'), isFalse);
    expect(cloudBytesV1.contains('Sup3rS3cretRdpPassword#1'), isFalse);
    expect(cloudBytesV1.contains('SECRET_BASTION_KEY_MATERIAL'), isFalse);
    expect(cloudBytesV1.contains('Core Infrastructure'), isFalse);

    // 2. Device B pulls cloudBytesV1, adds Host 2 + Credential 1, updates Jump Host 1, and deletes Host 1
    final pulledOnB = await VaultCloudSyncCrypto.openAsync(
      rawEnvelopeJson: cloudBytesV1,
      passphrase: masterSyncPass,
    );
    final bHosts = (pulledOnB['hosts'] as List<dynamic>)
        .map((m) => RemoteHostItem.fromJson(Map<String, dynamic>.from(m as Map)))
        .toList();
    expect(bHosts.length, 2);

    // Device B deletes Host 1 (ts=2000), updates Jump Host 1 (ts=2100), adds Host 2 & Credential 1 (ts=2200)
    bHosts.removeWhere((h) => h.id == 'host-rdp-dc01');
    final bJumpIdx = bHosts.indexWhere((h) => h.id == 'gw-edge-01');
    bHosts[bJumpIdx] = bHosts[bJumpIdx].copyWith(
      name: 'Edge Jump v2 (Hardened)',
      updatedAtMs: 2100,
    );
    const host2 = RemoteHostItem(
      id: 'host-k8s-master',
      name: 'K8s Prod API',
      address: '10.28.44.99',
      port: 22,
      protocol: RemoteProtocol.ssh,
      folder: 'Core Infrastructure',
      username: 'ubuntu',
      credentialId: 'cred-ops-01',
      updatedAtMs: 2200,
    );
    bHosts.add(host2);
    const cred1 = VaultCredentialItem(
      id: 'cred-ops-01',
      label: 'Prod Ops Key',
      username: 'ubuntu',
      password: 'OpsVaultPassword!99',
      updatedAtMs: 2200,
    );

    final deviceBLocal = <String, dynamic>{
      'hosts': bHosts.map((h) => h.toJson()).toList(),
      'credentials': <Map<String, dynamic>>[cred1.toJson()],
      'folders': pulledOnB['folders'],
      'totp': const <Map<String, dynamic>>[],
      'snippets': const <Map<String, dynamic>>[],
      'tombstones': <String, int>{'host:host-rdp-dc01': 2000},
    };
    final mergedOnB = VaultSyncPayloadMerger.merge(deviceBLocal, pulledOnB, nowMs: 2300);
    final cloudBytesV2 = await VaultCloudSyncCrypto.sealAsync(
      payload: mergedOnB,
      passphrase: masterSyncPass,
    );
    expect(cloudBytesV2.contains('10.28.44.99'), isFalse);
    expect(cloudBytesV2.contains('OpsVaultPassword!99'), isFalse);

    // 3. Device A (still holding stale Host 1 locally at updatedAtMs=1000!) syncs with cloudBytesV2
    final remoteLatestForA = await VaultCloudSyncCrypto.openAsync(
      rawEnvelopeJson: cloudBytesV2,
      passphrase: masterSyncPass,
    );
    final syncedDeviceA = VaultSyncPayloadMerger.merge(
      deviceAPayload,
      remoteLatestForA,
      nowMs: 3000,
    );

    final finalAHosts = (syncedDeviceA['hosts'] as List<dynamic>)
        .map((m) => RemoteHostItem.fromJson(Map<String, dynamic>.from(m as Map)))
        .toList();
    final finalACreds = (syncedDeviceA['credentials'] as List<dynamic>)
        .map((m) => VaultCredentialItem.fromJson(Map<String, dynamic>.from(m as Map)))
        .toList();
    final finalAFolders = (syncedDeviceA['folders'] as List<dynamic>)
        .map((m) => FolderGatewayConfig.fromJson(Map<String, dynamic>.from(m as Map)))
        .toList();

    // Verify Host 1 was NOT resurrected, Host 2 + Credential 1 arrived, Jump Host 1 updated to v2, Folder preserved!
    expect(finalAHosts.any((h) => h.id == 'host-rdp-dc01'), isFalse);
    expect(finalAHosts.any((h) => h.id == 'host-k8s-master'), isTrue);
    final syncedJump = finalAHosts.firstWhere((h) => h.id == 'gw-edge-01');
    expect(syncedJump.name, equals('Edge Jump v2 (Hardened)'));
    expect(finalACreds.map((c) => c.id), contains('cred-ops-01'));
    expect(finalAFolders.map((f) => f.name), contains('Core Infrastructure'));

    // Also verify tombstone capping to 500 most recent entries
    final hugeTombs = <String, int>{
      for (int i = 1; i <= 540; i++) 'host:old-$i': i,
    };
    final capped = VaultSyncPayloadMerger.capTombstones(hugeTombs);
    expect(capped.length, equals(500));
    expect(capped.containsKey('host:old-540'), isTrue);
    expect(capped.containsKey('host:old-1'), isFalse);
  });

  test(
      'v1.14.0+16 Test 2: Live Loopback Transport Adapters for Google Drive AppData (with 401 refresh), WebDAV, GitHub Secret Gist & OpenSSH SFTP',
      () async {
    final prevHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    addTearDown(() => HttpOverrides.global = prevHttpOverrides);

    final sealedSampleV1 = EncryptedVaultBackupCodec.sealJson(
      payload: <String, dynamic>{'syncSchema': 2, 'marker': 'v1'},
      passphrase: 'LoopbackTransportPass#1',
    );
    final sealedSampleV2 = EncryptedVaultBackupCodec.sealJson(
      payload: <String, dynamic>{'syncSchema': 2, 'marker': 'v2'},
      passphrase: 'LoopbackTransportPass#1',
    );

    // --- A. Google Drive v3 appDataFolder REST Transport + 401 Token Refresh ---
    String? driveStoredContent;
    String? driveFileId;
    int driveTokenRefreshCount = 0;

    final driveServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => driveServer.close(force: true));
    driveServer.listen((HttpRequest req) async {
      final authHeader = req.headers.value('authorization') ?? '';
      if (authHeader != 'Bearer valid-google-token-v2') {
        req.response.statusCode = 401;
        req.response.write('{"error":{"code":401,"message":"Invalid Credentials"}}');
        await req.response.close();
        return;
      }
      final path = req.uri.path;
      final body = await utf8.decoder.bind(req).join();
      req.response.headers.contentType = ContentType.json;

      if (req.method == 'GET' && path == '/drive/v3/files') {
        expect(req.uri.queryParameters['spaces'], equals('appDataFolder'));
        if (driveFileId == null) {
          req.response.statusCode = 200;
          req.response.write(jsonEncode(<String, Object>{'files': <Object>[]}));
        } else {
          req.response.statusCode = 200;
          req.response.write(jsonEncode(<String, Object>{
            'files': <Object>[
              <String, String>{
                'id': driveFileId!,
                'name': 'jaladesk-vault-v1.jvault',
                'modifiedTime': '2026-11-13T08:00:00Z',
              },
            ],
          }));
        }
      } else if (req.method == 'POST' && path == '/upload/drive/v3/files') {
        expect(req.uri.queryParameters['uploadType'], equals('multipart'));
        expect(body, contains('"appDataFolder"'));
        // Extract second JSON part (the encrypted .jvault envelope)
        final formatIdx = body.indexOf('{\n  "format":');
        driveStoredContent = formatIdx >= 0
            ? body.substring(formatIdx, body.lastIndexOf('}') + 1)
            : body;
        driveFileId = 'gdrive_appdata_file_001';
        req.response.statusCode = 200;
        req.response.write(jsonEncode(<String, String>{'id': driveFileId!}));
      } else if (req.method == 'PATCH' &&
          path == '/upload/drive/v3/files/gdrive_appdata_file_001') {
        expect(req.uri.queryParameters['uploadType'], equals('media'));
        driveStoredContent = body;
        req.response.statusCode = 200;
        req.response.write(jsonEncode(<String, String>{'id': driveFileId!}));
      } else if (req.method == 'GET' &&
          path == '/drive/v3/files/gdrive_appdata_file_001') {
        expect(req.uri.queryParameters['alt'], equals('media'));
        req.response.statusCode = 200;
        req.response.write(driveStoredContent ?? '');
      } else {
        req.response.statusCode = 404;
      }
      await req.response.close();
    });

    final mockGoogleAuth = _MockGoogleAuthTokenProvider(
      initialToken: 'stale-expired-token-v1',
      refreshedToken: 'valid-google-token-v2',
      onRefreshed: () => driveTokenRefreshCount++,
    );
    final gdriveTransport = GoogleDriveAppDataSyncTransport(
      authProvider: mockGoogleAuth,
      apiBaseUrl: 'http://127.0.0.1:${driveServer.port}',
    );
    expect(await gdriveTransport.downloadEnvelope(), isNull);
    expect(driveTokenRefreshCount, equals(1)); // Triggered automatic 401 refresh!
    await gdriveTransport.uploadEnvelope(sealedSampleV1);
    expect(await gdriveTransport.downloadEnvelope(), equals(sealedSampleV1));
    await gdriveTransport.uploadEnvelope(sealedSampleV2);
    expect(await gdriveTransport.downloadEnvelope(), equals(sealedSampleV2));

    // --- B. WebDAV Basic Auth Transport + WAN Plaintext HTTP Guard ---
    String? webdavStored;
    final webdavServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => webdavServer.close(force: true));
    webdavServer.listen((HttpRequest req) async {
      final expectedAuth = 'Basic ${base64Encode(utf8.encode('nas_user:nas_app_pass'))}';
      if (req.headers.value('authorization') != expectedAuth) {
        req.response.statusCode = 401;
        await req.response.close();
        return;
      }
      if (req.method == 'GET') {
        if (webdavStored == null) {
          req.response.statusCode = 404;
        } else {
          req.response.statusCode = 200;
          req.response.write(webdavStored);
        }
      } else if (req.method == 'PUT') {
        webdavStored = await utf8.decoder.bind(req).join();
        req.response.statusCode = 201;
      }
      await req.response.close();
    });

    final webdavTransport = WebDavVaultSyncTransport(
      fileUrl: 'http://127.0.0.1:${webdavServer.port}/remote.php/dav/files/nas_user/jaladesk.jvault',
      username: 'nas_user',
      password: 'nas_app_pass',
    );
    expect(await webdavTransport.downloadEnvelope(), isNull);
    await webdavTransport.uploadEnvelope(sealedSampleV1);
    expect(await webdavTransport.downloadEnvelope(), equals(sealedSampleV1));

    const insecureWanWebdav = WebDavVaultSyncTransport(
      fileUrl: 'http://nextcloud.public-example.org/dav/jaladesk.jvault',
      username: 'u',
      password: 'p',
    );
    expect(
      () => insecureWanWebdav.downloadEnvelope(),
      throwsA(isA<VaultCloudSyncException>()),
    );

    // --- C. GitHub Secret Gist Transport (Auto-Create, Auto-Discovery & PATCH) ---
    String? gistStoredContent;
    String? serverGistId;
    final gistServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => gistServer.close(force: true));
    gistServer.listen((HttpRequest req) async {
      if (req.headers.value('authorization') != 'Bearer ghp_testSecretToken123') {
        req.response.statusCode = 401;
        await req.response.close();
        return;
      }
      final path = req.uri.path;
      final body = await utf8.decoder.bind(req).join();
      req.response.headers.contentType = ContentType.json;

      if (req.method == 'GET' && path == '/gists') {
        req.response.statusCode = 200;
        req.response.write(jsonEncode(serverGistId == null
            ? <Object>[]
            : <Object>[
                <String, Object>{
                  'id': serverGistId!,
                  'public': false,
                  'files': <String, Object>{
                    'jaladesk-vault.jvault': <String, String>{
                      'filename': 'jaladesk-vault.jvault',
                    },
                  },
                },
              ]));
      } else if (req.method == 'POST' && path == '/gists') {
        final decoded = jsonDecode(body) as Map<String, dynamic>;
        expect(decoded['public'], isFalse);
        final files = decoded['files'] as Map<String, dynamic>;
        final vaultFile = files['jaladesk-vault.jvault'] as Map<String, dynamic>;
        gistStoredContent = vaultFile['content'] as String;
        serverGistId = 'gist_auto_998877';
        req.response.statusCode = 201;
        req.response.write(jsonEncode(<String, Object>{'id': serverGistId!}));
      } else if (req.method == 'GET' && path == '/gists/gist_auto_998877') {
        req.response.statusCode = 200;
        req.response.write(jsonEncode(<String, Object>{
          'id': serverGistId!,
          'public': false,
          'files': <String, Object>{
            'jaladesk-vault.jvault': <String, Object>{
              'content': gistStoredContent ?? '',
              'truncated': false,
            },
          },
        }));
      } else if (req.method == 'PATCH' && path == '/gists/gist_auto_998877') {
        final decoded = jsonDecode(body) as Map<String, dynamic>;
        final files = decoded['files'] as Map<String, dynamic>;
        final vaultFile = files['jaladesk-vault.jvault'] as Map<String, dynamic>;
        gistStoredContent = vaultFile['content'] as String;
        req.response.statusCode = 200;
        req.response.write(jsonEncode(<String, Object>{'id': serverGistId!}));
      } else {
        req.response.statusCode = 404;
      }
      await req.response.close();
    });

    String? capturedGistId;
    final gistCreator = GitHubGistVaultSyncTransport(
      token: 'ghp_testSecretToken123',
      apiBaseUrl: 'http://127.0.0.1:${gistServer.port}',
      onGistIdResolved: (id) => capturedGistId = id,
    );
    expect(await gistCreator.downloadEnvelope(), isNull);
    await gistCreator.uploadEnvelope(sealedSampleV1);
    expect(capturedGistId, equals('gist_auto_998877'));

    // Second device with blank gistId auto-discovers the secret gist!
    final gistSecondDevice = GitHubGistVaultSyncTransport(
      token: 'ghp_testSecretToken123',
      apiBaseUrl: 'http://127.0.0.1:${gistServer.port}',
    );
    expect(await gistSecondDevice.downloadEnvelope(), equals(sealedSampleV1));
    await gistSecondDevice.uploadEnvelope(sealedSampleV2);
    expect(await gistCreator.downloadEnvelope(), equals(sealedSampleV2));

    // --- D. SFTP Transport over Live Ephemeral OpenSSH internal-sftp ---
    final sshdBin = File('/usr/sbin/sshd');
    final sshKeygenBin = File('/usr/bin/ssh-keygen');
    if (sshdBin.existsSync() && sshKeygenBin.existsSync()) {
      final tmpDir = await Directory.systemTemp.createTemp('jaladesk_sync_sftp_');
      addTearDown(() async {
        try {
          if (await tmpDir.exists()) await tmpDir.delete(recursive: true);
        } on FileSystemException catch (_) {}
      });

      final hostKeyPath = '${tmpDir.path}/ssh_host_ed25519_key';
      final clientKeyPath = '${tmpDir.path}/id_ed25519';
      expect((await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', hostKeyPath])).exitCode, 0);
      expect((await Process.run(sshKeygenBin.path, ['-t', 'ed25519', '-N', '', '-f', clientKeyPath])).exitCode, 0);
      final clientPem = await File(clientKeyPath).readAsString();
      final currentUser = Platform.environment['USER'] ??
          (await Process.run('whoami', [])).stdout.toString().trim();

      final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final sshPort = probe.port;
      await probe.close();

      final cfgPath = '${tmpDir.path}/sshd_sync.conf';
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
        'PidFile ${tmpDir.path}/sshd_sync.pid',
      ].join('\n'));

      final sshdProc = await Process.start(sshdBin.path, ['-D', '-e', '-f', cfgPath]);
      addTearDown(() => sshdProc.kill(ProcessSignal.sigterm));

      for (int i = 0; i < 30; i++) {
        try {
          final s = await Socket.connect(
            '127.0.0.1',
            sshPort,
            timeout: const Duration(milliseconds: 150),
          );
          s.destroy();
          break;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 80));
        }
      }

      final remoteVaultPath = '${tmpDir.path}/vault_store/.jaladesk/jaladesk-vault.jvault';
      final sftpSync = SftpVaultSyncTransport(
        host: '127.0.0.1',
        port: sshPort,
        username: currentUser,
        privateKeyPem: clientPem,
        remotePath: remoteVaultPath,
      );
      expect(await sftpSync.downloadEnvelope(), isNull);
      await sftpSync.uploadEnvelope(sealedSampleV1);
      expect(await File(remoteVaultPath).exists(), isTrue);
      expect(await sftpSync.downloadEnvelope(), equals(sealedSampleV1));
      await sftpSync.uploadEnvelope(sealedSampleV2);
      expect(await sftpSync.downloadEnvelope(), equals(sealedSampleV2));
    }
  });

  testWidgets(
      'v1.14.0+16 Test 3: VaultCloudSyncScreen & Vault & 2FA Integration (Portrait + 915x412 Landscape, OAuth Diagnostic, SFTP Quick-Fill & Live Sync)',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final prevHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    addTearDown(() => HttpOverrides.global = prevHttpOverrides);

    // Pre-seed a remote encrypted .jvault on a real loopback WebDAV server
    const syncPass = 'MobileVault#Sync99';
    String? serverVaultEnvelope = EncryptedVaultBackupCodec.sealJson(
      payload: <String, dynamic>{
        'syncSchema': 2,
        'updatedAtMs': 1500,
        'hosts': <Map<String, dynamic>>[
          const RemoteHostItem(
            id: 'remote-synced-rdp-01',
            name: 'Cloud Synced Workstation',
            address: '10.77.10.50',
            port: 3389,
            protocol: RemoteProtocol.rdp,
            username: 'cloudadmin',
            updatedAtMs: 1500,
          ).toJson(),
        ],
        'credentials': const <Map<String, dynamic>>[],
        'folders': const <Map<String, dynamic>>[],
        'totp': const <Map<String, dynamic>>[],
        'snippets': const <Map<String, dynamic>>[],
        'tombstones': const <String, int>{},
      },
      passphrase: syncPass,
    );

    late HttpServer syncWebDavServer;
    await tester.runAsync(() async {
      syncWebDavServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      syncWebDavServer.listen((HttpRequest req) async {
        if (req.method == 'GET') {
          if (serverVaultEnvelope == null) {
            req.response.statusCode = 404;
          } else {
            req.response.statusCode = 200;
            req.response.write(serverVaultEnvelope);
          }
        } else if (req.method == 'PUT') {
          serverVaultEnvelope = await utf8.decoder.bind(req).join();
          req.response.statusCode = 201;
        }
        await req.response.close();
      });
    });
    addTearDown(() async {
      await tester.runAsync(() => syncWebDavServer.close(force: true));
    });

    final mockOAuthNeedsSetup = _MockGoogleAuthTokenProvider(
      throwOAuthSetupOnSignIn: true,
    );

    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final shellKey = GlobalKey<JalaDeskMobileShellState>();
    await tester.pumpWidget(
      JalaDeskMobileApp(
        disableNetworkProbes: true,
        shellKey: shellKey,
        googleAuthProviderOverride: mockOAuthNeedsSetup,
        initialHostsOverride: const <RemoteHostItem>[
          RemoteHostItem(
            id: 'local-jump-gw-1',
            name: 'Saved Bastion Node',
            address: '192.168.50.10',
            port: 2222,
            protocol: RemoteProtocol.ssh,
            username: 'ops_jump',
            password: 'JumpSecretPassword',
            isJumpHost: true,
            updatedAtMs: 2000,
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    final state = shellKey.currentState!;

    // 1. Open `Vault & 2FA` and verify ultra-clean `Cloud Sync` card
    await tester.tap(find.text('Vault & 2FA'));
    await tester.pumpAndSettle();
    expect(find.text('Cloud Sync'), findsOneWidget);
    expect(find.text('Sync encrypted connections across devices'), findsOneWidget);
    expect(find.byKey(const Key('btn_open_cloud_sync')), findsOneWidget);

    // 2. Open full-screen `VaultCloudSyncScreen` and verify all 4 provider pills in Portrait & 915x412 Landscape
    await tester.tap(find.byKey(const Key('btn_open_cloud_sync')));
    await tester.pumpAndSettle();
    expect(find.byType(VaultCloudSyncScreen), findsOneWidget);
    expect(find.byKey(const Key('cloud_sync_provider_bar')), findsOneWidget);
    expect(find.byKey(const ValueKey('sync_provider_googleDrive')), findsOneWidget);
    expect(find.byKey(const ValueKey('sync_provider_sftp')), findsOneWidget);
    expect(find.byKey(const ValueKey('sync_provider_webdav')), findsOneWidget);
    expect(find.byKey(const ValueKey('sync_provider_githubGist')), findsOneWidget);
    expect(tester.takeException(), isNull);

    // Switch to Oppo Find X9 Pro Landscape (`915x412`) and verify zero overflow!
    tester.view.physicalSize = const Size(915, 412);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    // Test friendly Google OAuth SHA-1 diagnostic box when Android OAuth client isn't registered yet
    await tester.ensureVisible(find.byKey(const Key('btn_google_sync_signin')));
    await tester.tap(find.byKey(const Key('btn_google_sync_signin')));
    await tester.pumpAndSettle();
    expect(find.text('Google Cloud OAuth Setup Needed'), findsOneWidget);
    expect(find.text(kAndroidAppPackageName), findsOneWidget);
    expect(find.text(kAndroidUploadKeySha1), findsOneWidget);

    // Test SFTP Quick-Fill from Saved SSH / Jump Host
    await tester.ensureVisible(find.byKey(const ValueKey('sync_provider_sftp')));
    await tester.tap(find.byKey(const ValueKey('sync_provider_sftp')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dropdown_sftp_sync_preset')), findsOneWidget);
    await tester.tap(find.byKey(const Key('dropdown_sftp_sync_preset')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Saved Bastion Node').last);
    await tester.pumpAndSettle();
    final sftpHostField =
        tester.widget<TextField>(find.byKey(const Key('field_sync_sftp_host')));
    expect(sftpHostField.controller?.text, equals('192.168.50.10'));

    // Switch back to Portrait (`412x915`), bind loopback WebDAV endpoint & tap `Save & Sync Now`
    tester.view.physicalSize = const Size(412, 915);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const ValueKey('sync_provider_webdav')));
    await tester.tap(find.byKey(const ValueKey('sync_provider_webdav')));
    await tester.pumpAndSettle();

    final webdavVaultUrl =
        'http://127.0.0.1:${syncWebDavServer.port}/dav/jaladesk-vault.jvault';
    await tester.enterText(find.byKey(const Key('field_sync_webdav_url')), webdavVaultUrl);
    await tester.enterText(find.byKey(const Key('field_sync_webdav_user')), 'sync_ops');
    await tester.enterText(find.byKey(const Key('field_sync_webdav_password')), 'AppPass#1');
    await tester.ensureVisible(find.byKey(const Key('field_cloud_sync_passphrase')));
    await tester.enterText(find.byKey(const Key('field_cloud_sync_passphrase')), syncPass);
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.byKey(const Key('btn_execute_cloud_sync')));
    await tester.pumpAndSettle();
    final executeBtn =
        tester.widget<ButtonStyleButton>(find.byKey(const Key('btn_execute_cloud_sync')));
    await tester.runAsync(() async {
      executeBtn.onPressed!();
      for (int i = 0; i < 80 && !state.cloudSyncConfig.isBound; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pumpAndSettle();

    // Verify smart E2EE merge kept local Bastion AND pulled Cloud Synced Workstation!
    expect(state.cloudSyncConfig.isBound, isTrue);
    expect(state.hosts.any((h) => h.id == 'local-jump-gw-1'), isTrue);
    expect(state.hosts.any((h) => h.id == 'remote-synced-rdp-01'), isTrue);
    expect(find.textContaining('Synced 1 connection & 1 gateway'), findsOneWidget);
    expect(find.byKey(const Key('switch_cloud_auto_sync')), findsOneWidget);
    expect(find.byKey(const Key('btn_cloud_pull_only')), findsOneWidget);
    expect(find.byKey(const Key('btn_cloud_push_force')), findsOneWidget);
    expect(find.byKey(const Key('btn_cloud_unbind')), findsOneWidget);

    // Close `VaultCloudSyncScreen` and verify active badge + `btn_cloud_sync_now` on `Vault & 2FA`
    await tester.tap(find.byKey(const Key('btn_close_cloud_sync')));
    await tester.pumpAndSettle();
    expect(find.byType(VaultCloudSyncScreen), findsNothing);
    expect(find.textContaining('WebDAV • 127.0.0.1:${syncWebDavServer.port}'), findsOneWidget);
    expect(find.byKey(const Key('btn_cloud_sync_now')), findsOneWidget);

    final quickSyncBtn =
        tester.widget<IconButton>(find.byKey(const Key('btn_cloud_sync_now')));
    await tester.runAsync(() async {
      quickSyncBtn.onPressed!();
      await Future<void>.delayed(const Duration(milliseconds: 80));
      for (int i = 0; i < 80 && state.isCloudSyncBusy; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pumpAndSettle();

    // Re-open Manage -> Unbind Sync -> verify local hosts remain untouched
    await tester.tap(find.byKey(const Key('btn_open_cloud_sync')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('btn_cloud_unbind')));
    final unbindBtn =
        tester.widget<ButtonStyleButton>(find.byKey(const Key('btn_cloud_unbind')));
    await tester.runAsync(() async {
      unbindBtn.onPressed!();
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pumpAndSettle();
    expect(state.cloudSyncConfig.isBound, isFalse);
    expect(state.hosts.length, equals(2));
    expect(tester.takeException(), isNull);
  });
}

class _MockGoogleAuthTokenProvider implements GoogleAuthTokenProvider {
  final String initialToken;
  final String refreshedToken;
  final VoidCallback? onRefreshed;
  final bool throwOAuthSetupOnSignIn;
  bool _wasRefreshed = false;
  GoogleAuthAccountInfo? _account;

  _MockGoogleAuthTokenProvider({
    this.initialToken = 'mock-token',
    this.refreshedToken = 'mock-refreshed-token',
    this.onRefreshed,
    this.throwOAuthSetupOnSignIn = false,
  }) : _account = throwOAuthSetupOnSignIn
            ? null
            : const GoogleAuthAccountInfo(
                email: 'ops@jaladesk.io',
                displayName: 'JalaDesk Ops',
              );

  @override
  GoogleAuthAccountInfo? get currentAccount => _account;

  @override
  Future<GoogleAuthAccountInfo?> signIn() async {
    if (throwOAuthSetupOnSignIn) {
      throw const GoogleOAuthConfigurationException(
        rawDetail: 'PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10, null, null)',
      );
    }
    _account = const GoogleAuthAccountInfo(
      email: 'ops@jaladesk.io',
      displayName: 'JalaDesk Ops',
    );
    return _account;
  }

  @override
  Future<GoogleAuthAccountInfo?> signInSilently() async => _account;

  @override
  Future<void> signOut() async {
    _account = null;
  }

  @override
  Future<String> getAccessToken({bool forceRefresh = false}) async {
    if (forceRefresh) {
      _wasRefreshed = true;
      onRefreshed?.call();
    }
    return _wasRefreshed ? refreshedToken : initialToken;
  }
}
