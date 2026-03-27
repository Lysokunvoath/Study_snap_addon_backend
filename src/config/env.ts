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
  port: getNumberEnv('PORT', 8080),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  jwtSecret: getJwtSecret(),
  jwtExpiresInSeconds: getNumberEnv('JWT_EXPIRES_IN_SECONDS', 600),
  sessionMaxRequestsPerMinute: getNumberEnv('SESSION_MAX_REQUESTS_PER_MINUTE', 30),
  wsMaxPayloadBytes: getNumberEnv('WS_MAX_PAYLOAD_BYTES', 512 * 1024),
  wsMaxMessagesPer10s: getNumberEnv('WS_MAX_MESSAGES_PER_10S', 60),
  parakeetModelPath: path.resolve(process.cwd(), process.env.PARAKEET_MODEL_PATH ?? '../parakeet-tdt-0.6b-v2.nemo'),
  parakeetLanguage: process.env.PARAKEET_LANGUAGE ?? 'en-US',
  parakeetSampleRate: getNumberEnv('PARAKEET_SAMPLE_RATE', 16000),
  parakeetMockMode: (process.env.PARAKEET_MOCK_MODE ?? 'true').toLowerCase() === 'true',
  parakeetPythonCommand: process.env.PARAKEET_PYTHON_COMMAND ?? 'python',
  parakeetInferScriptPath: path.resolve(
    process.cwd(),
    process.env.PARAKEET_INFER_SCRIPT_PATH ?? './scripts/parakeet_transcribe.py'
  ),
  parakeetInferIntervalMs: getNumberEnv('PARAKEET_INFER_INTERVAL_MS', 5000),
  parakeetInferenceTimeoutMs: getNumberEnv('PARAKEET_INFERENCE_TIMEOUT_MS', 120000),
  parakeetMaxBufferedSeconds: getNumberEnv('PARAKEET_MAX_BUFFERED_SECONDS', 120),
};
