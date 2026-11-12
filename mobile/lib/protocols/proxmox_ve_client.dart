import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;

class ProxmoxNodeStatus {
  final String node;
  final String status;
  final double cpu;
  final int maxCpu;
  final int memBytes;
  final int maxMemBytes;
  final int uptimeSeconds;

  const ProxmoxNodeStatus({
    required this.node,
    required this.status,
    required this.cpu,
    required this.maxCpu,
    required this.memBytes,
    required this.maxMemBytes,
    required this.uptimeSeconds,
  });

  double get memRatio => maxMemBytes > 0 ? (memBytes / maxMemBytes).clamp(0.0, 1.0) : 0.0;

  factory ProxmoxNodeStatus.fromJson(Map<String, dynamic> json) {
    return ProxmoxNodeStatus(
      node: (json['node'] ?? json['id'] ?? 'pve').toString(),
      status: (json['status'] ?? 'unknown').toString(),
      cpu: (json['cpu'] as num?)?.toDouble() ?? 0.0,
      maxCpu: (json['maxcpu'] as num?)?.toInt() ?? 0,
      memBytes: (json['mem'] as num?)?.toInt() ?? 0,
      maxMemBytes: (json['maxmem'] as num?)?.toInt() ?? 0,
      uptimeSeconds: (json['uptime'] as num?)?.toInt() ?? 0,
    );
  }
}

class ProxmoxResourceItem {
  final int vmid;
  final String name;
  final String node;
  final String type; // 'qemu' or 'lxc'
  final String status; // 'running', 'stopped', 'paused'
  final double cpu;
  final int maxCpu;
  final int memBytes;
  final int maxMemBytes;
  final int uptimeSeconds;
  final bool isTemplate;

  const ProxmoxResourceItem({
    required this.vmid,
    required this.name,
    required this.node,
    required this.type,
    required this.status,
    required this.cpu,
    required this.maxCpu,
    required this.memBytes,
    required this.maxMemBytes,
    required this.uptimeSeconds,
    this.isTemplate = false,
  });

  bool get isRunning => status.toLowerCase() == 'running';
  bool get isQemu => type == 'qemu';
  bool get isLxc => type == 'lxc';
  double get memRatio => maxMemBytes > 0 ? (memBytes / maxMemBytes).clamp(0.0, 1.0) : 0.0;

  factory ProxmoxResourceItem.fromJson(Map<String, dynamic> json) {
    final vmid = (json['vmid'] as num?)?.toInt() ?? 0;
    final rawType = (json['type'] ?? 'qemu').toString().toLowerCase();
    final rawName = (json['name'] ?? '').toString().trim();
    return ProxmoxResourceItem(
      vmid: vmid,
      name: rawName.isEmpty ? '${rawType.toUpperCase()} $vmid' : rawName,
      node: (json['node'] ?? 'pve').toString(),
      type: rawType,
      status: (json['status'] ?? 'stopped').toString(),
      cpu: (json['cpu'] as num?)?.toDouble() ?? 0.0,
      maxCpu: (json['maxcpu'] as num?)?.toInt() ?? 1,
      memBytes: (json['mem'] as num?)?.toInt() ?? 0,
      maxMemBytes: (json['maxmem'] as num?)?.toInt() ?? 0,
      uptimeSeconds: (json['uptime'] as num?)?.toInt() ?? 0,
      isTemplate: (json['template'] as num?)?.toInt() == 1,
    );
  }
}

class HypervisorClusterSnapshot {
  final bool isProxmoxVe;
  final bool authenticated;
  final String productBanner;
  final String versionText;
  final String authenticatedUser;
  final String tlsFingerprintSha256;
  final String tlsSubject;
  final int httpStatusCode;
  final String? authError;
  final List<ProxmoxNodeStatus> nodes;
  final List<ProxmoxResourceItem> resources;

  const HypervisorClusterSnapshot({
    required this.isProxmoxVe,
    required this.authenticated,
    required this.productBanner,
    required this.versionText,
    this.authenticatedUser = '',
    this.tlsFingerprintSha256 = '',
    this.tlsSubject = '',
    this.httpStatusCode = 200,
    this.authError,
    this.nodes = const <ProxmoxNodeStatus>[],
    this.resources = const <ProxmoxResourceItem>[],
  });
}

class ProxmoxApiException implements Exception {
  final String message;
  final int? statusCode;

  const ProxmoxApiException(this.message, {this.statusCode});

  @override
  String toString() => message;
}

/// Pure-Dart Interactive Proxmox VE (`:8006`) & VMware ESXi (`:443`) HTTPS Client.
/// Supports TOFU/self-signed lab certificates and optional local SSH Bastion port-forward tunnels.
class ProxmoxVeClient {
  final String host;
  final int port;
  final String? tunnelHost;
  final int? tunnelPort;
  final Duration timeout;

