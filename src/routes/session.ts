import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export const sessionRouter = Router();

const requestBuckets = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const bucket = requestBuckets.get(ip) ?? [];
  const filtered = bucket.filter((ts) => ts >= windowStart);

  filtered.push(now);
  requestBuckets.set(ip, filtered);

  return filtered.length > env.sessionMaxRequestsPerMinute;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

sessionRouter.post('/api/session', (req, res) => {
  const sourceIp = req.ip || req.socket.remoteAddress || 'unknown';

  if (isRateLimited(sourceIp)) {
    return res.status(429).json({
      error: 'Too many session requests, please retry shortly.',
    });
  }

  const sessionId = randomId();
  const token = jwt.sign(
    {
      sid: sessionId,
      aud: 'study-snap-transcribe',
      origin: req.headers.origin ?? null,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresInSeconds }
  );

  return res.json({
    token,
    expiresInSeconds: env.jwtExpiresInSeconds,
    sessionId,
  });
});
