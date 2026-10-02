import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openSseStream, type SseStream } from '../sse';

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let server: Server;
let baseUrl: string;
let latest: SseStream | null = null;
let closedCalls = 0;

describe('openSseStream', () => {
  beforeAll(async () => {
    const app = express();
    app.get('/stream', (req, res) => {
      latest = openSseStream(req, res);
      latest.onClose(() => {
        closedCalls += 1;
      });
      latest.send({ stage: 'starting' });
      // The handler returns without ending: the stream outlives the request
      // handler, exactly like the sync progress stream does.
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    latest?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('keeps writing while the client is connected and stops silently once it leaves', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/stream`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"stage":"starting"');
    expect(latest?.open).toBe(true);

    // The browser goes away mid-sync.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(latest?.open).toBe(false);
    expect(closedCalls).toBe(1);

    // This is the write that used to throw ERR_STREAM_WRITE_AFTER_END and
    // take the process down. Now it is a no-op.
    expect(() => latest!.send({ stage: 'progress' })).not.toThrow();
    expect(() => latest!.close()).not.toThrow();
    expect(closedCalls).toBe(1);
  });
});
