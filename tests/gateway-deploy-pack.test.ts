import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function readRepoFile(relPath: string): string {
  const abs = join(ROOT, relPath);
  assert.ok(existsSync(abs), `Expected file to exist: ${relPath}`);
  return readFileSync(abs, 'utf8');
}

function parseEnvTemplate(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    assert.ok(eqIdx > 0, `Invalid .env line (missing '='): ${line}`);
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    assert.match(key, /^[A-Z][A-Z0-9_]*$/, `Invalid env var identifier: ${key}`);
    vars.set(key, val);
  }
  return vars;
}

/**
 * Lightweight strict TOML parser for Fly.io deploy manifests (tables, array-of-tables, strings,
 * numbers, booleans, and string arrays) so we validate structure without external dependencies.
 */
function parseSimpleToml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;

  const parseValue = (raw: string): unknown => {
    const trimmed = raw.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return JSON.parse(trimmed);
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return JSON.parse(trimmed);
    }
    throw new Error(`Unsupported TOML value syntax: ${trimmed}`);
  };

  const getOrCreateTable = (parts: string[], isArray: boolean): Record<string, unknown> => {
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      if (isLast && isArray) {
        if (!Array.isArray(cursor[part])) {
          cursor[part] = [];
        }
        const entry: Record<string, unknown> = {};
        (cursor[part] as unknown[]).push(entry);
        return entry;
      }
      if (cursor[part] === undefined) {
        cursor[part] = {};
      }
      const next = cursor[part];
      if (Array.isArray(next)) {
        cursor = next[next.length - 1] as Record<string, unknown>;
      } else {
        cursor = next as Record<string, unknown>;
      }
    }
    return cursor;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const stripped = rawLine.replace(/\s+#.*$/, '').trim();
    if (!stripped || stripped.startsWith('#')) continue;

    if (stripped.startsWith('[[') && stripped.endsWith(']]')) {
      const name = stripped.slice(2, -2).trim();
      current = getOrCreateTable(name.split('.'), true);
      continue;
    }
    if (stripped.startsWith('[') && stripped.endsWith(']')) {
      const name = stripped.slice(1, -1).trim();
      current = getOrCreateTable(name.split('.'), false);
      continue;
    }
    const eqIdx = stripped.indexOf('=');
    assert.ok(eqIdx > 0, `Invalid TOML assignment: ${rawLine}`);
    const key = stripped.slice(0, eqIdx).trim();
    const val = stripped.slice(eqIdx + 1).trim();
    current[key] = parseValue(val);
  }
  return root;
}

/**
 * Extracts a top-level YAML block for a named service under `services:` so assertions can inspect
 * each service in isolation (e.g. confirming `jaladesk-gateway` has no `ports:` while `caddy` does).
 */
function extractYamlServiceBlock(yaml: string, serviceName: string): string {
  const lines = yaml.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.ok(startIdx >= 0, `Service "${serviceName}" not found in compose file`);
  const block: string[] = [lines[startIdx]!];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) break;
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function assertCleanYamlSyntax(yaml: string, label: string): void {
  assert.ok(yaml.trim().length > 0, `${label}: YAML must not be empty`);
  assert.ok(!/\t/.test(yaml), `${label}: YAML must not contain tab characters`);
  for (const [idx, line] of yaml.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    assert.equal(indent % 2, 0, `${label}:${idx + 1} has odd indentation (${indent} spaces): ${line}`);
  }
}

function extractGatewayServerEnvVars(): Set<string> {
  const serverSrc = readRepoFile('src/gateway/server.ts');
  const vars = new Set<string>();
  for (const match of serverSrc.matchAll(/process\.env\.(JALADESK_[A-Z0-9_]+)/g)) {
    vars.add(match[1]!);
  }
  return vars;
}

