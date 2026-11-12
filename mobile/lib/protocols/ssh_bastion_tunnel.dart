import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dartssh2/dartssh2.dart';
import 'package:pointycastle/export.dart';

/// Explicit override value stored in `RemoteHostItem.jumpHostId` when a host inside a
/// Jump-configured folder intentionally bypasses its folder's inherited Jump Host.
const String kDirectNoJumpOverride = '__direct__';

/// Royal TSX-style Folder-Level Gateway & Credential Inheritance Configuration.
/// All connections placed inside `name` automatically inherit `jumpHostId` (unless the host
/// specifies its own `jumpHostId` or `kDirectNoJumpOverride`) and optional `credentialId`.
class FolderGatewayConfig {
  final String name;
  final String? jumpHostId;
  final String? credentialId;
  final String accentTint;

  const FolderGatewayConfig({
    required this.name,
    this.jumpHostId,
    this.credentialId,
    this.accentTint = 'gold',
  });

  bool get hasJumpHost => jumpHostId != null && jumpHostId!.trim().isNotEmpty;
  bool get hasCredential => credentialId != null && credentialId!.trim().isNotEmpty;

  FolderGatewayConfig copyWith({
    String? name,
    String? jumpHostId,
    bool clearJumpHost = false,
    String? credentialId,
    bool clearCredential = false,
    String? accentTint,
  }) {
    return FolderGatewayConfig(
      name: name ?? this.name,
      jumpHostId: clearJumpHost ? null : (jumpHostId ?? this.jumpHostId),
      credentialId: clearCredential ? null : (credentialId ?? this.credentialId),
      accentTint: accentTint ?? this.accentTint,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'name': name,
        'jumpHostId': jumpHostId,
        'credentialId': credentialId,
        'accentTint': accentTint,
      };

  factory FolderGatewayConfig.fromJson(Map<String, dynamic> json) {
    final rawJump = (json['jumpHostId'] as String?)?.trim();
    final rawCred = (json['credentialId'] as String?)?.trim();
    return FolderGatewayConfig(
      name: (json['name'] as String? ?? 'General').trim(),
      jumpHostId: (rawJump == null || rawJump.isEmpty) ? null : rawJump,
      credentialId: (rawCred == null || rawCred.isEmpty) ? null : rawCred,
      accentTint: (json['accentTint'] as String?)?.trim().isNotEmpty == true
          ? (json['accentTint'] as String).trim()
          : 'gold',
    );
  }
}

/// Low-Latency `SSHSocket` transport that explicitly enables `SocketOption.tcpNoDelay` (`TCP_NODELAY`)
/// on the outer WAN TCP socket, eliminating 1.2–2.5s of Nagle + Delayed-ACK stalls across
/// multi-round-trip FreeRDP CredSSP/NLA/TLS/MCS handshakes over SSH Jump Hosts.
class NoDelaySshSocket implements SSHSocket {
  final Socket _socket;
  final bool tcpNoDelayApplied;

  NoDelaySshSocket._(this._socket, {required this.tcpNoDelayApplied});

  static Future<NoDelaySshSocket> connect(
    String host,
    int port, {
    Duration? timeout,
  }) async {
    final socket = await Socket.connect(host, port, timeout: timeout);
    bool applied = false;
    try {
      applied = socket.setOption(SocketOption.tcpNoDelay, true);
    } catch (_) {
      applied = false;
    }
    return NoDelaySshSocket._(socket, tcpNoDelayApplied: applied);
  }

  @override
  Stream<Uint8List> get stream => _socket;

  @override
  StreamSink<List<int>> get sink => _socket;

  @override
  Future<void> get done => _socket.done;

  @override
  Future<void> close() => _socket.close();

  @override
  void destroy() => _socket.destroy();

  @override
  Future<void> flush() => _socket.flush();

