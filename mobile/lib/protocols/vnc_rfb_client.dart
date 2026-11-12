import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/export.dart' as pc;

/// Pure-Dart RFC 6143 DES-ECB / DES-CBC implementation for VNC Authentication (Security Type 2 & MSLogonII)
/// Note: VNC reverses the bit order of each byte in the 8-byte password key.
class VncDesAuth {
  static const List<int> _ip = [
    58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
    62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
    57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7
  ];

  static const List<int> _fp = [
    40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
    38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
    36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
    34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25
  ];

  static const List<int> _pc1 = [
    57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
    10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
    63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
    14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4
  ];

  static const List<int> _pc2 = [
    14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
    23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
    41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
    44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
  ];

  static const List<int> _shifts = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

  static const List<int> _e = [
    32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
    8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
    16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
    24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
  ];

  static const List<int> _p = [
    16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
    2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
  ];

  static const List<List<int>> _sBoxes = [
    [
      14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
      0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
      4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
      15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13
    ],
    [
      15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
      3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
      0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
      13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9
    ],
    [
      10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
      13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
      13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
      1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12
    ],
    [
      7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
      13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
      10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
      3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14
    ],
    [
      2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
      14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
      4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
      11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3
    ],
    [
      12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
      10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
      9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
      4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13
    ],
    [
      4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
      13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
      1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
      6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12
    ],
    [
      13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
      1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
      7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
      2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11
    ]
  ];

  static int _reverseByteBits(int b) {
    int r = 0;
    for (int i = 0; i < 8; i++) {
      if ((b & (1 << i)) != 0) {
        r |= (1 << (7 - i));
      }
    }
    return r;
  }

  static List<int> _bytesToBits(Uint8List bytes) {
    final bits = List<int>.filled(bytes.length * 8, 0);
    for (int i = 0; i < bytes.length; i++) {
      for (int bit = 0; bit < 8; bit++) {
        bits[i * 8 + bit] = (bytes[i] >> (7 - bit)) & 1;
      }
    }
    return bits;
  }

  static Uint8List _bitsToBytes(List<int> bits) {
    final out = Uint8List(bits.length ~/ 8);
    for (int i = 0; i < out.length; i++) {
      int v = 0;
      for (int bit = 0; bit < 8; bit++) {
        v = (v << 1) | bits[i * 8 + bit];
      }
      out[i] = v;
    }
    return out;
  }

  static List<List<int>> _buildSubkeysFromReversedBytes(Uint8List rawKey8) {
    final keyBytes = Uint8List(8);
    for (int i = 0; i < 8; i++) {
      keyBytes[i] = i < rawKey8.length ? _reverseByteBits(rawKey8[i]) : 0;
    }
    final keyBits = _bytesToBits(keyBytes);
    final cd = List<int>.generate(56, (i) => keyBits[_pc1[i] - 1]);
    var c = cd.sublist(0, 28);
    var d = cd.sublist(28, 56);
    final subkeys = <List<int>>[];
    for (int round = 0; round < 16; round++) {
      final s = _shifts[round];
      c = [...c.sublist(s), ...c.sublist(0, s)];
      d = [...d.sublist(s), ...d.sublist(0, s)];
      final combined = [...c, ...d];
      subkeys.add(List<int>.generate(48, (i) => combined[_pc2[i] - 1]));
    }
    return subkeys;
  }

  static Uint8List _encryptBlock8(Uint8List block8, List<List<int>> subkeys) {
    final blockBits = _bytesToBits(block8);
    final perm = List<int>.generate(64, (i) => blockBits[_ip[i] - 1]);
    var l = perm.sublist(0, 32);
    var r = perm.sublist(32, 64);

    for (int round = 0; round < 16; round++) {
      final expanded = List<int>.generate(48, (i) => r[_e[i] - 1]);
      final xored = List<int>.generate(48, (i) => expanded[i] ^ subkeys[round][i]);
      final sOut = <int>[];
      for (int box = 0; box < 8; box++) {
        final off = box * 6;
        final row = (xored[off] << 1) | xored[off + 5];
        final col = (xored[off + 1] << 3) |
            (xored[off + 2] << 2) |
            (xored[off + 3] << 1) |
            xored[off + 4];
        final val = _sBoxes[box][row * 16 + col];
        sOut.add((val >> 3) & 1);
        sOut.add((val >> 2) & 1);
        sOut.add((val >> 1) & 1);
        sOut.add(val & 1);
      }
      final pOut = List<int>.generate(32, (i) => sOut[_p[i] - 1]);
      final nextR = List<int>.generate(32, (i) => l[i] ^ pOut[i]);
      l = r;
      r = nextR;
    }

    final preOut = [...r, ...l];
    final finalBits = List<int>.generate(64, (i) => preOut[_fp[i] - 1]);
    return _bitsToBytes(finalBits);
  }

  static Uint8List encryptVncChallenge(Uint8List challenge16, String password) {
    final rawPw = Uint8List.fromList(utf8.encode(password));
    final subkeys = _buildSubkeysFromReversedBytes(rawPw);
    final out = Uint8List(16);
    out.setRange(0, 8, _encryptBlock8(challenge16.sublist(0, 8), subkeys));
    out.setRange(8, 16, _encryptBlock8(challenge16.sublist(8, 16), subkeys));
    return out;
  }

  /// VNC reversed-bit DES-CBC encryption for UltraVNC MSLogonII (Security Type 113)
  static Uint8List encryptVncDesCbc(Uint8List data, Uint8List key8, Uint8List iv8) {
    final subkeys = _buildSubkeysFromReversedBytes(key8);
    final out = Uint8List(data.length);
    var prev = Uint8List.fromList(iv8.sublist(0, 8));
    for (int off = 0; off < data.length; off += 8) {
      final blk = Uint8List(8);
      for (int i = 0; i < 8; i++) {
        blk[i] = data[off + i] ^ prev[i];
      }
      final enc = _encryptBlock8(blk, subkeys);
      out.setRange(off, off + 8, enc);
      prev = enc;
    }
    return out;
  }
}

/// Apple Remote Desktop / macOS Screen Sharing Authentication (RFB Security Type 30)
/// Uses Diffie-Hellman key exchange -> MD5(sharedSecret) -> AES-128-ECB of [user\0+pad(64) | pass\0+pad(64)].
class VncAppleArdAuth {
  static BigInt bytesToBigInt(Uint8List bytes) {
    BigInt result = BigInt.zero;
    for (final b in bytes) {
      result = (result << 8) | BigInt.from(b);
    }
    return result;
  }

  static Uint8List bigIntToFixedBytes(BigInt value, int length) {
    final out = Uint8List(length);
    var v = value;
    for (int i = length - 1; i >= 0; i--) {
      out[i] = (v & BigInt.from(0xFF)).toInt();
      v = v >> 8;
    }
    return out;
  }