test('deploy pack & CI/CD files all exist and align with Dockerfile.gateway & server.ts', () => {
  const requiredFiles = [
    'Dockerfile.gateway',
    'docker-compose.gateway.yml',
    'deploy/.env.example',
    'deploy/caddy/Caddyfile',
    'deploy/caddy/docker-compose.caddy.yml',
    'deploy/cloudflare/docker-compose.cloudflared.yml',
    'fly.gateway.toml',
    'railway.gateway.json',
    '.github/workflows/ci-verify.yml',
    '.github/workflows/gateway-docker.yml',
    'docs/GATEWAY.md',
    'README.md',
  ];
  for (const file of requiredFiles) {
    assert.ok(existsSync(join(ROOT, file)), `Missing required file: ${file}`);
  }

  const dockerfile = readRepoFile('Dockerfile.gateway');
  const serverSrc = readRepoFile('src/gateway/server.ts');
  assert.match(dockerfile, /FROM\s+node:24-bookworm\s+AS\s+builder/);
  assert.match(dockerfile, /FROM\s+node:24-bookworm-slim\s+AS\s+runtime/);
  assert.match(dockerfile, /-DCMAKE_INSTALL_LIBDIR=lib/);
  assert.match(dockerfile, /-DWITH_UNICODE_BUILTIN=ON/);
  assert.match(dockerfile, /-DWITH_KRB5=OFF/);
  assert.match(dockerfile, /-DWITH_MANPAGES=OFF/);
  assert.match(dockerfile, /\bpython3\b/);
  assert.match(dockerfile, /EXPOSE\s+8443/);
  assert.match(dockerfile, /JALADESK_GATEWAY_PORT=8443/);
  assert.match(dockerfile, /\/healthz/);
  assert.match(serverSrc, /pathname === '\/healthz'/);
});

test('deploy/.env.example defines exact server.ts env vars and zero hardcoded secrets', () => {
  const envContent = readRepoFile('deploy/.env.example');
  const vars = parseEnvTemplate(envContent);
  const realServerVars = extractGatewayServerEnvVars();

  assert.equal(vars.get('JALADESK_GATEWAY_DOMAIN'), 'gateway.example.com');
  assert.equal(vars.get('JALADESK_GATEWAY_HOST'), '0.0.0.0');
  assert.equal(vars.get('JALADESK_GATEWAY_PORT'), '8443');
  assert.equal(vars.get('JALADESK_GATEWAY_CORS_ORIGINS'), 'https://ribato22.github.io');
  assert.ok(vars.has('JALADESK_GATEWAY_ALLOW_CIDRS'), 'must define JALADESK_GATEWAY_ALLOW_CIDRS');
  assert.ok(vars.has('JALADESK_GATEWAY_DENY_CIDRS'), 'must define JALADESK_GATEWAY_DENY_CIDRS');
  assert.equal(vars.get('JALADESK_GATEWAY_TOKEN'), '', 'JALADESK_GATEWAY_TOKEN must be blank in .env.example');
  assert.equal(vars.get('CLOUDFLARE_TUNNEL_TOKEN'), '', 'CLOUDFLARE_TUNNEL_TOKEN must be blank in .env.example');
  assert.equal(vars.get('JALADESK_GATEWAY_DEMO'), '0', 'demo mode must default off in production template');

  // Every JALADESK_GATEWAY_* runtime variable (except Caddy's JALADESK_GATEWAY_DOMAIN) must exist in server.ts
  for (const key of vars.keys()) {
    if (key.startsWith('JALADESK_GATEWAY_') && key !== 'JALADESK_GATEWAY_DOMAIN') {
      assert.ok(
        realServerVars.has(key),
        `Env var ${key} in deploy/.env.example is not read by src/gateway/server.ts`,
      );
    }
  }
});

test('deploy/caddy/Caddyfile enforces TLS 1.3, enterprise headers, WS proxy & /healthz check', () => {
  const caddyfile = readRepoFile('deploy/caddy/Caddyfile');

  assert.match(caddyfile, /\{\$JALADESK_GATEWAY_DOMAIN\}/);
  assert.match(caddyfile, /protocols\s+tls1\.3/);
  assert.match(caddyfile, /Strict-Transport-Security\s+"max-age=\d+;\s*includeSubDomains;\s*preload"/);
  assert.match(caddyfile, /X-Content-Type-Options\s+"nosniff"/);
  assert.match(caddyfile, /Referrer-Policy\s+"no-referrer"/);
  assert.match(caddyfile, /X-Frame-Options\s+"DENY"/);
  assert.match(caddyfile, /Permissions-Policy\s+"[^"]+"/);
  assert.match(caddyfile, /-Server/);
  assert.match(caddyfile, /reverse_proxy\s+jaladesk-gateway:8443/);
  assert.match(caddyfile, /flush_interval\s+-1/);
  assert.match(caddyfile, /health_uri\s+\/healthz/);
});

