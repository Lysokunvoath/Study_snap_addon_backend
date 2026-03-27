import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

type SessionResponse = {
  token: string;
  expiresInSeconds: number;
  sessionId: string;
};

function httpToWs(url: string): string {
  if (url.startsWith('https://')) {
    return `wss://${url.slice('https://'.length)}`;
  }

  if (url.startsWith('http://')) {
    return `ws://${url.slice('http://'.length)}`;
  }

  throw new Error(`Unsupported base URL protocol: ${url}`);
}

function generatePcm16Chunk(durationMs: number, sampleRate: number): Buffer {
  const sampleCount = Math.floor((durationMs / 1000) * sampleRate);
  const bytesPerSample = 2;
  const buffer = Buffer.alloc(sampleCount * bytesPerSample);

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const frequencyHz = 440;
    const value = Math.sin(2 * Math.PI * frequencyHz * t);
    const amplitude = 0.2;
    const sample = Math.max(-1, Math.min(1, value * amplitude));
    buffer.writeInt16LE(Math.floor(sample * 32767), i * 2);
  }

  return buffer;
}

async function createSessionToken(baseUrl: string, origin: string): Promise<SessionResponse> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Session request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as SessionResponse;
}

async function run(): Promise<void> {
  const baseUrl = process.env.BACKEND_BASE_URL ?? 'http://localhost:8080';
  const testOrigin = process.env.TEST_ORIGIN ?? process.env.CORS_ORIGIN ?? 'http://localhost:3000';
  const sampleRate = Number(process.env.PARAKEET_SAMPLE_RATE ?? '16000');
  const language = process.env.PARAKEET_LANGUAGE ?? 'en-US';
  const chunkDurationMs = Number(process.env.SMOKE_CHUNK_DURATION_MS ?? '250');
  const chunkCount = Number(process.env.SMOKE_CHUNK_COUNT ?? '20');

  const session = await createSessionToken(baseUrl, testOrigin);
  console.log('[smoke] created session', {
    sessionId: session.sessionId,
    expiresInSeconds: session.expiresInSeconds,
  });

  const wsBase = httpToWs(baseUrl);
  const wsUrl = `${wsBase}/ws/transcribe?token=${encodeURIComponent(session.token)}`;

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: testOrigin,
      },
    });

    let sentChunks = 0;
    let closed = false;

    const timeoutHandle = setTimeout(() => {
      if (closed) {
        return;
      }

      closed = true;
      ws.close();
      reject(new Error('Smoke test timed out waiting for transcript events'));
    }, 60_000);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'session.start',
          payload: { sampleRate, language },
        })
      );

      const interval = setInterval(() => {
        if (closed) {
          clearInterval(interval);
          return;
        }

        sentChunks += 1;
        const pcm = generatePcm16Chunk(chunkDurationMs, sampleRate);

        ws.send(
          JSON.stringify({
            type: 'audio.chunk',
            payload: {
              seq: sentChunks,
              audioBase64: pcm.toString('base64'),
            },
          })
        );

        if (sentChunks >= chunkCount) {
          clearInterval(interval);
          ws.send(JSON.stringify({ type: 'session.stop', payload: {} }));
        }
      }, chunkDurationMs);
    });

    ws.on('message', (data) => {
      const message = data.toString();
      console.log('[smoke] message', message);

      try {
        const parsed = JSON.parse(message) as { type?: string };
        if (parsed.type === 'session.ended') {
          if (!closed) {
            closed = true;
            clearTimeout(timeoutHandle);
            ws.close();
            resolve();
          }
        }
      } catch {
        // Keep raw log output even if parsing fails.
      }
    });

    ws.on('error', (error) => {
      if (!closed) {
        closed = true;
        clearTimeout(timeoutHandle);
        reject(error);
      }
    });

    ws.on('close', () => {
      if (!closed) {
        closed = true;
        clearTimeout(timeoutHandle);
        resolve();
      }
    });
  });

  console.log('[smoke] completed successfully');
}

run().catch((error) => {
  console.error('[smoke] failed', error);
  process.exit(1);
});