  @override
  String toString() =>
      'NoDelaySshSocket(${_socket.remoteAddress.address}:${_socket.remotePort}, tcpNoDelay=$tcpNoDelayApplied)';
}

/// Reusable Vault Credential (inspired by JalaDesk Desktop `src/credentials/` & Royal TS)
/// Allows binding a single Domain/User/Password or SSH Private Key across multiple
/// target hosts and SSH Jump Hosts without duplicating secrets.
class VaultCredentialItem {
  final String id;
  final String label;
  final String domain;
  final String username;
  final String password;
  final String privateKeyPem;
  final String notes;

  const VaultCredentialItem({
    required this.id,
    required this.label,
    this.domain = '',
    required this.username,
    this.password = '',
    this.privateKeyPem = '',
    this.notes = '',
  });

  bool get hasSshKey => privateKeyPem.trim().isNotEmpty;
  bool get hasPassword => password.isNotEmpty;

  String get kindBadge {
    if (hasSshKey && hasPassword) return 'SSH KEY + PASS';
    if (hasSshKey) return 'SSH KEY';
    if (domain.trim().isNotEmpty) return 'AD DOMAIN';
    return 'PASSWORD';
  }

  String get displayPrincipal {
    final d = domain.trim();
    final u = username.trim();
    if (d.isNotEmpty && u.isNotEmpty && !u.contains('\\')) {
      return '$d\\$u';
    }
    return u.isEmpty ? 'root' : u;
  }

  VaultCredentialItem copyWith({
    String? id,
    String? label,
    String? domain,
    String? username,
    String? password,
    String? privateKeyPem,
    String? notes,
  }) {
    return VaultCredentialItem(
      id: id ?? this.id,
      label: label ?? this.label,
      domain: domain ?? this.domain,
      username: username ?? this.username,
      password: password ?? this.password,
      privateKeyPem: privateKeyPem ?? this.privateKeyPem,
      notes: notes ?? this.notes,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'label': label,
        'domain': domain,
        'username': username,
        'password': password,
        'privateKeyPem': privateKeyPem,
        'notes': notes,
      };

  factory VaultCredentialItem.fromJson(Map<String, dynamic> json) {
    return VaultCredentialItem(
      id: json['id'] as String? ?? 'cred-${DateTime.now().millisecondsSinceEpoch}',
      label: json['label'] as String? ?? 'Saved Credential',
      domain: json['domain'] as String? ?? '',
      username: json['username'] as String? ?? 'root',
      password: json['password'] as String? ?? '',
      privateKeyPem: json['privateKeyPem'] as String? ?? '',
      notes: json['notes'] as String? ?? '',
    );
  }
}

/// Resolved SSH Jump Host / Bastion Hop specification
class BastionHopSpec {
  final String id;
  final String name;
  final String address;
  final int port;
  final String username;
  final String password;
  final String privateKeyPem;

  const BastionHopSpec({
    required this.id,
    required this.name,
    required this.address,
    required this.port,
    required this.username,
    this.password = '',
    this.privateKeyPem = '',
  });

  String get endpoint => '$username@$address:$port';
}

class BastionRoutingException implements Exception {
  final String message;
  const BastionRoutingException(this.message);

  @override
  String toString() => message;
}

/// Pure resolver for single-hop and multi-hop SSH `ProxyJump` chains (`Hop 1 -> Hop 2 -> Target`).
/// Detects self-references, missing jump hosts, non-SSH jump hosts, and circular hop loops.
class SshBastionRouteResolver {
  static const int maxHops = 8;

