import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';

let server: import('http').Server;
let baseUrl = '';
let wsBaseUrl = '';

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.CORS_ORIGIN = '*';
  process.env.ASR_PROVIDER = 'mock';

  const { createHttpServer } = await import('../src/createServer');
  server = createHttpServer();

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsBaseUrl = `ws://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

test('POST /api/session returns session token payload', async () => {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
    },
  });

  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    token: string;
    expiresInSeconds: number;
    sessionId: string;
  };

  assert.equal(typeof body.token, 'string');
  assert.ok(body.token.length > 10);
  assert.equal(typeof body.sessionId, 'string');
  assert.ok(body.sessionId.length > 5);
  assert.equal(typeof body.expiresInSeconds, 'number');
  assert.ok(body.expiresInSeconds > 0);
});

test('websocket transcribe flow emits start, transcript, and ended events', async () => {
  const sessionResponse = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
    },
  });
  assert.equal(sessionResponse.status, 200);

  const sessionBody = (await sessionResponse.json()) as { token: string };
  const wsUrl = `${wsBaseUrl}/ws/transcribe?token=${encodeURIComponent(sessionBody.token)}`;

  const observedTypes = await new Promise<string[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: 'http://localhost:3000' },
    });

    const seenTypes: string[] = [];
    const maxWait = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for websocket flow'));
    }, 20_000);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'session.start',
          payload: { sampleRate: 16000, language: 'en-US' },
        })
      );

      for (let seq = 1; seq <= 12; seq += 1) {
        const pcmChunk = Buffer.alloc(8000);
        ws.send(
          JSON.stringify({
            type: 'audio.chunk',
            payload: {
              seq,
              audioBase64: pcmChunk.toString('base64'),
            },
          })
        );
      }

      ws.send(JSON.stringify({ type: 'session.stop', payload: {} }));
    });

    ws.on('message', (message) => {
      try {
        const parsed = JSON.parse(message.toString()) as { type?: string };
        if (parsed.type) {
          seenTypes.push(parsed.type);
        }

        if (parsed.type === 'session.ended') {
          clearTimeout(maxWait);
          ws.close();
          resolve(seenTypes);
        }
      } catch {
        // Ignore malformed message in test harness.
      }
    });

    ws.on('error', (error) => {
      clearTimeout(maxWait);
      reject(error);
    });
  });

  assert.ok(observedTypes.includes('session.started'));
  assert.ok(observedTypes.includes('transcript.partial'));
  assert.ok(observedTypes.includes('transcript.final'));
  assert.ok(observedTypes.includes('session.ended'));
});

test('websocket rejects connection without token', async () => {
  const wsUrl = `${wsBaseUrl}/ws/transcribe`;

  const result = await new Promise<{
    messageType: string | null;
    errorCode: string | null;
    closeCode: number | null;
  }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: 'http://localhost:3000' },
    });

    let messageType: string | null = null;
    let errorCode: string | null = null;
    let closeCode: number | null = null;

    const maxWait = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for unauthorized websocket close'));
    }, 10_000);

    ws.on('message', (message) => {
      try {
        const parsed = JSON.parse(message.toString()) as {
          type?: string;
          payload?: { code?: string };
        };

        messageType = parsed.type ?? null;
        errorCode = parsed.payload?.code ?? null;
      } catch {
        // Ignore malformed unauthorized message payload in test harness.
      }
    });

    ws.on('close', (code) => {
      closeCode = code;
      clearTimeout(maxWait);
      resolve({ messageType, errorCode, closeCode });
    });

    ws.on('error', (error) => {
      clearTimeout(maxWait);
      reject(error);
    });
  });

  assert.equal(result.messageType, 'error');
  assert.equal(result.errorCode, 'UNAUTHORIZED');
  assert.equal(result.closeCode, 1008);
});
