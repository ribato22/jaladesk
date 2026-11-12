import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/services.dart';
import 'package:pointycastle/export.dart';
import 'package:shared_preferences/shared_preferences.dart';

class StagedLocalFile {
  final String path;
  final String name;
  final int sizeBytes;

  const StagedLocalFile({
    required this.path,
    required this.name,
    required this.sizeBytes,
  });
}

class StagedLocalDirectory {
  final String path;
  final String name;
  final int fileCount;

  const StagedLocalDirectory({
    required this.path,
    required this.name,
    required this.fileCount,
  });
}

/// Native Android / Mobile Platform Security & SAF Document Bridge (`com.jaladesk.app/native`).
/// Gracefully degrades on desktop test hosts without requiring third-party Gradle plugins.
class NativePlatformBridge {
  static const MethodChannel _channel = MethodChannel('com.jaladesk.app/native');

  /// Enables or disables Android `WindowManager.LayoutParams.FLAG_SECURE`
  /// (blocks screenshots, screen recording, and Android Recents task previews).
  static Future<bool> setSecureScreen(bool enable) async {
    try {
      final res = await _channel.invokeMethod<bool>('setSecureScreen', {'enable': enable});
      return res ?? enable;
    } catch (_) {
      return enable;
    }
  }

  /// Opens native Android SAF `ACTION_OPEN_DOCUMENT` picker for 1 or more files.
  /// Returns `null` if cancelled, or throws `UnsupportedError` on non-Android hosts.
  static Future<List<StagedLocalFile>?> pickFiles({bool allowMultiple = true}) async {
    if (!Platform.isAndroid) {
      throw UnsupportedError('System SAF file picker is only bridged on Android.');
    }
    final raw = await _channel.invokeMethod<List<dynamic>>(
      'pickFiles',
      {'allowMultiple': allowMultiple},
    );
    if (raw == null || raw.isEmpty) return null;
    final out = <StagedLocalFile>[];
    for (final item in raw) {
      if (item is Map) {
        final path = (item['path'] ?? '').toString();
        final name = (item['name'] ?? '').toString();
        final size = (item['size'] as num?)?.toInt() ?? 0;
        if (path.isNotEmpty) {
          out.add(StagedLocalFile(path: path, name: name.isEmpty ? 'file' : name, sizeBytes: size));
        }
      }
    }
    return out.isEmpty ? null : out;
  }

  /// Opens native Android SAF `ACTION_OPEN_DOCUMENT_TREE` picker and stages the directory hierarchy.
  static Future<StagedLocalDirectory?> pickDirectory() async {
    if (!Platform.isAndroid) {
      throw UnsupportedError('System SAF directory picker is only bridged on Android.');
    }
    final raw = await _channel.invokeMethod<Map<dynamic, dynamic>>('pickDirectory');
    if (raw == null) return null;
    final path = (raw['path'] ?? '').toString();
    final name = (raw['name'] ?? '').toString();
    final count = (raw['fileCount'] as num?)?.toInt() ?? 0;
    if (path.isEmpty) return null;
    return StagedLocalDirectory(
      path: path,
      name: name.isEmpty ? 'folder' : name,
      fileCount: count,
    );
  }

