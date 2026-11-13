import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../protocols/ssh_bastion_tunnel.dart';

const String kAndroidAppPackageName = 'com.jaladesk.app';
const String kAndroidUploadKeySha1 =
    '99:85:3E:A8:14:F9:D6:D7:51:E0:44:D9:0C:2A:B8:DF:DC:46:C9:E6';

const Color _kSyncCanvasTop = Color(0xFF090E17);
const Color _kSyncCanvasBottom = Color(0xFF0D1522);
const Color _kSyncSurface = Color(0xFF141E2D);
const Color _kSyncFieldFill = Color(0xFF0E1622);
const Color _kSyncBorder = Color(0xFF253549);
const Color _kSyncInputBorder = Color(0xFF384C65);
const Color _kSyncSelected = Color(0xFF233B56);
const Color _kSyncAccent = Color(0xFF2F6F9C);
const Color _kSyncAccentLine = Color(0xFF5AA2D4);
const Color _kSyncGold = Color(0xFFEDBA6E);
const Color _kSyncOk = Color(0xFF80D3A3);
const Color _kSyncDanger = Color(0xFFFFAAA1);
const Color _kSyncText = Color(0xFFE3EAF2);
const Color _kSyncText2 = Color(0xFFC3CFDB);
const Color _kSyncMuted = Color(0xFF9FB0C3);

enum VaultSyncProviderKind {
  googleDrive,
  sftp,
  webdav,
  githubGist;

  String get label {
    switch (this) {
      case VaultSyncProviderKind.googleDrive:
        return 'Google Drive';
      case VaultSyncProviderKind.sftp:
        return 'SFTP Server';
      case VaultSyncProviderKind.webdav:
        return 'WebDAV';
      case VaultSyncProviderKind.githubGist:
        return 'GitHub Gist';
    }
  }

  String get pillLabel {
    switch (this) {
      case VaultSyncProviderKind.googleDrive:
        return 'Google';
      case VaultSyncProviderKind.sftp:
        return 'SFTP';
      case VaultSyncProviderKind.webdav:
        return 'WebDAV';
      case VaultSyncProviderKind.githubGist:
        return 'GitHub';
    }
  }

  String get subtitle {
    switch (this) {
      case VaultSyncProviderKind.googleDrive:
        return 'Google Account AppData';
      case VaultSyncProviderKind.sftp:
        return 'Private SSH / Jump Host';
      case VaultSyncProviderKind.webdav:
        return 'Nextcloud / Synology / NAS';
      case VaultSyncProviderKind.githubGist:
        return 'Secret Gist + History';
    }
  }

  IconData get icon {
    switch (this) {
      case VaultSyncProviderKind.googleDrive:
        return Icons.add_to_drive_rounded;
      case VaultSyncProviderKind.sftp:
        return Icons.dns_rounded;
      case VaultSyncProviderKind.webdav:
        return Icons.cloud_circle_outlined;
      case VaultSyncProviderKind.githubGist:
        return Icons.code_rounded;
    }
  }

  static VaultSyncProviderKind fromName(String? raw) {
    for (final p in VaultSyncProviderKind.values) {
      if (p.name == raw) return p;
    }
    return VaultSyncProviderKind.googleDrive;
  }
}

enum VaultSyncOperationMode {
  smartMerge,
  pullOnly,
  pushForce,
}

class VaultCloudSyncException implements Exception {
  final String message;
  const VaultCloudSyncException(this.message);

  @override
  String toString() => message;
}

class GoogleOAuthConfigurationException extends VaultCloudSyncException {
  final String packageName;
  final String uploadKeySha1;
  final String rawDetail;

  const GoogleOAuthConfigurationException({
    this.packageName = kAndroidAppPackageName,
    this.uploadKeySha1 = kAndroidUploadKeySha1,
    this.rawDetail = '',
    String message = 'Google Cloud OAuth client registration required for Android Drive AppData.',
  }) : super(message);
}

String _sealVaultIsolateEntry((Map<String, dynamic>, String) args) {
  return EncryptedVaultBackupCodec.sealJson(
    payload: args.$1,
    passphrase: args.$2,
  );
}

Map<String, dynamic> _openVaultIsolateEntry((String, String) args) {
  return EncryptedVaultBackupCodec.openJson(
    rawEnvelopeJson: args.$1,
    passphrase: args.$2,
  );
}

/// Non-blocking E2EE Vault Codec runner.
/// Uses `compute(...)` background isolates in live app execution and unit tests so
/// 100,000-iteration PBKDF2-HMAC-SHA256 + AES-256-GCM never drops a UI frame.
class VaultCloudSyncCrypto {
  static bool get _isFakeAsyncWidgetTest {
    try {
      final typeName = WidgetsBinding.instance.runtimeType.toString();
      return typeName.contains('AutomatedTestWidgetsFlutterBinding');
    } catch (_) {
      return false;
    }
  }

  static Future<String> sealAsync({
    required Map<String, dynamic> payload,
    required String passphrase,
  }) async {
    if (passphrase.trim().length < 4) {
      throw const VaultCloudSyncException('Sync passphrase must be at least 4 characters.');
    }
    if (_isFakeAsyncWidgetTest) {
      return _sealVaultIsolateEntry((payload, passphrase));
    }
    return compute(_sealVaultIsolateEntry, (payload, passphrase));
  }

  static Future<Map<String, dynamic>> openAsync({
    required String rawEnvelopeJson,
    required String passphrase,
  }) async {
    if (passphrase.isEmpty) {
      throw const VaultCloudSyncException('Enter your Sync Passphrase to decrypt the cloud vault.');
    }
    try {
      if (_isFakeAsyncWidgetTest) {
        return _openVaultIsolateEntry((rawEnvelopeJson, passphrase));
      }
      return await compute(_openVaultIsolateEntry, (rawEnvelopeJson, passphrase));
    } on FormatException catch (e) {
      throw VaultCloudSyncException(e.message);
    }
  }
}

/// Deterministic Tombstone-Aware Multi-Device `.jvault` Payload Merger (`syncSchema: 2`).
class VaultSyncPayloadMerger {
  static const int syncSchemaVersion = 2;
  static const int maxTombstones = 500;

  static Map<String, int> parseTombstones(Object? raw) {
    final out = <String, int>{};
    if (raw is Map) {
      raw.forEach((key, value) {
        final k = key.toString().trim();
        final ts = (value is num) ? value.toInt() : int.tryParse(value.toString()) ?? 0;
        if (k.isNotEmpty && ts > 0) {
          out[k] = ts;
        }
      });
    }
    return out;
  }

  static Map<String, int> capTombstones(Map<String, int> tombstones) {
    if (tombstones.length <= maxTombstones) {
      return Map<String, int>.from(tombstones);
    }
    final sorted = tombstones.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    return <String, int>{
      for (final entry in sorted.take(maxTombstones)) entry.key: entry.value,
    };
  }

  static Map<String, dynamic> normalizePayload(
    Map<String, dynamic> source, {
    int? nowMs,
  }) {
    final ts = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final tombstones = capTombstones(parseTombstones(source['tombstones']));
    return <String, dynamic>{
      'syncSchema': syncSchemaVersion,
      'updatedAtMs': math.max(ts, (source['updatedAtMs'] as num?)?.toInt() ?? 0),
      'hosts': _extractMapList(source['hosts']),
      'credentials': _extractMapList(source['credentials']),
      'folders': _extractMapList(source['folders']),
      'totp': _extractMapList(source['totp']),
      'snippets': _extractMapList(source['snippets']),
      'tombstones': tombstones,
    };
  }

  static Map<String, dynamic> merge(
    Map<String, dynamic> local,
    Map<String, dynamic> remote, {
    int? nowMs,
  }) {
    final ts = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final localTombs = parseTombstones(local['tombstones']);
    final remoteTombs = parseTombstones(remote['tombstones']);

    final unionTombstones = <String, int>{...localTombs};
    remoteTombs.forEach((key, remoteDeletedAt) {
      final prev = unionTombstones[key] ?? 0;
      if (remoteDeletedAt > prev) {
        unionTombstones[key] = remoteDeletedAt;
      }
    });

    final mergedHosts = _mergeCollection(
      localList: _extractMapList(local['hosts']),
      remoteList: _extractMapList(remote['hosts']),
      keyField: 'id',
      tombstonePrefix: 'host:',
      tombstones: unionTombstones,
    );
    final mergedCreds = _mergeCollection(
      localList: _extractMapList(local['credentials']),
      remoteList: _extractMapList(remote['credentials']),
      keyField: 'id',
      tombstonePrefix: 'cred:',
      tombstones: unionTombstones,
    );
    final mergedFolders = _mergeCollection(
      localList: _extractMapList(local['folders']),
      remoteList: _extractMapList(remote['folders']),
      keyField: 'name',
      tombstonePrefix: 'folder:',
      tombstones: unionTombstones,
    );
    final mergedTotp = _mergeCollection(
      localList: _extractMapList(local['totp']),
      remoteList: _extractMapList(remote['totp']),
      keyField: 'id',
      tombstonePrefix: 'totp:',
      tombstones: unionTombstones,
    );
    final mergedSnippets = _mergeCollection(
      localList: _extractMapList(local['snippets']),
      remoteList: _extractMapList(remote['snippets']),
      keyField: 'id',
      tombstonePrefix: 'snippet:',
      tombstones: unionTombstones,
    );

    final localTopTs = (local['updatedAtMs'] as num?)?.toInt() ?? 0;
    final remoteTopTs = (remote['updatedAtMs'] as num?)?.toInt() ?? 0;

    return <String, dynamic>{
      'syncSchema': syncSchemaVersion,
      'updatedAtMs': math.max(ts, math.max(localTopTs, remoteTopTs)),
      'hosts': mergedHosts,
      'credentials': mergedCreds,
      'folders': mergedFolders,
      'totp': mergedTotp,
      'snippets': mergedSnippets,
      'tombstones': capTombstones(unionTombstones),
    };
  }

