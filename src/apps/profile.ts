import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Account } from '../auth/account.js';
import { ACCOUNT_AUTH } from './definitions.js';
import { READ_ONLY, ok, runTool, toolMeta, type ToolContext } from '../tools.js';

const ProfileSchema = z.object({
  id: z.string().min(1).regex(/\S/),
  name: z.string().optional(),
  email: z.string().optional(),
  nickname: z.string().optional(),
}).strict();

/**
 * Stable opaque id for this credential. Prefer the identity provider's user id.
 * Do not mint a new id per call, and do not use an email address.
 */
export function profileId(account: Account): string | undefined {
  if (account.authMethod === 'anonymous') return undefined;
  const user = account.userId?.trim();
  if (user) return user;
  const company = account.companyId?.trim();
  if (company) return company;
  const id = account.id?.trim();
  if (id && !id.includes(' ')) return id;
  return undefined;
}

export function profileOf(account: Account): { id: string; name?: string; email?: string } | undefined {
  const id = profileId(account);
  if (!id) return undefined;
  return {
    id,
    ...(account.displayName ? { name: account.displayName } : {}),
    ...(account.email ? { email: account.email } : {}),
  };
}

export function authRequired(metadataUrl: string): CallToolResult {
  const challenge = `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="Sign in with a Journey account to continue"`;
  return {
    isError: true,
    content: [{ type: 'text', text: 'Authentication required. Sign in with a Journey account to continue.' }],
    _meta: { 'mcp/www_authenticate': [`'${challenge}'`] },
  };
}

export function registerProfileTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    'get_profile',
    {
      title: 'Get profile',
      description:
        "Return the profile represented by this request's authenticated credentials. The opaque id is unique within this app and remains unchanged across token refresh, reconnection, and display-metadata changes. Requires a signed-in Journey account.",
      inputSchema: z.object({}).strict(),
      outputSchema: ProfileSchema,
      annotations: { title: 'Get profile', ...READ_ONLY },
      _meta: toolMeta(ctx, 'get_profile', { securitySchemes: ACCOUNT_AUTH, 'openai/profile': true }) ?? { securitySchemes: ACCOUNT_AUTH, 'openai/profile': true },
    },
    runTool(ctx, 'get_profile', async () => {
      if (ctx.account.authMethod === 'anonymous') {
        return authRequired(ctx.resourceMetadataUrl ?? '/.well-known/oauth-protected-resource');
      }
      const profile = profileOf(ctx.account);
      if (!profile) {
        return { isError: true, content: [{ type: 'text', text: 'Profile identity unavailable.' }] };
      }
      return ok(profile);
    }),
  );
}
