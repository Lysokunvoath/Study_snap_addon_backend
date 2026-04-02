import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function getNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function getJwtSecret(): string {
  const configured = process.env.JWT_SECRET;
  if (configured) {
    return configured;
  }

  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    return 'dev-insecure-change-me';
  }

  throw new Error('Missing required env var: JWT_SECRET');
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  asrProvider: (process.env.ASR_PROVIDER ?? 'mock').toLowerCase(),
  port: getNumberEnv('PORT', 8080),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  jwtSecret: getJwtSecret(),
  jwtExpiresInSeconds: getNumberEnv('JWT_EXPIRES_IN_SECONDS', 600),
  sessionMaxRequestsPerMinute: getNumberEnv('SESSION_MAX_REQUESTS_PER_MINUTE', 30),
  wsMaxPayloadBytes: getNumberEnv('WS_MAX_PAYLOAD_BYTES', 512 * 1024),
  wsMaxMessagesPer10s: getNumberEnv('WS_MAX_MESSAGES_PER_10S', 60),
  googleProjectId: process.env.GOOGLE_CLOUD_PROJECT_ID ?? '',
  googleCredentialsJson: process.env.GOOGLE_CLOUD_CREDENTIALS_JSON ?? '',
  googleSpeechModel: process.env.GOOGLE_SPEECH_MODEL ?? 'latest_long',
};