  static List<Map<String, dynamic>> _extractMapList(Object? raw) {
    if (raw is! List) return const <Map<String, dynamic>>[];
    final out = <Map<String, dynamic>>[];
    for (final item in raw) {
      if (item is Map<String, dynamic>) {
        out.add(Map<String, dynamic>.from(item));
      } else if (item is Map) {
        out.add(item.map((k, v) => MapEntry(k.toString(), v)));
      }
    }
    return out;
  }

  static List<Map<String, dynamic>> _mergeCollection({
    required List<Map<String, dynamic>> localList,
    required List<Map<String, dynamic>> remoteList,
    required String keyField,
    required String tombstonePrefix,
    required Map<String, int> tombstones,
  }) {
    final localByKey = <String, Map<String, dynamic>>{};
    final orderedKeys = <String>[];

    for (final item in localList) {
      final k = (item[keyField] ?? '').toString().trim();
      if (k.isEmpty) continue;
      if (!localByKey.containsKey(k)) orderedKeys.add(k);
      localByKey[k] = item;
    }

    final remoteByKey = <String, Map<String, dynamic>>{};
    for (final item in remoteList) {
      final k = (item[keyField] ?? '').toString().trim();
      if (k.isEmpty) continue;
      if (!localByKey.containsKey(k) && !remoteByKey.containsKey(k)) {
        orderedKeys.add(k);
      }
      remoteByKey[k] = item;
    }

    final merged = <Map<String, dynamic>>[];
    for (final k in orderedKeys) {
      final lItem = localByKey[k];
      final rItem = remoteByKey[k];
      final lTs = (lItem?['updatedAtMs'] as num?)?.toInt() ?? 0;
      final rTs = (rItem?['updatedAtMs'] as num?)?.toInt() ?? 0;
      final maxItemTs = math.max(lTs, rTs);

      final tombKey = '$tombstonePrefix$k';
      final deletedAt = tombstones[tombKey] ?? 0;
      if (deletedAt > maxItemTs) {
        continue;
      }
      if (deletedAt > 0 && maxItemTs >= deletedAt) {
        tombstones.remove(tombKey);
      }

      if (lItem != null && rItem != null) {
        if (rTs > lTs) {
          merged.add(Map<String, dynamic>.from(rItem));
        } else {
          merged.add(Map<String, dynamic>.from(lItem));
        }
      } else if (lItem != null) {
        merged.add(Map<String, dynamic>.from(lItem));
      } else if (rItem != null) {
        merged.add(Map<String, dynamic>.from(rItem));
      }
    }
    return merged;
  }
}

class GoogleAuthAccountInfo {
  final String email;
  final String displayName;

  const GoogleAuthAccountInfo({
    required this.email,
    this.displayName = '',
  });
}

abstract class GoogleAuthTokenProvider {
  GoogleAuthAccountInfo? get currentAccount;
  Future<GoogleAuthAccountInfo?> signIn();
  Future<GoogleAuthAccountInfo?> signInSilently();
  Future<void> signOut();
  Future<String> getAccessToken({bool forceRefresh = false});
}

class PluginGoogleAuthTokenProvider implements GoogleAuthTokenProvider {
  static const List<String> driveAppDataScopes = <String>[
    'https://www.googleapis.com/auth/drive.appdata',
  ];

  final GoogleSignIn _googleSignIn;
  GoogleSignInAccount? _cachedAccount;

  PluginGoogleAuthTokenProvider({GoogleSignIn? googleSignIn})
      : _googleSignIn = googleSignIn ?? GoogleSignIn(scopes: driveAppDataScopes);

  @override
  GoogleAuthAccountInfo? get currentAccount {
    final acc = _cachedAccount ?? _googleSignIn.currentUser;
    if (acc == null) return null;
    return GoogleAuthAccountInfo(
      email: acc.email,
      displayName: acc.displayName ?? '',
    );
  }

  static Never _rethrowTranslatedPlatformError(PlatformException err) {
    final combined = '${err.code} ${err.message ?? ''} ${err.details ?? ''}';
    if (combined.contains('sign_in_failed') ||
        combined.contains('ApiException: 10') ||
        combined.contains('statusCode=10') ||
        combined.contains(': 10,') ||
        combined.contains('12500')) {
      throw GoogleOAuthConfigurationException(rawDetail: combined.trim());
    }
    throw VaultCloudSyncException(
      err.message?.trim().isNotEmpty == true
          ? err.message!.trim()
          : 'Google Sign-In failed (${err.code}).',
    );
  }

  @override
  Future<GoogleAuthAccountInfo?> signIn() async {
    try {
      final acc = await _googleSignIn.signIn();
      _cachedAccount = acc;
      if (acc == null) return null;
      return GoogleAuthAccountInfo(
        email: acc.email,
        displayName: acc.displayName ?? '',
      );
    } on PlatformException catch (err) {
      _rethrowTranslatedPlatformError(err);
    }
  }

  @override
  Future<GoogleAuthAccountInfo?> signInSilently() async {
    try {
      final acc = await _googleSignIn.signInSilently();
      _cachedAccount = acc;
      if (acc == null) return null;
      return GoogleAuthAccountInfo(
        email: acc.email,
        displayName: acc.displayName ?? '',
      );
    } on PlatformException catch (err) {
      _rethrowTranslatedPlatformError(err);
    }
  }

  @override
  Future<void> signOut() async {
    _cachedAccount = null;
    try {
      await _googleSignIn.signOut();
    } catch (_) {}
  }

  @override
  Future<String> getAccessToken({bool forceRefresh = false}) async {
    try {
      GoogleSignInAccount? acc = _cachedAccount ?? _googleSignIn.currentUser;
      acc ??= await _googleSignIn.signInSilently();
      if (acc == null) {
        throw const VaultCloudSyncException(
          'Google account is not signed in. Tap "Sign in with Google" first.',
        );
      }
      _cachedAccount = acc;
      if (forceRefresh) {
        await acc.clearAuthCache();
      }
      final auth = await acc.authentication;
      final token = auth.accessToken ?? '';
      if (token.isEmpty) {
        throw const VaultCloudSyncException(
          'Unable to obtain Google Drive AppData access token.',
        );
      }
      return token;
    } on PlatformException catch (err) {
      _rethrowTranslatedPlatformError(err);
    }
  }
}

abstract class VaultCloudSyncTransport {
  Future<String?> downloadEnvelope();
  Future<void> uploadEnvelope(String sealedJson);
}

class _HttpResponseSnapshot {
  final int statusCode;
  final String body;

  const _HttpResponseSnapshot({
    required this.statusCode,
    required this.body,
  });
}

Future<_HttpResponseSnapshot> _executeRawHttp({
  required String method,
  required Uri uri,
  required Map<String, String> headers,
  List<int>? bodyBytes,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final client = HttpClient()..connectionTimeout = timeout;
  try {
    final req = await client.openUrl(method, uri).timeout(timeout);
    req.followRedirects = true;
    headers.forEach(req.headers.set);
    if (bodyBytes != null) {
      req.contentLength = bodyBytes.length;
      req.add(bodyBytes);
    }
    final resp = await req.close().timeout(timeout);
    final rawBytes = await resp.fold<BytesBuilder>(
      BytesBuilder(copy: false),
      (b, chunk) => b..add(chunk),
    ).timeout(timeout);
    return _HttpResponseSnapshot(
      statusCode: resp.statusCode,
      body: utf8.decode(rawBytes.takeBytes(), allowMalformed: true),
    );
  } on SocketException catch (e) {
    throw VaultCloudSyncException('Network connection failed: ${e.message}');
  } on TimeoutException {
    throw const VaultCloudSyncException('Cloud request timed out.');
  } finally {
    client.close(force: false);
  }
}

/// Adapter 1: Google Drive v3 `appDataFolder` REST Transport (`dart:io` `HttpClient`).
class GoogleDriveAppDataSyncTransport implements VaultCloudSyncTransport {
  static const String defaultApiBaseUrl = 'https://www.googleapis.com';
  static const String defaultVaultFileName = 'jaladesk-vault-v1.jvault';

  final GoogleAuthTokenProvider authProvider;
  final String apiBaseUrl;
  final String fileName;
  final Duration timeout;

  const GoogleDriveAppDataSyncTransport({
    required this.authProvider,
    this.apiBaseUrl = defaultApiBaseUrl,
    this.fileName = defaultVaultFileName,
    this.timeout = const Duration(seconds: 20),
  });

  String get _cleanBase => apiBaseUrl.trim().replaceAll(RegExp(r'/+$'), '');

  Future<_HttpResponseSnapshot> _authorizedCall({
    required String method,
    required Uri uri,
    Map<String, String>? extraHeaders,
    List<int>? bodyBytes,
  }) async {
    String token = await authProvider.getAccessToken(forceRefresh: false);
    Map<String, String> buildHeaders(String bearer) => <String, String>{
          'Authorization': 'Bearer $bearer',
          'Accept': 'application/json',
          if (extraHeaders != null) ...extraHeaders,
        };

    var res = await _executeRawHttp(
      method: method,
      uri: uri,
      headers: buildHeaders(token),
      bodyBytes: bodyBytes,
      timeout: timeout,
    );
    if (res.statusCode == 401) {
      token = await authProvider.getAccessToken(forceRefresh: true);
      res = await _executeRawHttp(
        method: method,
        uri: uri,
        headers: buildHeaders(token),
        bodyBytes: bodyBytes,
        timeout: timeout,
      );
    }
    return res;
  }

  Future<String?> _findAppDataFileId() async {
    final query = "name = '$fileName' and trashed = false";
    final uri = Uri.parse(
      '$_cleanBase/drive/v3/files'
      '?spaces=appDataFolder'
      '&q=${Uri.encodeQueryComponent(query)}'
      '&fields=${Uri.encodeQueryComponent('files(id,name,modifiedTime)')}'
      '&pageSize=5',
    );
    final res = await _authorizedCall(method: 'GET', uri: uri);
    if (res.statusCode != 200) {
      throw VaultCloudSyncException(
        'Google Drive lookup failed (HTTP ${res.statusCode}).',
      );
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) {
      final files = decoded['files'];
      if (files is List && files.isNotEmpty) {
        final first = files.first;
        if (first is Map) {
          final id = (first['id'] ?? '').toString().trim();
          if (id.isNotEmpty) return id;
        }
      }
    }
    return null;
  }

  @override
  Future<String?> downloadEnvelope() async {
    final fileId = await _findAppDataFileId();
    if (fileId == null) return null;
    final uri = Uri.parse(
      '$_cleanBase/drive/v3/files/${Uri.encodeComponent(fileId)}?alt=media',
    );
    final res = await _authorizedCall(method: 'GET', uri: uri);
    if (res.statusCode == 404) return null;
    if (res.statusCode != 200) {
      throw VaultCloudSyncException(
        'Google Drive download failed (HTTP ${res.statusCode}).',
      );
    }
    final trimmed = res.body.trim();
    return trimmed.isEmpty ? null : res.body;
  }

  @override
  Future<void> uploadEnvelope(String sealedJson) async {
    final existingId = await _findAppDataFileId();
    if (existingId != null) {
      final patchUri = Uri.parse(
        '$_cleanBase/upload/drive/v3/files/${Uri.encodeComponent(existingId)}?uploadType=media',
      );
      final res = await _authorizedCall(
        method: 'PATCH',
        uri: patchUri,
        extraHeaders: const <String, String>{
          'Content-Type': 'application/json; charset=utf-8',
        },
        bodyBytes: utf8.encode(sealedJson),
      );
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw VaultCloudSyncException(
          'Google Drive update failed (HTTP ${res.statusCode}).',
        );
      }
      return;
    }

    final boundary = 'jaladesk_appdata_${DateTime.now().microsecondsSinceEpoch}';
    final metadataJson = jsonEncode(<String, Object>{
      'name': fileName,
      'parents': <String>['appDataFolder'],
    });
    final multipartBody = StringBuffer()
      ..write('--$boundary\r\n')
      ..write('Content-Type: application/json; charset=UTF-8\r\n\r\n')
      ..write('$metadataJson\r\n')
      ..write('--$boundary\r\n')
      ..write('Content-Type: application/json; charset=UTF-8\r\n\r\n')
      ..write('$sealedJson\r\n')
      ..write('--$boundary--');

    final createUri = Uri.parse(
      '$_cleanBase/upload/drive/v3/files?uploadType=multipart',
    );
    final res = await _authorizedCall(
      method: 'POST',
      uri: createUri,
      extraHeaders: <String, String>{
        'Content-Type': 'multipart/related; boundary=$boundary',
      },
      bodyBytes: utf8.encode(multipartBody.toString()),
    );
    if (res.statusCode != 200 && res.statusCode != 201) {
      throw VaultCloudSyncException(
        'Google Drive upload failed (HTTP ${res.statusCode}).',
      );
    }
  }
}