  static List<T> resolveHopItems<T>({
    required T target,
    required List<T> allHosts,
    required String Function(T) idOf,
    required String Function(T) nameOf,
    required String? Function(T) jumpHostIdOf,
    required bool Function(T) isSshCapable,
  }) {
    final firstJumpId = jumpHostIdOf(target)?.trim() ?? '';
    if (firstJumpId.isEmpty) return const [];

    final byId = <String, T>{for (final h in allHosts) idOf(h): h};
    final visited = <String>{idOf(target)};
    final reversedHops = <T>[];
    String currentJumpId = firstJumpId;

    while (currentJumpId.isNotEmpty) {
      if (visited.contains(currentJumpId)) {
        throw BastionRoutingException(
          'Circular Jump Host loop detected involving "${nameOf(target)}". Edit the Jump Host chain to remove the cycle.',
        );
      }
      if (reversedHops.length >= maxHops) {
        throw const BastionRoutingException(
          'Jump Host chain exceeds maximum depth ($maxHops hops).',
        );
      }
      final hop = byId[currentJumpId];
      if (hop == null) {
        throw BastionRoutingException(
          'Assigned Jump Host ($currentJumpId) no longer exists in Vault. Edit "${nameOf(target)}" to select a valid SSH Jump Host.',
        );
      }
      if (!isSshCapable(hop)) {
        throw BastionRoutingException(
          'Jump Host "${nameOf(hop)}" must use SSH protocol to tunnel remote traffic.',
        );
      }
      visited.add(currentJumpId);
      reversedHops.add(hop);
      currentJumpId = jumpHostIdOf(hop)?.trim() ?? '';
    }

    // `target` points to its immediate parent bastion; reverse so index 0 is the entry bastion!
    return reversedHops.reversed.toList();
  }

  /// Checks whether assigning `candidateJumpId` as the Jump Host of `editingHostId` is cycle-free.
  static bool wouldCreateCycle<T>({
    required String? editingHostId,
    required String candidateJumpId,
    required List<T> allHosts,
    required String Function(T) idOf,
    required String? Function(T) jumpHostIdOf,
  }) {
    if (editingHostId == null || editingHostId.isEmpty) return false;
    if (editingHostId == candidateJumpId) return true;

    final byId = <String, T>{for (final h in allHosts) idOf(h): h};
    final seen = <String>{editingHostId};
    String? cursor = candidateJumpId;
    int guard = 0;
    while (cursor != null && cursor.isNotEmpty && guard < maxHops + 4) {
      if (seen.contains(cursor)) return true;
      seen.add(cursor);
      final node = byId[cursor];
      cursor = node == null ? null : jumpHostIdOf(node);
      guard++;
    }
    return false;
  }

  static String formatRouteBadge(List<String> hopNames) {
    if (hopNames.isEmpty) return '';
    if (hopNames.length == 1) return 'via ${hopNames.first}';
    return '${hopNames.length}-hop: ${hopNames.join(" → ")}';
  }
}

/// Active Local TCP Port-Forward (`127.0.0.1:<localPort> ⇄ <remoteHost>:<remotePort>`)
/// Used both transparently for RDP / VNC / Hypervisor sessions over SSH Jump Hosts
/// and explicitly in the standalone SSH Port Forwarding Studio (`ssh -L`).
class ActiveLocalPortForward {
  final String id;
  final String label;
  final String bastionSummary;
  final String remoteHost;
  final int remotePort;
  final ServerSocket _server;
  final SSHClient _exitSshClient;
  final SshBastionChain? _ownedChain;
  final VoidCallbackRef? _onClosedFromParent;
  final DateTime startedAt;
  final VoidCallbackRef? onStatsUpdated;

  int bytesSent = 0;
  int bytesReceived = 0;
  int activeStreams = 0;
  int totalConnections = 0;
  bool _closed = false;
  bool _usedPrewarmedChannel = false;
  Future<SSHForwardChannel>? _prewarmedForwardFuture;
  final Set<Socket> _openSockets = <Socket>{};
  final Set<SSHForwardChannel> _openChannels = <SSHForwardChannel>{};
  late final StreamSubscription<Socket> _acceptSub;

