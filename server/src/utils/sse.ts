/**
 * Server-sent events, without the crash.
 *
 * A progress stream lives as long as the work it reports on, but the browser
 * that opened it can leave at any moment: a closed tab, a navigation, a proxy
 * timeout. Writing to the response after that raises an 'error' event on the
 * ServerResponse, and an unhandled one takes the whole process down
 * (ERR_STREAM_WRITE_AFTER_END). Every stream goes through this helper so a
 * departed client is a no-op, never an exception.
 */
import type { Request, Response } from 'express';
import logger from './logger';

export interface SseStream {
  /** Send one event. Silently dropped once the client has gone. */
  send(data: unknown): void;
  /** Whether the client is still connected. */
  readonly open: boolean;
  /** Run `fn` when the client disconnects or the stream is closed, once. */
  onClose(fn: () => void): void;
  /** End the response if it is still open. */
  close(): void;
}

export interface SseOptions {
  /**
   * Interval for `: keep-alive` comment lines, which every parser ignores.
   * A deletion can sit on one upstream call for minutes; without traffic a
   * reverse proxy's idle timeout cuts the connection and the browser never
   * hears how it ended. 0 disables.
   */
  heartbeatMs?: number;
}

export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

export function openSseStream(req: Request, res: Response, options: SseOptions = {}): SseStream {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  let open = true;
  const closers: Array<() => void> = [];

  const heartbeatMs = options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (!open || res.writableEnded || res.destroyed) return;
          try {
            res.write(': keep-alive\n\n');
          } catch {
            markClosed();
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref();

  const markClosed = () => {
    if (!open) return;
    open = false;
    if (heartbeat) clearInterval(heartbeat);
    for (const fn of closers.splice(0)) {
      try {
        fn();
      } catch (error) {
        logger.debug(`SSE close handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  // The socket going away is the common case; 'error' covers the rest. Both
  // must be handled or the response emits an unhandled 'error'.
  req.on('close', markClosed);
  res.on('close', markClosed);
  res.on('error', (error) => {
    logger.debug(`SSE response error: ${error.message}`);
    markClosed();
  });

  return {
    get open() {
      return open && !res.writableEnded && !res.destroyed;
    },
    send(data: unknown) {
      if (!open || res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        logger.debug(`SSE write failed: ${error instanceof Error ? error.message : String(error)}`);
        markClosed();
      }
    },
    onClose(fn: () => void) {
      if (!open) {
        fn();
        return;
      }
      closers.push(fn);
    },
    close() {
      if (open && !res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
      markClosed();
    },
  };
}