  /// Exports a downloaded temporary file into user-visible `Downloads/JalaDesk/<subDir>/<fileName>`.
  static Future<String> exportToDownloads({
    required String sourcePath,
    String subDir = '',
    required String fileName,
  }) async {
    if (Platform.isAndroid) {
      try {
        final raw = await _channel.invokeMethod<Map<dynamic, dynamic>>(
          'exportToDownloads',
          {
            'sourcePath': sourcePath,
            'subDir': subDir,
            'fileName': fileName,
          },
        );
        final saved = raw?['savedPath']?.toString();
        if (saved != null && saved.isNotEmpty) return saved;
      } catch (_) {}
    }

    // Fallback for macOS / Linux / test runner
    final cleanSub = subDir
        .split('/')
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty && s != '.' && s != '..')
        .join('/');
    final basePath = '${Directory.systemTemp.path}/JalaDesk_Downloads';
    final targetDir = Directory(cleanSub.isEmpty ? basePath : '$basePath/$cleanSub');
    await targetDir.create(recursive: true);
    final destFile = File('${targetDir.path}/$fileName');
    await File(sourcePath).copy(destFile.path);
    return destFile.path;
  }

  /// Returns the app-private local SFTP workspace directory for browsing/creating local files.
  static Future<Directory> resolveLocalWorkspaceDirectory() async {
    if (Platform.isAndroid) {
      try {
        final raw = await _channel.invokeMethod<Map<dynamic, dynamic>>('getAppStoragePaths');
        final ws = raw?['workspacePath']?.toString();
        if (ws != null && ws.isNotEmpty) {
          final dir = Directory(ws);
          if (!await dir.exists()) await dir.create(recursive: true);
          return dir;
        }
      } catch (_) {}
    }
    final fallback = Directory('${Directory.systemTemp.path}/jaladesk_local_workspace');
    if (!await fallback.exists()) {
      await fallback.create(recursive: true);
    }
    return fallback;
  }
}

/// Authenticated AES-256-GCM At-Rest Vault Cipher for `SharedPreferences`.
/// Protects saved hosts, passwords, SSH PEM private keys, reusable credentials, and 2FA seeds
/// at rest, while transparently migrating legacy v2 plaintext JSON records.
class VaultAtRestCipher {
  static const String _prefsMasterKey = 'jaladesk_enclave_dek_v1';
  static const String envelopePrefix = 'jseal:v1:';
  static final Uint8List _aad = Uint8List.fromList(utf8.encode('jaladesk-vault-at-rest-v1'));

  static Future<Uint8List> _getOrCreateDeviceKey(SharedPreferences prefs) async {
    final existing = prefs.getString(_prefsMasterKey);
    if (existing != null && existing.isNotEmpty) {
      try {
        final decoded = base64Decode(existing);
        if (decoded.length == 32) return decoded;
      } catch (_) {}
    }
    final rng = Random.secure();
    final fresh = Uint8List.fromList(List<int>.generate(32, (_) => rng.nextInt(256)));
    await prefs.setString(_prefsMasterKey, base64Encode(fresh));
    return fresh;
  }

  static String sealWithKey(String plaintext, Uint8List key32) {
    final rng = Random.secure();
    final iv = Uint8List.fromList(List<int>.generate(12, (_) => rng.nextInt(256)));
    final cipher = GCMBlockCipher(AESEngine())
      ..init(true, AEADParameters(KeyParameter(key32), 128, iv, _aad));
    final input = Uint8List.fromList(utf8.encode(plaintext));
    final sealed = cipher.process(input);
    return '$envelopePrefix${base64Encode(iv)}:${base64Encode(sealed)}';
  }

  static String openWithKey(String storedValue, Uint8List key32) {
    if (!storedValue.startsWith(envelopePrefix)) {
      // Transparent migration path from legacy v1/v2 plaintext JSON
      return storedValue;
    }
    final body = storedValue.substring(envelopePrefix.length);
    final sep = body.indexOf(':');
    if (sep <= 0) {
      throw const FormatException('Malformed AES-256-GCM at-rest vault envelope.');
    }
    final iv = base64Decode(body.substring(0, sep));
    final ciphertext = base64Decode(body.substring(sep + 1));
    final cipher = GCMBlockCipher(AESEngine())
      ..init(false, AEADParameters(KeyParameter(key32), 128, iv, _aad));
    final clear = cipher.process(ciphertext);
    return utf8.decode(clear);
  }

  static Future<String> encryptForPrefs(SharedPreferences prefs, String plaintext) async {
    final key = await _getOrCreateDeviceKey(prefs);
    return sealWithKey(plaintext, key);
  }

  static Future<String?> decryptFromPrefs(SharedPreferences prefs, String prefsKey) async {
    final raw = prefs.getString(prefsKey);
    if (raw == null || raw.isEmpty) return null;
    if (!raw.startsWith(envelopePrefix)) return raw;
    final key = await _getOrCreateDeviceKey(prefs);
    return openWithKey(raw, key);
  }
}

