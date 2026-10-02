/**
 * What Sonarr and Radarr answers mean for a deletion.
 *
 * Both apps answer a lookup of something that is gone with 404, and both keep
 * working on a file delete after the HTTP client has given up waiting: a big
 * file on a network share can take Radarr well over 30 seconds to remove. The
 * deletion pipeline needs to tell those two cases apart from a real failure,
 * so the classification lives here, shared by both clients.
 */
import type { AxiosError } from 'axios';

/** Default per-request timeout for ordinary Sonarr/Radarr calls. */
export const ARR_REQUEST_TIMEOUT_MS = 30_000;

/** Progress callback payload for multi-file deletions. */
export interface FileDeletionProgress {
  current: number;
  total: number;
  fileName: string;
  /** 'verifying' means the delete timed out and the file is being polled. */
  status: 'deleting' | 'verifying' | 'deleted' | 'failed';
}

export interface ArrTimingOptions {
  /** How long to wait for a delete call before verifying upstream instead. */
  deleteTimeoutMs?: number;
  /** How long to keep checking whether a timed-out delete finished. */
  verifyWindowMs?: number;
  /** Pause between those checks. */
  verifyIntervalMs?: number;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

/**
 * Timing for deletes, from the environment with sane floors. Deleting a file is
 * the one call that legitimately runs long, so it gets its own, longer limit
 * (ARR_DELETE_TIMEOUT_MS, default 120 s) and a verification window after that
 * (ARR_DELETE_VERIFY_SECONDS, default 90 s).
 */
export function arrTimingFromEnv(): Required<ArrTimingOptions> {
  return {
    deleteTimeoutMs: envInt('ARR_DELETE_TIMEOUT_MS', 120_000, 5_000),
    verifyWindowMs: envInt('ARR_DELETE_VERIFY_SECONDS', 90, 0) * 1000,
    verifyIntervalMs: 5_000,
  };
}

export function resolveArrTiming(options?: ArrTimingOptions): Required<ArrTimingOptions> {
  const defaults = arrTimingFromEnv();
  return {
    deleteTimeoutMs: options?.deleteTimeoutMs ?? defaults.deleteTimeoutMs,
    verifyWindowMs: options?.verifyWindowMs ?? defaults.verifyWindowMs,
    verifyIntervalMs: options?.verifyIntervalMs ?? defaults.verifyIntervalMs,
  };
}

function asAxiosError(error: unknown): AxiosError | null {
  if (error && typeof error === 'object' && (error as AxiosError).isAxiosError) {
    return error as AxiosError;
  }
  return null;
}

/** HTTP status the upstream app answered with, when it answered at all. */
export function upstreamStatus(error: unknown): number | undefined {
  return asAxiosError(error)?.response?.status;
}

/** The thing we asked about does not exist upstream (any more). */
export function isNotFound(error: unknown): boolean {
  return upstreamStatus(error) === 404;
}

/**
 * The client stopped waiting; the request may well still be running upstream.
 * Covers axios's own timeout (ECONNABORTED / ETIMEDOUT) and a socket that the
 * proxy in between closed on us.
 */
export function isTimeout(error: unknown): boolean {
  const axiosError = asAxiosError(error);
  if (!axiosError) return false;
  if (axiosError.response) return false;
  const code = axiosError.code ?? '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;
  return /timeout/i.test(axiosError.message);
}

/** Short, user-facing description of an upstream failure. */
export function describeUpstreamError(service: string, error: unknown): string {
  const status = upstreamStatus(error);
  if (status !== undefined) return `${service} answered HTTP ${status}`;
  if (isTimeout(error)) return `${service} did not answer in time`;
  const message = error instanceof Error ? error.message : String(error);
  return `${service}: ${message}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keep asking `isGone` until it says yes or the window runs out. Used after a
 * delete timed out: the upstream app is usually still working, so give it the
 * verification window before calling the deletion a failure.
 */
export async function waitUntilGone(
  isGone: () => Promise<boolean>,
  timing: Required<ArrTimingOptions>
): Promise<boolean> {
  const deadline = Date.now() + timing.verifyWindowMs;
  for (;;) {
    if (await isGone()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(timing.verifyIntervalMs, Math.max(0, deadline - Date.now())));
  }
}
