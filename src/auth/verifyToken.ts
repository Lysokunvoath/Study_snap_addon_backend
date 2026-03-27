import jwt, { JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env';

export type SessionTokenPayload = JwtPayload & {
  sid: string;
  aud: 'study-snap-transcribe';
};

export function verifySessionToken(token: string): SessionTokenPayload {
  const decoded = jwt.verify(token, env.jwtSecret, {
    audience: 'study-snap-transcribe',
  });

  if (typeof decoded === 'string' || !decoded.sid) {
    throw new Error('Invalid session token payload');
  }

  return decoded as SessionTokenPayload;
}
