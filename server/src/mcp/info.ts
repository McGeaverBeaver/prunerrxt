/**
 * What the Settings panel shows about the MCP connector.
 */
import type { Request } from 'express';
import { getAuthConfig } from '../auth/config';
import { requestIsSecure } from '../auth/sessions';
import { allowsImmediateDeletion, isMcpEnabledByEnv, isMcpEnabledBySetting, mcpDisabledReason, type McpDisabledReason } from './config';
import { getToolCatalog, type ToolCatalogEntry } from './helpers';
import { createMcpServer } from './server';
import { getActiveMcpSessionCount } from './http';

export interface McpInfo {
  enabled: boolean;
  disabledReason: McpDisabledReason | null;
  enabledByEnv: boolean;
  enabledBySetting: boolean;
  authEnabled: boolean;
  allowImmediateDeletion: boolean;
  endpoint: string;
  activeSessions: number;
  tools: ToolCatalogEntry[];
  resources: string[];
  prompts: string[];
}

export const MCP_RESOURCE_URIS = [
  'prunerr://overview',
  'prunerr://queue',
  'prunerr://rules',
  'prunerr://rules/schema',
  'prunerr://collections',
  'prunerr://tools',
  'prunerr://media/{id}',
];

export const MCP_PROMPT_NAMES = ['review_queue', 'reclaim_space', 'build_rule', 'health_check'];

/** The public URL of the endpoint, as the client reached us. */
export function mcpEndpointFor(req: Request): string {
  const appUrl = getAuthConfig().appUrl;
  if (appUrl) return `${appUrl}/mcp`;
  const proto = requestIsSecure(req) ? 'https' : 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' && forwardedHost.split(',')[0]?.trim()) || req.headers['host'] || 'localhost:3000';
  return `${proto}://${host}/mcp`;
}

export function getMcpInfo(req: Request): McpInfo {
  // The catalogue fills as tools register; make sure that has happened at
  // least once even if no client has connected yet.
  if (getToolCatalog().length === 0) {
    createMcpServer();
  }
  return {
    enabled: mcpDisabledReason() === null,
    disabledReason: mcpDisabledReason(),
    enabledByEnv: isMcpEnabledByEnv(),
    enabledBySetting: isMcpEnabledBySetting(),
    authEnabled: getAuthConfig().enabled,
    allowImmediateDeletion: allowsImmediateDeletion(),
    endpoint: mcpEndpointFor(req),
    activeSessions: getActiveMcpSessionCount(),
    tools: [...getToolCatalog()],
    resources: MCP_RESOURCE_URIS,
    prompts: MCP_PROMPT_NAMES,
  };
}