  static ({Uint8List encryptedCredentials, Uint8List clientPublicKey}) computeArdResponse({
    required int generator,
    required int keySize,
    required Uint8List primeModulus,
    required Uint8List serverPublicKey,
    required String username,
    required String password,
    Uint8List? deterministicPrivateKey,
  }) {
    if (keySize < 16 || keySize > 1024) {
      throw SocketException('Unsupported ARD Diffie-Hellman key length: $keySize');
    }
    final rng = Random.secure();
    final p = bytesToBigInt(primeModulus);
    final g = BigInt.from(generator);
    final peerPub = bytesToBigInt(serverPublicKey);

    BigInt priv;
    if (deterministicPrivateKey != null) {
      priv = bytesToBigInt(deterministicPrivateKey);
    } else {
      final randBytes = Uint8List.fromList(List<int>.generate(keySize, (_) => rng.nextInt(256)));
      randBytes[0] &= 0x7F;
      priv = bytesToBigInt(randBytes);
      if (p > BigInt.from(4)) {
        priv = (priv % (p - BigInt.from(3))) + BigInt.two;
      }
    }

    final clientPub = g.modPow(priv, p);
    final sharedSecret = peerPub.modPow(priv, p);

    final clientPubBytes = bigIntToFixedBytes(clientPub, keySize);
    final sharedSecretBytes = bigIntToFixedBytes(sharedSecret, keySize);

    // Derive 128-bit AES key via MD5(sharedSecretBytes)
    final aesKey = Uint8List.fromList(crypto.md5.convert(sharedSecretBytes).bytes);

    // Format 128-byte credentials block: [username\0 + random (64B) | password\0 + random (64B)]
    final plain = Uint8List(128);
    for (int i = 0; i < 128; i++) {
      plain[i] = rng.nextInt(256);
    }

    final userUtf8 = utf8.encode(username);
    final userCopyLen = min(userUtf8.length, 63);
    plain.setRange(0, userCopyLen, userUtf8);
    plain[userCopyLen] = 0;

    final passUtf8 = utf8.encode(password);
    final passCopyLen = min(passUtf8.length, 63);
    plain.setRange(64, 64 + passCopyLen, passUtf8);
    plain[64 + passCopyLen] = 0;

    // Encrypt 8 blocks of 16 bytes with AES-128-ECB
    final aes = pc.AESEngine()..init(true, pc.KeyParameter(aesKey));
    final encrypted = Uint8List(128);
    for (int off = 0; off < 128; off += 16) {
      aes.processBlock(plain, off, encrypted, off);
    }

    return (
      encryptedCredentials: encrypted,
      clientPublicKey: clientPubBytes,
    );
  }
}

/// Asynchronous buffered byte reader over a Dart TCP / TLS Socket
class SocketByteReader {
  final StreamSubscription<Uint8List> _sub;
  final BytesBuilder _buf = BytesBuilder(copy: false);
  Completer<void>? _waiter;
  bool _closed = false;
  Object? _error;

  SocketByteReader(Stream<Uint8List> socket)
      : _sub = socket.listen(
          (_) {},
        ) {
    _sub.onData((chunk) {
      _buf.add(chunk);
      if (_waiter != null && !_waiter!.isCompleted) {
        _waiter!.complete();
      }
    });
    _sub.onError((Object e) {
      _error = e;
      _closed = true;
      if (_waiter != null && !_waiter!.isCompleted) {
        _waiter!.completeError(e);
      }
    });
    _sub.onDone(() {
      _closed = true;
      if (_waiter != null && !_waiter!.isCompleted) {
        _waiter!.complete();
      }
    });
  }

  Future<Uint8List> readExact(int count, {Duration timeout = const Duration(seconds: 10)}) async {
    final deadline = DateTime.now().add(timeout);
    while (_buf.length < count) {
      if (_error != null) throw _error!;
      if (_closed) {
        throw const SocketException('Remote socket closed during read');
      }
      final remaining = deadline.difference(DateTime.now());
      if (remaining.isNegative) {
        throw TimeoutException('Timed out waiting for $count bytes');
      }
      _waiter = Completer<void>();
      await _waiter!.future.timeout(remaining);
    }
    final all = _buf.takeBytes();
    final head = Uint8List.sublistView(all, 0, count);
    final copy = Uint8List.fromList(head);
    if (all.length > count) {
      _buf.add(Uint8List.sublistView(all, count));
    }
    return copy;
  }

  Future<void> dispose() async {
    _closed = true;
    await _sub.cancel();
  }
}

class _VncAuthAttemptException implements Exception {
  final String message;
  final List<int> offeredTypes;
  final String serverBanner;

  const _VncAuthAttemptException({
    required this.message,
    required this.offeredTypes,
    required this.serverBanner,
  });

  @override
  String toString() => message;
}

/// Full RFC 6143 VNC Client Engine supporting:
/// - Apple Remote Desktop / macOS Screen Sharing (`SecType 30` DH + AES-128-ECB)
/// - VeNCrypt (`SecType 19` TLS / X509 / Plain / VNC Auth for TigerVNC, QEMU, Proxmox, GNOME)
/// - Tight Security (`SecType 16` for TightVNC / x11vnc)
/// - UltraVNC MSLogonII (`SecType 113` DH + DES-CBC)
/// - Standard VNC DES (`SecType 2`) & None (`SecType 1`)
class VncRfbClient {
  final String host;
  final int port;
  final String username;
  final String password;
  final int? initialTargetWidth;
  final int? initialTargetHeight;
  final void Function(ui.Image image, int width, int height, String status) onFrame;
  final void Function(String status, {bool isError}) onStatus;
  final void Function(int width, int height, bool supportsDynamicResize)? onDesktopGeometryChanged;
  final void Function(
    ui.Image? cursorImage,
    int width,
    int height,
    int hotX,
    int hotY,
    bool isHidden,
    bool isTextIBeam,
  )? onCursorChanged;

  Socket? _socket;
  SocketByteReader? _reader;
  bool _running = false;
  int width = 1024;
  int height = 768;
  bool supportsExtendedDesktopSize = false;
  int _primaryScreenId = 0;
  int _primaryScreenFlags = 0;
  bool _appliedInitialTargetSize = false;
  String desktopName = 'VNC Remote Desktop';
  String negotiatedAuthLabel = 'RFB 3.8';
  late Uint8List _rgbaBuffer;
  RawZLibFilter? _zlibFilter;
  RawZLibFilter? _zrleFilter;
  Timer? _initialFramePulse;
  bool _receivedAnyFrame = false;

  VncRfbClient({
    required this.host,
    required this.port,
    this.username = '',
    required this.password,
    this.initialTargetWidth,
    this.initialTargetHeight,
    required this.onFrame,
    required this.onStatus,
    this.onDesktopGeometryChanged,
    this.onCursorChanged,
  });

  /// Classifies whether an RGBA32 server cursor bitmap + hotspot represents a Text Input `I-Beam` (`I`) cursor.
  /// Cleanly distinguishes `I-Beam` from Top-Left Arrow (`↖`), Crosshair (`+`), Resize (`↔`/`↕`), and Hand cursors.
  static bool classifyIBeamCursor(Uint8List rgba, int w, int h, int hotX, int hotY) {
    if (w < 8 || h < 12 || rgba.length < w * h * 4) return false;
    if (hotX < w ~/ 4 || hotX > (w * 3) ~/ 4 || hotY < h ~/ 4 || hotY > (h * 3) ~/ 4) {
      return false;
    }
    final yStart = h ~/ 4;
    final yEnd = (h * 3) ~/ 4;
    if (yEnd <= yStart) return false;

    int centerOpaqueRows = 0;
    final xMin = max(0, hotX - 1);
    final xMax = min(w - 1, hotX + 1);
    for (int y = yStart; y <= yEnd; y++) {
      bool rowHasStem = false;
      for (int x = xMin; x <= xMax; x++) {
        if (rgba[(y * w + x) * 4 + 3] >= 96) {
          rowHasStem = true;
          break;
        }
      }
      if (rowHasStem) centerOpaqueRows++;
    }
    final totalMidRows = yEnd - yStart + 1;
    if (centerOpaqueRows / totalMidRows < 0.45) return false;

    final mid3Start = (h * 35) ~/ 100;
    final mid3End = (h * 65) ~/ 100;
    int outerChecked = 0;
    int outerOpaque = 0;
    for (int y = mid3Start; y <= mid3End; y++) {
      int rowOuterChecked = 0;
      int rowOuterOpaque = 0;
      for (int x = 0; x < w; x++) {
        if (x <= hotX - 4 || x >= hotX + 4) {
          outerChecked++;
          rowOuterChecked++;
          if (rgba[(y * w + x) * 4 + 3] >= 96) {
            outerOpaque++;
            rowOuterOpaque++;
          }
        }
      }
      if (rowOuterChecked > 0 && (rowOuterOpaque / rowOuterChecked) >= 0.35) {
        return false;
      }
    }
    if (outerChecked <= 0) return false;
    return (outerOpaque / outerChecked) < 0.15;
  }

