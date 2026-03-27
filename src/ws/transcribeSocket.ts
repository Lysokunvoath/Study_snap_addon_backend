import { IncomingMessage } from 'http';
import { URL } from 'url';
import { WebSocket } from 'ws';
import { verifySessionToken } from '../auth/verifyToken';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { createTranscriptionProvider } from '../asr/providerFactory';
import { TranscriptionProvider } from '../asr/types';

type ClientMessage =
  | { type: 'session.start'; payload: { sampleRate?: number; language?: string } }
  | { type: 'audio.chunk'; payload: { seq: number; audioBase64: string } }
  | { type: 'session.stop'; payload: Record<string, never> };

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseClientMessage(raw: string): ClientMessage {
  const parsed = JSON.parse(raw) as { type?: string; payload?: unknown };

  if (!parsed.type || typeof parsed.type !== 'string') {
    throw new Error('Invalid message type');
  }

  if (parsed.type === 'session.start') {
    return {
      type: 'session.start',
      payload: (parsed.payload ?? {}) as { sampleRate?: number; language?: string },
    };
  }

  if (parsed.type === 'audio.chunk') {
    const payload = (parsed.payload ?? {}) as { seq?: number; audioBase64?: string };

    if (typeof payload.seq !== 'number' || typeof payload.audioBase64 !== 'string') {
      throw new Error('Invalid audio.chunk payload');
    }

    return {
      type: 'audio.chunk',
      payload: {
        seq: payload.seq,
        audioBase64: payload.audioBase64,
      },
    };
  }

  if (parsed.type === 'session.stop') {
    return { type: 'session.stop', payload: {} };
  }

  throw new Error(`Unsupported message type: ${parsed.type}`);
}

function getTokenFromRequest(req: IncomingMessage): string {
  const host = req.headers.host;

  if (!host || !req.url) {
    throw new Error('Missing host/url for websocket request');
  }

  const url = new URL(req.url, `http://${host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    throw new Error('Missing token query parameter');
  }

  return token;
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }

  if (env.corsOrigin === '*') {
    return true;
  }

  return origin === env.corsOrigin;
}

export function handleTranscribeConnection(ws: WebSocket, req: IncomingMessage): void {
  try {
    const token = getTokenFromRequest(req);
    verifySessionToken(token);

    if (!isAllowedOrigin(req.headers.origin)) {
      throw new Error('Origin is not allowed');
    }
  } catch (error) {
    sendJson(ws, {
      type: 'error',
      payload: {
        code: 'UNAUTHORIZED',
        message: error instanceof Error ? error.message : 'Unauthorized',
      },
    });
    ws.close(1008, 'Unauthorized');
    return;
  }

  let provider: TranscriptionProvider | null = null;
  let messageCount = 0;
  let windowStartedAt = Date.now();

  ws.on('message', async (message) => {
    try {
      if (typeof message !== 'string' && !(message instanceof Buffer)) {
        throw new Error('Unexpected websocket frame type');
      }

      const now = Date.now();
      if (now - windowStartedAt >= 10_000) {
        messageCount = 0;
        windowStartedAt = now;
      }

      messageCount += 1;
      if (messageCount > env.wsMaxMessagesPer10s) {
        throw new Error('Rate limit exceeded for websocket messages');
      }

      const raw = message.toString();
      if (Buffer.byteLength(raw, 'utf8') > env.wsMaxPayloadBytes) {
        throw new Error('Payload too large');
      }

      const clientMessage = parseClientMessage(raw);

      if (clientMessage.type === 'session.start') {
        if (provider) {
          throw new Error('Session already started');
        }

        provider = createTranscriptionProvider({
          onPartial: (event) => sendJson(ws, { type: 'transcript.partial', payload: event }),
          onFinal: (event) => sendJson(ws, { type: 'transcript.final', payload: event }),
          onError: (error) =>
            sendJson(ws, {
              type: 'error',
              payload: {
                code: 'ASR_UPSTREAM_ERROR',
                message: error.message,
              },
            }),
        });

        await provider.startStream({
          language: clientMessage.payload.language ?? env.parakeetLanguage,
          sampleRate: clientMessage.payload.sampleRate ?? env.parakeetSampleRate,
        });

        sendJson(ws, {
          type: 'session.started',
          payload: {
            language: clientMessage.payload.language ?? env.parakeetLanguage,
          },
        });
        return;
      }

      if (clientMessage.type === 'audio.chunk') {
        if (!provider) {
          throw new Error('Session not started');
        }

        const audioBuffer = Buffer.from(clientMessage.payload.audioBase64, 'base64');
        await provider.sendAudio(audioBuffer);
        return;
      }

      if (clientMessage.type === 'session.stop') {
        if (provider) {
          await provider.close();
          provider = null;
        }

        sendJson(ws, {
          type: 'session.ended',
          payload: { reason: 'client_stop' },
        });

        ws.close(1000, 'Client stop');
      }
    } catch (error) {
      logger.warn('Websocket message handling failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      sendJson(ws, {
        type: 'error',
        payload: {
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Unknown websocket error',
        },
      });
    }
  });

  ws.on('close', async () => {
    if (provider) {
      await provider.close();
      provider = null;
    }
  });
}
