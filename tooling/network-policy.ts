import type { Plugin } from 'vite';

export interface NetworkPolicyOptions {
  readonly syncUrl?: string;
  readonly dictionaryEnabled?: boolean;
  readonly development?: boolean;
  readonly desktop?: boolean;
  readonly websocketOrigins?: readonly string[];
}

/** Public Vite configuration must contain an endpoint, never credentials. */
export function syncOrigin(raw: string | undefined, development = false): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('VITE_SYNC_URL must be an absolute HTTPS API URL.');
  }
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(url.hostname)) {
    throw new Error(
      'VITE_SYNC_URL must use a concrete hostname without wildcards or CSP delimiters.',
    );
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(development && loopback && url.protocol === 'http:')) {
    throw new Error(
      'VITE_SYNC_URL requires HTTPS; HTTP is allowed only on loopback in development.',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('VITE_SYNC_URL must not contain credentials, a query, or a fragment.');
  }
  return url.origin;
}

export function applicationCsp(options: NetworkPolicyOptions = {}): string {
  if (options.desktop && options.syncUrl?.trim()) {
    throw new Error(
      'Desktop sync is not available yet: Cloudflare Access sign-in requires a native authentication flow. Build desktop without VITE_SYNC_URL and use portable backups; web sync remains available.',
    );
  }
  const connections = ["'self'"];
  const origin = syncOrigin(options.syncUrl, options.development);
  if (origin) connections.push(origin);
  if (options.desktop) connections.push('ipc:', 'http://ipc.localhost');
  if (options.dictionaryEnabled !== false) connections.push('https://api.dictionaryapi.dev');
  if (options.development) {
    for (const origin of options.websocketOrigins ?? []) {
      const url = new URL(origin);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Development websocket sources must be websocket origins.');
      }
      connections.push(url.origin);
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    'frame-src blob:',
    "img-src 'self' blob: data:",
    "font-src 'self' blob: data:",
    "style-src 'self' blob: 'unsafe-inline'",
    `connect-src ${[...new Set(connections)].join(' ')}`,
    "worker-src 'self' blob:",
    "form-action 'none'",
  ].join('; ');
}

/** Set the policy before Vite injects scripts. Book frames retain their stricter policy. */
export function networkPolicy(options: NetworkPolicyOptions): Plugin {
  // Fail configuration immediately, including builds that never transform HTML.
  applicationCsp(options);
  return {
    name: 'reader-network-policy',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const urls = context.server?.resolvedUrls;
        const websocketOrigins = [...(urls?.local ?? []), ...(urls?.network ?? [])].map((raw) => {
          const url = new URL(raw);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          return url.origin;
        });
        const policy = applicationCsp({ ...options, websocketOrigins });
        const meta =
          /(<meta\s+id="app-csp"\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*("\s*\/?>)/;
        if (!meta.test(html)) throw new Error('The application CSP meta element is missing.');
        return html.replace(
          meta,
          (_match, before: string, after: string) => `${before}${policy}${after}`,
        );
      },
    },
  };
}
