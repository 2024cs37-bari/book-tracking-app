export interface AccountSession {
  readonly userId: string;
  readonly username: string;
  readonly trustedDevice: boolean;
  readonly expiresAt: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function isAccountSession(value: unknown): value is AccountSession {
  if (value === null || typeof value !== 'object') return false;
  const session = value as Partial<AccountSession>;
  return (
    typeof session.userId === 'string' &&
    session.userId.length > 0 &&
    session.userId.length <= 320 &&
    typeof session.username === 'string' &&
    session.username.length > 0 &&
    session.username.length <= 128 &&
    typeof session.trustedDevice === 'boolean' &&
    typeof session.expiresAt === 'string' &&
    Number.isFinite(Date.parse(session.expiresAt))
  );
}

export class AuthClient {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async send(path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(`${this.base}/auth/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AuthError('The sign-in server could not be reached. Check your connection and retry.');
    }
    if (!response.ok) {
      const message =
        response.status === 401
          ? 'The username or password is incorrect, or your session has expired.'
          : response.status === 429
            ? 'Too many sign-in attempts. Please wait a few minutes before trying again.'
            : 'Sign-in is unavailable. Check the server authentication configuration and retry.';
      throw new AuthError(message, response.status);
    }
    return response;
  }

  private async sessionResponse(response: Response): Promise<AccountSession> {
    const value: unknown = await response.json().catch(() => null);
    if (!isAccountSession(value) || Date.parse(value.expiresAt) <= Date.now()) {
      throw new AuthError('The server returned an invalid or expired session.');
    }
    return value;
  }

  async session(): Promise<AccountSession | null> {
    try {
      return await this.sessionResponse(await this.send('session'));
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) return null;
      throw error;
    }
  }

  async login(username: string, password: string, trustedDevice: boolean): Promise<AccountSession> {
    return this.sessionResponse(await this.send('login', { username, password, trustedDevice }));
  }

  async logout(): Promise<void> {
    await this.send('logout', {});
  }
}