/// Adapter 2: Private SSH / SFTP Server Transport (`NoDelaySshSocket` + `dartssh2` + optional Jump Chain).
class SftpVaultSyncTransport implements VaultCloudSyncTransport {
  static const String defaultRemotePath = '.jaladesk/jaladesk-vault.jvault';

  final String host;
  final int port;
  final String username;
  final String password;
  final String privateKeyPem;
  final String remotePath;
  final List<BastionHopSpec> upstreamHops;
  final FutureOr<bool> Function(String keyType, Uint8List fingerprint)? onVerifyHostKey;
  final Duration timeout;

  const SftpVaultSyncTransport({
    required this.host,
    this.port = 22,
    required this.username,
    this.password = '',
    this.privateKeyPem = '',
    this.remotePath = defaultRemotePath,
    this.upstreamHops = const <BastionHopSpec>[],
    this.onVerifyHostKey,
    this.timeout = const Duration(seconds: 15),
  });

  String get _normalizedPath {
    final trimmed = remotePath.trim().replaceAll('\\', '/');
    return trimmed.isEmpty ? defaultRemotePath : trimmed;
  }

  Future<(SshBastionChain?, SSHClient, SftpClient)> _openSession() async {
    final cleanHost = host.trim();
    if (cleanHost.isEmpty) {
      throw const VaultCloudSyncException('Enter an SFTP server host or IP address.');
    }
    SshBastionChain? chain;
    SSHClient? client;
    try {
      final SSHSocket transport;
      if (upstreamHops.isNotEmpty) {
        chain = await SshBastionChain.connect(
          upstreamHops,
          hopTimeout: timeout,
        );
        transport = await chain.openTargetForward(cleanHost, port, timeout: timeout);
      } else {
        transport = await NoDelaySshSocket.connect(cleanHost, port, timeout: timeout);
      }

      List<SSHKeyPair>? identities;
      if (privateKeyPem.trim().isNotEmpty) {
        identities = SshBastionChain.parseOrGetCachedKeys(privateKeyPem, password);
      }

      client = SSHClient(
        transport,
        username: username.trim().isEmpty ? 'root' : username.trim(),
        identities: identities,
        onPasswordRequest: () => password,
        onVerifyHostKey: onVerifyHostKey,
      );
      await client.authenticated.timeout(timeout);
      final sftp = await client.sftp().timeout(timeout);
      return (chain, client, sftp);
    } catch (e) {
      client?.close();
      await chain?.dispose();
      if (e is VaultCloudSyncException) rethrow;
      throw VaultCloudSyncException('SFTP connection failed: $e');
    }
  }

  static Future<void> _ensureParentDirs(SftpClient sftp, String targetPath) async {
    final slashIdx = targetPath.lastIndexOf('/');
    if (slashIdx <= 0) return;
    final parentDir = targetPath.substring(0, slashIdx);
    final isAbs = parentDir.startsWith('/');
    final segments = parentDir.split('/').where((s) => s.isNotEmpty).toList();
    String current = isAbs ? '' : '';
    for (final seg in segments) {
      current = current.isEmpty ? (isAbs ? '/$seg' : seg) : '$current/$seg';
      try {
        final st = await sftp.stat(current);
        if (st.isDirectory) continue;
      } catch (_) {}
      try {
        await sftp.mkdir(current);
      } catch (_) {}
    }
  }

  @override
  Future<String?> downloadEnvelope() async {
    final (chain, client, sftp) = await _openSession();
    try {
      final path = _normalizedPath;
      SftpFile remoteFile;
      try {
        remoteFile = await sftp.open(path, mode: SftpFileOpenMode.read);
      } on SftpStatusError catch (e) {
        if (e.code == SftpStatusCode.noSuchFile) {
          return null;
        }
        throw VaultCloudSyncException('SFTP open failed: ${e.message}');
      }
      try {
        final bytes = await remoteFile.readBytes();
        final text = utf8.decode(bytes, allowMalformed: true);
        return text.trim().isEmpty ? null : text;
      } finally {
        await remoteFile.close();
      }
    } finally {
      sftp.close();
      client.close();
      await chain?.dispose();
    }
  }

  @override
  Future<void> uploadEnvelope(String sealedJson) async {
    final (chain, client, sftp) = await _openSession();
    try {
      final path = _normalizedPath;
      await _ensureParentDirs(sftp, path);
      final payloadBytes = Uint8List.fromList(utf8.encode(sealedJson));
      final tmpPath = '$path.tmp';

      final tmpFile = await sftp.open(
        tmpPath,
        mode: SftpFileOpenMode.create | SftpFileOpenMode.truncate | SftpFileOpenMode.write,
      );
      try {
        const int chunk = 65536;
        int offset = 0;
        while (offset < payloadBytes.length) {
          final end = math.min(offset + chunk, payloadBytes.length);
          final slice = Uint8List.sublistView(payloadBytes, offset, end);
          await tmpFile.writeBytes(slice, offset: offset);
          offset = end;
        }
      } finally {
        await tmpFile.close();
      }

      try {
        try {
          await sftp.remove(path);
        } catch (_) {}
        await sftp.rename(tmpPath, path);
      } catch (_) {
        final directFile = await sftp.open(
          path,
          mode: SftpFileOpenMode.create | SftpFileOpenMode.truncate | SftpFileOpenMode.write,
        );
        try {
          await directFile.writeBytes(payloadBytes);
        } finally {
          await directFile.close();
        }
        try {
          await sftp.remove(tmpPath);
        } catch (_) {}
      }
    } on SftpStatusError catch (e) {
      throw VaultCloudSyncException('SFTP write failed: ${e.message}');
    } finally {
      sftp.close();
      client.close();
      await chain?.dispose();
    }
  }
}

/// Adapter 3: WebDAV Basic-Auth Transport (Nextcloud / OwnCloud / Synology / Private NAS).
class WebDavVaultSyncTransport implements VaultCloudSyncTransport {
  final String fileUrl;
  final String username;
  final String password;
  final Duration timeout;

  const WebDavVaultSyncTransport({
    required this.fileUrl,
    required this.username,
    required this.password,
    this.timeout = const Duration(seconds: 20),
  });

  static bool isLoopbackOrPrivateLanHost(String rawHost) {
    final h = rawHost.trim().toLowerCase();
    if (h == 'localhost' || h == '::1' || h == '[::1]' || h.startsWith('127.')) {
      return true;
    }
    final parts = h.split('.');
    if (parts.length == 4) {
      final o = parts.map(int.tryParse).toList();
      if (o.every((x) => x != null && x >= 0 && x <= 255)) {
        final a = o[0]!;
        final b = o[1]!;
        if (a == 10) return true;
        if (a == 192 && b == 168) return true;
        if (a == 172 && b >= 16 && b <= 31) return true;
      }
    }
    return false;
  }