  String? _pveAuthCookie;
  String? _csrfPreventionToken;
  String _authenticatedUser = '';
  String _tlsFingerprintSha256 = '';
  String _tlsSubject = '';

  String? get pveAuthCookie => _pveAuthCookie;
  String? get csrfPreventionToken => _csrfPreventionToken;
  String get authenticatedUser => _authenticatedUser;
  String get tlsFingerprintSha256 => _tlsFingerprintSha256;
  String get tlsSubject => _tlsSubject;
  bool get isAuthenticated =>
      _pveAuthCookie != null &&
      _pveAuthCookie!.isNotEmpty &&
      _csrfPreventionToken != null &&
      _csrfPreventionToken!.isNotEmpty;

  ProxmoxVeClient({
    required this.host,
    this.port = 8006,
    this.tunnelHost,
    this.tunnelPort,
    this.timeout = const Duration(seconds: 7),
  });

  String get _connectHost => (tunnelHost != null && tunnelHost!.isNotEmpty) ? tunnelHost! : host;
  int get _connectPort => (tunnelPort != null && tunnelPort! > 0) ? tunnelPort! : port;

  HttpClient _createHttpClient() {
    final client = HttpClient()
      ..connectionTimeout = timeout
      ..idleTimeout = const Duration(seconds: 5)
      ..badCertificateCallback = (X509Certificate cert, String _, int __) {
        _captureCertMetadata(cert);
        return true;
      };
    return client;
  }

  void _captureCertMetadata(X509Certificate? cert) {
    if (cert == null) return;
    if (_tlsSubject.isEmpty && cert.subject.isNotEmpty) {
      _tlsSubject = cert.subject;
    }
    if (_tlsFingerprintSha256.isEmpty && cert.der.isNotEmpty) {
      final digest = crypto.sha256.convert(cert.der).bytes;
      final b64 = base64Encode(digest).replaceAll('=', '');
      _tlsFingerprintSha256 = 'SHA256:$b64';
    }
  }

  Future<(int statusCode, Map<String, String> headers, String body)> _sendRawRequest({
    required String method,
    required String path,
    Map<String, String>? formFields,
    bool includeAuthCookie = true,
  }) async {
    final client = _createHttpClient();
    try {
      final uri = Uri(
        scheme: 'https',
        host: _connectHost,
        port: _connectPort,
        path: path.startsWith('/') ? path : '/$path',
      );
      final req = await client.openUrl(method, uri).timeout(timeout);
      req.followRedirects = true;
      req.headers.set(HttpHeaders.hostHeader, '$host:$port');
      req.headers.set(HttpHeaders.acceptHeader, 'application/json, text/html;q=0.8, */*;q=0.5');

      if (includeAuthCookie && _pveAuthCookie != null && _pveAuthCookie!.isNotEmpty) {
        req.headers.set(
          HttpHeaders.cookieHeader,
          'PVEAuthCookie=${Uri.encodeComponent(_pveAuthCookie!)}',
        );
      }
      if (method.toUpperCase() != 'GET' &&
          _csrfPreventionToken != null &&
          _csrfPreventionToken!.isNotEmpty) {
        req.headers.set('CSRFPreventionToken', _csrfPreventionToken!);
      }

      if (formFields != null && formFields.isNotEmpty) {
        final encoded = formFields.entries
            .map((e) => '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}')
            .join('&');
        final bytes = utf8.encode(encoded);
        req.headers.set(
          HttpHeaders.contentTypeHeader,
          'application/x-www-form-urlencoded; charset=utf-8',
        );
        req.contentLength = bytes.length;
        req.add(bytes);
      }

      final resp = await req.close().timeout(timeout);
      _captureCertMetadata(resp.certificate);
      final hdrs = <String, String>{};
      resp.headers.forEach((name, values) {
        if (values.isNotEmpty) {
          hdrs[name.toLowerCase()] = values.join(', ');
        }
      });
      final body = await resp.transform(utf8.decoder).join().timeout(timeout);
      return (resp.statusCode, hdrs, body);
    } finally {
      client.close(force: true);
    }
  }