  /// Decodes RFC 6143 `RichCursor (-239)` 32bpp BGRA pixels + 1-bit MSB-first transparency mask into RGBA32.
  static Uint8List decodeRichCursorRgba(Uint8List bgraBytes, Uint8List maskBytes, int rw, int rh) {
    final rgba = Uint8List(rw * rh * 4);
    final maskRowBytes = (rw + 7) ~/ 8;
    for (int y = 0; y < rh; y++) {
      final maskRowOff = y * maskRowBytes;
      for (int x = 0; x < rw; x++) {
        final sIdx = (y * rw + x) * 4;
        final dIdx = sIdx;
        final mIdx = maskRowOff + (x >> 3);
        final opaque = mIdx < maskBytes.length && ((maskBytes[mIdx] >> (7 - (x & 7))) & 1) != 0;
        if (opaque && sIdx + 2 < bgraBytes.length) {
          rgba[dIdx] = bgraBytes[sIdx + 2]; // R
          rgba[dIdx + 1] = bgraBytes[sIdx + 1]; // G
          rgba[dIdx + 2] = bgraBytes[sIdx]; // B
          rgba[dIdx + 3] = 255;
        }
      }
    }
    return rgba;
  }

  bool get isConnected => _running && _socket != null;

  static String describeSecurityType(int code) {
    switch (code) {
      case 1:
        return 'None (1)';
      case 2:
        return 'VNC DES (2)';
      case 16:
        return 'Tight (16)';
      case 18:
        return 'TLS (18)';
      case 19:
        return 'VeNCrypt (19)';
      case 30:
        return 'Apple Remote Desktop (30)';
      case 33:
      case 35:
      case 36:
        return 'Apple Screen Sharing ($code)';
      case 113:
        return 'UltraVNC MSLogonII (113)';
      default:
        return 'Type $code';
    }
  }

  Future<void> connect() async {
    try {
      await _connectOnce();
    } on _VncAuthAttemptException catch (firstErr) {
      // If macOS / hybrid server offered BOTH ARD (30) and classic VNC DES (2),
      // and the user entered a dedicated 8-char VNC password while also having a username saved,
      // automatically retry once forcing Classic VNC DES (SecType 2)!
      if (firstErr.offeredTypes.contains(30) &&
          firstErr.offeredTypes.contains(2) &&
          username.trim().isNotEmpty &&
          password.isNotEmpty) {
        await _cleanupSocket();
        try {
          await _connectOnce(forceSecurityType: 2);
          return;
        } on _VncAuthAttemptException catch (secondErr) {
          throw SocketException(_formatActionableAuthError(secondErr));
        }
      }
      throw SocketException(_formatActionableAuthError(firstErr));
    }
  }

  String _formatActionableAuthError(_VncAuthAttemptException err) {
    final offeredDesc = err.offeredTypes.map(describeSecurityType).join(', ');
    final hasApple = err.offeredTypes.contains(30) ||
        err.serverBanner.contains('003.889') ||
        err.offeredTypes.any((t) => t >= 30 && t <= 36);
    if (hasApple) {
      if (username.trim().isEmpty) {
        return '${err.message}\n\n'
            'macOS Screen Sharing detected ($offeredDesc). '
            'Edit this host and enter your Mac account Username + Password (ARD), '
            'or enable "VNC viewers may control screen with password" in macOS Sharing > Screen Sharing > Computer Settings.';
      }
      return '${err.message}\n\n'
          'macOS Screen Sharing ($offeredDesc): Verify your Mac login username ("$username") '
          'and password, and ensure "$username" is allowed under System Settings > General > Sharing > Screen Sharing.';
    }
    return '${err.message}\n\n'
        'Server ${err.serverBanner} offered [$offeredDesc]. '
        'Note: Classic Linux/Windows VNC servers (TigerVNC, TightVNC, x11vnc) authenticate against '
        'your VNC password (first 8 chars set via vncpasswd), which may differ from your OS/SSH password.';
  }

