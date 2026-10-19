import { appendFileSync } from 'node:fs';
import type { Logger } from '../logger.js';

/**
 * One structured event per tool call. No arguments, no returned data, no credentials: only who (account id and
 * tier), what (tool, outcome, record counts), how much of the cap is used, which client, and how long it took.
 */
export interface UsageEvent {
  v: 1;
  ts: string;
  account: string;
  tier: string;
  auth: 'oauth' | 'api_key' | 'local';
  tool: string;
  outcome: 'ok' | 'error' | 'cap_exceeded' | 'rate_limited' | 'not_connected';
  error_code?: string;
  /** New plus repeat records returned, per entity. */
  records: Record<string, number>;
  /** Records held back by the cap on this call. */
  withheld: number;
  /** Highest lifetime cap use across entities after the call, 0-1. */
  cap_used_max: number;
  cap_entity_max?: string;
  client: string;
  client_version?: string;
  user_agent?: string;
  transport: 'stdio' | 'http' | 'worker';
  latency_ms: number;
}

export interface UsageSink {
  emit(e: UsageEvent): void | Promise<void>;
}

/** Writes events as structured log lines (stderr in stdio mode); the default everywhere. */
export class LogUsageSink implements UsageSink {
  constructor(private readonly log: Logger) {}
  emit(e: UsageEvent) {
    this.log.info('usage_event', e as unknown as Record<string, unknown>);
  }
}

/** Appends NDJSON to a local file (JOURNEY_USAGE_EVENTS_FILE). For self-hosted Node deployments. */
export class FileUsageSink implements UsageSink {
  constructor(private readonly file: string) {}
  emit(e: UsageEvent) {
    appendFileSync(this.file, JSON.stringify(e) + '\n', { mode: 0o600 });
  }
}

/** Minimal shape of a Cloudflare Analytics Engine dataset binding. */
export interface AnalyticsEngineDataset {
  writeDataPoint(p: { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] }): void;
}

/**
 * Cloudflare Workers Analytics Engine. Column layout (keep stable; dashboards query by position):
 * index1 account
 * blob1 tool, blob2 tier, blob3 outcome, blob4 client, blob5 auth, blob6 error_code, blob7 cap_entity_max, blob8 client_version, blob9 transport
 * double1 latency_ms, double2 records_total, double3 withheld, double4 cap_used_max,
 * double5 product, double6 supplier, double7 ingredient, double8 price_series, double9 lab_result
 */
export class AnalyticsEngineUsageSink implements UsageSink {
  constructor(private readonly ds: AnalyticsEngineDataset) {}
  emit(e: UsageEvent) {
    const r = e.records;
    this.ds.writeDataPoint({
      indexes: [e.account.slice(0, 96)],
      blobs: [e.tool, e.tier, e.outcome, e.client, e.auth, e.error_code ?? '', e.cap_entity_max ?? '', e.client_version ?? '', e.transport],
      doubles: [
        e.latency_ms,
        Object.values(r).reduce((a, b) => a + b, 0),
        e.withheld,
        e.cap_used_max,
        r.product ?? 0,
        r.supplier ?? 0,
        r.ingredient ?? 0,
        r.price_series ?? 0,
        r.lab_result ?? 0,
      ],
    });
  }
}

export class MultiUsageSink implements UsageSink {
  constructor(private readonly sinks: UsageSink[]) {}
  async emit(e: UsageEvent) {
    await Promise.all(this.sinks.map(async (s) => s.emit(e)));
  }
}

const CLIENTS: [RegExp, string][] = [
  [/claude[- ]?code/i, 'Claude Code'],
  [/claude|anthropic/i, 'Claude'],
  [/chatgpt|openai/i, 'ChatGPT'],
  [/cursor/i, 'Cursor'],
  [/windsurf|codeium/i, 'Windsurf'],
  [/vs ?code|visual studio code|copilot/i, 'VS Code'],
  [/perplexity/i, 'Perplexity'],
  [/gemini|google/i, 'Gemini'],
  [/goose/i, 'Goose'],
  [/cline/i, 'Cline'],
  [/zed/i, 'Zed'],
  [/mcp-inspector|inspector/i, 'MCP Inspector'],
  [/n8n/i, 'n8n'],
  [/zapier/i, 'Zapier'],
];

/** Normalizes MCP clientInfo.name and the HTTP user agent into a short client label for reporting. */
export function classifyClient(clientName?: string, userAgent?: string): string {
  for (const src of [clientName, userAgent]) {
    if (!src) continue;
    for (const [re, label] of CLIENTS) if (re.test(src)) return label;
  }
  if (clientName) return clientName.slice(0, 40);
  return userAgent ? 'other' : 'unknown';
}
