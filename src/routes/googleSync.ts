import { Router } from 'express';
import { google } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import { env } from '../config/env';

type OAuthStartBody = {
  userKey?: string;
};

type SyncTranscriptBody = {
  userKey?: string;
  meetingCode?: string;
};

type StoredToken = Credentials;

const authStateToUserKey = new Map<string, string>();
const userTokens = new Map<string, StoredToken>();

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

export const googleSyncRouter = Router();

googleSyncRouter.post('/api/google/oauth/start', (req, res) => {
  const body = (req.body ?? {}) as OAuthStartBody;
  const userKey = (body.userKey ?? '').trim();

  if (!userKey) {
    return res.status(400).json({
      error: 'userKey is required.',
    });
  }

  if (!env.googleOauthClientId || !env.googleOauthClientSecret || !env.googleOauthRedirectUri) {
    return res.status(400).json({
      error:
        'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.',
    });
  }

  const state = randomId();
  authStateToUserKey.set(state, userKey);

  const oauthClient = createOAuthClient();
  const authUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: SCOPES,
    state,
  });

  return res.json({ authUrl });
});

googleSyncRouter.get('/api/google/oauth/callback', async (req, res) => {
  const state = String(req.query.state ?? '');
  const code = String(req.query.code ?? '');

  const userKey = authStateToUserKey.get(state);
  authStateToUserKey.delete(state);

  if (!userKey || !code) {
    return res.status(400).send('Invalid OAuth callback state or code.');
  }

  try {
    const oauthClient = createOAuthClient();
    const tokenResponse = await oauthClient.getToken(code);

    const credentials = tokenResponse.tokens;
    userTokens.set(userKey, {
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      expiry_date: credentials.expiry_date,
      scope: credentials.scope,
      token_type: credentials.token_type,
    });

    return res
      .status(200)
      .send('<html><body><script>window.close();</script>Google account connected. You can close this window.</body></html>');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).send(`OAuth token exchange failed: ${message}`);
  }
});

googleSyncRouter.get('/api/google/oauth/status', (req, res) => {
  const userKey = String(req.query.userKey ?? '').trim();
  if (!userKey) {
    return res.status(400).json({ error: 'userKey is required.' });
  }

  const token = userTokens.get(userKey);
  return res.json({
    connected: !!token,
  });
});

googleSyncRouter.post('/api/google/transcript/sync', async (req, res) => {
  const body = (req.body ?? {}) as SyncTranscriptBody;
  const userKey = (body.userKey ?? '').trim();
  const meetingCode = (body.meetingCode ?? '').trim();

  if (!userKey) {
    return res.status(400).json({ error: 'userKey is required.' });
  }

  const token = userTokens.get(userKey);
  if (!token) {
    return res.status(401).json({
      error: 'Google account is not connected for this user.',
    });
  }

  try {
    const oauthClient = createOAuthClient();
    oauthClient.setCredentials(token);

    oauthClient.on('tokens', (tokens) => {
      const existing = userTokens.get(userKey) ?? {};
      userTokens.set(userKey, {
        access_token: tokens.access_token ?? existing.access_token,
        refresh_token: tokens.refresh_token ?? existing.refresh_token,
        expiry_date: tokens.expiry_date ?? existing.expiry_date,
        scope: tokens.scope ?? existing.scope,
        token_type: tokens.token_type ?? existing.token_type,
      });
    });

    const drive = google.drive({ version: 'v3', auth: oauthClient });
    const docs = google.docs({ version: 'v1', auth: oauthClient });

    let query = "mimeType='application/vnd.google-apps.document' and trashed=false";
    if (meetingCode) {
      query += ` and name contains '${meetingCode.replace(/'/g, "\\'")}'`;
    }

    const fileList = await drive.files.list({
      q: query,
      orderBy: 'modifiedTime desc',
      pageSize: 20,
      fields: 'files(id,name,modifiedTime)',
    });

    const files = fileList.data.files ?? [];
    const transcriptFile =
      files.find((file: { name?: string | null }) => /transcript|meeting/i.test(file.name ?? '')) ??
      files[0];

    if (!transcriptFile?.id) {
      return res.status(404).json({
        error: 'No transcript document found for this account.',
      });
    }

    const document = await docs.documents.get({ documentId: transcriptFile.id });
    const fullText = extractGoogleDocText(document.data);

    const lines = fullText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 800);

    return res.json({
      documentId: transcriptFile.id,
      documentTitle: transcriptFile.name ?? 'Meeting transcript',
      modifiedTime: transcriptFile.modifiedTime ?? null,
      importedLineCount: lines.length,
      lines,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      error: `Transcript sync failed: ${message}`,
    });
  }
});

function createOAuthClient() {
  return new google.auth.OAuth2(
    env.googleOauthClientId,
    env.googleOauthClientSecret,
    env.googleOauthRedirectUri
  );
}

function extractGoogleDocText(doc: unknown): string {
  const body = (doc as { body?: { content?: Array<unknown> } }).body;
  const content = body?.content ?? [];
  const chunks: string[] = [];

  for (const block of content) {
    const paragraph = (block as { paragraph?: { elements?: Array<unknown> } }).paragraph;
    const elements = paragraph?.elements ?? [];

    for (const element of elements) {
      const textRun = (element as { textRun?: { content?: string } }).textRun;
      if (textRun?.content) {
        chunks.push(textRun.content);
      }
    }
  }

  return chunks.join('');
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