  Future<void> _connectOnce({int? forceSecurityType}) async {
    onStatus('Connecting TCP socket to $host:$port...');
    Socket sock = await Socket.connect(host, port, timeout: const Duration(seconds: 8));
    sock.setOption(SocketOption.tcpNoDelay, true);
    _socket = sock;
    SocketByteReader reader = SocketByteReader(sock);
    _reader = reader;

    // 1. Read Server ProtocolVersion (12 bytes: "RFB xxx.yyy\n", e.g., "RFB 003.008\n" or macOS "RFB 003.889\n")
    final verBytes = await reader.readExact(12);
    final verStr = ascii.decode(verBytes, allowInvalid: true).trim();
    if (!verStr.startsWith('RFB ')) {
      throw SocketException('Invalid VNC RFB banner: $verStr');
    }
    final is33 = verStr.contains('003.003');
    final is37 = verStr.contains('003.007');
    sock.add(ascii.encode(is33 ? 'RFB 003.003\n' : (is37 ? 'RFB 003.007\n' : 'RFB 003.008\n')));
    await sock.flush();

    // 2. Negotiate Security Type
    int chosenSec = 1;
    List<int> offeredTypes = <int>[];
    if (is33) {
      final secBuf = await reader.readExact(4);
      chosenSec = ByteData.sublistView(secBuf).getUint32(0, Endian.big);
      if (chosenSec == 0) {
        final lenBuf = await reader.readExact(4);
        final reasonLen = ByteData.sublistView(lenBuf).getUint32(0, Endian.big);
        final reason = utf8.decode(await reader.readExact(reasonLen), allowMalformed: true);
        throw SocketException('VNC connection refused: $reason');
      }
      offeredTypes = [chosenSec];
    } else {
      final countBuf = await reader.readExact(1);
      final count = countBuf[0];
      if (count == 0) {
        final lenBuf = await reader.readExact(4);
        final reasonLen = ByteData.sublistView(lenBuf).getUint32(0, Endian.big);
        final reason = utf8.decode(await reader.readExact(reasonLen), allowMalformed: true);
        throw SocketException('VNC security failed: $reason');
      }
      offeredTypes = (await reader.readExact(count)).toList();

      if (forceSecurityType != null && offeredTypes.contains(forceSecurityType)) {
        chosenSec = forceSecurityType;
      } else if (offeredTypes.contains(30) && username.trim().isNotEmpty) {
        chosenSec = 30; // Apple Remote Desktop (macOS Screen Sharing username + password)
      } else if (offeredTypes.contains(19)) {
        chosenSec = 19; // VeNCrypt (TigerVNC / QEMU / GNOME / WayVNC)
      } else if (offeredTypes.contains(1) && password.isEmpty) {
        chosenSec = 1; // None
      } else if (offeredTypes.contains(2)) {
        chosenSec = 2; // Classic VNC Auth (DES)
      } else if (offeredTypes.contains(16)) {
        chosenSec = 16; // TightVNC
      } else if (offeredTypes.contains(113) && username.trim().isNotEmpty) {
        chosenSec = 113; // UltraVNC MSLogonII
      } else if (offeredTypes.contains(30)) {
        chosenSec = 30;
      } else if (offeredTypes.contains(1)) {
        chosenSec = 1;
      } else {
        final names = offeredTypes.map(describeSecurityType).join(', ');
        throw SocketException('Unsupported VNC security types offered by server: [$names]');
      }
      sock.add([chosenSec]);
      await sock.flush();
    }

    negotiatedAuthLabel = describeSecurityType(chosenSec);
    bool checkSecurityResult = !is33 && (chosenSec != 1 || !is37);

    if (chosenSec == 30) {
      // Apple Remote Desktop Diffie-Hellman + AES-128-ECB
      if (username.trim().isEmpty) {
        throw _VncAuthAttemptException(
          message: 'VNC Authentication requires a Username for Apple Remote Desktop (Security Type 30).',
          offeredTypes: offeredTypes,
          serverBanner: verStr,
        );
      }
      onStatus('Authenticating macOS Screen Sharing (ARD DH-AES128)...');
      final dhHdr = await reader.readExact(4);
      final dhBd = ByteData.sublistView(dhHdr);
      final generator = dhBd.getUint16(0, Endian.big);
      final keySize = dhBd.getUint16(2, Endian.big);
      final primeModulus = await reader.readExact(keySize);
      final serverPubKey = await reader.readExact(keySize);

      final ard = VncAppleArdAuth.computeArdResponse(
        generator: generator,
        keySize: keySize,
        primeModulus: primeModulus,
        serverPublicKey: serverPubKey,
        username: username.trim(),
        password: password,
      );
      sock.add(ard.encryptedCredentials);
      sock.add(ard.clientPublicKey);
      await sock.flush();
      checkSecurityResult = true;
    } else if (chosenSec == 2) {
      onStatus('Authenticating VNC DES challenge...');
      final challenge = await reader.readExact(16);
      final response = VncDesAuth.encryptVncChallenge(challenge, password);
      sock.add(response);
      await sock.flush();
      checkSecurityResult = !is33;
    } else if (chosenSec == 19) {
      // VeNCrypt 0.2 negotiation
      onStatus('Negotiating VeNCrypt TLS security...');
      final vVer = await reader.readExact(2);
      if (vVer[0] == 0 && vVer[1] >= 2) {
        sock.add([0, 2]);
      } else {
        sock.add([vVer[0], vVer[1]]);
      }
      await sock.flush();
      final ack = (await reader.readExact(1))[0];
      if (ack != 0) {
        throw SocketException('VeNCrypt version negotiation rejected by server (ack=$ack).');
      }
      final subCount = (await reader.readExact(1))[0];
      if (subCount == 0) {
        throw const SocketException('Server offered zero VeNCrypt subtypes.');
      }
      final subRaw = await reader.readExact(subCount * 4);
      final subBd = ByteData.sublistView(subRaw);
      final subtypes = List<int>.generate(subCount, (i) => subBd.getUint32(i * 4, Endian.big));

      // Prefer TLS/X509 Plain when username is set, otherwise X509Vnc/TLSVnc, Plain, VNC, None
      const preferredWithUser = [262, 259, 261, 258, 256, 2, 260, 257, 1];
      const preferredNoUser = [261, 258, 262, 259, 2, 256, 260, 257, 1];
      final prefs = username.trim().isNotEmpty ? preferredWithUser : preferredNoUser;
      final selectedSub = prefs.firstWhere(
        subtypes.contains,
        orElse: () => subtypes.first,
      );

      final selBuf = ByteData(4)..setUint32(0, selectedSub, Endian.big);
      sock.add(selBuf.buffer.asUint8List());
      await sock.flush();

      final needsTls = {257, 258, 259, 260, 261, 262}.contains(selectedSub);
      if (needsTls) {
        final tlsAck = (await reader.readExact(1))[0];
        if (tlsAck != 1) {
          throw SocketException('VeNCrypt TLS setup rejected by server (ack=$tlsAck).');
        }
        await reader.dispose();
        final tlsSock = await SecureSocket.secure(
          sock,
          onBadCertificate: (_) => true,
        );
        sock = tlsSock;
        _socket = tlsSock;
        reader = SocketByteReader(tlsSock);
        _reader = reader;
      }

      if (selectedSub == 256 || selectedSub == 259 || selectedSub == 262) {
        // VeNCrypt Plain: U32 userLen + U32 passLen + user + pass
        final uBytes = utf8.encode(username.trim());
        final pBytes = utf8.encode(password);
        final hdr = ByteData(8)
          ..setUint32(0, uBytes.length, Endian.big)
          ..setUint32(4, pBytes.length, Endian.big);
        sock.add(hdr.buffer.asUint8List());
        sock.add(uBytes);
        sock.add(pBytes);
        await sock.flush();
      } else if (selectedSub == 2 || selectedSub == 258 || selectedSub == 261) {
        final challenge = await reader.readExact(16);
        final response = VncDesAuth.encryptVncChallenge(challenge, password);
        sock.add(response);
        await sock.flush();
      } else if (selectedSub != 1 && selectedSub != 257 && selectedSub != 260) {
        throw SocketException('Unsupported VeNCrypt subtype: $selectedSub');
      }
      checkSecurityResult = true;
    } else if (chosenSec == 16) {
      // Tight Security Type (16)
      onStatus('Negotiating TightVNC capabilities...');
      final nTunnels = ByteData.sublistView(await reader.readExact(4)).getUint32(0, Endian.big);
      if (nTunnels > 0) {
        await reader.readExact(nTunnels * 16);
        sock.add([0, 0, 0, 0]); // No tunnel
        await sock.flush();
      }
      final nAuth = ByteData.sublistView(await reader.readExact(4)).getUint32(0, Endian.big);
      if (nAuth == 0) {
        checkSecurityResult = false;
      } else {
        final capsBytes = await reader.readExact(nAuth * 16);
        final capsBd = ByteData.sublistView(capsBytes);
        final authCodes = List<int>.generate(nAuth, (i) => capsBd.getUint32(i * 16, Endian.big));
        final chosenTightAuth = authCodes.contains(2)
            ? 2
            : (authCodes.contains(1) ? 1 : authCodes.first);
        final authSel = ByteData(4)..setUint32(0, chosenTightAuth, Endian.big);
        sock.add(authSel.buffer.asUint8List());
        await sock.flush();
        if (chosenTightAuth == 2) {
          final challenge = await reader.readExact(16);
          sock.add(VncDesAuth.encryptVncChallenge(challenge, password));
          await sock.flush();
          checkSecurityResult = true;
        } else {
          checkSecurityResult = !is37;
        }
      }
    } else if (chosenSec == 113) {
      // UltraVNC MSLogonII (Diffie-Hellman 64-bit + VNC DES-CBC)
      onStatus('Authenticating UltraVNC MSLogonII...');
      final genBytes = await reader.readExact(8);
      final modBytes = await reader.readExact(8);
      final respBytes = await reader.readExact(8);
      final g = VncAppleArdAuth.bytesToBigInt(genBytes);
      final m = VncAppleArdAuth.bytesToBigInt(modBytes);
      final serverPub = VncAppleArdAuth.bytesToBigInt(respBytes);
      final rng = Random.secure();
      final priv = BigInt.from(rng.nextInt(0x7FFFFFFF) + 2);
      final clientPub = VncAppleArdAuth.bigIntToFixedBytes(g.modPow(priv, m), 8);
      final sharedKey = VncAppleArdAuth.bigIntToFixedBytes(serverPub.modPow(priv, m), 8);

      final userBlock = Uint8List.fromList(List<int>.generate(256, (_) => rng.nextInt(256)));
      final uUtf8 = utf8.encode(username.trim());
      final uLen = min(uUtf8.length, 255);
      userBlock.setRange(0, uLen, uUtf8);
      userBlock[uLen] = 0;

      final passBlock = Uint8List.fromList(List<int>.generate(64, (_) => rng.nextInt(256)));
      final pUtf8 = utf8.encode(password);
      final pLen = min(pUtf8.length, 63);
      passBlock.setRange(0, pLen, pUtf8);
      passBlock[pLen] = 0;

      final encUser = VncDesAuth.encryptVncDesCbc(userBlock, sharedKey, sharedKey);
      final encPass = VncDesAuth.encryptVncDesCbc(passBlock, sharedKey, sharedKey);
      sock.add(clientPub);
      sock.add(encUser);
      sock.add(encPass);
      await sock.flush();
      checkSecurityResult = true;
    }

    if (checkSecurityResult) {
      final resBuf = await reader.readExact(4);
      final secResult = ByteData.sublistView(resBuf).getUint32(0, Endian.big);
      if (secResult != 0) {
        String errMsg = secResult == 2
            ? 'VNC Authentication locked temporarily (too many attempts).'
            : 'VNC Authentication failed (invalid credentials).';
        if (!is37 && !is33) {
          try {
            final lenBuf = await reader.readExact(4, timeout: const Duration(milliseconds: 1200));
            final len = ByteData.sublistView(lenBuf).getUint32(0, Endian.big);
            if (len > 0 && len < 2048) {
              final serverReason =
                  utf8.decode(await reader.readExact(len), allowMalformed: true).trim();
              if (serverReason.isNotEmpty) {
                errMsg = 'VNC Authentication failed: $serverReason';
              }
            }
          } catch (_) {}
        }
        throw _VncAuthAttemptException(
          message: errMsg,
          offeredTypes: offeredTypes,
          serverBanner: verStr,
        );
      }
    }

    // 3. Send ClientInit (shared = 1)
    sock.add([1]);
    await sock.flush();

    // 4. Read ServerInit (24 bytes + nameLength)
    final initHeader = await reader.readExact(24);
    final bd = ByteData.sublistView(initHeader);
    width = bd.getUint16(0, Endian.big);
    height = bd.getUint16(2, Endian.big);
    final nameLen = bd.getUint32(20, Endian.big);
    if (nameLen > 0 && nameLen < 4096) {
      desktopName = utf8.decode(await reader.readExact(nameLen), allowMalformed: true);
    }

    _rgbaBuffer = Uint8List(width * height * 4);
    for (int i = 3; i < _rgbaBuffer.length; i += 4) {
      _rgbaBuffer[i] = 255;
    }
    _zlibFilter = RawZLibFilter.inflateFilter();
    _zrleFilter = RawZLibFilter.inflateFilter();
    _receivedAnyFrame = false;

    // 5. Send SetPixelFormat (msgType = 0):
    // Standard universal VNC 32bpp little-endian BGRA (depth 24, R@16, G@8, B@0)
    // Required for zero-quirk compatibility with macOS Screen Sharing (RFB 003.889), TigerVNC, TightVNC & UltraVNC.
    final setPf = ByteData(20);
    setPf.setUint8(0, 0);
    setPf.setUint8(4, 32);
    setPf.setUint8(5, 24);
    setPf.setUint8(6, 0); // little-endian
    setPf.setUint8(7, 1); // true-colour
    setPf.setUint16(8, 255, Endian.big);
    setPf.setUint16(10, 255, Endian.big);
    setPf.setUint16(12, 255, Endian.big);
    setPf.setUint8(14, 16); // redShift = 16 (byte 2)
    setPf.setUint8(15, 8); // greenShift = 8 (byte 1)
    setPf.setUint8(16, 0); // blueShift = 0 (byte 0)
    sock.add(setPf.buffer.asUint8List());

    // 6. Send SetEncodings (msgType = 2):
    // ZRLE (16), Zlib (6), Hextile (5), RRE (2), CopyRect (1), Raw (0),
    // ExtendedDesktopSize (-308), DesktopSize (-223), Cursor (-239), LastRect (-224)
    const encodings = <int>[16, 6, 5, 2, 1, 0, -308, -223, -239, -224];
    final setEnc = ByteData(4 + encodings.length * 4);
    setEnc.setUint8(0, 2);
    setEnc.setUint16(2, encodings.length, Endian.big);
    for (int i = 0; i < encodings.length; i++) {
      setEnc.setInt32(4 + i * 4, encodings[i], Endian.big);
    }
    sock.add(setEnc.buffer.asUint8List());

    supportsExtendedDesktopSize = false;
    _appliedInitialTargetSize = false;
    _running = true;
    onStatus('Connected to $desktopName (${width}x$height • ${describeSecurityType(chosenSec)})');
    _sendFramebufferUpdateRequest(incremental: false);
    await sock.flush();

    _initialFramePulse?.cancel();
    _initialFramePulse = Timer.periodic(const Duration(milliseconds: 850), (t) {
      if (!_running || _receivedAnyFrame || t.tick > 6) {
        t.cancel();
        return;
      }
      _sendFramebufferUpdateRequest(incremental: false);
    });

    unawaited(_receiveLoop());
  }

