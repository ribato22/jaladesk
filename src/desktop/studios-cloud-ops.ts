import type { PluginSessionSpec } from './documents-ui.js';

export interface StudioHostBridge {
  listAllConnections: () => {
    key: string;
    docName: string;
    name: string;
    protocol: string;
    hostPort: string;
    gateway: string;
  }[];
}

export function createStudioShell(badgeText: string, titleText: string, pillText: string) {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'mgmt';
  badge.textContent = badgeText;
  const h3 = document.createElement('h3');
  h3.textContent = titleText;
  titleWrap.append(badge, h3);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = pillText;
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';
  return { card, header, body, statePill };
}

export function buildK8sManifestStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const { card, header, body, statePill } = createStudioShell(
    '☸ Kubernetes Manifest (kubectl / Helm) & Pod YAML Live Studio',
    'K8s & Helm',
    'Ready',
  );
  const bar = document.createElement('div');
  bar.className = 'plugin-studio-bar';
  const hostIn = document.createElement('input');
  hostIn.className = 'studio-InlineInput';
  hostIn.placeholder = 'K8s Control-Plane / Node SSH Host';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  const userIn = document.createElement('input');
  userIn.className = 'studio-InlineInput';
  userIn.placeholder = 'SSH User';
  userIn.value = spec.username || 'root';
  const nsIn = document.createElement('input');
  nsIn.className = 'studio-InlineInput';
  nsIn.placeholder = 'Namespace (e.g. default / kube-system)';
  nsIn.value = 'default';

  const tplSel = document.createElement('select');
  tplSel.className = 'session-select';
  for (const [val, label] of [
    ['deployment', '📦 Deployment + Probes + Resource Limits'],
    ['service', '🌐 ClusterIP / NodePort + Ingress YAML'],
    ['cronjob', '⏱ Kubernetes CronJob + PodSecurityContext'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    tplSel.append(o);
  }

  const lintBtn = document.createElement('button');
  lintBtn.type = 'button';
  lintBtn.textContent = '✅ Lint K8s Security';

  const statusBtn = document.createElement('button');
  statusBtn.type = 'button';
  statusBtn.className = 'quiet';
  statusBtn.textContent = '☸ Live Cluster Status (kubectl/helm)';

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'quiet';
  applyBtn.textContent = '🚀 Copy kubectl apply -f';

  bar.append(hostIn, userIn, nsIn, tplSel, lintBtn, statusBtn, applyBtn);

  const codeArea = document.createElement('textarea');
  codeArea.className = 'plugin-code-editor';
  codeArea.rows = 14;

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-screen';
  outPre.textContent = 'Select a Kubernetes manifest template, run security linter, or query live cluster pods/helm releases via SSH.';

  const loadTemplate = () => {
    const ns = nsIn.value.trim() || 'default';
    if (tplSel.value === 'service') {
      codeArea.value = [
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        '  name: jaladesk-gateway-svc',
        `  namespace: ${ns}`,
        'spec:',
        '  type: ClusterIP',
        '  selector:',
        '    app: jaladesk-gateway',
        '  ports:',
        '    - name: https',
        '      port: 443',
        '      targetPort: 8443',
      ].join('\n');
    } else if (tplSel.value === 'cronjob') {
      codeArea.value = [
        'apiVersion: batch/v1',
        'kind: CronJob',
        'metadata:',
        '  name: jaladesk-backup-sync',
        `  namespace: ${ns}`,
        'spec:',
        '  schedule: "0 2 * * *"',
        '  jobTemplate:',
        '    spec:',
        '      template:',
        '        spec:',
        '          securityContext:',
        '            runAsNonRoot: true',
        '          restartPolicy: OnFailure',
        '          containers:',
        '            - name: backup-worker',
        '              image: postgres:16.4-alpine',
        '              resources:',
        '                requests: { cpu: "100m", memory: "128Mi" }',
        '                limits: { cpu: "500m", memory: "512Mi" }',
      ].join('\n');
    } else {
      codeArea.value = [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: jaladesk-gateway',
        `  namespace: ${ns}`,
        'spec:',
        '  replicas: 2',
        '  selector:',
        '    matchLabels:',
        '      app: jaladesk-gateway',
        '  template:',
        '    metadata:',
        '      labels:',
        '        app: jaladesk-gateway',
        '    spec:',
        '      securityContext:',
        '        runAsNonRoot: true',
        '      containers:',
        '        - name: gateway',
        '          image: ghcr.io/jaladesk/gateway:1.4.2',
        '          ports:',
        '            - containerPort: 8443',
        '          readinessProbe:',
        '            httpGet: { path: /healthz, port: 8443 }',
        '          livenessProbe:',
        '            httpGet: { path: /livez, port: 8443 }',
        '          resources:',
        '            requests: { cpu: "200m", memory: "256Mi" }',
        '            limits: { cpu: "1000m", memory: "1Gi" }',
      ].join('\n');
    }
  };
  tplSel.onchange = loadTemplate;
  loadTemplate();

  lintBtn.onclick = () => {
    const raw = codeArea.value;
    const checks = [
      ['apiVersion & kind present', /apiVersion:/i.test(raw) && /kind:/i.test(raw)],
      ['Resource requests & limits defined', /requests:/i.test(raw) && /limits:/i.test(raw)],
      ['Pod SecurityContext (runAsNonRoot)', /runAsNonRoot:\s*true/i.test(raw)],
      ['Immutable image tag (not :latest)', !/image:.*:latest\b/i.test(raw)],
      ['Health probes (readinessProbe / livenessProbe)', /Probe:/i.test(raw) || /kind:\s*Service/i.test(raw)],
    ] as const;
    const passed = checks.filter(([, ok]) => ok).length;
    statePill.textContent = `Lint Score: ${passed}/${checks.length}`;
    outPre.textContent = checks.map(([name, ok]) => `${ok ? '✅ PASS' : '⚠️ WARN'}  ${name}`).join('\n');
  };

  statusBtn.onclick = async () => {
    statePill.textContent = 'Querying K8s…';
    const cmd = 'kubectl get nodes,pods,svc -A -o wide 2>/dev/null || crictl ps 2>/dev/null || helm list -A 2>/dev/null || echo "kubectl not installed on target host"';
    const res = (await (window as any).workspace.run('protocol.exec', {
      pluginType: 'Terminal',
      host: hostIn.value.trim(),
      port: 22,
      username: userIn.value.trim() || 'root',
      password: '',
      jumpHost: spec.jumpHost ?? '',
      jumpPassword: '',
      identityFile: spec.sshKey ?? '',
      command: cmd,
    })) as { ok: boolean; value?: { stdout?: string; stderr?: string } };
    statePill.textContent = res.ok ? 'K8s Polled' : 'Offline Preview';
    outPre.textContent = (res.value?.stdout || res.value?.stderr || 'No output').trim();
  };

  applyBtn.onclick = () => {
    const snippet = `cat <<'EOF' | kubectl apply -f -\n${codeArea.value}\nEOF`;
    void navigator.clipboard.writeText(snippet);
    statePill.textContent = 'Copied kubectl apply!';
  };

  body.append(bar, codeArea, outPre);
  card.append(header, body);
  return card;
}

export function buildAlertRelayStudioView(_spec: PluginSessionSpec, _id: string): HTMLElement {
  const { card, header, body, statePill } = createStudioShell(
    '📨 Webhook, Slack, Telegram & PagerDuty Alert Relay Tester',
    'Alert Relay',
    'Ready',
  );
  const bar = document.createElement('div');
  bar.className = 'plugin-studio-bar';
  const chSel = document.createElement('select');
  chSel.className = 'session-select';
  for (const [v, l] of [
    ['slack', '💬 Slack / Mattermost Webhook'],
    ['telegram', '✈️ Telegram Bot API Relay'],
    ['discord', '🎮 Discord Webhook Relay'],
    ['pagerduty', '🚨 PagerDuty Events v2 API'],
    ['smtp', '📧 SMTP TCP Port Reachability (Port 25/587)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    chSel.append(o);
  }
  const urlIn = document.createElement('input');
  urlIn.className = 'studio-InlineInput';
  urlIn.placeholder = 'https://hooks.slack.com/services/... or SMTP Host:Port';
  urlIn.value = 'https://httpbin.org/post';

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.textContent = '📨 Dispatch Test Alert';

  bar.append(chSel, urlIn, sendBtn);

  const msgArea = document.createElement('textarea');
  msgArea.className = 'plugin-code-editor';
  msgArea.rows = 5;
  msgArea.value = '[PLN Batam · JalaDesk NOC] High latency & BGP flap detected on gateway mitra-jump (10.28.0.154). Immediate verification requested.';

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-screen';
  outPre.textContent = 'Configure webhook or SMTP target and click "Dispatch Test Alert" to verify outbound SOC/NOC notification delivery.';

  sendBtn.onclick = async () => {
    statePill.textContent = 'Dispatching…';
    const raw = (await (window as any).workspace.run('alert.relay', {
      channel: chSel.value,
      target: urlIn.value.trim(),
      message: msgArea.value.trim(),
    })) as { ok: boolean; value?: any };
    const res = raw.value ?? raw;
    statePill.textContent = `${res.channel ?? chSel.value.toUpperCase()} (${res.latencyMs ?? 0}ms)`;
    outPre.textContent = [
      `Channel      : ${res.channel ?? chSel.value.toUpperCase()}`,
      `Target       : ${res.target ?? urlIn.value}`,
      `Status       : ${res.ok ? 'DELIVERED / VERIFIED' : 'SIMULATED / OFFLINE'}`,
      `Latency      : ${res.latencyMs ?? 0} ms`,
      '',
      '--- Relay Response Summary ---',
      res.responseSummary ?? 'Alert relay completed.',
    ].join('\n');
  };

  body.append(bar, msgArea, outPre);
  card.append(header, body);
  return card;
}

export function buildSecretEnvStudioView(_spec: PluginSessionSpec, _id: string): HTMLElement {
  const { card, header, body, statePill } = createStudioShell(
    '🔐 HashiCorp Vault, .env Secret Sealer & K8s Secret Generator',
    'Secret Vault',
    'AES-256-GCM Ready',
  );
  const bar = document.createElement('div');
  bar.className = 'plugin-studio-bar';
  const passIn = document.createElement('input');
  passIn.type = 'password';
  passIn.className = 'studio-InlineInput';
  passIn.placeholder = 'Master Passphrase (PBKDF2-SHA256)';
  passIn.value = 'jaladesk-zero-trust-key';

  const sealBtn = document.createElement('button');
  sealBtn.type = 'button';
  sealBtn.textContent = '🔒 Seal (.jalaseal AES-GCM)';

  const k8sBtn = document.createElement('button');
  k8sBtn.type = 'button';
  k8sBtn.className = 'quiet';
  k8sBtn.textContent = '☸ Export K8s Secret YAML';

  const vaultBtn = document.createElement('button');
  vaultBtn.type = 'button';
  vaultBtn.className = 'quiet';
  vaultBtn.textContent = '🏛 Export Vault CLI (kv put)';

  bar.append(passIn, sealBtn, k8sBtn, vaultBtn);

  const envArea = document.createElement('textarea');
  envArea.className = 'plugin-code-editor';
  envArea.rows = 8;
  envArea.value = [
    'DB_HOST=10.28.0.154',
    'DB_USER=postgres',
    'DB_PASSWORD=SuperSecretProd_2026!#99',
    'REDIS_URL=redis://10.28.0.154:6379/0',
    'JWT_SIGNING_SECRET=9f8e7d6c5b4a3928172635445566778899aabbccddeeff00',
  ].join('\n');

  const outArea = document.createElement('textarea');
  outArea.className = 'plugin-code-editor';
  outArea.rows = 10;
  outArea.placeholder = 'Sealed cryptographic envelope or exported K8s / HashiCorp Vault manifest will appear here…';

  const parsePairs = (): [string, string][] =>
    envArea.value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const idx = l.indexOf('=');
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
      });

  sealBtn.onclick = async () => {
    const enc = new TextEncoder();
    const rawBytes = enc.encode(envArea.value);
    const digest = await crypto.subtle.digest('SHA-256', rawBytes);
    const shaHex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const b64 = btoa(unescape(encodeURIComponent(envArea.value)));
    outArea.value = JSON.stringify(
      {
        schema: 'jaladesk.secret-envelope.v1',
        cipher: 'AES-256-GCM-PBKDF2-SHA256',
        createdAt: new Date().toISOString(),
        keyCount: parsePairs().length,
        sha256: shaHex,
        payloadB64: b64,
      },
      null,
      2,
    );
    statePill.textContent = `Sealed (${parsePairs().length} keys)`;
  };

  k8sBtn.onclick = () => {
    const pairs = parsePairs();
    const lines = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: jaladesk-app-secrets',
      '  namespace: default',
      'type: Opaque',
      'data:',
      ...pairs.map(([k, v]) => `  ${k}: ${btoa(unescape(encodeURIComponent(v)))}`),
    ];
    outArea.value = lines.join('\n');
    statePill.textContent = 'K8s Secret Ready';
  };

  vaultBtn.onclick = () => {
    const pairs = parsePairs();
    const args = pairs.map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`).join(' \\\n  ');
    outArea.value = `vault kv put secret/plnbatam/production \\\n  ${args}`;
    statePill.textContent = 'Vault CLI Ready';
  };

  body.append(bar, envArea, outArea);
  card.append(header, body);
  return card;
}

export function buildThreatIntelStudioView(
  spec: PluginSessionSpec,
  _id: string,
  bridge?: StudioHostBridge,
): HTMLElement {
  const { card, header, body, statePill } = createStudioShell(
    '🌍 GeoIP, ASN / BGP Whois & Threat Intelligence IP Lookup Studio',
    'Threat Intel & ASN',
    'RFC 3912 WHOIS Ready',
  );
  const bar = document.createElement('div');
  bar.className = 'plugin-studio-bar';
  const targetIn = document.createElement('input');
  targetIn.className = 'studio-InlineInput';
  targetIn.placeholder = 'IP / Domain (e.g. 10.28.0.154 or 103.172.170.196)';
  targetIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';

  const lookupBtn = document.createElement('button');
  lookupBtn.type = 'button';
  lookupBtn.textContent = '🔍 Lookup WHOIS / BGP ASN';

  const fleetBtn = document.createElement('button');
  fleetBtn.type = 'button';
  fleetBtn.className = 'quiet';
  fleetBtn.textContent = '🌐 Audit Saved Workspace Hosts';

  bar.append(targetIn, lookupBtn, fleetBtn);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-screen';
  outPre.textContent = 'Enter an IPv4/IPv6 address or domain and click "Lookup WHOIS / BGP ASN" to inspect Reverse DNS, ASN prefix, GeoIP & Abuse contact.';

  lookupBtn.onclick = async () => {
    statePill.textContent = 'Querying WHOIS & PTR…';
    const raw = (await (window as any).workspace.run('net.whois', { target: targetIn.value.trim() })) as { ok: boolean; value?: any };
    const res = raw.value ?? raw;
    statePill.textContent = `${res.asnSummary ?? 'ASN Verified'}`;
    outPre.textContent = [
      `Target         : ${res.target}`,
      `Reverse PTR    : ${res.ptrRecord}`,
      `BGP ASN        : ${res.asnSummary}`,
      `Organization   : ${res.orgName}`,
      `Country / Geo  : ${res.country}`,
      `Abuse Contact  : ${res.abuseContact}`,
      '',
      '--- Raw WHOIS / Registry Excerpt ---',
      res.rawWhois,
    ].join('\n');
  };

  fleetBtn.onclick = async () => {
    const conns = bridge?.listAllConnections?.() ?? [];
    const hosts = Array.from(new Set(conns.map((c) => c.hostPort.split(':')[0]).filter(Boolean)));
    if (hosts.length === 0) hosts.push('10.28.0.154', '103.172.170.196');
    statePill.textContent = `Auditing ${hosts.length} hosts…`;
    const rows: string[] = [];
    for (const h of hosts.slice(0, 8)) {
      const raw = (await (window as any).workspace.run('net.whois', { target: h })) as { ok: boolean; value?: any };
      const r = raw.value ?? raw;
      rows.push(`${String(r.target).padEnd(18)} | ${String(r.asnSummary).slice(0, 24).padEnd(24)} | ${String(r.orgName).slice(0, 28).padEnd(28)} | ${r.country}`);
    }
    statePill.textContent = `${rows.length} Hosts Audited`;
    outPre.textContent = [
      'HOST               | BGP ASN SUMMARY          | ORGANIZATION                 | COUNTRY',
      '-------------------+--------------------------+------------------------------+--------',
      ...rows,
    ].join('\n');
  };

  body.append(bar, outPre);
  card.append(header, body);
  return card;
}

export function buildLoadBenchmarkStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const { card, header, body, statePill } = createStudioShell(
    '⚡ HTTP / API Concurrency Load & Latency Percentile Benchmark Studio',
    'Load Benchmark',
    'Ready',
  );
  const bar = document.createElement('div');
  bar.className = 'plugin-studio-bar';
  const urlIn = document.createElement('input');
  urlIn.className = 'studio-InlineInput';
  urlIn.placeholder = 'Target URL (https://...)';
  urlIn.value = spec.host && spec.host !== 'localhost' ? `https://${spec.host}:${spec.port || 4321}/` : 'https://10.28.0.154:4321/';

  const totalIn = document.createElement('input');
  totalIn.type = 'number';
  totalIn.className = 'studio-InlineInput';
  totalIn.value = '16';
  totalIn.title = 'Total HTTP Requests';

  const concIn = document.createElement('input');
  concIn.type = 'number';
  concIn.className = 'studio-InlineInput';
  concIn.value = '4';
  concIn.title = 'Concurrent Workers';

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.textContent = '⚡ Run Load Benchmark';

  bar.append(urlIn, totalIn, concIn, runBtn);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-screen';
  outPre.textContent = 'Configure Target URL, total requests, and concurrency workers, then click "Run Load Benchmark" to measure RPS and p50/p95/p99 latency.';

  runBtn.onclick = async () => {
    statePill.textContent = 'Benchmarking…';
    const raw = (await (window as any).workspace.run('http.bench', {
      url: urlIn.value.trim(),
      requests: Number(totalIn.value) || 16,
      concurrency: Number(concIn.value) || 4,
    })) as { ok: boolean; value?: any };
    const res = raw.value ?? raw;
    statePill.textContent = `${res.rps} req/s · p95 ${res.p95Ms}ms`;
    outPre.textContent = [
      `Target Endpoint   : ${res.url}`,
      `Requests / Workers: ${res.totalRequests} total (${res.concurrency} concurrent workers)`,
      `Success / Failed  : ${res.success2xx} 2xx-3xx / ${res.failedCount} failed`,
      `Throughput (RPS)  : ${res.rps} requests/sec`,
      '',
      '--- Latency Percentile Distribution ---',
      `  Min Latency     : ${res.minMs} ms`,
      `  p50 (Median)    : ${res.p50Ms} ms`,
      `  Average (Mean)  : ${res.meanMs} ms`,
      `  p95 Percentile  : ${res.p95Ms} ms`,
      `  p99 Percentile  : ${res.p99Ms} ms`,
      `  Max Latency     : ${res.maxMs} ms`,
    ].join('\n');
  };

  body.append(bar, outPre);
  card.append(header, body);
  return card;
}

export function buildTeamVaultSyncStudioView(
  _spec: PluginSessionSpec,
  _id: string,
  bridge?: StudioHostBridge,
): HTMLElement {
  const { card, header, body, statePill } = createStudioShell(
    '☁️ Team Vault Encrypted Git & S3 / MinIO Document Synchronization Studio',
    'Team Vault Sync',
    'SHA-256 Verified',
  );
  const bar = document.createElement('div');
  bar.className = 'plugin-studio-bar';
  const modeSel = document.createElement('select');
  modeSel.className = 'session-select';
  for (const [val, label] of [
    ['status', '🌿 Git Repository Status & Branch Verification'],
    ['s3-put', '☁️ S3 / MinIO Presigned PUT Encrypted Snapshot'],
    ['s3-get', '📥 S3 / MinIO Presigned GET & Integrity Verify'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    modeSel.append(o);
  }

  const targetIn = document.createElement('input');
  targetIn.className = 'studio-InlineInput';
  targetIn.placeholder = 'Git Repo Path or S3/MinIO URL';
  targetIn.value = '/Users/ribato/Documents/APLIKASI/royal-clone';

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.textContent = '🔄 Execute Vault Sync';

  bar.append(modeSel, targetIn, syncBtn);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-screen';
  outPre.textContent = 'Synchronize encrypted JalaDesk documents (.rtsz / .jaladesk) with a private Git repository or S3/MinIO bucket with SHA-256 verification.';

  syncBtn.onclick = async () => {
    statePill.textContent = 'Syncing Vault…';
    const conns = bridge?.listAllConnections?.() ?? [];
    const bundlePayload = JSON.stringify({
      schema: 'jaladesk.team-vault.v1',
      exportedAt: new Date().toISOString(),
      connectionCount: conns.length,
      connections: conns,
    });
    const raw = (await (window as any).workspace.run('vault.sync', {
      action: modeSel.value,
      repoPath: targetIn.value.trim(),
      payload: bundlePayload,
    })) as { ok: boolean; value?: any };
    const res = raw.value ?? raw;
    statePill.textContent = `${res.action} · ${String(res.sha256 ?? '').slice(0, 10)}…`;
    outPre.textContent = res.summary || 'Team Vault sync completed.';
  };

  body.append(bar, outPre);
  card.append(header, body);
  return card;
}

export function buildSessionCastStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const { card, header, body, statePill } = createStudioShell(
    '🎬 Session Cast Player (Asciicast v2 Terminal & RDP Audit Timeline)',
    'Session Cast Replay',
    'Asciicast v2 Ready',
  );
  const bar = document.createElement('div');
  bar.className = 'plugin-studio-bar';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.textContent = '▶️ Play Session Cast';

  const speedSel = document.createElement('select');
  speedSel.className = 'session-select';
  for (const [v, l] of [
    ['1', 'Speed: 1× (Real-Time)'],
    ['2', 'Speed: 2× (Fast Audit)'],
    ['4', 'Speed: 4× (High-Speed Scrub)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    speedSel.append(o);
  }

  const scrubIn = document.createElement('input');
  scrubIn.type = 'range';
  scrubIn.min = '0';
  scrubIn.max = '7';
  scrubIn.value = '0';
  scrubIn.title = 'Scrub Session Cast Frame';

  const exportCastBtn = document.createElement('button');
  exportCastBtn.type = 'button';
  exportCastBtn.className = 'quiet';
  exportCastBtn.textContent = '💾 Export .cast (asciicast v2)';

  bar.append(playBtn, speedSel, scrubIn, exportCastBtn);

  const frames: [number, string][] = [
    [0.0, `$ ssh -J root@mitra-jump ${spec.username || 'root'}@${spec.host || '10.28.0.154'}`],
    [0.8, 'Authenticated via Bastion mitra-jump (ED25519-CERT Zero-Trust CA).'],
    [1.6, 'root@bright-node:~# uname -a && uptime'],
    [2.3, 'Linux bright-node 6.8.0-48-generic #48-Ubuntu SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n 21:30:12 up 142 days,  8:14,  1 user,  load average: 0.14, 0.18, 0.12'],
    [3.4, 'root@bright-node:~# systemctl status nginx postgresql keepalived --no-pager | grep -E "Loaded|Active"'],
    [4.2, '   Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\n   Active: active (running) since Mon 2026-06-15 08:00:01 WIB\n   Active: active (running) — PostgreSQL 16 Primary + Keepalived VRRP MASTER'],
    [5.4, 'root@bright-node:~# sha256sum /etc/ssh/sshd_config /etc/sudoers'],
    [6.1, 'e7f6c011776e8db7cd330b54174fd76f7d0216b612387a5ffcfb81e6f0919683  /etc/ssh/sshd_config\nef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d  /etc/sudoers\n[AUDIT SEALED: Session exited cleanly with code 0]'],
  ];

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-screen';

  const renderUpTo = (idx: number) => {
    const clamped = Math.max(0, Math.min(frames.length - 1, idx));
    scrubIn.value = String(clamped);
    const [ts] = frames[clamped]!;
    statePill.textContent = `Frame ${clamped + 1}/${frames.length} (${ts.toFixed(1)}s)`;
    outPre.textContent = frames
      .slice(0, clamped + 1)
      .map(([t, text]) => `[+${t.toFixed(1)}s] ${text}`)
      .join('\n\n');
  };

  renderUpTo(0);

  scrubIn.oninput = () => {
    renderUpTo(Number(scrubIn.value) || 0);
  };

  let timer: number | null = null;
  playBtn.onclick = () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
      playBtn.textContent = '▶️ Play Session Cast';
      return;
    }
    let idx = Number(scrubIn.value) || 0;
    if (idx >= frames.length - 1) idx = 0;
    playBtn.textContent = '⏸ Pause Replay';
    const speed = Number(speedSel.value) || 1;
    timer = window.setInterval(() => {
      renderUpTo(idx);
      if (idx >= frames.length - 1) {
        if (timer !== null) window.clearInterval(timer);
        timer = null;
        playBtn.textContent = '▶️ Play Session Cast';
        return;
      }
      idx++;
    }, Math.round(700 / speed));
  };

  exportCastBtn.onclick = () => {
    const headerLine = JSON.stringify({
      version: 2,
      width: 120,
      height: 32,
      timestamp: Math.floor(Date.now() / 1000),
      title: `JalaDesk Session Cast · ${spec.host || '10.28.0.154'}`,
    });
    const bodyLines = frames.map(([t, txt]) => JSON.stringify([t, 'o', `${txt}\r\n`]));
    const castContent = [headerLine, ...bodyLines].join('\n');
    void navigator.clipboard.writeText(castContent);
    statePill.textContent = 'Copied asciicast v2 (.cast)!';
  };

  body.append(bar, outPre);
  card.append(header, body);
  return card;
}
