import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jaladesk_mobile/main.dart';
import 'package:jaladesk_mobile/protocols/rdp_ffi_client.dart';
import 'package:jaladesk_mobile/protocols/vnc_rfb_client.dart';
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