  void _sendFramebufferUpdateRequest({required bool incremental}) {
    final sock = _socket;
    if (sock == null || !_running) return;
    final req = ByteData(10);
    req.setUint8(0, 3);
    req.setUint8(1, incremental ? 1 : 0);
    req.setUint16(2, 0, Endian.big);
    req.setUint16(4, 0, Endian.big);
    req.setUint16(6, width, Endian.big);
    req.setUint16(8, height, Endian.big);
    try {
      sock.add(req.buffer.asUint8List());
    } catch (_) {}
  }

  Uint8List _inflateStateful(RawZLibFilter filter, Uint8List compressed) {
    if (compressed.isEmpty) return Uint8List(0);
    filter.process(compressed, 0, compressed.length);
    final out = BytesBuilder(copy: false);
    List<int>? chunk;
    while ((chunk = filter.processed(flush: true, end: false)) != null && chunk!.isNotEmpty) {
      out.add(chunk);
    }
    return out.takeBytes();
  }

  void _blitBgraPixels(int rx, int ry, int rw, int rh, Uint8List bgraBytes) {
    for (int row = 0; row < rh; row++) {
      final dstY = ry + row;
      if (dstY >= height) break;
      final srcOff = row * rw * 4;
      final dstOff = (dstY * width + rx) * 4;
      final copyPixels = (rx + rw <= width) ? rw : (width - rx);
      for (int col = 0; col < copyPixels; col++) {
        final sIdx = srcOff + col * 4;
        if (sIdx + 2 >= bgraBytes.length) return;
        final dIdx = dstOff + col * 4;
        _rgbaBuffer[dIdx] = bgraBytes[sIdx + 2]; // R
        _rgbaBuffer[dIdx + 1] = bgraBytes[sIdx + 1]; // G
        _rgbaBuffer[dIdx + 2] = bgraBytes[sIdx]; // B
        _rgbaBuffer[dIdx + 3] = 255;
      }
    }
  }

  void _fillSolidRect(int rx, int ry, int rw, int rh, int r, int g, int b) {
    final endY = (ry + rh <= height) ? (ry + rh) : height;
    final endX = (rx + rw <= width) ? (rx + rw) : width;
    for (int y = ry; y < endY; y++) {
      int dIdx = (y * width + rx) * 4;
      for (int x = rx; x < endX; x++) {
        _rgbaBuffer[dIdx] = r;
        _rgbaBuffer[dIdx + 1] = g;
        _rgbaBuffer[dIdx + 2] = b;
        _rgbaBuffer[dIdx + 3] = 255;
        dIdx += 4;
      }
    }
  }

