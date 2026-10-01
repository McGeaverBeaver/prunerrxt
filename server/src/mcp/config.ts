/**
 * Switches for the MCP connector.
 *
 * Three things have to be true for /mcp to answer:
 *   - login is enabled (AUTH_ENABLED=true). Without a login the web UI is open
 *     to anyone on the network, and an AI connector on top of that is one
 *     exposure too many, so the connector stays off.
 *   - MCP_ENABLED is not "false" (a hard off switch for the container).
 *   - the in-app toggle (Settings → System → AI assistant) is on. It is on by
 *     default once the two above are satisfied.
 *
 * Immediate deletion — "Delete now" and processing the queue for real — is a
 * separate opt-in, off by default. Everything else an assistant does goes
 * through the grace-period queue, where it can be reviewed and undone.
 */
import settingsRepo from '../db/repositories/settings';
import { getAuthConfig } from '../auth/config';

export const MCP_SETTING_ENABLED = 'mcp_enabled';
export const MCP_SETTING_ALLOW_IMMEDIATE_DELETION = 'mcp_allow_immediate_deletion';

export type McpDisabledReason = 'auth_disabled' | 'env' | 'setting';

export function isMcpEnabledByEnv(): boolean {
  const raw = process.env['MCP_ENABLED'];
  if (raw === undefined) return true;
  const lower = raw.trim().toLowerCase();
  return !(lower === 'false' || lower === '0' || lower === 'no' || lower === 'off');
}

export function isMcpEnabledBySetting(): boolean {
  return settingsRepo.getBoolean(MCP_SETTING_ENABLED, true);
}

/** Why the connector is off, or null when it is on. Checked in order of authority. */
export function mcpDisabledReason(): McpDisabledReason | null {
  if (!getAuthConfig().enabled) return 'auth_disabled';
  if (!isMcpEnabledByEnv()) return 'env';
  if (!isMcpEnabledBySetting()) return 'setting';
  return null;
}

export function isMcpEnabled(): boolean {
  return mcpDisabledReason() === null;
}

export function allowsImmediateDeletion(): boolean {
  return settingsRepo.getBoolean(MCP_SETTING_ALLOW_IMMEDIATE_DELETION, false);
}

export function setMcpEnabled(enabled: boolean): void {
  settingsRepo.set({ key: MCP_SETTING_ENABLED, value: enabled ? 'true' : 'false' });
}

export function setAllowImmediateDeletion(allowed: boolean): void {
  settingsRepo.set({ key: MCP_SETTING_ALLOW_IMMEDIATE_DELETION, value: allowed ? 'true' : 'false' });
}

/** The message a refused immediate deletion carries, so the assistant can explain it. */
export const IMMEDIATE_DELETION_REFUSED =
  'Immediate deletion is not allowed for the MCP connector. Items can be queued for deletion (they are deleted after the grace period), but "delete now" and processing the queue for real require an admin to enable "Allow immediate deletion" under Settings → System → AI assistant in Prunerr.';