test('deploy/caddy/docker-compose.caddy.yml isolates gateway on private network with full container hardening', () => {
  const compose = readRepoFile('deploy/caddy/docker-compose.caddy.yml');
  assertCleanYamlSyntax(compose, 'deploy/caddy/docker-compose.caddy.yml');

  const gateway = extractYamlServiceBlock(compose, 'jaladesk-gateway');
  const caddy = extractYamlServiceBlock(compose, 'caddy');

  // Gateway build & runtime alignment
  assert.match(gateway, /context:\s+\.\.\/\.\./);
  assert.match(gateway, /dockerfile:\s+Dockerfile\.gateway/);
  assert.match(gateway, /JALADESK_GATEWAY_HOST:\s+"0\.0\.0\.0"/);
  assert.match(gateway, /JALADESK_GATEWAY_PORT:\s+"8443"/);
  assert.match(gateway, /JALADESK_GATEWAY_CORS_ORIGINS:.*https:\/\/ribato22\.github\.io/);
  assert.match(gateway, /JALADESK_GATEWAY_ALLOW_CIDRS:/);

  // Zero exposed host ports on gateway
  assert.doesNotMatch(gateway, /^\s+ports:\s*$/m, 'jaladesk-gateway must NOT expose host ports in Caddy stack');

  // Container hardening on gateway
  assert.match(gateway, /read_only:\s+true/);
  assert.match(gateway, /cap_drop:\s*\n\s+-\s+ALL/);
  assert.match(gateway, /security_opt:\s*\n\s+-\s+no-new-privileges:true/);
  assert.match(gateway, /tmpfs:\s*\n\s+-\s+\/tmp/);
  assert.match(gateway, /healthcheck:[\s\S]*\/healthz/);

  // Caddy reverse proxy hardening & wiring
  assert.match(caddy, /image:\s+caddy:/);
  assert.match(caddy, /condition:\s+service_healthy/);
  assert.match(caddy, /"80:80"/);
  assert.match(caddy, /"443:443"/);
  assert.match(caddy, /\.\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/);
  assert.match(caddy, /JALADESK_GATEWAY_DOMAIN:/);
  assert.match(caddy, /cap_drop:\s*\n\s+-\s+ALL/);
  assert.match(caddy, /NET_BIND_SERVICE/);
  assert.match(caddy, /no-new-privileges:true/);

  // All JALADESK_GATEWAY_* env vars passed to gateway exist in src/gateway/server.ts
  const realServerVars = extractGatewayServerEnvVars();
  for (const match of gateway.matchAll(/^\s+(JALADESK_GATEWAY_[A-Z0-9_]+):/gm)) {
    assert.ok(realServerVars.has(match[1]!), `Unknown gateway env var in Caddy compose: ${match[1]}`);
  }
});