  Uri _validatedUri() {
    final trimmed = fileUrl.trim();
    final uri = Uri.tryParse(trimmed);
    if (uri == null || uri.host.isEmpty || (uri.scheme != 'https' && uri.scheme != 'http')) {
      throw const VaultCloudSyncException('Enter a valid WebDAV .jvault URL.');
    }
    if (uri.scheme == 'http' && !isLoopbackOrPrivateLanHost(uri.host)) {
      throw const VaultCloudSyncException(
        'WebDAV requires HTTPS over public networks (HTTP is only permitted on private LAN / loopback).',
      );
    }
    return uri;
  }

  Map<String, String> _authHeaders({String? contentType}) {
    final basic = base64Encode(utf8.encode('$username:$password'));
    return <String, String>{
      'Authorization': 'Basic $basic',
      'User-Agent': 'JalaDesk-Mobile',
      if (contentType != null) 'Content-Type': contentType,
    };
  }

  @override
  Future<String?> downloadEnvelope() async {
    final uri = _validatedUri();
    final res = await _executeRawHttp(
      method: 'GET',
      uri: uri,
      headers: _authHeaders(),
      timeout: timeout,
    );
    if (res.statusCode == 404) return null;
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultCloudSyncException(
        'WebDAV authentication rejected (HTTP ${res.statusCode}). Check username & app password.',
      );
    }
    if (res.statusCode != 200) {
      throw VaultCloudSyncException('WebDAV GET failed (HTTP ${res.statusCode}).');
    }
    return res.body.trim().isEmpty ? null : res.body;
  }

  @override
  Future<void> uploadEnvelope(String sealedJson) async {
    final uri = _validatedUri();
    final res = await _executeRawHttp(
      method: 'PUT',
      uri: uri,
      headers: _authHeaders(contentType: 'application/json; charset=utf-8'),
      bodyBytes: utf8.encode(sealedJson),
      timeout: timeout,
    );
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultCloudSyncException(
        'WebDAV authentication rejected (HTTP ${res.statusCode}). Check username & app password.',
      );
    }
    if (res.statusCode == 409) {
      throw const VaultCloudSyncException(
        'WebDAV parent folder does not exist (HTTP 409). Verify the folder path in your URL.',
      );
    }
    if (res.statusCode != 200 && res.statusCode != 201 && res.statusCode != 204) {
      throw VaultCloudSyncException('WebDAV PUT failed (HTTP ${res.statusCode}).');
    }
  }
}

/// Adapter 4: GitHub Secret Gist Transport (`POST /gists`, `GET /gists`, `PATCH /gists/{id}`).
class GitHubGistVaultSyncTransport implements VaultCloudSyncTransport {
  static const String defaultApiBaseUrl = 'https://api.github.com';
  static const String defaultGistFileName = 'jaladesk-vault.jvault';

  final String token;
  final String gistId;
  final String apiBaseUrl;
  final String gistFileName;
  final void Function(String resolvedGistId)? onGistIdResolved;
  final Duration timeout;

  String? _resolvedGistId;

  GitHubGistVaultSyncTransport({
    required this.token,
    this.gistId = '',
    this.apiBaseUrl = defaultApiBaseUrl,
    this.gistFileName = defaultGistFileName,
    this.onGistIdResolved,
    this.timeout = const Duration(seconds: 20),
  }) : _resolvedGistId = gistId.trim().isEmpty ? null : gistId.trim();

  String? get resolvedGistId => _resolvedGistId;

  String get _cleanBase => apiBaseUrl.trim().replaceAll(RegExp(r'/+$'), '');

  Map<String, String> _headers({bool jsonBody = false}) {
    final cleanToken = token.trim();
    if (cleanToken.isEmpty) {
      throw const VaultCloudSyncException(
        'Enter a GitHub Personal Access Token with gist scope.',
      );
    }
    return <String, String>{
      'Authorization': 'Bearer $cleanToken',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'JalaDesk-Mobile',
      if (jsonBody) 'Content-Type': 'application/json; charset=utf-8',
    };
  }

  Future<String?> _discoverExistingVaultGistId() async {
    final uri = Uri.parse('$_cleanBase/gists?per_page=50');
    final res = await _executeRawHttp(
      method: 'GET',
      uri: uri,
      headers: _headers(),
      timeout: timeout,
    );
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultCloudSyncException(
        'GitHub token rejected (HTTP ${res.statusCode}). Ensure the token has gist scope.',
      );
    }
    if (res.statusCode != 200) {
      throw VaultCloudSyncException(
        'GitHub Gist list failed (HTTP ${res.statusCode}).',
      );
    }
    final decoded = jsonDecode(res.body);
    if (decoded is List) {
      String? fallbackPublicMatch;
      for (final entry in decoded) {
        if (entry is Map) {
          final id = (entry['id'] ?? '').toString().trim();
          final files = entry['files'];
          final isPublic = entry['public'] == true;
          if (id.isNotEmpty && files is Map && files.containsKey(gistFileName)) {
            if (!isPublic) {
              _resolvedGistId = id;
              onGistIdResolved?.call(id);
              return id;
            }
            fallbackPublicMatch ??= id;
          }
        }
      }
      if (fallbackPublicMatch != null) {
        _resolvedGistId = fallbackPublicMatch;
        onGistIdResolved?.call(fallbackPublicMatch);
        return fallbackPublicMatch;
      }
    }
    return null;
  }

  @override
  Future<String?> downloadEnvelope() async {
    String? targetId = (_resolvedGistId?.isNotEmpty == true)
        ? _resolvedGistId
        : await _discoverExistingVaultGistId();
    if (targetId == null || targetId.isEmpty) return null;

    final uri = Uri.parse('$_cleanBase/gists/${Uri.encodeComponent(targetId)}');
    final res = await _executeRawHttp(
      method: 'GET',
      uri: uri,
      headers: _headers(),
      timeout: timeout,
    );
    if (res.statusCode == 404) return null;
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultCloudSyncException(
        'GitHub token rejected (HTTP ${res.statusCode}).',
      );
    }
    if (res.statusCode != 200) {
      throw VaultCloudSyncException(
        'GitHub Gist fetch failed (HTTP ${res.statusCode}).',
      );
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map) {
      final files = decoded['files'];
      if (files is Map) {
        final fileObj = files[gistFileName];
        if (fileObj is Map) {
          final isTruncated = fileObj['truncated'] == true;
          final rawUrl = (fileObj['raw_url'] ?? '').toString().trim();
          if (isTruncated && rawUrl.isNotEmpty) {
            final rawRes = await _executeRawHttp(
              method: 'GET',
              uri: Uri.parse(rawUrl),
              headers: _headers(),
              timeout: timeout,
            );
            if (rawRes.statusCode == 200) {
              return rawRes.body.trim().isEmpty ? null : rawRes.body;
            }
          }
          final content = (fileObj['content'] ?? '').toString();
          return content.trim().isEmpty ? null : content;
        }
      }
    }
    return null;
  }

  @override
  Future<void> uploadEnvelope(String sealedJson) async {
    String? targetId = (_resolvedGistId?.isNotEmpty == true)
        ? _resolvedGistId
        : await _discoverExistingVaultGistId();

    if (targetId == null || targetId.isEmpty) {
      final createUri = Uri.parse('$_cleanBase/gists');
      final createBody = jsonEncode(<String, Object>{
        'description': 'JalaDesk Encrypted Vault (.jvault)',
        'public': false,
        'files': <String, Object>{
          gistFileName: <String, String>{'content': sealedJson},
        },
      });
      final res = await _executeRawHttp(
        method: 'POST',
        uri: createUri,
        headers: _headers(jsonBody: true),
        bodyBytes: utf8.encode(createBody),
        timeout: timeout,
      );
      if (res.statusCode != 201 && res.statusCode != 200) {
        throw VaultCloudSyncException(
          'GitHub Gist create failed (HTTP ${res.statusCode}).',
        );
      }
      final decoded = jsonDecode(res.body);
      if (decoded is Map) {
        final createdId = (decoded['id'] ?? '').toString().trim();
        if (createdId.isNotEmpty) {
          _resolvedGistId = createdId;
          onGistIdResolved?.call(createdId);
        }
      }
      return;
    }

    final patchUri = Uri.parse('$_cleanBase/gists/${Uri.encodeComponent(targetId)}');
    final patchBody = jsonEncode(<String, Object>{
      'description': 'JalaDesk Encrypted Vault (.jvault)',
      'files': <String, Object>{
        gistFileName: <String, String>{'content': sealedJson},
      },
    });
    final res = await _executeRawHttp(
      method: 'PATCH',
      uri: patchUri,
      headers: _headers(jsonBody: true),
      bodyBytes: utf8.encode(patchBody),
      timeout: timeout,
    );
    if (res.statusCode != 200) {
      throw VaultCloudSyncException(
        'GitHub Gist update failed (HTTP ${res.statusCode}).',
      );
    }
    _resolvedGistId = targetId;
  }
}

class SftpSyncHostPreset {
  final String id;
  final String name;
  final String host;
  final int port;
  final String username;
  final String password;
  final String privateKeyPem;
  final bool isJumpHost;
  final List<BastionHopSpec> upstreamHops;

  const SftpSyncHostPreset({
    required this.id,
    required this.name,
    required this.host,
    required this.port,
    required this.username,
    this.password = '',
    this.privateKeyPem = '',
    this.isJumpHost = false,
    this.upstreamHops = const <BastionHopSpec>[],
  });

  String get displayLabel =>
      '${isJumpHost ? "[Gateway] " : ""}$name ($username@$host:$port)';
}

class VaultSyncConfig {
  final bool isBound;
  final VaultSyncProviderKind provider;
  final String syncPassphrase;
  final bool autoSyncEnabled;
  final int lastSyncedAtMs;

  final String googleAccountEmail;
  final String googleDisplayName;
  final String googleApiBaseUrl;

  final String sftpHost;
  final int sftpPort;
  final String sftpUsername;
  final String sftpPassword;
  final String sftpPrivateKeyPem;
  final String sftpRemotePath;
  final String? sftpPresetHostId;

