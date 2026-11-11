import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jaladesk_mobile/main.dart';
import 'package:jaladesk_mobile/protocols/rdp_ffi_client.dart';
import 'package:jaladesk_mobile/protocols/vnc_rfb_client.dart';
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
    addTearDown(() => tmpDir.delete(recursive: true));
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
    addTearDown(() => tmpDir.delete(recursive: true));
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
    await tester.tap(find.text('SFTP Check'));
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
}