  ActiveLocalPortForward._({
    required this.id,
    required this.label,
    required this.bastionSummary,
    required this.remoteHost,
    required this.remotePort,
    required ServerSocket server,
    required SSHClient exitSshClient,
    SshBastionChain? ownedChain,
    VoidCallbackRef? onClosedFromParent,
    bool prewarmChannel = false,
    this.onStatsUpdated,
  })  : _server = server,
        _exitSshClient = exitSshClient,
        _ownedChain = ownedChain,
        _onClosedFromParent = onClosedFromParent,
        startedAt = DateTime.now() {
    if (prewarmChannel) {
      final Future<SSHForwardChannel> fut = _exitSshClient
          .forwardLocal(remoteHost, remotePort)
          .timeout(const Duration(seconds: 10));
      // Prevent unhandled async error if never consumed before close()
      unawaited(fut.then((_) {}, onError: (_) {}));
      _prewarmedForwardFuture = fut;
    }
    _acceptSub = _server.listen(
      (Socket sock) {
        sock.done.catchError((_) {});
        unawaited(_handleIncomingSocket(sock).catchError((_) {}));
      },
      onError: (_) {},
      cancelOnError: false,
    );
  }

  int get localPort => _server.port;
  String get localEndpoint => '127.0.0.1:$localPort';
  String get remoteEndpoint => '$remoteHost:$remotePort';
  bool get isClosed => _closed;
  bool get usedPrewarmedChannel => _usedPrewarmedChannel;

  Future<void> _handleIncomingSocket(Socket clientSocket) async {
    clientSocket.done.catchError((_) {});
    if (_closed) {
      try {
        clientSocket.destroy();
      } catch (_) {}
      return;
    }
    try {
      clientSocket.setOption(SocketOption.tcpNoDelay, true);
    } catch (_) {}

    SSHForwardChannel? forward;
    bool cleanedUp = false;
    bool forwardReady = false;
    final List<Uint8List> preForwardBuffer = <Uint8List>[];
    StreamSubscription<Uint8List>? tcpToSshSub;
    StreamSubscription<Uint8List>? sshToTcpSub;

    Future<void> tearDownPair() async {
      if (cleanedUp) return;
      cleanedUp = true;
      await tcpToSshSub?.cancel();
      await sshToTcpSub?.cancel();
      _openSockets.remove(clientSocket);
      if (forward != null) {
        _openChannels.remove(forward);
      }
      if (activeStreams > 0 && forwardReady) activeStreams--;
      try {
        await forward?.close();
      } catch (_) {}
      try {
        clientSocket.destroy();
      } catch (_) {}
      if (forwardReady) {
        onStatsUpdated?.call();
      }
    }

    // Attach error-safe listener synchronously so early ECONNRESET never escapes
    tcpToSshSub = clientSocket.listen(
      (Uint8List chunk) {
        if (cleanedUp || _closed) return;
        if (!forwardReady) {
          preForwardBuffer.add(Uint8List.fromList(chunk));
          return;
        }
        bytesSent += chunk.length;
        try {
          forward!.sink.add(chunk);
        } catch (_) {
          unawaited(tearDownPair());
        }
      },
      onError: (_) => unawaited(tearDownPair()),
      onDone: () => unawaited(tearDownPair()),
      cancelOnError: true,
    );

    final prewarmed = _prewarmedForwardFuture;
    _prewarmedForwardFuture = null;
    try {
      if (prewarmed != null) {
        forward = await prewarmed;
        _usedPrewarmedChannel = true;
      } else {
        forward = await _exitSshClient
            .forwardLocal(remoteHost, remotePort)
            .timeout(const Duration(seconds: 10));
      }
    } catch (_) {
      await tearDownPair();
      return;
    }

    if (_closed || cleanedUp) {
      try {
        await forward.close();
      } catch (_) {}
      await tearDownPair();
      return;
    }

    _openSockets.add(clientSocket);
    _openChannels.add(forward);
    forwardReady = true;
    activeStreams++;
    totalConnections++;
    onStatsUpdated?.call();

    for (final buffered in preForwardBuffer) {
      if (cleanedUp || _closed) break;
      bytesSent += buffered.length;
      try {
        forward.sink.add(buffered);
      } catch (_) {
        await tearDownPair();
        return;
      }
    }
    preForwardBuffer.clear();

    sshToTcpSub = forward.stream.listen(
      (Uint8List chunk) {
        if (cleanedUp || _closed) return;
        bytesReceived += chunk.length;
        try {
          clientSocket.add(chunk);
        } catch (_) {
          unawaited(tearDownPair());
        }
      },
      onError: (_) => unawaited(tearDownPair()),
      onDone: () => unawaited(tearDownPair()),
      cancelOnError: true,
    );
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    final unclaimedPrewarm = _prewarmedForwardFuture;
    _prewarmedForwardFuture = null;
    if (unclaimedPrewarm != null) {
      unawaited(
        unclaimedPrewarm.then(
          (ch) {
            try {
              ch.destroy();
            } catch (_) {}
          },
          onError: (_) {},
        ),
      );
    }
    try {
      await _acceptSub.cancel();
    } catch (_) {}
    try {
      await _server.close();
    } catch (_) {}
    for (final ch in _openChannels.toList()) {
      try {
        ch.destroy();
      } catch (_) {}
    }
    _openChannels.clear();
    for (final sock in _openSockets.toList()) {
      try {
        sock.destroy();
      } catch (_) {}
    }
    _openSockets.clear();
    activeStreams = 0;
    _onClosedFromParent?.call();
    if (_ownedChain != null) {
      await _ownedChain.dispose();
    }
  }
}

typedef VoidCallbackRef = void Function();

/// Live Multi-Hop SSH Bastion Chain (`Hop 1 -> Hop 2 -> ... -> Hop N`)
/// Provides both direct `SSHForwardChannel` (`ProxyJump` for SSH/SFTP) and
/// local loopback `127.0.0.1` port-forward tunnels (for native FreeRDP, VNC, & HTTPS).
class SshBastionChain {
  static final Map<String, List<SSHKeyPair>> _parsedKeyCache = <String, List<SSHKeyPair>>{};