/// PBKDF2-HMAC-SHA256 App-Lock PIN Hasher (Constant-Time Verification)
class VaultPinHasher {
  static const int iterations = 60000;

  static String hashPin(String pin) {
    final rng = Random.secure();
    final salt = Uint8List.fromList(List<int>.generate(16, (_) => rng.nextInt(256)));
    final derived = _derive(pin, salt, iterations);
    return 'pbkdf2:$iterations:${base64Encode(salt)}:${base64Encode(derived)}';
  }

  static bool verifyPin(String pin, String storedRecord) {
    final parts = storedRecord.split(':');
    if (parts.length != 4 || parts[0] != 'pbkdf2') return false;
    final iters = int.tryParse(parts[1]) ?? iterations;
    try {
      final salt = base64Decode(parts[2]);
      final expected = base64Decode(parts[3]);
      final actual = _derive(pin, salt, iters);
      if (actual.length != expected.length) return false;
      int diff = 0;
      for (int i = 0; i < actual.length; i++) {
        diff |= actual[i] ^ expected[i];
      }
      return diff == 0;
    } catch (_) {
      return false;
    }
  }

  static Uint8List _derive(String pin, Uint8List salt, int iters) {
    final derivator = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64))
      ..init(Pbkdf2Parameters(salt, iters, 32));
    return derivator.process(Uint8List.fromList(utf8.encode(pin)));
  }
}

/// Trusted SSH Host Key Entry (RFC 4251 TOFU — Trust On First Use)
class KnownSshHostKeyEntry {
  final String endpoint;
  final String keyType;
  final String fingerprintDisplay;
  final String rawHex;
  final String trustedAtIso;

  const KnownSshHostKeyEntry({
    required this.endpoint,
    required this.keyType,
    required this.fingerprintDisplay,
    required this.rawHex,
    required this.trustedAtIso,
  });

  Map<String, dynamic> toJson() => {
        'endpoint': endpoint,
        'keyType': keyType,
        'fingerprintDisplay': fingerprintDisplay,
        'rawHex': rawHex,
        'trustedAtIso': trustedAtIso,
      };

  factory KnownSshHostKeyEntry.fromJson(Map<String, dynamic> json) {
    return KnownSshHostKeyEntry(
      endpoint: json['endpoint'] as String? ?? '',
      keyType: json['keyType'] as String? ?? 'ssh-ed25519',
      fingerprintDisplay: json['fingerprintDisplay'] as String? ?? '',
      rawHex: json['rawHex'] as String? ?? '',
      trustedAtIso: json['trustedAtIso'] as String? ?? '',
    );
  }
}

class SshHostKeyMismatchAlert {
  final String endpoint;
  final String keyType;
  final String previousKeyType;
  final String previousFingerprint;
  final String incomingFingerprint;

  const SshHostKeyMismatchAlert({
    required this.endpoint,
    required this.keyType,
    required this.previousKeyType,
    required this.previousFingerprint,
    required this.incomingFingerprint,
  });
}

/// Persistent SSH Known-Hosts Pinning Store (`known_hosts` TOFU + MITM Detection)
class SshKnownHostsStore {
  final Map<String, KnownSshHostKeyEntry> _entries = <String, KnownSshHostKeyEntry>{};

  List<KnownSshHostKeyEntry> get entries {
    final list = _entries.values.toList();
    list.sort((a, b) => a.endpoint.compareTo(b.endpoint));
    return list;
  }

  void loadFromJsonList(List<dynamic> decoded) {
    _entries.clear();
    for (final item in decoded) {
      if (item is Map<String, dynamic>) {
        final entry = KnownSshHostKeyEntry.fromJson(item);
        if (entry.endpoint.isNotEmpty && entry.rawHex.isNotEmpty) {
          _entries[entry.endpoint] = entry;
        }
      }
    }
  }