  void _decodeZrleRect(int rx, int ry, int rw, int rh, Uint8List data) {
    int pos = 0;
    final palR = Uint8List(128);
    final palG = Uint8List(128);
    final palB = Uint8List(128);

    for (int ty = 0; ty < rh; ty += 64) {
      final th = (ty + 64 <= rh) ? 64 : (rh - ty);
      for (int tx = 0; tx < rw; tx += 64) {
        final tw = (tx + 64 <= rw) ? 64 : (rw - tx);
        if (pos >= data.length) return;
        final sub = data[pos++];

        if (sub == 0) {
          // Raw 3-byte CPIXELs ([B, G, R])
          for (int y = 0; y < th; y++) {
            final dy = ry + ty + y;
            for (int x = 0; x < tw; x++) {
              if (pos + 2 >= data.length) return;
              final b = data[pos++];
              final g = data[pos++];
              final r = data[pos++];
              final dx = rx + tx + x;
              if (dx < width && dy < height) {
                final dIdx = (dy * width + dx) * 4;
                _rgbaBuffer[dIdx] = r;
                _rgbaBuffer[dIdx + 1] = g;
                _rgbaBuffer[dIdx + 2] = b;
                _rgbaBuffer[dIdx + 3] = 255;
              }
            }
          }
        } else if (sub == 1) {
          // Solid tile (1 CPIXEL)
          if (pos + 2 >= data.length) return;
          final b = data[pos++];
          final g = data[pos++];
          final r = data[pos++];
          _fillSolidRect(rx + tx, ry + ty, tw, th, r, g, b);
        } else if (sub >= 2 && sub <= 16) {
          // Packed palette tile
          final palSize = sub;
          for (int p = 0; p < palSize; p++) {
            if (pos + 2 >= data.length) return;
            palB[p] = data[pos++];
            palG[p] = data[pos++];
            palR[p] = data[pos++];
          }
          final bpp = palSize == 2 ? 1 : (palSize <= 4 ? 2 : 4);
          final mask = (1 << bpp) - 1;
          for (int y = 0; y < th; y++) {
            final dy = ry + ty + y;
            int shift = 0;
            int currentByte = 0;
            for (int x = 0; x < tw; x++) {
              if (shift == 0) {
                if (pos >= data.length) return;
                currentByte = data[pos++];
                shift = 8;
              }
              shift -= bpp;
              final idx = (currentByte >> shift) & mask;
              final dx = rx + tx + x;
              if (dx < width && dy < height && idx < palSize) {
                final dIdx = (dy * width + dx) * 4;
                _rgbaBuffer[dIdx] = palR[idx];
                _rgbaBuffer[dIdx + 1] = palG[idx];
                _rgbaBuffer[dIdx + 2] = palB[idx];
                _rgbaBuffer[dIdx + 3] = 255;
              }
            }
          }
        } else if (sub == 128) {
          // Plain RLE
          int pixDone = 0;
          final totalPix = tw * th;
          while (pixDone < totalPix) {
            if (pos + 2 >= data.length) return;
            final b = data[pos++];
            final g = data[pos++];
            final r = data[pos++];
            int runLen = 1;
            int rb;
            do {
              if (pos >= data.length) return;
              rb = data[pos++];
              runLen += rb;
            } while (rb == 255);
            for (int k = 0; k < runLen && pixDone < totalPix; k++, pixDone++) {
              final dx = rx + tx + (pixDone % tw);
              final dy = ry + ty + (pixDone ~/ tw);
              if (dx < width && dy < height) {
                final dIdx = (dy * width + dx) * 4;
                _rgbaBuffer[dIdx] = r;
                _rgbaBuffer[dIdx + 1] = g;
                _rgbaBuffer[dIdx + 2] = b;
                _rgbaBuffer[dIdx + 3] = 255;
              }
            }
          }
        } else if (sub >= 130) {
          // Palette RLE
          final palSize = sub - 128;
          for (int p = 0; p < palSize; p++) {
            if (pos + 2 >= data.length) return;
            palB[p] = data[pos++];
            palG[p] = data[pos++];
            palR[p] = data[pos++];
          }
          int pixDone = 0;
          final totalPix = tw * th;
          while (pixDone < totalPix) {
            if (pos >= data.length) return;
            final code = data[pos++];
            final palIdx = code & 0x7F;
            int runLen = 1;
            if ((code & 0x80) != 0) {
              int rb;
              do {
                if (pos >= data.length) return;
                rb = data[pos++];
                runLen += rb;
              } while (rb == 255);
            }
            final r = palIdx < palSize ? palR[palIdx] : 0;
            final g = palIdx < palSize ? palG[palIdx] : 0;
            final b = palIdx < palSize ? palB[palIdx] : 0;
            for (int k = 0; k < runLen && pixDone < totalPix; k++, pixDone++) {
              final dx = rx + tx + (pixDone % tw);
              final dy = ry + ty + (pixDone ~/ tw);
              if (dx < width && dy < height) {
                final dIdx = (dy * width + dx) * 4;
                _rgbaBuffer[dIdx] = r;
                _rgbaBuffer[dIdx + 1] = g;
                _rgbaBuffer[dIdx + 2] = b;
                _rgbaBuffer[dIdx + 3] = 255;
              }
            }
          }
        }
      }
    }
  }