  /// Authenticates against Proxmox VE `/api2/json/access/ticket`.
  /// Automatically appends `@pam` if no `@realm` is present, and retries `@pve` if `@pam` returns 401/403.
  Future<void> authenticate({
    required String username,
    required String password,
    String? otp,
  }) async {
    final trimmedUser = username.trim().isEmpty ? 'root' : username.trim();
    final candidates = trimmedUser.contains('@')
        ? <String>[trimmedUser]
        : <String>['$trimmedUser@pam', '$trimmedUser@pve'];

    int? lastStatus;
    String lastDetail = 'Authentication failed.';

    for (final candidate in candidates) {
      final fields = <String, String>{
        'username': candidate,
        'password': password,
      };
      if (otp != null && otp.trim().isNotEmpty) {
        fields['otp'] = otp.trim();
      }
      final (status, _, body) = await _sendRawRequest(
        method: 'POST',
        path: '/api2/json/access/ticket',
        formFields: fields,
        includeAuthCookie: false,
      );
      lastStatus = status;

      if (status >= 200 && status < 300) {
        final decoded = _tryDecodeJsonMap(body);
        final data = decoded?['data'];
        if (data is Map<String, dynamic>) {
          final ticket = (data['ticket'] ?? '').toString();
          final csrf = (data['CSRFPreventionToken'] ?? '').toString();
          if (ticket.isNotEmpty) {
            _pveAuthCookie = ticket;
            _csrfPreventionToken = csrf;
            _authenticatedUser = (data['username'] ?? candidate).toString();
            return;
          }
        }
      }

      lastDetail = 'HTTP $status from /api2/json/access/ticket for $candidate';
      if (status != 401 && status != 403) {
        break;
      }
    }

    throw ProxmoxApiException(lastDetail, statusCode: lastStatus);
  }

  /// Fetches live Proxmox VE cluster version, nodes, and QEMU/LXC resources, or gracefully falls back
  /// to HTTPS hypervisor banner inspection (e.g. VMware ESXi / vCenter on `:443`).
  Future<HypervisorClusterSnapshot> connectAndInspect({
    String username = '',
    String password = '',
    String? otp,
  }) async {
    String? authErr;
    bool looksLikeProxmox = false;
    String versionText = '';
    int rootStatus = 200;
    Map<String, String> rootHeaders = const <String, String>{};

    // 1. Authenticate first if password was supplied (since /api2/json/version requires auth on many PVE setups)
    if (password.isNotEmpty) {
      try {
        await authenticate(username: username, password: password, otp: otp);
        looksLikeProxmox = true;
      } on ProxmoxApiException catch (e) {
        if (e.statusCode == 401 || e.statusCode == 403) {
          looksLikeProxmox = true;
          authErr = 'Proxmox VE rejected credentials (${e.message}).';
        }
      }
    }

    // 2. Query /api2/json/version
    try {
      final (verStatus, verHdrs, verBody) = await _sendRawRequest(
        method: 'GET',
        path: '/api2/json/version',
      );
      rootStatus = verStatus;
      rootHeaders = verHdrs;
      final serverHdr = (verHdrs['server'] ?? '').toLowerCase();
      if (serverHdr.contains('pve-api-daemon') || verStatus == 401) {
        looksLikeProxmox = true;
      }
      if (verStatus >= 200 && verStatus < 300) {
        final decoded = _tryDecodeJsonMap(verBody);
        final data = decoded?['data'];
        if (data is Map<String, dynamic> && (data.containsKey('version') || data.containsKey('release'))) {
          looksLikeProxmox = true;
          final v = (data['version'] ?? data['release'] ?? '').toString();
          final repoid = (data['repoid'] ?? '').toString();
          versionText = repoid.isNotEmpty ? 'Proxmox VE $v ($repoid)' : 'Proxmox VE $v';
        }
      }
    } catch (_) {
      // Rethrow network unreachable errors so caller knows host is down
      rethrow;
    }

    // 3. If authenticated against Proxmox VE, fetch /nodes and /cluster/resources
    if (looksLikeProxmox) {
      final nodes = <ProxmoxNodeStatus>[];
      final resources = <ProxmoxResourceItem>[];

      if (isAuthenticated) {
        final (nodesStatus, _, nodesBody) = await _sendRawRequest(
          method: 'GET',
          path: '/api2/json/nodes',
        );
        if (nodesStatus >= 200 && nodesStatus < 300) {
          final map = _tryDecodeJsonMap(nodesBody);
          final list = map?['data'];
          if (list is List) {
            for (final item in list) {
              if (item is Map<String, dynamic>) {
                nodes.add(ProxmoxNodeStatus.fromJson(item));
              }
            }
          }
        }

        final (resStatus, _, resBody) = await _sendRawRequest(
          method: 'GET',
          path: '/api2/json/cluster/resources',
        );
        if (resStatus >= 200 && resStatus < 300) {
          final map = _tryDecodeJsonMap(resBody);
          final list = map?['data'];
          if (list is List) {
            for (final item in list) {
              if (item is Map<String, dynamic>) {
                final rType = (item['type'] ?? '').toString().toLowerCase();
                if (rType == 'node' && nodes.isEmpty) {
                  nodes.add(ProxmoxNodeStatus.fromJson(item));
                } else if (rType == 'qemu' || rType == 'lxc') {
                  final parsed = ProxmoxResourceItem.fromJson(item);
                  if (!parsed.isTemplate && parsed.vmid > 0) {
                    resources.add(parsed);
                  }
                }
              }
            }
          }
        }

        resources.sort((a, b) {
          if (a.isRunning != b.isRunning) {
            return a.isRunning ? -1 : 1;
          }
          return a.vmid.compareTo(b.vmid);
        });
      } else {
        authErr ??= 'Enter Proxmox VE credentials (e.g. root@pam) to inspect & control QEMU/LXC workloads.';
      }

      return HypervisorClusterSnapshot(
        isProxmoxVe: true,
        authenticated: isAuthenticated,
        productBanner: versionText.isNotEmpty ? versionText : 'Proxmox Virtual Environment',
        versionText: versionText.isNotEmpty ? versionText : 'PVE API :$port',
        authenticatedUser: _authenticatedUser,
        tlsFingerprintSha256: _tlsFingerprintSha256,
        tlsSubject: _tlsSubject,
        httpStatusCode: rootStatus,
        authError: authErr,
        nodes: nodes,
        resources: resources,
      );
    }

    // 4. Non-Proxmox Hypervisor fallback: gracefully probe VMware ESXi / vCenter `/ui/` and `/sdk`
    String banner = rootHeaders['server'] ?? 'HTTPS Hypervisor Endpoint';
    int probeStatus = rootStatus;
    try {
      final (uiStatus, uiHdrs, uiBody) = await _sendRawRequest(
        method: 'GET',
        path: '/ui/',
        includeAuthCookie: false,
      );
      probeStatus = uiStatus;
      final lowerBody = uiBody.toLowerCase();
      if (lowerBody.contains('vmware') || lowerBody.contains('esxi') || lowerBody.contains('vsphere')) {
        banner = 'VMware ESXi / vSphere Host Client';
      } else if ((uiHdrs['server'] ?? '').isNotEmpty) {
        banner = uiHdrs['server']!;
      }

      if (!banner.contains('VMware')) {
        final (sdkStatus, sdkHdrs, sdkBody) = await _sendRawRequest(
          method: 'GET',
          path: '/sdk',
          includeAuthCookie: false,
        );
        if (sdkBody.toLowerCase().contains('vmware') || sdkStatus == 400 || sdkStatus == 405) {
          if ((sdkHdrs['server'] ?? '').toLowerCase().contains('envoy') ||
              sdkBody.toLowerCase().contains('soap')) {
            banner = 'VMware vSphere / ESXi SOAP SDK';
          }
        }
      }
    } catch (_) {}

    return HypervisorClusterSnapshot(
      isProxmoxVe: false,
      authenticated: false,
      productBanner: banner,
      versionText: 'HTTPS :$port (HTTP $probeStatus)',
      tlsFingerprintSha256: _tlsFingerprintSha256,
      tlsSubject: _tlsSubject,
      httpStatusCode: probeStatus,
    );
  }