  final String webdavUrl;
  final String webdavUsername;
  final String webdavPassword;

  final String githubToken;
  final String githubGistId;
  final String githubApiBaseUrl;

  const VaultSyncConfig({
    this.isBound = false,
    this.provider = VaultSyncProviderKind.googleDrive,
    this.syncPassphrase = '',
    this.autoSyncEnabled = true,
    this.lastSyncedAtMs = 0,
    this.googleAccountEmail = '',
    this.googleDisplayName = '',
    this.googleApiBaseUrl = GoogleDriveAppDataSyncTransport.defaultApiBaseUrl,
    this.sftpHost = '',
    this.sftpPort = 22,
    this.sftpUsername = 'root',
    this.sftpPassword = '',
    this.sftpPrivateKeyPem = '',
    this.sftpRemotePath = SftpVaultSyncTransport.defaultRemotePath,
    this.sftpPresetHostId,
    this.webdavUrl = '',
    this.webdavUsername = '',
    this.webdavPassword = '',
    this.githubToken = '',
    this.githubGistId = '',
    this.githubApiBaseUrl = GitHubGistVaultSyncTransport.defaultApiBaseUrl,
  });

  String get accountSummary {
    switch (provider) {
      case VaultSyncProviderKind.googleDrive:
        return googleAccountEmail.trim().isNotEmpty
            ? googleAccountEmail.trim()
            : 'AppData';
      case VaultSyncProviderKind.sftp:
        final h = sftpHost.trim();
        if (h.isEmpty) return 'SSH Endpoint';
        final u = sftpUsername.trim().isEmpty ? 'root' : sftpUsername.trim();
        return '$u@$h:$sftpPort';
      case VaultSyncProviderKind.webdav:
        final parsed = Uri.tryParse(webdavUrl.trim());
        if (parsed != null && parsed.host.isNotEmpty) {
          return parsed.hasPort && parsed.port != 443 && parsed.port != 80
              ? '${parsed.host}:${parsed.port}'
              : parsed.host;
        }
        return 'WebDAV Endpoint';
      case VaultSyncProviderKind.githubGist:
        final g = githubGistId.trim();
        if (g.isNotEmpty) {
          final shortId = g.length > 8 ? g.substring(0, 8) : g;
          return 'Gist $shortId';
        }
        return 'Secret Gist';
    }
  }

  VaultSyncConfig copyWith({
    bool? isBound,
    VaultSyncProviderKind? provider,
    String? syncPassphrase,
    bool? autoSyncEnabled,
    int? lastSyncedAtMs,
    String? googleAccountEmail,
    String? googleDisplayName,
    String? googleApiBaseUrl,
    String? sftpHost,
    int? sftpPort,
    String? sftpUsername,
    String? sftpPassword,
    String? sftpPrivateKeyPem,
    String? sftpRemotePath,
    String? sftpPresetHostId,
    bool clearSftpPresetHostId = false,
    String? webdavUrl,
    String? webdavUsername,
    String? webdavPassword,
    String? githubToken,
    String? githubGistId,
    String? githubApiBaseUrl,
  }) {
    return VaultSyncConfig(
      isBound: isBound ?? this.isBound,
      provider: provider ?? this.provider,
      syncPassphrase: syncPassphrase ?? this.syncPassphrase,
      autoSyncEnabled: autoSyncEnabled ?? this.autoSyncEnabled,
      lastSyncedAtMs: lastSyncedAtMs ?? this.lastSyncedAtMs,
      googleAccountEmail: googleAccountEmail ?? this.googleAccountEmail,
      googleDisplayName: googleDisplayName ?? this.googleDisplayName,
      googleApiBaseUrl: googleApiBaseUrl ?? this.googleApiBaseUrl,
      sftpHost: sftpHost ?? this.sftpHost,
      sftpPort: sftpPort ?? this.sftpPort,
      sftpUsername: sftpUsername ?? this.sftpUsername,
      sftpPassword: sftpPassword ?? this.sftpPassword,
      sftpPrivateKeyPem: sftpPrivateKeyPem ?? this.sftpPrivateKeyPem,
      sftpRemotePath: sftpRemotePath ?? this.sftpRemotePath,
      sftpPresetHostId:
          clearSftpPresetHostId ? null : (sftpPresetHostId ?? this.sftpPresetHostId),
      webdavUrl: webdavUrl ?? this.webdavUrl,
      webdavUsername: webdavUsername ?? this.webdavUsername,
      webdavPassword: webdavPassword ?? this.webdavPassword,
      githubToken: githubToken ?? this.githubToken,
      githubGistId: githubGistId ?? this.githubGistId,
      githubApiBaseUrl: githubApiBaseUrl ?? this.githubApiBaseUrl,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'isBound': isBound,
        'provider': provider.name,
        'syncPassphrase': syncPassphrase,
        'autoSyncEnabled': autoSyncEnabled,
        'lastSyncedAtMs': lastSyncedAtMs,
        'googleAccountEmail': googleAccountEmail,
        'googleDisplayName': googleDisplayName,
        'googleApiBaseUrl': googleApiBaseUrl,
        'sftpHost': sftpHost,
        'sftpPort': sftpPort,
        'sftpUsername': sftpUsername,
        'sftpPassword': sftpPassword,
        'sftpPrivateKeyPem': sftpPrivateKeyPem,
        'sftpRemotePath': sftpRemotePath,
        'sftpPresetHostId': sftpPresetHostId,
        'webdavUrl': webdavUrl,
        'webdavUsername': webdavUsername,
        'webdavPassword': webdavPassword,
        'githubToken': githubToken,
        'githubGistId': githubGistId,
        'githubApiBaseUrl': githubApiBaseUrl,
      };

  factory VaultSyncConfig.fromJson(Map<String, dynamic> json) {
    final rawPreset = (json['sftpPresetHostId'] as String?)?.trim();
    return VaultSyncConfig(
      isBound: json['isBound'] as bool? ?? false,
      provider: VaultSyncProviderKind.fromName(json['provider'] as String?),
      syncPassphrase: json['syncPassphrase'] as String? ?? '',
      autoSyncEnabled: json['autoSyncEnabled'] as bool? ?? true,
      lastSyncedAtMs: (json['lastSyncedAtMs'] as num?)?.toInt() ?? 0,
      googleAccountEmail: json['googleAccountEmail'] as String? ?? '',
      googleDisplayName: json['googleDisplayName'] as String? ?? '',
      googleApiBaseUrl: (json['googleApiBaseUrl'] as String?)?.trim().isNotEmpty == true
          ? (json['googleApiBaseUrl'] as String).trim()
          : GoogleDriveAppDataSyncTransport.defaultApiBaseUrl,
      sftpHost: json['sftpHost'] as String? ?? '',
      sftpPort: ((json['sftpPort'] as num?)?.toInt() ?? 22).clamp(1, 65535),
      sftpUsername: json['sftpUsername'] as String? ?? 'root',
      sftpPassword: json['sftpPassword'] as String? ?? '',
      sftpPrivateKeyPem: json['sftpPrivateKeyPem'] as String? ?? '',
      sftpRemotePath: (json['sftpRemotePath'] as String?)?.trim().isNotEmpty == true
          ? (json['sftpRemotePath'] as String).trim()
          : SftpVaultSyncTransport.defaultRemotePath,
      sftpPresetHostId: (rawPreset == null || rawPreset.isEmpty) ? null : rawPreset,
      webdavUrl: json['webdavUrl'] as String? ?? '',
      webdavUsername: json['webdavUsername'] as String? ?? '',
      webdavPassword: json['webdavPassword'] as String? ?? '',
      githubToken: json['githubToken'] as String? ?? '',
      githubGistId: json['githubGistId'] as String? ?? '',
      githubApiBaseUrl: (json['githubApiBaseUrl'] as String?)?.trim().isNotEmpty == true
          ? (json['githubApiBaseUrl'] as String).trim()
          : GitHubGistVaultSyncTransport.defaultApiBaseUrl,
    );
  }
}

class VaultSyncRunSummary {
  final VaultSyncConfig updatedConfig;
  final String message;
  final int connectionCount;
  final int gatewayCount;

  const VaultSyncRunSummary({
    required this.updatedConfig,
    required this.message,
    required this.connectionCount,
    required this.gatewayCount,
  });
}

String formatSyncRelativeTime(int lastSyncedAtMs, {DateTime? now}) {
  if (lastSyncedAtMs <= 0) return 'Never synced';
  final ref = now ?? DateTime.now();
  final diffSec = math.max(0, (ref.millisecondsSinceEpoch - lastSyncedAtMs) ~/ 1000);
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return '${diffSec}s ago';
  final diffMin = diffSec ~/ 60;
  if (diffMin < 60) return '${diffMin}m ago';
  final diffHr = diffMin ~/ 60;
  if (diffHr < 24) return '${diffHr}h ago';
  final diffDays = diffHr ~/ 24;
  return '${diffDays}d ago';
}

/// Full-Screen Zero-Knowledge E2EE Cloud Sync Studio (`#090E17 -> #0D1522`).
/// Responsive across Portrait (`412×915`) and Oppo Find X9 Pro Landscape (`915×412`).
class VaultCloudSyncScreen extends StatefulWidget {
  final VaultSyncConfig initialConfig;
  final List<SftpSyncHostPreset> sftpPresets;
  final GoogleAuthTokenProvider googleAuthProvider;
  final Future<VaultSyncRunSummary> Function(
    VaultSyncConfig draftConfig,
    VaultSyncOperationMode mode,
  ) onExecuteSync;
  final Future<void> Function() onUnbindSync;
  final void Function(VaultSyncConfig updatedConfig)? onConfigChanged;

  const VaultCloudSyncScreen({
    super.key,
    required this.initialConfig,
    required this.sftpPresets,
    required this.googleAuthProvider,
    required this.onExecuteSync,
    required this.onUnbindSync,
    this.onConfigChanged,
  });