  /// Parses PEM private key once and caches the `SSHKeyPair` list in memory until Vault Lock / Clear.
  static List<SSHKeyPair> parseOrGetCachedKeys(String privateKeyPem, [String? passphrase]) {
    final cleanPem = privateKeyPem.trim();
    if (cleanPem.isEmpty) return const <SSHKeyPair>[];
    final cleanPass = (passphrase != null && passphrase.isNotEmpty) ? passphrase : null;
    final cacheKey = '$cleanPem\u0000${cleanPass ?? ''}';
    final cached = _parsedKeyCache[cacheKey];
    if (cached != null) return cached;
    final parsed = List<SSHKeyPair>.unmodifiable(SSHKeyPair.fromPem(cleanPem, cleanPass));
    if (_parsedKeyCache.length >= 32) {
      _parsedKeyCache.remove(_parsedKeyCache.keys.first);
    }
    _parsedKeyCache[cacheKey] = parsed;
    return parsed;
  }

  static int get cachedKeyCount => _parsedKeyCache.length;

  static void clearKeyCache() => _parsedKeyCache.clear();

  final List<BastionHopSpec> hops;
  final List<SSHClient> _clients;
  final List<ActiveLocalPortForward> _tunnels = [];
  bool _disposed = false;

  SshBastionChain._(this.hops, this._clients);

  /// Test-only factory for deterministic unit tests of `BastionSessionPool` without live SSH daemons.
  factory SshBastionChain.testFake(List<BastionHopSpec> hops, {bool initiallyDisposed = false}) {
    final chain = SshBastionChain._(List<BastionHopSpec>.unmodifiable(hops), const <SSHClient>[]);
    chain._disposed = initiallyDisposed;
    return chain;
  }

  SSHClient get exitClient => _clients.last;
  bool get isDisposed => _disposed;
  bool get isHealthy =>
      !_disposed && (_clients.isEmpty || _clients.every((c) => !c.isClosed));

  String get routeSummary =>
      SshBastionRouteResolver.formatRouteBadge(hops.map((h) => h.name).toList());