  /// Dispatches a live VM / LXC Container power lifecycle action (`start`, `shutdown`, `stop`, `reboot`).
  Future<String> performPowerAction({
    required String node,
    required String type,
    required int vmid,
    required String action,
  }) async {
    const allowedActions = <String>{'start', 'shutdown', 'stop', 'reboot'};
    final normalizedAction = action.trim().toLowerCase();
    if (!allowedActions.contains(normalizedAction)) {
      throw ProxmoxApiException('Unsupported Proxmox power action: $action');
    }
    final normalizedType = type.trim().toLowerCase() == 'lxc' ? 'lxc' : 'qemu';
    if (!isAuthenticated) {
      throw const ProxmoxApiException('Not authenticated with Proxmox VE API.');
    }

    final path =
        '/api2/json/nodes/${Uri.encodeComponent(node)}/$normalizedType/$vmid/status/$normalizedAction';
    final (status, _, body) = await _sendRawRequest(
      method: 'POST',
      path: path,
    );
    if (status < 200 || status >= 300) {
      throw ProxmoxApiException(
        'Proxmox action "$normalizedAction" failed (HTTP $status).',
        statusCode: status,
      );
    }
    final decoded = _tryDecodeJsonMap(body);
    final upid = (decoded?['data'] ?? 'OK').toString();
    return upid;
  }

  static Map<String, dynamic>? _tryDecodeJsonMap(String raw) {
    if (raw.trim().isEmpty) return null;
    try {
      final parsed = jsonDecode(raw);
      return parsed is Map<String, dynamic> ? parsed : null;
    } catch (_) {
      return null;
    }
  }
}