  Future<void> _receiveLoop() async {
    final reader = _reader;
    if (reader == null) return;
    try {
      while (_running) {
        final msgTypeBuf = await reader.readExact(1, timeout: const Duration(seconds: 60));
        final msgType = msgTypeBuf[0];
        if (msgType == 0) {
          final hdr = await reader.readExact(3);
          final numRects = ByteData.sublistView(hdr).getUint16(1, Endian.big);
          bool drewPixels = false;
          for (int r = 0; r < numRects; r++) {
            final rectHdr = await reader.readExact(12);
            final rbd = ByteData.sublistView(rectHdr);
            final rx = rbd.getUint16(0, Endian.big);
            final ry = rbd.getUint16(2, Endian.big);
            final rw = rbd.getUint16(4, Endian.big);
            final rh = rbd.getUint16(6, Endian.big);
            final encoding = rbd.getInt32(8, Endian.big);

            if (encoding == -224) {
              // LastRect pseudo-encoding
              break;
            } else if (encoding == -308) {
              // ExtendedDesktopSize pseudo-encoding (TigerVNC / RealVNC / TightVNC / x11vnc / KasmVNC / GNOME)
              final extHdr = await reader.readExact(4);
              final numScreens = extHdr[0];
              if (numScreens > 0) {
                final screensBuf = await reader.readExact(numScreens * 16);
                final sbd = ByteData.sublistView(screensBuf);
                _primaryScreenId = sbd.getUint32(0, Endian.big);
                _primaryScreenFlags = sbd.getUint32(12, Endian.big);
              }
              supportsExtendedDesktopSize = true;
              // rx = reason (0=server layout, 1=client requested), ry = status (0=no error)
              if ((ry == 0 || rx == 0) && rw > 0 && rh > 0 && (rw != width || rh != height)) {
                width = rw;
                height = rh;
                _rgbaBuffer = Uint8List(width * height * 4);
                for (int i = 3; i < _rgbaBuffer.length; i += 4) {
                  _rgbaBuffer[i] = 255;
                }
                _sendFramebufferUpdateRequest(incremental: false);
              }
              onDesktopGeometryChanged?.call(width, height, true);
              if (!_appliedInitialTargetSize &&
                  initialTargetWidth != null &&
                  initialTargetHeight != null) {
                _appliedInitialTargetSize = true;
                requestResolution(initialTargetWidth!, initialTargetHeight!);
              }
              continue;
            } else if (encoding == -223) {
              // DesktopSize pseudo-encoding
              if (rw > 0 && rh > 0 && (rw != width || rh != height)) {
                width = rw;
                height = rh;
                _rgbaBuffer = Uint8List(width * height * 4);
                for (int i = 3; i < _rgbaBuffer.length; i += 4) {
                  _rgbaBuffer[i] = 255;
                }
                _sendFramebufferUpdateRequest(incremental: false);
                onDesktopGeometryChanged?.call(width, height, supportsExtendedDesktopSize);
              }
              continue;
            } else if (encoding == -239) {
              // Cursor / RichCursor pseudo-encoding (RFC 6143 Section 7.8.1)
              if (rw <= 0 || rh <= 0) {
                onCursorChanged?.call(null, 0, 0, 0, 0, true, false);
              } else {
                final pixLen = rw * rh * 4;
                final maskLen = ((rw + 7) ~/ 8) * rh;
                final bgraBytes = await reader.readExact(pixLen);
                final maskBytes = await reader.readExact(maskLen);
                final cursorCb = onCursorChanged;
                if (cursorCb != null && rw <= 384 && rh <= 384) {
                  bool anyOpaque = false;
                  for (int i = 0; i < maskBytes.length; i++) {
                    if (maskBytes[i] != 0) {
                      anyOpaque = true;
                      break;
                    }
                  }
                  if (!anyOpaque) {
                    cursorCb(null, rw, rh, 0, 0, true, false);
                  } else {
                    final hotX = rx.clamp(0, rw - 1);
                    final hotY = ry.clamp(0, rh - 1);
                    final rgba = decodeRichCursorRgba(bgraBytes, maskBytes, rw, rh);
                    final isIBeam = classifyIBeamCursor(rgba, rw, rh, hotX, hotY);
                    final c = Completer<ui.Image>();
                    ui.decodeImageFromPixels(rgba, rw, rh, ui.PixelFormat.rgba8888, c.complete);
                    final cursorImg = await c.future;
                    if (_running) {
                      cursorCb(cursorImg, rw, rh, hotX, hotY, false, isIBeam);
                    }
                  }
                }
              }
              continue;
            } else if (encoding == 0) {
              // Raw (32bpp BGRA)
              if (rw > 0 && rh > 0) {
                final rawBytes = await reader.readExact(rw * rh * 4);
                _blitBgraPixels(rx, ry, rw, rh, rawBytes);
                drewPixels = true;
              }
            } else if (encoding == 1) {
              // CopyRect
              final cpBytes = await reader.readExact(4);
              final cpBd = ByteData.sublistView(cpBytes);
              final srcX = cpBd.getUint16(0, Endian.big);
              final srcY = cpBd.getUint16(2, Endian.big);
              final temp = Uint8List(rw * rh * 4);
              for (int row = 0; row < rh; row++) {
                final sy = srcY + row;
                if (sy >= height) break;
                for (int col = 0; col < rw; col++) {
                  final sx = srcX + col;
                  if (sx >= width) break;
                  final sIdx = (sy * width + sx) * 4;
                  final tIdx = (row * rw + col) * 4;
                  temp[tIdx] = _rgbaBuffer[sIdx];
                  temp[tIdx + 1] = _rgbaBuffer[sIdx + 1];
                  temp[tIdx + 2] = _rgbaBuffer[sIdx + 2];
                  temp[tIdx + 3] = 255;
                }
              }
              for (int row = 0; row < rh; row++) {
                final dy = ry + row;
                if (dy >= height) break;
                for (int col = 0; col < rw; col++) {
                  final dx = rx + col;
                  if (dx >= width) break;
                  final dIdx = (dy * width + dx) * 4;
                  final tIdx = (row * rw + col) * 4;
                  _rgbaBuffer[dIdx] = temp[tIdx];
                  _rgbaBuffer[dIdx + 1] = temp[tIdx + 1];
                  _rgbaBuffer[dIdx + 2] = temp[tIdx + 2];
                  _rgbaBuffer[dIdx + 3] = 255;
                }
              }
              drewPixels = true;
            } else if (encoding == 2) {
              // RRE (Rise-and-Run-length Encoding)
              final rreHdr = await reader.readExact(8);
              final numSub = ByteData.sublistView(rreHdr).getUint32(0, Endian.big);
              _fillSolidRect(rx, ry, rw, rh, rreHdr[6], rreHdr[5], rreHdr[4]);
              if (numSub > 0 && numSub < 262144) {
                final subBuf = await reader.readExact(numSub * 12);
                final sbd = ByteData.sublistView(subBuf);
                for (int s = 0; s < numSub; s++) {
                  final base = s * 12;
                  final sr = subBuf[base + 2];
                  final sg = subBuf[base + 1];
                  final sb = subBuf[base];
                  final sx = sbd.getUint16(base + 4, Endian.big);
                  final sy = sbd.getUint16(base + 6, Endian.big);
                  final sw = sbd.getUint16(base + 8, Endian.big);
                  final sh = sbd.getUint16(base + 10, Endian.big);
                  _fillSolidRect(rx + sx, ry + sy, sw, sh, sr, sg, sb);
                }
              }
              drewPixels = true;
            } else if (encoding == 5) {
              // Hextile (RFC 6143 Section 7.7.4)
              int bgR = 0, bgG = 0, bgB = 0;
              int fgR = 255, fgG = 255, fgB = 255;
              for (int ty = 0; ty < rh; ty += 16) {
                final th = (ty + 16 <= rh) ? 16 : (rh - ty);
                for (int tx = 0; tx < rw; tx += 16) {
                  final tw = (tx + 16 <= rw) ? 16 : (rw - tx);
                  final subMask = (await reader.readExact(1))[0];
                  if ((subMask & 0x01) != 0) {
                    final tileRaw = await reader.readExact(tw * th * 4);
                    _blitBgraPixels(rx + tx, ry + ty, tw, th, tileRaw);
                    continue;
                  }
                  if ((subMask & 0x02) != 0) {
                    final bgPx = await reader.readExact(4);
                    bgB = bgPx[0];
                    bgG = bgPx[1];
                    bgR = bgPx[2];
                  }
                  _fillSolidRect(rx + tx, ry + ty, tw, th, bgR, bgG, bgB);
                  if ((subMask & 0x04) != 0) {
                    final fgPx = await reader.readExact(4);
                    fgB = fgPx[0];
                    fgG = fgPx[1];
                    fgR = fgPx[2];
                  }
                  if ((subMask & 0x08) != 0) {
                    final nSub = (await reader.readExact(1))[0];
                    final coloured = (subMask & 0x10) != 0;
                    final perSub = coloured ? 6 : 2;
                    final subData = await reader.readExact(nSub * perSub);
                    for (int s = 0; s < nSub; s++) {
                      final off = s * perSub;
                      final sr = coloured ? subData[off + 2] : fgR;
                      final sg = coloured ? subData[off + 1] : fgG;
                      final sb = coloured ? subData[off] : fgB;
                      final xy = subData[off + (coloured ? 4 : 0)];
                      final wh = subData[off + (coloured ? 5 : 1)];
                      final sx = (xy >> 4) & 0x0F;
                      final sy = xy & 0x0F;
                      final sw = ((wh >> 4) & 0x0F) + 1;
                      final sh = (wh & 0x0F) + 1;
                      _fillSolidRect(rx + tx + sx, ry + ty + sy, sw, sh, sr, sg, sb);
                    }
                  }
                }
              }
              drewPixels = true;
            } else if (encoding == 6) {
              // Zlib (stateful stream)
              final zLenBuf = await reader.readExact(4);
              final zLen = ByteData.sublistView(zLenBuf).getUint32(0, Endian.big);
              if (zLen > 0) {
                final comp = await reader.readExact(zLen);
                final rawBytes = _inflateStateful(_zlibFilter!, comp);
                _blitBgraPixels(rx, ry, rw, rh, rawBytes);
                drewPixels = true;
              }
            } else if (encoding == 16) {
              // ZRLE (RFC 6143 Section 7.7.6 stateful zlib + 64x64 CPIXEL tiles)
              final zLenBuf = await reader.readExact(4);
              final zLen = ByteData.sublistView(zLenBuf).getUint32(0, Endian.big);
              if (zLen > 0) {
                final comp = await reader.readExact(zLen);
                final tileBytes = _inflateStateful(_zrleFilter!, comp);
                _decodeZrleRect(rx, ry, rw, rh, tileBytes);
                drewPixels = true;
              }
            }
          }
          if (drewPixels || !_receivedAnyFrame) {
            _receivedAnyFrame = true;
            _initialFramePulse?.cancel();
            await _emitDecodedImage();
          }
          _sendFramebufferUpdateRequest(incremental: true);
        } else if (msgType == 1) {
          final hdr = await reader.readExact(5);
          final nColors = ByteData.sublistView(hdr).getUint16(3, Endian.big);
          await reader.readExact(nColors * 6);
        } else if (msgType == 2) {
          // Bell
        } else if (msgType == 3) {
          final hdr = await reader.readExact(7);
          final len = ByteData.sublistView(hdr).getUint32(3, Endian.big);
          if (len > 0 && len < 1048576) {
            await reader.readExact(len);
          }
        }
      }
    } catch (e) {
      if (_running) {
        onStatus('VNC stream closed: $e', isError: true);
      }
    }
  }

  Future<void> _emitDecodedImage() async {
    final c = Completer<ui.Image>();
    ui.decodeImageFromPixels(
      Uint8List.fromList(_rgbaBuffer),
      width,
      height,
      ui.PixelFormat.rgba8888,
      c.complete,
    );
    final img = await c.future;
    if (_running) {
      onFrame(img, width, height, 'RFB 3.8 Live ($desktopName • ${width}x$height)');
    }
  }

