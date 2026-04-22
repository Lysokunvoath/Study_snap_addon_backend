import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function getGoogleCredentialsJson(): string {
  // Support common naming variants used in deployment dashboards.
  return (
    process.env.GOOGLE_CLOUD_CREDENTIALS_JSON ??
    process.env.GOOGLE_CLOUD_CREDENTIAL_JSON ??
    process.env.GOOGLE_CLOUD_CREDENTIALIAL_JSON ??
    ''
  );
}

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
  googleCredentialsJson: getGoogleCredentialsJson(),
  googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
  googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
  googleOauthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? '',
  vertexAiLocation: process.env.VERTEX_AI_LOCATION ?? 'us-central1',
  vertexAiModel: process.env.VERTEX_AI_MODEL ?? 'gemini-1.5-flash-002',
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  supabaseDefaultUserId: process.env.SUPABASE_DEFAULT_USER_ID ?? '',
  meetingBaasApiKey: process.env.MEETINGBAAS_API_KEY ?? '',
  meetingBaasBaseUrl: process.env.MEETINGBAAS_BASE_URL ?? 'https://api.meetingbaas.com',
  meetingBaasWebhookSecret: process.env.MEETINGBAAS_WEBHOOK_SECRET ?? '',
  meetingBaasBotName: process.env.MEETINGBAAS_BOT_NAME ?? 'Study Snap Bot',
};