  @override
  State<VaultCloudSyncScreen> createState() => _VaultCloudSyncScreenState();
}

class _VaultCloudSyncScreenState extends State<VaultCloudSyncScreen> {
  late VaultSyncProviderKind _selectedProvider;
  late bool _isBound;
  late bool _autoSyncEnabled;
  late int _lastSyncedAtMs;
  late String _googleEmail;
  late String _googleDisplayName;
  late String? _selectedSftpPresetId;
  bool _sftpUsePrivateKey = false;
  bool _obscurePassphrase = true;
  bool _obscureProviderSecret = true;
  bool _busy = false;
  String? _statusFeedback;
  bool _statusIsError = false;
  GoogleOAuthConfigurationException? _oauthSetupDiagnostic;

  late final TextEditingController _passphraseCtrl;
  late final TextEditingController _sftpHostCtrl;
  late final TextEditingController _sftpPortCtrl;
  late final TextEditingController _sftpUserCtrl;
  late final TextEditingController _sftpPasswordCtrl;
  late final TextEditingController _sftpKeyCtrl;
  late final TextEditingController _sftpPathCtrl;
  late final TextEditingController _webdavUrlCtrl;
  late final TextEditingController _webdavUserCtrl;
  late final TextEditingController _webdavPasswordCtrl;
  late final TextEditingController _githubTokenCtrl;
  late final TextEditingController _githubGistIdCtrl;

  @override
  void initState() {
    super.initState();
    final cfg = widget.initialConfig;
    _selectedProvider = cfg.provider;
    _isBound = cfg.isBound;
    _autoSyncEnabled = cfg.autoSyncEnabled;
    _lastSyncedAtMs = cfg.lastSyncedAtMs;
    _googleEmail = cfg.googleAccountEmail;
    _googleDisplayName = cfg.googleDisplayName;
    final currentAcc = widget.googleAuthProvider.currentAccount;
    if (_googleEmail.isEmpty && currentAcc != null) {
      _googleEmail = currentAcc.email;
      _googleDisplayName = currentAcc.displayName;
    }
    _selectedSftpPresetId = cfg.sftpPresetHostId;
    _sftpUsePrivateKey =
        cfg.sftpPrivateKeyPem.trim().isNotEmpty && cfg.sftpPassword.isEmpty;

    _passphraseCtrl = TextEditingController(text: cfg.syncPassphrase);
    _sftpHostCtrl = TextEditingController(text: cfg.sftpHost);
    _sftpPortCtrl = TextEditingController(text: '${cfg.sftpPort}');
    _sftpUserCtrl = TextEditingController(
      text: cfg.sftpUsername.isEmpty ? 'root' : cfg.sftpUsername,
    );
    _sftpPasswordCtrl = TextEditingController(text: cfg.sftpPassword);
    _sftpKeyCtrl = TextEditingController(text: cfg.sftpPrivateKeyPem);
    _sftpPathCtrl = TextEditingController(text: cfg.sftpRemotePath);
    _webdavUrlCtrl = TextEditingController(text: cfg.webdavUrl);
    _webdavUserCtrl = TextEditingController(text: cfg.webdavUsername);
    _webdavPasswordCtrl = TextEditingController(text: cfg.webdavPassword);
    _githubTokenCtrl = TextEditingController(text: cfg.githubToken);
    _githubGistIdCtrl = TextEditingController(text: cfg.githubGistId);
  }

  @override
  void dispose() {
    _passphraseCtrl.dispose();
    _sftpHostCtrl.dispose();
    _sftpPortCtrl.dispose();
    _sftpUserCtrl.dispose();
    _sftpPasswordCtrl.dispose();
    _sftpKeyCtrl.dispose();
    _sftpPathCtrl.dispose();
    _webdavUrlCtrl.dispose();
    _webdavUserCtrl.dispose();
    _webdavPasswordCtrl.dispose();
    _githubTokenCtrl.dispose();
    _githubGistIdCtrl.dispose();
    super.dispose();
  }

  VaultSyncConfig _collectDraftConfig() {
    final parsedPort = (int.tryParse(_sftpPortCtrl.text.trim()) ?? 22).clamp(1, 65535);
    return widget.initialConfig.copyWith(
      isBound: _isBound,
      provider: _selectedProvider,
      syncPassphrase: _passphraseCtrl.text,
      autoSyncEnabled: _autoSyncEnabled,
      lastSyncedAtMs: _lastSyncedAtMs,
      googleAccountEmail: _googleEmail.trim(),
      googleDisplayName: _googleDisplayName.trim(),
      sftpHost: _sftpHostCtrl.text.trim(),
      sftpPort: parsedPort,
      sftpUsername: _sftpUserCtrl.text.trim().isEmpty ? 'root' : _sftpUserCtrl.text.trim(),
      sftpPassword: _sftpUsePrivateKey ? _sftpPasswordCtrl.text : _sftpPasswordCtrl.text,
      sftpPrivateKeyPem: _sftpUsePrivateKey ? _sftpKeyCtrl.text.trim() : '',
      sftpRemotePath: _sftpPathCtrl.text.trim().isEmpty
          ? SftpVaultSyncTransport.defaultRemotePath
          : _sftpPathCtrl.text.trim(),
      sftpPresetHostId: _selectedSftpPresetId,
      clearSftpPresetHostId: _selectedSftpPresetId == null,
      webdavUrl: _webdavUrlCtrl.text.trim(),
      webdavUsername: _webdavUserCtrl.text.trim(),
      webdavPassword: _webdavPasswordCtrl.text,
      githubToken: _githubTokenCtrl.text.trim(),
      githubGistId: _githubGistIdCtrl.text.trim(),
    );
  }

  void _applySftpPreset(SftpSyncHostPreset preset) {
    setState(() {
      _selectedSftpPresetId = preset.id;
      _sftpHostCtrl.text = preset.host;
      _sftpPortCtrl.text = '${preset.port}';
      _sftpUserCtrl.text = preset.username.isEmpty ? 'root' : preset.username;
      _sftpPasswordCtrl.text = preset.password;
      _sftpKeyCtrl.text = preset.privateKeyPem;
      _sftpUsePrivateKey = preset.privateKeyPem.trim().isNotEmpty;
      _statusFeedback = 'Populated endpoint from ${preset.name}';
      _statusIsError = false;
    });
  }