  void sendPointerEvent(int x, int y, int buttonMask) {
    final sock = _socket;
    if (sock == null || !_running) return;
    final pkt = ByteData(6);
    pkt.setUint8(0, 5);
    pkt.setUint8(1, buttonMask & 0xFF);
    pkt.setUint16(2, x.clamp(0, width - 1), Endian.big);
    pkt.setUint16(4, y.clamp(0, height - 1), Endian.big);
    sock.add(pkt.buffer.asUint8List());
  }

  /// Sends VNC RFB vertical scroll wheel ticks (Bit 3 = `0x08` Wheel Up, Bit 4 = `0x10` Wheel Down).
  void sendMouseWheel(int x, int y, int delta) {
    if (delta == 0) return;
    final mask = delta > 0 ? 0x08 : 0x10;
    final steps = (delta.abs() / 90).ceil().clamp(1, 4);
    for (int i = 0; i < steps; i++) {
      sendPointerEvent(x, y, mask);
      sendPointerEvent(x, y, 0);
    }
  }

  /// Dynamically resizes remote VNC desktop resolution via RFC 6143 / Tight `SetDesktopSize` (`msgType = 251`)
  /// when the server advertised `ExtendedDesktopSize (-308)`. Returns `true` if sent.
  bool requestResolution(int newWidth, int newHeight) {
    final sock = _socket;
    if (sock == null || !_running || !supportsExtendedDesktopSize) return false;
    final alignedW = (((newWidth.clamp(320, 4096) + 3) ~/ 4) * 4);
    final alignedH = (((newHeight.clamp(320, 4096) + 1) ~/ 2) * 2);
    if ((alignedW - width).abs() < 4 && (alignedH - height).abs() < 4) return true;

    final pkt = ByteData(24);
    pkt.setUint8(0, 251); // SetDesktopSize
    pkt.setUint8(1, 0); // padding
    pkt.setUint16(2, alignedW, Endian.big);
    pkt.setUint16(4, alignedH, Endian.big);
    pkt.setUint8(6, 1); // number-of-screens = 1
    // bytes 7..9 = 0 padding
    pkt.setUint32(8, _primaryScreenId, Endian.big);
    pkt.setUint16(12, 0, Endian.big); // x-position
    pkt.setUint16(14, 0, Endian.big); // y-position
    pkt.setUint16(16, alignedW, Endian.big);
    pkt.setUint16(18, alignedH, Endian.big);
    pkt.setUint32(20, _primaryScreenFlags, Endian.big);
    try {
      sock.add(pkt.buffer.asUint8List());
      _sendFramebufferUpdateRequest(incremental: false);
      return true;
    } catch (_) {
      return false;
    }
  }

  void sendKeySym(int keysym, {bool? down}) {
    final sock = _socket;
    if (sock == null || !_running) return;
    final states = down != null ? [down ? 1 : 0] : [1, 0];
    for (final st in states) {
      final pkt = ByteData(8);
      pkt.setUint8(0, 4);
      pkt.setUint8(1, st);
      pkt.setUint32(4, keysym, Endian.big);
      sock.add(pkt.buffer.asUint8List());
    }
  }

  static int runeToX11KeySym(int rune) {
    if (rune == 10 || rune == 13) return 0xFF0D; // Return
    if (rune == 8 || rune == 127) return 0xFF08; // BackSpace
    if (rune == 9) return 0xFF09; // Tab
    if (rune == 27) return 0xFF1B; // Escape
    if (rune >= 0x20 && rune <= 0xFF) return rune; // Latin-1 / ASCII matches X11 keysym directly
    return 0x01000000 | (rune & 0xFFFFFF); // X11 Unicode keysym convention
  }

  void sendText(String text) {
    for (final rune in text.runes) {
      final ks = runeToX11KeySym(rune);
      // Uppercase ASCII or shifted punctuation on strict X11 VNC servers (x11vnc / TigerVNC)
      final needsShift = (rune >= 0x41 && rune <= 0x5A) ||
          '~!@#\$%^&*()_+{}|:"<>?'.codeUnits.contains(rune);
      if (needsShift) sendKeySym(0xFFE1, down: true); // Shift_L
      sendKeySym(ks);
      if (needsShift) sendKeySym(0xFFE1, down: false);
    }
  }

  void sendSpecialKey(String label, {bool ctrl = false, bool alt = false, bool win = false, bool shift = false}) {
    if (!_running || _socket == null) return;
    if (label == 'Ctrl+Alt+Del') {
      sendKeySym(0xFFE3, down: true); // Control_L
      sendKeySym(0xFFE9, down: true); // Alt_L
      sendKeySym(0xFFFF); // Delete
      sendKeySym(0xFFE9, down: false);
      sendKeySym(0xFFE3, down: false);
      return;
    }
    if (label == 'Win+D') {
      sendKeySym(0xFFEB, down: true); // Super_L / Command
      sendKeySym(0x64); // 'd'
      sendKeySym(0xFFEB, down: false);
      return;
    }

    if (ctrl) sendKeySym(0xFFE3, down: true);
    if (alt) sendKeySym(0xFFE9, down: true);
    if (win) sendKeySym(0xFFEB, down: true);
    if (shift) sendKeySym(0xFFE1, down: true);

    switch (label) {
      case 'Esc':
        sendKeySym(0xFF1B);
        break;
      case 'Tab':
        sendKeySym(0xFF09);
        break;
      case 'Enter':
        sendKeySym(0xFF0D);
        break;
      case 'Bksp':
        sendKeySym(0xFF08);
        break;
      case 'Del':
        sendKeySym(0xFFFF);
        break;
      case 'Ins':
        sendKeySym(0xFF63);
        break;
      case 'Home':
        sendKeySym(0xFF50);
        break;
      case 'End':
        sendKeySym(0xFF57);
        break;
      case 'PgUp':
        sendKeySym(0xFF55);
        break;
      case 'PgDn':
        sendKeySym(0xFF56);
        break;
      case '←':
        sendKeySym(0xFF51);
        break;
      case '↑':
        sendKeySym(0xFF52);
        break;
      case '→':
        sendKeySym(0xFF53);
        break;
      case '↓':
        sendKeySym(0xFF54);
        break;
      case 'F1':
        sendKeySym(0xFFBE);
        break;
      case 'F2':
        sendKeySym(0xFFBF);
        break;
      case 'F3':
        sendKeySym(0xFFC0);
        break;
      case 'F4':
        sendKeySym(0xFFC1);
        break;
      case 'F5':
        sendKeySym(0xFFC2);
        break;
      case 'F6':
        sendKeySym(0xFFC3);
        break;
      case 'F7':
        sendKeySym(0xFFC4);
        break;
      case 'F8':
        sendKeySym(0xFFC5);
        break;
      case 'F9':
        sendKeySym(0xFFC6);
        break;
      case 'F10':
        sendKeySym(0xFFC7);
        break;
      case 'F11':
        sendKeySym(0xFFC8);
        break;
      case 'F12':
        sendKeySym(0xFFC9);
        break;
      default:
        if ((ctrl || alt || win) && label.length == 1) {
          sendKeySym(runeToX11KeySym(label.toLowerCase().runes.first));
        } else {
          sendText(label);
        }
    }

    if (shift) sendKeySym(0xFFE1, down: false);
    if (win) sendKeySym(0xFFEB, down: false);
    if (alt) sendKeySym(0xFFE9, down: false);
    if (ctrl) sendKeySym(0xFFE3, down: false);
  }

  Future<void> _cleanupSocket() async {
    _running = false;
    _initialFramePulse?.cancel();
    _initialFramePulse = null;
    _zlibFilter = null;
    _zrleFilter = null;
    await _reader?.dispose();
    _reader = null;
    try {
      _socket?.destroy();
    } catch (_) {}
    _socket = null;
  }

  Future<void> dispose() async {
    await _cleanupSocket();
  }
}
