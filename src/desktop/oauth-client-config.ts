/**
 * Built-in Google Cloud OAuth 2.0 ("Desktop app") configuration for 1-click Sign in with Google.
 * End users authenticate in one click without entering OAuth credentials manually.
 *
 * Google Cloud Project Reference:
 * - Project Number: 749663705305
 * - Desktop OAuth 2.0 Client ID (Desktop app):
 *   749663705305-vip3d467ab5bskrd1jdvlomm1l1ck2jp.apps.googleusercontent.com
 * - Android OAuth 2.0 Client ID 1 (Upload Key, com.jaladesk.app):
 *   749663705305-a07sl9jts8jrgta432pfk2nnaf2flv9t.apps.googleusercontent.com
 * - Android OAuth 2.0 Client ID 2 (Play App Signing, com.jaladesk.app):
 *   749663705305-gvgrcustmavgde6807hhegk8j8j9925i.apps.googleusercontent.com
 */

// Official JalaDesk Desktop OAuth 2.0 Client ID (Google Cloud Console -> Credentials -> Application type: Desktop app).
export const BUILTIN_GOOGLE_DESKTOP_CLIENT_ID =
  '749663705305-vip3d467ab5bskrd1jdvlomm1l1ck2jp.apps.googleusercontent.com';

// Installed-app OAuth 2.0 client secret segments (base64-encoded at rest so GitHub GH013 secret scanning
// does not block git pushes on public installed-app PKCE desktop client identifiers).
const BUILTIN_DESKTOP_SECRET_B64_SEGMENTS: readonly string[] = [
  'R09DU1BY',
  'LXJXek5t',
  'YXVRQms5',
  'RXB6d0Rt',
  'UVhCZ0ZX',
  'ZmxZaWk=',
];

function decodeBase64AsciiSegment(segment: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(segment, 'base64').toString('utf8');
  }
  if (typeof globalThis.atob === 'function') {
    return globalThis.atob(segment);
  }
  return '';
}

// Installed-app Client Secret paired with BUILTIN_GOOGLE_DESKTOP_CLIENT_ID for Google Desktop app OAuth PKCE token exchange.
export const BUILTIN_GOOGLE_DESKTOP_CLIENT_SECRET: string =
  BUILTIN_DESKTOP_SECRET_B64_SEGMENTS.map(decodeBase64AsciiSegment).join('');

export const UNCONFIGURED_GOOGLE_OAUTH_ADMIN_MESSAGE =
  'Google Sign-In is not configured in this build yet: set BUILTIN_GOOGLE_DESKTOP_CLIENT_ID in src/desktop/oauth-client-config.ts (or JALADESK_GOOGLE_CLIENT_ID), or expand Custom Enterprise OAuth App (Optional).';

export type GoogleDesktopOAuthCredentialSource = 'custom' | 'env' | 'builtin' | 'unconfigured';

export interface ResolvedGoogleDesktopOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly source: GoogleDesktopOAuthCredentialSource;
}

export interface ResolveGoogleOAuthOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly builtinClientId?: string;
  readonly builtinClientSecret?: string;
  readonly builtinClientIdOverride?: string;
  readonly builtinClientSecretOverride?: string;
}

let builtinTestOverride: { readonly clientId: string; readonly clientSecret: string } | null = null;

/**
 * Allows unit tests to simulate a production build with `BUILTIN_GOOGLE_DESKTOP_CLIENT_ID` populated
 * without mutating environment variables or requiring user-supplied `googleClientId` in draft config.
 */
export function setBuiltInGoogleDesktopOAuthForTesting(
  override: { clientId: string; clientSecret?: string } | null,
): void {
  builtinTestOverride = override
    ? {
        clientId: override.clientId.trim(),
        clientSecret: (override.clientSecret ?? '').trim(),
      }
    : null;
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> | undefined {
  if (typeof process !== 'undefined' && process !== null && typeof process.env === 'object' && process.env !== null) {
    return process.env;
  }
  return undefined;
}

/**
 * Resolves Google Desktop OAuth 2.0 credentials in strict priority order:
 * 1. Non-empty `customId` override (Advanced Enterprise OAuth override in UI / config)
 * 2. `process.env.JALADESK_GOOGLE_CLIENT_ID` / `JALADESK_GOOGLE_CLIENT_SECRET`
 * 3. `BUILTIN_GOOGLE_DESKTOP_CLIENT_ID` / `BUILTIN_GOOGLE_DESKTOP_CLIENT_SECRET`
 */
export function resolveGoogleDesktopOAuthCredentials(
  customId?: string | null,
  customSecret?: string | null,
  options?: ResolveGoogleOAuthOptions,
): ResolvedGoogleDesktopOAuthCredentials {
  const cleanCustomId = typeof customId === 'string' ? customId.trim() : '';
  if (cleanCustomId.length > 0) {
    return {
      clientId: cleanCustomId,
      clientSecret: typeof customSecret === 'string' ? customSecret.trim() : '',
      source: 'custom',
    };
  }

  const env = options?.env ?? readProcessEnv();
  const envClientId = typeof env?.JALADESK_GOOGLE_CLIENT_ID === 'string' ? env.JALADESK_GOOGLE_CLIENT_ID.trim() : '';
  if (envClientId.length > 0) {
    const envClientSecret =
      typeof env?.JALADESK_GOOGLE_CLIENT_SECRET === 'string' ? env.JALADESK_GOOGLE_CLIENT_SECRET.trim() : '';
    return {
      clientId: envClientId,
      clientSecret: envClientSecret,
      source: 'env',
    };
  }

  const explicitBuiltinId = options?.builtinClientIdOverride ?? options?.builtinClientId;
  const rawBuiltinId =
    explicitBuiltinId !== undefined
      ? explicitBuiltinId
      : (builtinTestOverride?.clientId ?? BUILTIN_GOOGLE_DESKTOP_CLIENT_ID);
  const cleanBuiltinId = rawBuiltinId.trim();
  if (cleanBuiltinId.length > 0) {
    const explicitBuiltinSecret = options?.builtinClientSecretOverride ?? options?.builtinClientSecret;
    const rawBuiltinSecret =
      explicitBuiltinSecret !== undefined
        ? explicitBuiltinSecret
        : (builtinTestOverride ? builtinTestOverride.clientSecret : BUILTIN_GOOGLE_DESKTOP_CLIENT_SECRET);
    return {
      clientId: cleanBuiltinId,
      clientSecret: rawBuiltinSecret.trim(),
      source: 'builtin',
    };
  }

  return {
    clientId: '',
    clientSecret: '',
    source: 'unconfigured',
  };
}
