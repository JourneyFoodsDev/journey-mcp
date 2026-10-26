export const CONTRACT_URL = 'https://journeyfoods.io/contact';

export class JourneyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 500,
  ) {
    super(message);
    this.name = 'JourneyError';
  }
}

export class CapExceededError extends JourneyError {
  constructor(
    public readonly cap: 'lifetime_records' | 'lifetime_ingredients' | string,
    detail: string,
    upgradeMessage?: string,
  ) {
    super(
      `${detail} Your Journey account has reached its self-serve data access limit. ` +
        (upgradeMessage ? `${upgradeMessage.trim()} ` : '') +
        `To keep going${upgradeMessage ? ' beyond that' : ''}, request a custom contract at ${CONTRACT_URL} and our team will follow up. Thank you.`,
      'cap_exceeded',
      429,
    );
  }
}

export class RateLimitError extends JourneyError {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      `Rate limit reached for this Journey account. Please retry in about ${retryAfterSeconds} seconds. ` +
        `For higher limits, request a custom contract at ${CONTRACT_URL}. Thank you.`,
      'rate_limited',
      429,
    );
  }
}

export class UpstreamError extends JourneyError {
  constructor(message: string, status: number, public readonly endpoint: string) {
    super(message, 'upstream_error', status);
  }
}

export class NotConnectedError extends JourneyError {
  constructor(feature: string, detail?: string) {
    super(
      detail ?? `${feature} is not connected on this Journey MCP server yet. No data was returned.`,
      'not_connected',
      501,
    );
  }
}

export class AuthError extends JourneyError {
  constructor(message: string, code = 'invalid_token') {
    super(message, code, 401);
  }
}
