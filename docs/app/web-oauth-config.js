/**
 * Built-in Google Identity Services (GIS) OAuth 2.0 Web Client configuration for JalaDesk Web.
 *
 * Google Cloud Project Reference:
 * - Project Number: 749663705305
 * - Application Type: Web application (Google Cloud Console -> APIs & Services -> Credentials)
 * - Client Secret: NOT required in browsers (GIS OAuth2 Token Model runs purely client-side
 *   with origin validation via Authorized JavaScript origins).
 *
 * Required Authorized JavaScript origins in Google Cloud Console:
 * - https://ribato22.github.io
 * - http://localhost:4173 (optional, for local PWA preview)
 * - http://127.0.0.1:4173 (optional, for local PWA preview)
 *
 * Wired to the official Web application OAuth Client ID in GCP project `749663705305`.
 * Users can also supply a custom Web OAuth Client ID under
 * "Advanced: Custom Web Client ID or Manual Token" without rebuilding.
 */

export const GOOGLE_CLOUD_PROJECT_NUMBER = '749663705305';

/**
 * Official JalaDesk Web OAuth 2.0 Client ID (GCP project 749663705305 -> Web application).
 * Zero Client Secret is needed or stored in browser bundles.
 */
export const BUILTIN_GOOGLE_WEB_CLIENT_ID = '749663705305-aatpuo0m1f11se7kii0afaspgion454d.apps.googleusercontent.com';

/**
 * Resolves the effective Google Web OAuth Client ID for 1-click Google Identity Services sign-in.
 * Prefers a non-empty user-supplied `customClientId`, falling back to `BUILTIN_GOOGLE_WEB_CLIENT_ID`.
 *
 * @param {string | null | undefined} [customClientId]
 * @param {{ builtinClientId?: string; builtinClientIdOverride?: string }} [options]
 * @returns {string}
 */
export function resolveGoogleWebOAuthClientId(customClientId = '', options = {}) {
  const custom = typeof customClientId === 'string' ? customClientId.trim() : '';
  if (custom.length > 0) {
    return custom;
  }
  const builtin =
    typeof options?.builtinClientId === 'string'
      ? options.builtinClientId.trim()
      : typeof options?.builtinClientIdOverride === 'string'
        ? options.builtinClientIdOverride.trim()
        : BUILTIN_GOOGLE_WEB_CLIENT_ID.trim();
  return builtin;
}