  static Future<SshBastionChain> connect(
    List<BastionHopSpec> hops, {
    void Function(String stage)? onStage,
    FutureOr<bool> Function(BastionHopSpec hop, String keyType, Uint8List fingerprint)? onVerifyHopHostKey,
    Duration hopTimeout = const Duration(seconds: 9),
  }) async {
    if (hops.isEmpty) {
      throw const BastionRoutingException('Cannot open SSH Bastion chain with zero hops.');
    }

    final openedClients = <SSHClient>[];
    try {
      for (int i = 0; i < hops.length; i++) {
        final hop = hops[i];
        final hopNum = i + 1;
        final total = hops.length;

        onStage?.call(
          total == 1
              ? 'Connecting to Jump Host ${hop.name} (${hop.address}:${hop.port})...'
              : 'Jump Hop $hopNum/$total: Connecting to ${hop.name} (${hop.address}:${hop.port})...',
        );

        final SSHSocket transport;
        if (i == 0) {
          transport = await NoDelaySshSocket.connect(
            hop.address,
            hop.port,
            timeout: hopTimeout,
          );
        } else {
          transport = await openedClients.last
              .forwardLocal(hop.address, hop.port)
              .timeout(hopTimeout);
        }

        List<SSHKeyPair>? identities;
        if (hop.privateKeyPem.trim().isNotEmpty) {
          identities = parseOrGetCachedKeys(hop.privateKeyPem, hop.password);
        }

        onStage?.call(
          total == 1
              ? 'Authenticating Jump Host ${hop.username}@${hop.name}...'
              : 'Jump Hop $hopNum/$total: Authenticating ${hop.username}@${hop.name}...',
        );

        final client = SSHClient(
          transport,
          username: hop.username.trim().isEmpty ? 'root' : hop.username.trim(),
          identities: identities,
          onPasswordRequest: () => hop.password,
          onVerifyHostKey: onVerifyHopHostKey == null
              ? null
              : (String type, Uint8List fp) => onVerifyHopHostKey(hop, type, fp),
        );

        await client.authenticated.timeout(hopTimeout);
        openedClients.add(client);
      }

      return SshBastionChain._(List<BastionHopSpec>.unmodifiable(hops), openedClients);
    } catch (err) {
      for (final c in openedClients.reversed) {
        try {
          c.close();
        } catch (_) {}
      }
      rethrow;
    }
  }

  /// Opens a direct RFC 4254 `direct-tcpip` SSH channel through the bastion chain (`ssh -J`)
  Future<SSHForwardChannel> openTargetForward(
    String targetHost,
    int targetPort, {
    Duration timeout = const Duration(seconds: 9),
  }) async {
    if (_disposed || !isHealthy) {
      throw const BastionRoutingException('Bastion chain has already been closed.');
    }
    return exitClient.forwardLocal(targetHost, targetPort).timeout(timeout);
  }

  /// Binds a Zero-Trust loopback-only (`127.0.0.1`) TCP port that tunnels traffic
  /// through the exit Jump Host to `remoteHost:remotePort` (for RDP, VNC, HTTPS, or `ssh -L`).
  Future<ActiveLocalPortForward> startLocalPortForward({
    required String remoteHost,
    required int remotePort,
    int localBindPort = 0,
    String label = '',
    bool ownChainLifecycle = false,
    bool prewarmChannel = false,
    VoidCallbackRef? onStatsUpdated,
  }) async {
    if (_disposed || !isHealthy) {
      throw const BastionRoutingException('Bastion chain has already been closed.');
    }
    final server = await ServerSocket.bind(
      InternetAddress.loopbackIPv4,
      localBindPort,
      shared: false,
    );
    late final ActiveLocalPortForward tunnel;
    tunnel = ActiveLocalPortForward._(
      id: 'tun-${DateTime.now().microsecondsSinceEpoch}',
      label: label.isEmpty ? '$remoteHost:$remotePort' : label,
      bastionSummary: routeSummary,
      remoteHost: remoteHost,
      remotePort: remotePort,
      server: server,
      exitSshClient: exitClient,
      ownedChain: ownChainLifecycle ? this : null,
      onClosedFromParent: () => _tunnels.remove(tunnel),
      prewarmChannel: prewarmChannel,
      onStatsUpdated: onStatsUpdated,
    );
    _tunnels.add(tunnel);
    return tunnel;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    final activeTunnels = List<ActiveLocalPortForward>.from(_tunnels);
    _tunnels.clear();
    for (final t in activeTunnels) {
      if (!t.isClosed) {
        await t.close();
      }
    }
    for (final c in _clients.reversed) {
      try {
        c.close();
      } catch (_) {}
    }
  }
}

/// Warm SSH Bastion Connection Multiplexing Pool (`ControlPersist`-style session reuse).
/// Keeps authenticated SSH Jump Host chains warm across RDP / VNC / SSH / SFTP sessions so
/// subsequent connections skip TCP + SSH KEX + Ed25519/RSA auth (`0ms` bastion acquisition).
class BastionSessionPool {
  final Map<String, SshBastionChain> _pool = <String, SshBastionChain>{};
  final Map<String, Future<SshBastionChain>> _inFlight = <String, Future<SshBastionChain>>{};

