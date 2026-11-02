import { DurableObject } from 'cloudflare:workers';

/**
 * Live sqlite classes. Exported so a deploy keeps the existing namespaces
 * (journey-mcp_JourneyMcp, journey-mcp_AccountLedger). These methods do not read or delete storage.
 * The HTTP entrypoint is the default fetch handler, not these objects.
 */
export class JourneyMcp extends DurableObject {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_served_here' }, { status: 501 });
  }
}

export class AccountLedger extends DurableObject {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_served_here' }, { status: 501 });
  }
}