  Future<void> _handleGoogleSignIn() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _statusFeedback = null;
      _oauthSetupDiagnostic = null;
    });
    try {
      final account = await widget.googleAuthProvider.signIn();
      if (!mounted) return;
      if (account == null) {
        setState(() {
          _busy = false;
          _statusFeedback = 'Google Sign-In cancelled.';
          _statusIsError = false;
        });
        return;
      }
      setState(() {
        _busy = false;
        _googleEmail = account.email;
        _googleDisplayName = account.displayName;
        _statusFeedback = 'Connected as ${account.email}';
        _statusIsError = false;
      });
    } on GoogleOAuthConfigurationException catch (oauthErr) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _oauthSetupDiagnostic = oauthErr;
        _statusFeedback = null;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _statusFeedback = err.toString();
        _statusIsError = true;
      });
    }
  }

  Future<void> _handleGoogleSignOut() async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.googleAuthProvider.signOut();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _googleEmail = '';
      _googleDisplayName = '';
      _statusFeedback = 'Google account disconnected.';
      _statusIsError = false;
    });
  }

  Future<void> _runSyncOperation(VaultSyncOperationMode mode) async {
    if (_busy) return;
    FocusScope.of(context).unfocus();
    final draft = _collectDraftConfig();
    if (draft.syncPassphrase.trim().length < 4) {
      setState(() {
        _statusFeedback = 'Sync Passphrase must be at least 4 characters.';
        _statusIsError = true;
      });
      return;
    }

    setState(() {
      _busy = true;
      _statusFeedback = null;
      _oauthSetupDiagnostic = null;
    });

    try {
      final summary = await widget.onExecuteSync(draft, mode);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _isBound = summary.updatedConfig.isBound;
        _lastSyncedAtMs = summary.updatedConfig.lastSyncedAtMs;
        if (summary.updatedConfig.githubGistId.isNotEmpty) {
          _githubGistIdCtrl.text = summary.updatedConfig.githubGistId;
        }
        if (summary.updatedConfig.googleAccountEmail.isNotEmpty) {
          _googleEmail = summary.updatedConfig.googleAccountEmail;
        }
        _statusFeedback = summary.message;
        _statusIsError = false;
      });
    } on GoogleOAuthConfigurationException catch (oauthErr) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _oauthSetupDiagnostic = oauthErr;
        _statusFeedback = null;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _statusFeedback = err.toString().replaceFirst('Exception: ', '');
        _statusIsError = true;
      });
    }
  }

  Future<void> _handleUnbind() async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.onUnbindSync();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _isBound = false;
      _lastSyncedAtMs = 0;
      _statusFeedback = 'Cloud sync unbound. Local vault remains intact.';
      _statusIsError = false;
    });
  }

  void _copyValue(String value, String label) {
    Clipboard.setData(ClipboardData(text: value));
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Copied $label')),
    );
  }

  InputDecoration _fieldDecoration({
    required String label,
    String? hint,
    IconData? icon,
    Widget? suffixIcon,
  }) {
    return InputDecoration(
      labelText: label,
      hintText: hint,
      labelStyle: const TextStyle(fontSize: 11.5, color: _kSyncText2),
      hintStyle: const TextStyle(fontSize: 11.5, color: _kSyncMuted),
      prefixIcon: icon != null ? Icon(icon, size: 17, color: _kSyncGold) : null,
      suffixIcon: suffixIcon,
      isDense: true,
      filled: true,
      fillColor: _kSyncFieldFill,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(9),
        borderSide: const BorderSide(color: _kSyncInputBorder),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(9),
        borderSide: const BorderSide(color: _kSyncAccentLine, width: 1.3),
      ),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(9),
        borderSide: const BorderSide(color: _kSyncInputBorder),
      ),
    );
  }

  Widget _buildSegmentedProviderBar() {
    return Container(
      key: const Key('cloud_sync_provider_bar'),
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: _kSyncFieldFill,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: _kSyncBorder),
      ),
      child: Row(
        children: [
          for (final p in VaultSyncProviderKind.values)
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2),
                child: Material(
                  color: _selectedProvider == p ? _kSyncSelected : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                  child: InkWell(
                    key: ValueKey('sync_provider_${p.name}'),
                    borderRadius: BorderRadius.circular(8),
                    onTap: _busy
                        ? null
                        : () {
                            setState(() {
                              _selectedProvider = p;
                              _statusFeedback = null;
                              _oauthSetupDiagnostic = null;
                            });
                          },
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: _selectedProvider == p
                              ? _kSyncGold.withValues(alpha: 0.65)
                              : Colors.transparent,
                        ),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            p.icon,
                            size: 14.5,
                            color: _selectedProvider == p ? _kSyncGold : _kSyncMuted,
                          ),
                          const SizedBox(width: 5),
                          Flexible(
                            child: Text(
                              p.pillLabel,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 11.5,
                                fontWeight: _selectedProvider == p
                                    ? FontWeight.w700
                                    : FontWeight.w600,
                                color: _selectedProvider == p ? _kSyncText : _kSyncMuted,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildProviderPanel() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _kSyncSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _kSyncBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(_selectedProvider.icon, size: 17, color: _kSyncGold),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _selectedProvider.label,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                    color: _kSyncText,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Text(
                _selectedProvider.subtitle,
                style: const TextStyle(fontSize: 11, color: _kSyncMuted),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
          const SizedBox(height: 12),
          switch (_selectedProvider) {
            VaultSyncProviderKind.googleDrive => _buildGoogleDriveFields(),
            VaultSyncProviderKind.sftp => _buildSftpFields(),
            VaultSyncProviderKind.webdav => _buildWebDavFields(),
            VaultSyncProviderKind.githubGist => _buildGitHubFields(),
          },
        ],
      ),
    );
  }

  Widget _buildGoogleDriveFields() {
    final signedIn = _googleEmail.trim().isNotEmpty;
    final initialChar = signedIn ? _googleEmail.trim()[0].toUpperCase() : 'G';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!signedIn) ...[
          const Text(
            'Stores a hidden encrypted snapshot inside your private Google Drive AppData folder.',
            style: TextStyle(fontSize: 12, color: _kSyncText2, height: 1.35),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            key: const Key('btn_google_sync_signin'),
            style: FilledButton.styleFrom(
              backgroundColor: _kSyncSelected,
              foregroundColor: _kSyncText,
              side: BorderSide(color: _kSyncGold.withValues(alpha: 0.55)),
              padding: const EdgeInsets.symmetric(vertical: 11, horizontal: 14),
            ),
            onPressed: _busy ? null : _handleGoogleSignIn,
            icon: const Icon(Icons.account_circle_outlined, size: 18, color: _kSyncGold),
            label: const Text(
              'Sign in with Google',
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
            ),
          ),
        ] else ...[
          Row(
            children: [
              CircleAvatar(
                radius: 17,
                backgroundColor: _kSyncSelected,
                child: Text(
                  initialChar,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: _kSyncGold,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _googleEmail,
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: _kSyncText,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const Text(
                      'AppData scope • Hidden from public Drive files',
                      style: TextStyle(fontSize: 11, color: _kSyncOk),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              TextButton(
                key: const Key('btn_google_sync_signout'),
                style: TextButton.styleFrom(
                  foregroundColor: _kSyncDanger,
                  visualDensity: VisualDensity.compact,
                ),
                onPressed: _busy ? null : _handleGoogleSignOut,
                child: const Text(
                  'Disconnect',
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ],
        if (_oauthSetupDiagnostic != null) ...[
          const SizedBox(height: 12),
          const Divider(height: 1, color: _kSyncBorder),
          const SizedBox(height: 10),
          const Row(
            children: [
              Icon(Icons.info_outline_rounded, size: 16, color: _kSyncGold),
              SizedBox(width: 6),
              Expanded(
                child: Text(
                  'Google Cloud OAuth Setup Needed',
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: _kSyncGold,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'Register an Android OAuth 2.0 Client ID in Google Cloud Console with Drive API enabled, or switch to SFTP / WebDAV / GitHub right now:',
            style: TextStyle(fontSize: 11.5, color: _kSyncText2, height: 1.35),
          ),
          const SizedBox(height: 8),
          _buildCopyableIdentityRow(
            label: 'Package',
            value: _oauthSetupDiagnostic!.packageName,
            copyKey: const Key('btn_copy_oauth_pkg'),
          ),
          const SizedBox(height: 6),
          _buildCopyableIdentityRow(
            label: 'SHA-1',
            value: _oauthSetupDiagnostic!.uploadKeySha1,
            copyKey: const Key('btn_copy_oauth_sha1'),
          ),
        ],
      ],
    );
  }

  Widget _buildCopyableIdentityRow({
    required String label,
    required String value,
    required Key copyKey,
  }) {
    return Row(
      children: [
        SizedBox(
          width: 56,
          child: Text(
            label,
            style: const TextStyle(fontSize: 11, color: _kSyncMuted, fontWeight: FontWeight.w600),
          ),
        ),
        Expanded(
          child: SelectableText(
            value,
            maxLines: 1,
            style: const TextStyle(
              fontSize: 11,
              fontFamily: 'monospace',
              color: _kSyncText,
            ),
          ),
        ),
        IconButton(
          key: copyKey,
          visualDensity: VisualDensity.compact,
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          padding: EdgeInsets.zero,
          tooltip: 'Copy $label',
          onPressed: () => _copyValue(value, label),
          icon: const Icon(Icons.copy_rounded, size: 15, color: _kSyncGold),
        ),
      ],
    );
  }

  Widget _buildSftpFields() {
    final presets = widget.sftpPresets;
    final validPresetId =
        presets.any((p) => p.id == _selectedSftpPresetId) ? _selectedSftpPresetId : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (presets.isNotEmpty) ...[
          DropdownButtonFormField<String>(
            key: const Key('dropdown_sftp_sync_preset'),
            initialValue: validPresetId,
            isExpanded: true,
            dropdownColor: _kSyncSurface,
            style: const TextStyle(fontSize: 12, color: _kSyncText),
            decoration: _fieldDecoration(
              label: 'Quick Fill from Saved SSH / Jump Host',
              icon: Icons.bolt_rounded,
            ),
            items: [
              for (final p in presets)
                DropdownMenuItem<String>(
                  value: p.id,
                  child: Text(
                    p.displayLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
            onChanged: _busy
                ? null
                : (selectedId) {
                    if (selectedId == null) return;
                    final match = presets.firstWhere((p) => p.id == selectedId);
                    _applySftpPreset(match);
                  },
          ),
          const SizedBox(height: 10),
        ],
        Row(
          children: [
            Expanded(
              flex: 3,
              child: TextField(
                key: const Key('field_sync_sftp_host'),
                controller: _sftpHostCtrl,
                style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace', color: _kSyncText),
                decoration: _fieldDecoration(
                  label: 'Host / IP *',
                  hint: 'sftp.example.internal',
                  icon: Icons.lan_outlined,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              flex: 1,
              child: TextField(
                key: const Key('field_sync_sftp_port'),
                controller: _sftpPortCtrl,
                keyboardType: TextInputType.number,
                style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace', color: _kSyncText),
                decoration: _fieldDecoration(label: 'Port', hint: '22'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('field_sync_sftp_user'),
                controller: _sftpUserCtrl,
                style: const TextStyle(fontSize: 12.5, color: _kSyncText),
                decoration: _fieldDecoration(
                  label: 'Username',
                  hint: 'root',
                  icon: Icons.person_outline_rounded,
                ),
              ),
            ),
            const SizedBox(width: 8),
            OutlinedButton.icon(
              key: const Key('toggle_sync_sftp_auth_mode'),
              style: OutlinedButton.styleFrom(
                foregroundColor: _kSyncGold,
                side: const BorderSide(color: _kSyncInputBorder),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
              ),
              onPressed: _busy
                  ? null
                  : () => setState(() => _sftpUsePrivateKey = !_sftpUsePrivateKey),
              icon: Icon(
                _sftpUsePrivateKey ? Icons.vpn_key_rounded : Icons.password_rounded,
                size: 15,
              ),
              label: Text(
                _sftpUsePrivateKey ? 'SSH Key' : 'Password',
                style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (_sftpUsePrivateKey)
          TextField(
            key: const Key('field_sync_sftp_key'),
            controller: _sftpKeyCtrl,
            maxLines: 3,
            style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: _kSyncText),
            decoration: _fieldDecoration(
              label: 'OpenSSH / PEM Private Key *',
              hint: '-----BEGIN OPENSSH PRIVATE KEY-----',
            ),
          )
        else
          TextField(
            key: const Key('field_sync_sftp_password'),
            controller: _sftpPasswordCtrl,
            obscureText: _obscureProviderSecret,
            style: const TextStyle(fontSize: 12.5, color: _kSyncText),
            decoration: _fieldDecoration(
              label: 'SSH Password',
              icon: Icons.key_rounded,
              suffixIcon: IconButton(
                visualDensity: VisualDensity.compact,
                onPressed: () =>
                    setState(() => _obscureProviderSecret = !_obscureProviderSecret),
                icon: Icon(
                  _obscureProviderSecret
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                  size: 17,
                  color: _kSyncMuted,
                ),
              ),
            ),
          ),
        const SizedBox(height: 10),
        TextField(
          key: const Key('field_sync_sftp_path'),
          controller: _sftpPathCtrl,
          style: const TextStyle(fontSize: 12, fontFamily: 'monospace', color: _kSyncText),
          decoration: _fieldDecoration(
            label: 'Vault Path',
            hint: SftpVaultSyncTransport.defaultRemotePath,
            icon: Icons.folder_zip_outlined,
          ),
        ),
      ],
    );
  }

  Widget _buildWebDavFields() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const Key('field_sync_webdav_url'),
          controller: _webdavUrlCtrl,
          keyboardType: TextInputType.url,
          style: const TextStyle(fontSize: 12, fontFamily: 'monospace', color: _kSyncText),
          decoration: _fieldDecoration(
            label: 'File URL (HTTPS) *',
            hint: 'https://cloud.example.com/remote.php/dav/files/user/jaladesk.jvault',
            icon: Icons.link_rounded,
          ),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('field_sync_webdav_user'),
                controller: _webdavUserCtrl,
                style: const TextStyle(fontSize: 12.5, color: _kSyncText),
                decoration: _fieldDecoration(
                  label: 'Username',
                  icon: Icons.person_outline_rounded,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: TextField(
                key: const Key('field_sync_webdav_password'),
                controller: _webdavPasswordCtrl,
                obscureText: _obscureProviderSecret,
                style: const TextStyle(fontSize: 12.5, color: _kSyncText),
                decoration: _fieldDecoration(
                  label: 'App Password',
                  icon: Icons.key_rounded,
                  suffixIcon: IconButton(
                    visualDensity: VisualDensity.compact,
                    onPressed: () =>
                        setState(() => _obscureProviderSecret = !_obscureProviderSecret),
                    icon: Icon(
                      _obscureProviderSecret
                          ? Icons.visibility_outlined
                          : Icons.visibility_off_outlined,
                      size: 17,
                      color: _kSyncMuted,
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

  Widget _buildGitHubFields() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const Key('field_sync_github_token'),
          controller: _githubTokenCtrl,
          obscureText: _obscureProviderSecret,
          style: const TextStyle(fontSize: 12, fontFamily: 'monospace', color: _kSyncText),
          decoration: _fieldDecoration(
            label: 'Personal Access Token (gist scope) *',
            hint: 'ghp_... or github_pat_...',
            icon: Icons.vpn_key_outlined,
            suffixIcon: IconButton(
              visualDensity: VisualDensity.compact,
              onPressed: () =>
                  setState(() => _obscureProviderSecret = !_obscureProviderSecret),
              icon: Icon(
                _obscureProviderSecret
                    ? Icons.visibility_outlined
                    : Icons.visibility_off_outlined,
                size: 17,
                color: _kSyncMuted,
              ),
            ),
          ),
        ),
        const SizedBox(height: 10),
        TextField(
          key: const Key('field_sync_github_gist_id'),
          controller: _githubGistIdCtrl,
          style: const TextStyle(fontSize: 12, fontFamily: 'monospace', color: _kSyncText),
          decoration: _fieldDecoration(
            label: 'Gist ID (auto-detected if blank)',
            hint: 'Leave blank to auto-create or find secret gist',
            icon: Icons.tag_rounded,
          ),
        ),
      ],
    );
  }

  Widget _buildEncryptionAndActionsPanel() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _kSyncSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _kSyncBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Row(
            children: [
              Icon(Icons.enhanced_encryption_rounded, size: 17, color: _kSyncGold),
              SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Zero-Knowledge Encryption',
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                    color: _kSyncText,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          TextField(
            key: const Key('field_cloud_sync_passphrase'),
            controller: _passphraseCtrl,
            obscureText: _obscurePassphrase,
            style: const TextStyle(fontSize: 12.5, color: _kSyncText),
            decoration: _fieldDecoration(
              label: 'Sync Passphrase *',
              hint: 'Min 4 chars • AES-256-GCM + PBKDF2',
              icon: Icons.lock_outline_rounded,
              suffixIcon: IconButton(
                key: const Key('btn_toggle_sync_passphrase_visibility'),
                visualDensity: VisualDensity.compact,
                onPressed: () =>
                    setState(() => _obscurePassphrase = !_obscurePassphrase),
                icon: Icon(
                  _obscurePassphrase
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                  size: 17,
                  color: _kSyncMuted,
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            'Encrypts your vault before upload. Never shared with cloud provider.',
            style: TextStyle(fontSize: 11, color: _kSyncMuted),
          ),
          const SizedBox(height: 10),
          const Divider(height: 1, color: _kSyncBorder),
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Auto-Sync Changes',
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: _kSyncText,
                  ),
                ),
              ),
              Switch.adaptive(
                key: const Key('switch_cloud_auto_sync'),
                activeThumbColor: _kSyncGold,
                activeTrackColor: _kSyncSelected,
                value: _autoSyncEnabled,
                onChanged: _busy
                    ? null
                    : (v) {
                        setState(() => _autoSyncEnabled = v);
                        if (_isBound) {
                          widget.onConfigChanged?.call(_collectDraftConfig());
                        }
                      },
              ),
            ],
          ),
          if (_statusFeedback != null) ...[
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: _statusIsError
                    ? _kSyncDanger.withValues(alpha: 0.12)
                    : _kSyncOk.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: _statusIsError
                      ? _kSyncDanger.withValues(alpha: 0.45)
                      : _kSyncOk.withValues(alpha: 0.45),
                ),
              ),
              child: Row(
                children: [
                  Icon(
                    _statusIsError
                        ? Icons.error_outline_rounded
                        : Icons.check_circle_outline_rounded,
                    size: 16,
                    color: _statusIsError ? _kSyncDanger : _kSyncOk,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _statusFeedback!,
                      style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w600,
                        color: _statusIsError ? _kSyncDanger : _kSyncOk,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 12),
          FilledButton.icon(
            key: const Key('btn_execute_cloud_sync'),
            style: FilledButton.styleFrom(
              backgroundColor: _kSyncAccent,
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
            ),
            onPressed: _busy ? null : () => _runSyncOperation(VaultSyncOperationMode.smartMerge),
            icon: _busy
                ? const SizedBox(
                    width: 15,
                    height: 15,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Icon(Icons.sync_rounded, size: 18),
            label: Text(
              _busy ? 'Syncing Encrypted Vault...' : 'Save & Sync Now',
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            alignment: WrapAlignment.center,
            spacing: 6,
            runSpacing: 4,
            children: [
              TextButton.icon(
                key: const Key('btn_cloud_pull_only'),
                style: TextButton.styleFrom(
                  foregroundColor: _kSyncAccentLine,
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                ),
                onPressed: _busy ? null : () => _runSyncOperation(VaultSyncOperationMode.pullOnly),
                icon: const Icon(Icons.cloud_download_outlined, size: 15),
                label: const Text(
                  'Pull Only',
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600),
                ),
              ),
              TextButton.icon(
                key: const Key('btn_cloud_push_force'),
                style: TextButton.styleFrom(
                  foregroundColor: _kSyncGold,
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                ),
                onPressed: _busy ? null : () => _runSyncOperation(VaultSyncOperationMode.pushForce),
                icon: const Icon(Icons.cloud_upload_outlined, size: 15),
                label: const Text(
                  'Push Overwrite',
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600),
                ),
              ),
              if (_isBound)
                TextButton.icon(
                  key: const Key('btn_cloud_unbind'),
                  style: TextButton.styleFrom(
                    foregroundColor: _kSyncDanger,
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  ),
                  onPressed: _busy ? null : _handleUnbind,
                  icon: const Icon(Icons.link_off_rounded, size: 15),
                  label: const Text(
                    'Unbind Sync',
                    style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final mediaPadding = MediaQuery.paddingOf(context);
    final viewInsets = MediaQuery.viewInsetsOf(context);
    final symPadX = math.max(mediaPadding.left, mediaPadding.right) + 14.0;

    return Scaffold(
      backgroundColor: _kSyncCanvasTop,
      appBar: AppBar(
        backgroundColor: _kSyncCanvasTop,
        elevation: 0,
        automaticallyImplyLeading: false,
        titleSpacing: symPadX,
        title: Row(
          children: [
            Icon(
              _isBound ? Icons.cloud_done_rounded : Icons.cloud_outlined,
              size: 19,
              color: _isBound ? _kSyncOk : _kSyncGold,
            ),
            const SizedBox(width: 8),
            const Flexible(
              child: Text(
                'Cloud Sync',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: _kSyncText,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: (_isBound ? _kSyncOk : _kSyncGold).withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(99),
                border: Border.all(
                  color: (_isBound ? _kSyncOk : _kSyncGold).withValues(alpha: 0.48),
                ),
              ),
              child: Text(
                'E2EE',
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w700,
                  color: _isBound ? _kSyncOk : _kSyncGold,
                ),
              ),
            ),
          ],
        ),
        actions: [
          Padding(
            padding: EdgeInsets.only(right: math.max(mediaPadding.right, 8)),
            child: IconButton(
              key: const Key('btn_close_cloud_sync'),
              tooltip: 'Close',
              onPressed: () => Navigator.of(context).pop(),
              icon: const Icon(Icons.close_rounded, color: _kSyncText2),
            ),
          ),
        ],
      ),
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: <Color>[_kSyncCanvasTop, _kSyncCanvasBottom],
          ),
        ),
        child: LayoutBuilder(
          builder: (ctx, constraints) {
            final isLandscapeTwoPane = constraints.maxWidth >= 700;
            return SingleChildScrollView(
              padding: EdgeInsets.fromLTRB(
                symPadX,
                6,
                symPadX,
                16 + mediaPadding.bottom + viewInsets.bottom,
              ),
              child: isLandscapeTwoPane
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _buildSegmentedProviderBar(),
                        const SizedBox(height: 12),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(flex: 11, child: _buildProviderPanel()),
                            const SizedBox(width: 12),
                            Expanded(flex: 10, child: _buildEncryptionAndActionsPanel()),
                          ],
                        ),
                      ],
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _buildSegmentedProviderBar(),
                        const SizedBox(height: 12),
                        _buildProviderPanel(),
                        const SizedBox(height: 12),
                        _buildEncryptionAndActionsPanel(),
                      ],
                    ),
            );
          },
        ),
      ),
    );
  }
}