  static String computeRouteSignature(List<BastionHopSpec> hops) {
    final buf = StringBuffer();
    for (int i = 0; i < hops.length; i++) {
      final h = hops[i];
      final authDigest = sha256
          .convert(utf8.encode('${h.password}\u0000${h.privateKeyPem.trim()}'))
          .toString()
          .substring(0, 16);
      if (i > 0) buf.write('>>');
      buf.write('${h.id}|${h.username.trim()}@${h.address.trim()}:${h.port}|$authDigest');
    }
    return buf.toString();
  }

  int get warmCount => _pool.values.where((c) => c.isHealthy).length;

  bool isHopWarm(String hopId) =>
      _pool.values.any((c) => c.isHealthy && c.hops.any((h) => h.id == hopId));

  bool containsChain(SshBastionChain? chain) =>
      chain != null && _pool.values.contains(chain);

  Future<SshBastionChain> acquire(
    List<BastionHopSpec> hops, {
    void Function(String stage)? onStage,
    FutureOr<bool> Function(BastionHopSpec hop, String keyType, Uint8List fingerprint)? onVerifyHopHostKey,
    Duration hopTimeout = const Duration(seconds: 9),
    Future<SshBastionChain> Function(List<BastionHopSpec> hops)? connectorOverride,
  }) async {
    if (hops.isEmpty) {
      throw const BastionRoutingException('Cannot acquire SSH Bastion chain with zero hops.');
    }
    final sig = computeRouteSignature(hops);
    final existing = _pool[sig];
    if (existing != null) {
      if (existing.isHealthy) {
        onStage?.call('Using warm Jump Host tunnel (${existing.routeSummary})...');
        return existing;
      }
      _pool.remove(sig);
      unawaited(existing.dispose());
    }

    final pending = _inFlight[sig];
    if (pending != null) {
      onStage?.call('Joining active Jump Host handshake...');
      return pending;
    }

    final connectFuture = (connectorOverride != null
        ? connectorOverride(hops)
        : SshBastionChain.connect(
            hops,
            onStage: onStage,
            onVerifyHopHostKey: onVerifyHopHostKey,
            hopTimeout: hopTimeout,
          ));
    _inFlight[sig] = connectFuture;
    try {
      final fresh = await connectFuture;
      _pool[sig] = fresh;
      if (fresh._clients.isNotEmpty) {
        unawaited(
          fresh.exitClient.done.then(
            (_) {
              if (_pool[sig] == fresh) _pool.remove(sig);
            },
            onError: (_) {
              if (_pool[sig] == fresh) _pool.remove(sig);
            },
          ),
        );
      }
      return fresh;
    } finally {
      if (_inFlight[sig] == connectFuture) {
        _inFlight.remove(sig);
      }
    }
  }

  Future<void> evictByHops(List<BastionHopSpec> hops) async {
    final sig = computeRouteSignature(hops);
    final old = _pool.remove(sig);
    if (old != null) {
      await old.dispose();
    }
  }

