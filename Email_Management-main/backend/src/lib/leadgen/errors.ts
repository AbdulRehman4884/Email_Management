export type FetchErrorCode =
  | 'bad_url'
  | 'blocked_address'
  | 'timeout'
  | 'too_large'
  | 'too_many_redirects'
  | 'wrong_content_type'
  | 'robots_disallowed'
  | 'network';

/** A request we refused to make or could not finish. Not retried for bad_url / blocked_address / robots. */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly code: FetchErrorCode,
  ) {
    super(message);
    this.name = 'FetchError';
  }

  get retryable(): boolean {
    return this.code === 'timeout' || this.code === 'network';
  }
}

/**
 * A source answered 429 / 403 or showed a CAPTCHA. The worker puts the source on cooldown;
 * other sources keep running and the run ends 'partial'.
 */
export class SourceBlockedError extends Error {
  constructor(
    readonly sourceCode: string,
    readonly reason: '429' | '403' | 'captcha',
    readonly retryAfterMs: number | null = null,
  ) {
    super(`Source ${sourceCode} blocked (${reason})`);
    this.name = 'SourceBlockedError';
  }
}

/** A source cannot be used right now (disabled, no API key, cooldown or daily cap). Not an error of the task. */
export class SourceUnavailableError extends Error {
  constructor(
    readonly sourceCode: string,
    readonly reason: 'disabled' | 'not_configured' | 'cooldown' | 'daily_cap',
    readonly until: Date | null = null,
  ) {
    super(`Source ${sourceCode} unavailable (${reason})`);
    this.name = 'SourceUnavailableError';
  }
}