test('deploy/cloudflare/docker-compose.cloudflared.yml opens ZERO inbound ports and hardens both containers', () => {
  const compose = readRepoFile('deploy/cloudflare/docker-compose.cloudflared.yml');
  assertCleanYamlSyntax(compose, 'deploy/cloudflare/docker-compose.cloudflared.yml');

  // ZERO host port bindings anywhere in the Cloudflare Tunnel compose stack
  assert.doesNotMatch(compose, /^\s+ports:\s*$/m, 'Cloudflare tunnel stack must open ZERO inbound host ports');

  const gateway = extractYamlServiceBlock(compose, 'jaladesk-gateway');
  const cloudflared = extractYamlServiceBlock(compose, 'cloudflared');

  // Gateway hardening & Dockerfile alignment
  assert.match(gateway, /context:\s+\.\.\/\.\./);
  assert.match(gateway, /dockerfile:\s+Dockerfile\.gateway/);
  assert.match(gateway, /read_only:\s+true/);
  assert.match(gateway, /cap_drop:\s*\n\s+-\s+ALL/);
  assert.match(gateway, /security_opt:\s*\n\s+-\s+no-new-privileges:true/);
  assert.match(gateway, /tmpfs:\s*\n\s+-\s+\/tmp/);
  assert.match(gateway, /healthcheck:[\s\S]*\/healthz/);

  // Cloudflared tunnel connector
  assert.match(cloudflared, /image:\s+cloudflare\/cloudflared:latest/);
  assert.match(cloudflared, /condition:\s+service_healthy/);
  assert.match(cloudflared, /-\s+tunnel/);
  assert.match(cloudflared, /-\s+--no-autoupdate/);
  assert.match(cloudflared, /-\s+run/);
  assert.match(cloudflared, /-\s+--token/);
  assert.match(cloudflared, /CLOUDFLARE_TUNNEL_TOKEN/);
  assert.match(cloudflared, /read_only:\s+true/);
  assert.match(cloudflared, /cap_drop:\s*\n\s+-\s+ALL/);
  assert.match(cloudflared, /no-new-privileges:true/);
  assert.match(compose, /http:\/\/jaladesk-gateway:8443/);
});

test('fly.gateway.toml is valid TOML aligned with Dockerfile.gateway, port 8443, and /healthz', () => {
  const raw = readRepoFile('fly.gateway.toml');
  const parsed = parseSimpleToml(raw);

  const build = parsed.build as Record<string, unknown>;
  assert.equal(build.dockerfile, 'Dockerfile.gateway');

  const env = parsed.env as Record<string, unknown>;
  assert.equal(env.JALADESK_GATEWAY_HOST, '0.0.0.0');
  assert.equal(env.JALADESK_GATEWAY_PORT, '8443');
  assert.equal(env.JALADESK_GATEWAY_CORS_ORIGINS, 'https://ribato22.github.io');

  const httpService = parsed.http_service as Record<string, unknown>;
  assert.equal(httpService.internal_port, 8443);
  assert.equal(httpService.force_https, true);
  assert.equal(httpService.auto_stop_machines, 'suspend');
  assert.equal(httpService.auto_start_machines, true);
  assert.equal(httpService.min_machines_running, 0);

  const checks = httpService.checks as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(checks) && checks.length >= 1, 'Expected [[http_service.checks]] entry');
  assert.equal(checks[0]!.path, '/healthz');
  assert.equal(checks[0]!.method, 'GET');

  // Verify every env var matches server.ts
  const realServerVars = extractGatewayServerEnvVars();
  for (const key of Object.keys(env)) {
    assert.ok(realServerVars.has(key), `Unknown env var in fly.gateway.toml: ${key}`);
  }
});

test('railway.gateway.json is valid JSON matching Railway schema and Dockerfile.gateway', () => {
  const raw = readRepoFile('railway.gateway.json');
  const parsed = JSON.parse(raw) as {
    $schema?: string;
    build?: { builder?: string; dockerfilePath?: string };
    deploy?: { healthcheckPath?: string; healthcheckTimeout?: number; restartPolicyType?: string };
  };

  assert.equal(parsed.$schema, 'https://railway.com/railway.schema.json');
  assert.equal(parsed.build?.builder, 'DOCKERFILE');
  assert.equal(parsed.build?.dockerfilePath, 'Dockerfile.gateway');
  assert.equal(parsed.deploy?.healthcheckPath, '/healthz');
  assert.equal(parsed.deploy?.healthcheckTimeout, 60);
  assert.equal(parsed.deploy?.restartPolicyType, 'ON_FAILURE');
});