  Future<void> evictHopId(String hopId) async {
    final matchingKeys = _pool.entries
        .where((e) => e.value.hops.any((h) => h.id == hopId))
        .map((e) => e.key)
        .toList();
    for (final k in matchingKeys) {
      final chain = _pool.remove(k);
      if (chain != null) {
        await chain.dispose();
      }
    }
  }

  Future<void> disposeAll() async {
    final all = _pool.values.toList();
    _pool.clear();
    _inFlight.clear();
    SshBastionChain.clearKeyCache();
    for (final chain in all) {
      await chain.dispose();
    }
  }
}

/// Authenticated AES-256-GCM + PBKDF2-HMAC-SHA256 Encrypted Workspace Backup Codec
/// Matches JalaDesk Desktop's Zero-Trust encrypted document discipline for `.jvault` exports.
class EncryptedVaultBackupCodec {
  static const String magicFormat = 'jaladesk-encrypted-vault-v1';
  static const int pbkdf2Iterations = 100000;
  static final Uint8List _aadBytes = Uint8List.fromList(utf8.encode(magicFormat));

  static String sealJson({
    required Map<String, dynamic> payload,
    required String passphrase,
  }) {
    if (passphrase.isEmpty) {
      throw ArgumentError('Passphrase cannot be empty for encrypted backup.');
    }
    final rng = Random.secure();
    final salt = Uint8List.fromList(List<int>.generate(16, (_) => rng.nextInt(256)));
    final iv = Uint8List.fromList(List<int>.generate(12, (_) => rng.nextInt(256)));
    final key = _deriveKey(passphrase, salt, pbkdf2Iterations);

    final plaintext = Uint8List.fromList(utf8.encode(jsonEncode(payload)));
    final cipher = GCMBlockCipher(AESEngine())
      ..init(
        true,
        AEADParameters(KeyParameter(key), 128, iv, _aadBytes),
      );
    final sealedBytes = cipher.process(plaintext);

    final envelope = <String, dynamic>{
      'format': magicFormat,
      'kdf': 'PBKDF2-HMAC-SHA256',
      'iterations': pbkdf2Iterations,
      'cipher': 'AES-256-GCM',
      'salt': base64Encode(salt),
      'iv': base64Encode(iv),
      'ciphertext': base64Encode(sealedBytes),
      'exportedAt': DateTime.now().toUtc().toIso8601String(),
    };
    return const JsonEncoder.withIndent('  ').convert(envelope);
  }

  static Map<String, dynamic> openJson({
    required String rawEnvelopeJson,
    required String passphrase,
  }) {
    final decoded = jsonDecode(rawEnvelopeJson);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Invalid Vault snapshot JSON object.');
    }
    if (decoded['format'] != magicFormat) {
      throw const FormatException('Unrecognized encrypted Vault envelope version.');
    }
    final iterations = (decoded['iterations'] as num?)?.toInt() ?? pbkdf2Iterations;
    final salt = base64Decode(decoded['salt'] as String);
    final iv = base64Decode(decoded['iv'] as String);
    final ciphertext = base64Decode(decoded['ciphertext'] as String);

    final key = _deriveKey(passphrase, salt, iterations);
    final cipher = GCMBlockCipher(AESEngine())
      ..init(
        false,
        AEADParameters(KeyParameter(key), 128, iv, _aadBytes),
      );

    try {
      final clearBytes = cipher.process(ciphertext);
      final map = jsonDecode(utf8.decode(clearBytes));
      if (map is! Map<String, dynamic>) {
        throw const FormatException('Decrypted payload is not a valid Vault map.');
      }
      return map;
    } on InvalidCipherTextException {
      throw const FormatException('Incorrect passphrase or tampered encrypted Vault backup.');
    }
  }

  static Uint8List _deriveKey(String passphrase, Uint8List salt, int iterations) {
    final derivator = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64))
      ..init(Pbkdf2Parameters(salt, iterations, 32));
    return derivator.process(Uint8List.fromList(utf8.encode(passphrase)));
  }
}
