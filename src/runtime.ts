import { loadConfig, type JourneyConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { RestJourneyData } from './api/rest-adapter.js';
import { loadPolicy } from './policy/policy.js';
import { FileUsageStore, MemoryUsageStore } from './policy/usage-store.js';
import { PolicyEnforcer } from './policy/enforcer.js';
import { ApiKeyResolver } from './auth/api-key.js';
import { createTokenVerifier } from './auth/oauth.js';
import { FileUsageSink, LogUsageSink, MultiUsageSink, type UsageSink } from './telemetry/usage-events.js';

export function buildRuntime(cfg: JourneyConfig = loadConfig(), log: Logger = createLogger()) {
  const policy = loadPolicy(cfg.policyFile);
  const store = cfg.usageStore === 'file' ? new FileUsageStore(cfg.usageFile) : new MemoryUsageStore();
  // Usage events: structured log lines always; plus NDJSON when JOURNEY_USAGE_EVENTS_FILE is set. Off with JOURNEY_USAGE_EVENTS=off.
  const sinks: UsageSink[] = [];
  if (process.env.JOURNEY_USAGE_EVENTS !== 'off') {
    sinks.push(new LogUsageSink(log));
    if (process.env.JOURNEY_USAGE_EVENTS_FILE) sinks.push(new FileUsageSink(process.env.JOURNEY_USAGE_EVENTS_FILE));
  }
  return {
    cfg,
    log,
    policy,
    data: new RestJourneyData(cfg, log),
    enforcer: new PolicyEnforcer(policy, store),
    keys: new ApiKeyResolver(cfg.keyLookupUrl, log, (input, init) => fetch(input, init), 5 * 60_000, cfg.priceAccountBaseUrl),
    verifier: createTokenVerifier(cfg),
    usage: sinks.length ? new MultiUsageSink(sinks) : undefined,
  };
}