test('.github/workflows/ci-verify.yml configures least-privilege Node 24 build & test CI', () => {
  const workflow = readRepoFile('.github/workflows/ci-verify.yml');
  assertCleanYamlSyntax(workflow, '.github/workflows/ci-verify.yml');

  assert.match(workflow, /^on:\s*\n[\s\S]*push:[\s\S]*branches:[\s\S]*-\s+main/m);
  assert.match(workflow, /pull_request:[\s\S]*branches:[\s\S]*-\s+main/);
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read\s*$/m);
  assert.doesNotMatch(workflow, /:\s+write\b/, 'ci-verify.yml must stay strictly read-only');
  assert.match(workflow, /name:\s+Build & Test \(Node 24\)/);
  assert.match(workflow, /uses:\s+actions\/checkout@v4/);
  assert.match(workflow, /uses:\s+actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s+["']?24["']?/);
  assert.match(workflow, /run:\s+npm ci/);
  assert.match(workflow, /run:\s+npm run build/);
  assert.match(workflow, /run:\s+npm test/);
});

test('.github/workflows/gateway-docker.yml builds multi-arch GHCR images with provenance & SBOM', () => {
  const workflow = readRepoFile('.github/workflows/gateway-docker.yml');
  assertCleanYamlSyntax(workflow, '.github/workflows/gateway-docker.yml');

  assert.match(workflow, /tags:\s*\n\s+-\s+["']?v\*["']?/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s+read/);
  assert.match(workflow, /packages:\s+write/);
  assert.match(workflow, /attestations:\s+write/);
  assert.match(workflow, /id-token:\s+write/);
  assert.match(workflow, /uses:\s+actions\/checkout@v4/);
  assert.match(workflow, /uses:\s+docker\/setup-qemu-action@v3/);
  assert.match(workflow, /uses:\s+docker\/setup-buildx-action@v3/);
  assert.match(workflow, /uses:\s+docker\/login-action@v3/);
  assert.match(workflow, /uses:\s+docker\/metadata-action@v5/);
  assert.match(workflow, /uses:\s+docker\/build-push-action@v6/);
  assert.match(workflow, /ghcr\.io\/ribato22\/jaladesk-gateway/);
  assert.match(workflow, /file:\s+Dockerfile\.gateway/);
  assert.match(workflow, /platforms:\s+linux\/amd64,linux\/arm64/);
  assert.match(workflow, /org\.opencontainers\.image\.title=/);
  assert.match(workflow, /org\.opencontainers\.image\.licenses=Apache-2\.0/);
  assert.match(workflow, /provenance:\s+mode=max/);
  assert.match(workflow, /sbom:\s+true/);
});

test('zero hardcoded secrets exist across all deploy pack, workflow & governance files', () => {
  const filesToScan = [
    'deploy/.env.example',
    'deploy/caddy/Caddyfile',
    'deploy/caddy/docker-compose.caddy.yml',
    'deploy/cloudflare/docker-compose.cloudflared.yml',
    'fly.gateway.toml',
    'railway.gateway.json',
    '.github/workflows/ci-verify.yml',
    '.github/workflows/gateway-docker.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
  ];

  const secretPatterns: Array<{ name: string; re: RegExp }> = [
    { name: 'GitHub PAT', re: /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{16,}\b/ },
    { name: 'JWT / Cloudflare Tunnel token', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
    { name: 'PEM Private Key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
    { name: 'Hardcoded 256-bit hex secret assignment', re: /(?:TOKEN|SECRET|PASSWORD)\s*[:=]\s*["']?[0-9a-fA-F]{32,}["']?/ },
  ];

  for (const relPath of filesToScan) {
    const content = readRepoFile(relPath);
    for (const { name, re } of secretPatterns) {
      assert.doesNotMatch(content, re, `Potential hardcoded ${name} detected in ${relPath}`);
    }
  }
});

test('docs/GATEWAY.md and README.md cover all 4 JalaDesk surfaces and all 4 deploy targets', () => {
  const gatewayDoc = readRepoFile('docs/GATEWAY.md');
  const readme = readRepoFile('README.md');

  for (const [name, doc] of [
    ['docs/GATEWAY.md', gatewayDoc],
    ['README.md', readme],
  ] as const) {
    // 4 JalaDesk surfaces
    assert.match(doc, /Desktop Studio \+ 1-Click Web Bridge/, `${name}: missing Desktop Studio + 1-Click Web Bridge`);
    assert.match(doc, /Android Foldable Flex Mode/, `${name}: missing Android Foldable Flex Mode`);
    assert.match(doc, /v1\.17\.0/, `${name}: missing v1.17.0 reference`);
    assert.match(doc, /https:\/\/ribato22\.github\.io\/jaladesk\/app\//, `${name}: missing Web PWA URL`);
    assert.match(doc, /JSR1/, `${name}: missing JSR1 gateway reference`);

    // 4 production deploy pack targets
    assert.match(doc, /deploy\/caddy\/docker-compose\.caddy\.yml/, `${name}: missing Caddy compose command`);
    assert.match(doc, /deploy\/cloudflare\/docker-compose\.cloudflared\.yml/, `${name}: missing Cloudflare compose command`);
    assert.match(doc, /fly\.gateway\.toml/, `${name}: missing Fly.io deploy reference`);
    assert.match(doc, /railway\.gateway\.json/, `${name}: missing Railway deploy reference`);
  }
});

test('open-source governance docs (SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md) meet enterprise standards', () => {
  const security = readRepoFile('SECURITY.md');
  assert.match(security, /1\.17\.x/);
  assert.match(security, /Private Vulnerability Reporting/i);
  assert.match(security, /rizkybachtiar7@gmail\.com/);
  assert.match(security, /48 hours/i);
  assert.match(security, /7 days/i);
  assert.match(security, /AES-256-GCM/);
  assert.match(security, /never stores user vaults/i);
  assert.match(security, /169\.254\.169\.254/);
  assert.match(security, /SSRF/);

  const contributing = readRepoFile('CONTRIBUTING.md');
  assert.match(contributing, /Node\.js 24/i);
  assert.match(contributing, /Android Foldable/i);
  assert.match(contributing, /Web PWA/i);
  assert.match(contributing, /innerHTML/);
  assert.match(contributing, /style=""/);
  assert.match(contributing, /Zero Plaintext/i);
  assert.match(contributing, /npm run build && npm test/);
  assert.match(contributing, /flutter test/);
  assert.match(contributing, /impeccable detect/);

  const coc = readRepoFile('CODE_OF_CONDUCT.md');
  assert.match(coc, /Contributor Covenant/);
  assert.match(coc, /version 2\.1/i);
  assert.match(coc, /rizkybachtiar7@gmail\.com/);
});

test('.github issue forms & PR template have valid YAML and cover all 4 JalaDesk surfaces', () => {
  const bugReport = readRepoFile('.github/ISSUE_TEMPLATE/bug_report.yml');
  const featureReq = readRepoFile('.github/ISSUE_TEMPLATE/feature_request.yml');
  const config = readRepoFile('.github/ISSUE_TEMPLATE/config.yml');
  const prTemplate = readRepoFile('.github/PULL_REQUEST_TEMPLATE.md');

  assertCleanYamlSyntax(bugReport, '.github/ISSUE_TEMPLATE/bug_report.yml');
  assertCleanYamlSyntax(featureReq, '.github/ISSUE_TEMPLATE/feature_request.yml');
  assertCleanYamlSyntax(config, '.github/ISSUE_TEMPLATE/config.yml');

  for (const [label, form] of [
    ['bug_report.yml', bugReport],
    ['feature_request.yml', featureReq],
  ] as const) {
    assert.match(form, /Desktop macOS\/Windows/, `${label}: missing Desktop surface option`);
    assert.match(form, /Android & Foldable/, `${label}: missing Android & Foldable surface option`);
    assert.match(form, /Web PWA/, `${label}: missing Web PWA surface option`);
    assert.match(form, /Self-Hosted Gateway JSR1/, `${label}: missing Gateway JSR1 surface option`);
  }

  assert.match(bugReport, /Reproduction Steps/i);
  assert.match(config, /blank_issues_enabled:\s+false/);
  assert.match(config, /SECURITY\.md/);
  assert.match(config, /docs\/GATEWAY\.md/);

  assert.match(prTemplate, /npm run build && npm test/);
  assert.match(prTemplate, /Zero plaintext secrets/i);
  assert.match(prTemplate, /Strict CSP/i);
  assert.match(prTemplate, /SECURITY\.md|README\.md|docs\/GATEWAY\.md/);
});
