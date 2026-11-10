import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

/// Pure-Dart RFC 6143 DES-ECB implementation for VNC Authentication (Security Type 2)
/// Note: VNC reverses the bit order of each byte in the 8-byte password key!
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
    final keyBytes = Uint8List(8);
    final rawPw = utf8.encode(password);
    for (int i = 0; i < 8; i++) {
      keyBytes[i] = i < rawPw.length ? _reverseByteBits(rawPw[i]) : 0;
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

    final out = Uint8List(16);
    out.setRange(0, 8, _encryptBlock8(challenge16.sublist(0, 8), subkeys));
    out.setRange(8, 16, _encryptBlock8(challenge16.sublist(8, 16), subkeys));
    return out;
  }
}

/// Asynchronous buffered byte reader over a Dart TCP Socket
class SocketByteReader {
  final StreamSubscription<Uint8List> _sub;
  final BytesBuilder _buf = BytesBuilder(copy: false);
  Completer<void>? _waiter;
  bool _closed = false;
  Object? _error;

  SocketByteReader(Socket socket)
      : _sub = socket.listen(
          ( _) {},
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

/// Full RFC 6143 VNC (RFB 3.3 / 3.7 / 3.8) Client Engine with Live RGBA32 Framebuffer
class VncRfbClient {
  final String host;
  final int port;
  final String password;
  final void Function(ui.Image image, int width, int height, String status) onFrame;
  final void Function(String status, {bool isError}) onStatus;

  Socket? _socket;
  SocketByteReader? _reader;
  bool _running = false;
  int width = 1024;
  int height = 768;
  String desktopName = 'VNC Remote Desktop';
  late Uint8List _rgbaBuffer;

  VncRfbClient({
    required this.host,
    required this.port,
    required this.password,
    required this.onFrame,
    required this.onStatus,
  });

  bool get isConnected => _running && _socket != null;

  Future<void> connect() async {
    onStatus('Connecting TCP socket to $host:$port...');
    final sock = await Socket.connect(host, port, timeout: const Duration(seconds: 7));
    sock.setOption(SocketOption.tcpNoDelay, true);
    _socket = sock;
    final reader = SocketByteReader(sock);
    _reader = reader;

    // 1. Read Server ProtocolVersion (12 bytes: "RFB xxx.yyy\n")
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
    if (is33) {
      final secBuf = await reader.readExact(4);
      chosenSec = ByteData.sublistView(secBuf).getUint32(0, Endian.big);
      if (chosenSec == 0) {
        final lenBuf = await reader.readExact(4);
        final reasonLen = ByteData.sublistView(lenBuf).getUint32(0, Endian.big);
        final reason = utf8.decode(await reader.readExact(reasonLen), allowMalformed: true);
        throw SocketException('VNC connection refused: $reason');
      }
    } else {
      final countBuf = await reader.readExact(1);
      final count = countBuf[0];
      if (count == 0) {
        final lenBuf = await reader.readExact(4);
        final reasonLen = ByteData.sublistView(lenBuf).getUint32(0, Endian.big);
        final reason = utf8.decode(await reader.readExact(reasonLen), allowMalformed: true);
        throw SocketException('VNC security failed: $reason');
      }
      final types = await reader.readExact(count);
      if (types.contains(1) && password.isEmpty) {
        chosenSec = 1; // None
      } else if (types.contains(2)) {
        chosenSec = 2; // VNC Auth (DES)
      } else if (types.contains(1)) {
        chosenSec = 1;
      } else {
        chosenSec = types.first;
      }
      sock.add([chosenSec]);
      await sock.flush();
    }

    if (chosenSec == 2) {
      onStatus('Authenticating VNC DES challenge...');
      final challenge = await reader.readExact(16);
      final response = VncDesAuth.encryptVncChallenge(challenge, password);
      sock.add(response);
      await sock.flush();
    }

    if (!is33 && (chosenSec == 2 || !is37)) {
      final resBuf = await reader.readExact(4);
      final secResult = ByteData.sublistView(resBuf).getUint32(0, Endian.big);
      if (secResult != 0) {
        String errMsg = 'VNC Authentication failed (wrong password).';
        if (!is37) {
          try {
            final lenBuf = await reader.readExact(4, timeout: const Duration(seconds: 2));
            final len = ByteData.sublistView(lenBuf).getUint32(0, Endian.big);
            if (len > 0 && len < 2048) {
              errMsg = utf8.decode(await reader.readExact(len), allowMalformed: true);
            }
          } catch (_) {}
        }
        throw SocketException(errMsg);
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

    // 5. Send SetPixelFormat (msgType = 0): 32bpp, depth 24, little-endian, true-color, R@0, G@8, B@16
    final setPf = ByteData(20);
    setPf.setUint8(0, 0); // SetPixelFormat
    setPf.setUint8(4, 32); // bits-per-pixel = 32
    setPf.setUint8(5, 24); // depth = 24
    setPf.setUint8(6, 0); // big-endian-flag = 0 (little-endian so byte0=R, byte1=G, byte2=B)
    setPf.setUint8(7, 1); // true-colour-flag = 1
    setPf.setUint16(8, 255, Endian.big); // red-max = 255
    setPf.setUint16(10, 255, Endian.big); // green-max = 255
    setPf.setUint16(12, 255, Endian.big); // blue-max = 255
    setPf.setUint8(14, 0); // red-shift = 0
    setPf.setUint8(15, 8); // green-shift = 8
    setPf.setUint8(16, 16); // blue-shift = 16
    sock.add(setPf.buffer.asUint8List());

    // 6. Send SetEncodings (msgType = 2): CopyRect (1), Raw (0), DesktopSize (-223)
    final setEnc = ByteData(16);
    setEnc.setUint8(0, 2); // SetEncodings
    setEnc.setUint16(2, 3, Endian.big); // 3 encodings
    setEnc.setInt32(4, 1, Endian.big); // CopyRect
    setEnc.setInt32(8, 0, Endian.big); // Raw
    setEnc.setInt32(12, -223, Endian.big); // DesktopSize pseudo-encoding
    sock.add(setEnc.buffer.asUint8List());
    await sock.flush();

    _running = true;
    onStatus('Connected to $desktopName (${width}x$height • RFB 3.8)');
    _sendFramebufferUpdateRequest(incremental: false);
    unawaited(_receiveLoop());
  }

  void _sendFramebufferUpdateRequest({required bool incremental}) {
    final sock = _socket;
    if (sock == null || !_running) return;
    final req = ByteData(10);
    req.setUint8(0, 3); // FramebufferUpdateRequest
    req.setUint8(1, incremental ? 1 : 0);
    req.setUint16(2, 0, Endian.big);
    req.setUint16(4, 0, Endian.big);
    req.setUint16(6, width, Endian.big);
    req.setUint16(8, height, Endian.big);
    sock.add(req.buffer.asUint8List());
  }

  Future<void> _receiveLoop() async {
    final reader = _reader;
    if (reader == null) return;
    try {
      while (_running) {
        final msgTypeBuf = await reader.readExact(1, timeout: const Duration(seconds: 60));
        final msgType = msgTypeBuf[0];
        if (msgType == 0) {
          // FramebufferUpdate
          final hdr = await reader.readExact(3);
          final numRects = ByteData.sublistView(hdr).getUint16(1, Endian.big);
          for (int r = 0; r < numRects; r++) {
            final rectHdr = await reader.readExact(12);
            final rbd = ByteData.sublistView(rectHdr);
            final rx = rbd.getUint16(0, Endian.big);
            final ry = rbd.getUint16(2, Endian.big);
            final rw = rbd.getUint16(4, Endian.big);
            final rh = rbd.getUint16(6, Endian.big);
            final encoding = rbd.getInt32(8, Endian.big);

            if (encoding == -223) {
              // DesktopSize pseudo-encoding
              width = rw;
              height = rh;
              _rgbaBuffer = Uint8List(width * height * 4);
              for (int i = 3; i < _rgbaBuffer.length; i += 4) {
                _rgbaBuffer[i] = 255;
              }
              continue;
            } else if (encoding == 0) {
              // Raw encoding (rw * rh * 4 bytes)
              final rawBytes = await reader.readExact(rw * rh * 4);
              for (int row = 0; row < rh; row++) {
                final dstY = ry + row;
                if (dstY >= height) break;
                final srcOff = row * rw * 4;
                final dstOff = (dstY * width + rx) * 4;
                final copyPixels = (rx + rw <= width) ? rw : (width - rx);
                for (int col = 0; col < copyPixels; col++) {
                  final sIdx = srcOff + col * 4;
                  final dIdx = dstOff + col * 4;
                  _rgbaBuffer[dIdx] = rawBytes[sIdx];
                  _rgbaBuffer[dIdx + 1] = rawBytes[sIdx + 1];
                  _rgbaBuffer[dIdx + 2] = rawBytes[sIdx + 2];
                  _rgbaBuffer[dIdx + 3] = 255;
                }
              }
            } else if (encoding == 1) {
              // CopyRect (4 bytes: srcX, srcY)
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
            }
          }
          await _emitDecodedImage();
          _sendFramebufferUpdateRequest(incremental: true);
        } else if (msgType == 1) {
          // SetColourMapEntries
          final hdr = await reader.readExact(5);
          final nColors = ByteData.sublistView(hdr).getUint16(3, Endian.big);
          await reader.readExact(nColors * 6);
        } else if (msgType == 2) {
          // Bell
        } else if (msgType == 3) {
          // ServerCutText
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
    pkt.setUint8(0, 5); // PointerEvent
    pkt.setUint8(1, buttonMask & 0xFF);
    pkt.setUint16(2, x.clamp(0, width - 1), Endian.big);
    pkt.setUint16(4, y.clamp(0, height - 1), Endian.big);
    sock.add(pkt.buffer.asUint8List());
  }

  void sendKeySym(int keysym, {bool? down}) {
    final sock = _socket;
    if (sock == null || !_running) return;
    final states = down != null ? [down ? 1 : 0] : [1, 0];
    for (final st in states) {
      final pkt = ByteData(8);
      pkt.setUint8(0, 4); // KeyEvent
      pkt.setUint8(1, st);
      pkt.setUint32(4, keysym, Endian.big);
      sock.add(pkt.buffer.asUint8List());
    }
  }

  void sendText(String text) {
    for (final rune in text.runes) {
      sendKeySym(rune);
    }
  }

  Future<void> dispose() async {
    _running = false;
    await _reader?.dispose();
    try {
      _socket?.destroy();
    } catch (_) {}
    _socket = null;
  }
}
