/** Test stand-in for the Workers runtime module. Wrangler leaves the real module external. */
export class DurableObject<Env = unknown> {
  constructor(readonly ctx: unknown, readonly env: Env) {}
}