  List<Map<String, dynamic>> toJsonList() => _entries.values.map((e) => e.toJson()).toList();

  void removeEndpoint(String endpoint) {
    _entries.remove(endpoint);
  }

  void clearAll() {
    _entries.clear();
  }

  static String normalizeEndpoint(String host, int port) => '${host.trim().toLowerCase()}:$port';

  static String bytesToHex(Uint8List bytes) =>
      bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

  static String formatFingerprint(Uint8List fingerprintBytes) {
    if (fingerprintBytes.length == 16) {
      final colonHex = fingerprintBytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join(':');
      return 'MD5:$colonHex';
    }
    if (fingerprintBytes.length == 32) {
      final b64 = base64Encode(fingerprintBytes).replaceAll('=', '');
      return 'SHA256:$b64';
    }
    final digest = crypto.sha256.convert(fingerprintBytes).bytes;
    final b64 = base64Encode(digest).replaceAll('=', '');
    return 'SHA256:$b64';
  }

  /// Verifies an incoming SSH server host key against pinned `known_hosts`.
  /// - First connection: trusts on first use (TOFU) and pins the key.
  /// - Matching key: approves immediately.
  /// - Changed key: invokes `onMismatch` so the user can reject a potential MITM attack!
  Future<bool> verifyOrPin({
    required String host,
    required int port,
    required String keyType,
    required Uint8List fingerprint,
    void Function()? onStoreMutated,
    Future<bool> Function(SshHostKeyMismatchAlert alert)? onMismatch,
  }) async {
    final endpoint = normalizeEndpoint(host, port);
    final incomingHex = bytesToHex(fingerprint);
    final incomingDisplay = formatFingerprint(fingerprint);
    final existing = _entries[endpoint];

    if (existing == null) {
      _entries[endpoint] = KnownSshHostKeyEntry(
        endpoint: endpoint,
        keyType: keyType,
        fingerprintDisplay: incomingDisplay,
        rawHex: incomingHex,
        trustedAtIso: DateTime.now().toUtc().toIso8601String(),
      );
      onStoreMutated?.call();
      return true;
    }

    if (existing.rawHex == incomingHex) {
      return true;
    }

    if (onMismatch == null) {
      return false;
    }

    final replaceApproved = await onMismatch(
      SshHostKeyMismatchAlert(
        endpoint: endpoint,
        keyType: keyType,
        previousKeyType: existing.keyType,
        previousFingerprint: existing.fingerprintDisplay,
        incomingFingerprint: incomingDisplay,
      ),
    );

    if (replaceApproved) {
      _entries[endpoint] = KnownSshHostKeyEntry(
        endpoint: endpoint,
        keyType: keyType,
        fingerprintDisplay: incomingDisplay,
        rawHex: incomingHex,
        trustedAtIso: DateTime.now().toUtc().toIso8601String(),
      );
      onStoreMutated?.call();
      return true;
    }
    return false;
  }
}

/// Real Timed OS Clipboard Secret Scrubber (Purges copied passwords & 2FA codes after `ttl`)
class ClipboardSecretScrubber {
  Timer? _timer;
  String? _lastSensitiveValue;

  void copySecret(
    String secret, {
    required bool autoScrubEnabled,
    Duration ttl = const Duration(seconds: 30),
    void Function()? onScrubbed,
  }) {
    _timer?.cancel();
    _lastSensitiveValue = secret;
    Clipboard.setData(ClipboardData(text: secret));
    if (!autoScrubEnabled) return;

    _timer = Timer(ttl, () async {
      try {
        final current = await Clipboard.getData(Clipboard.kTextPlain);
        if (current == null || current.text == _lastSensitiveValue) {
          await Clipboard.setData(const ClipboardData(text: ''));
          onScrubbed?.call();
        }
      } catch (_) {
        try {
          await Clipboard.setData(const ClipboardData(text: ''));
        } catch (_) {}
      } finally {
        _lastSensitiveValue = null;
      }
    });
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
    _lastSensitiveValue = null;
  }
}
