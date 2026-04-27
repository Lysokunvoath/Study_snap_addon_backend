import { Router } from 'express';
import { env } from '../config/env';
import {
  fetchBotSessionStatusRecord,
  fetchTranscriptLinesRecord,
  upsertBotSessionRecord,
  upsertTranscriptLineRecord,
  updateBotSessionStatusRecord,
} from '../db/supabase';

type BotStartBody = {
  meetingUrl?: string;
  botName?: string;
  userId?: string;
};

type BotStopBody = {
  botId?: string;
};

type TranscriptLine = {
  seq: number;
  text: string;
  speaker: string | null;
  timestamp: string;
};

type BotSession = {
  botId: string;
  meetingUrl: string;
  status: string;
  userId?: string;
  lines: TranscriptLine[];
  signatures: Set<string>;
  seq: number;
};

const sessionsByBotId = new Map<string, BotSession>();
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'recording_failed',
  'call_ended',
  'api_request_stop',
  'bot_removed',
  'bot_removed_too_early',
  'waiting_room_timeout',
  'invalid_meeting_url',
  'meeting_error',
]);
const DISABLE_TRANSCRIPT_DEDUPE_FOR_DEBUG = true;

export const meetingBaasRouter = Router();

meetingBaasRouter.post('/api/bot/start', async (req, res) => {
  const body = (req.body ?? {}) as BotStartBody;
  const meetingUrl = (body.meetingUrl ?? '').trim();
  const botName = (body.botName ?? env.meetingBaasBotName).trim() || env.meetingBaasBotName;
  const userId = (body.userId ?? '').trim() || undefined;

  if (!env.meetingBaasApiKey) {
    return res.status(400).json({
      error: 'MEETINGBAAS_API_KEY is not configured.',
    });
  }

  if (!meetingUrl.startsWith('https://')) {
    return res.status(400).json({
      error: 'meetingUrl must be a valid https URL.',
    });
  }

  try {
    const response = await meetingBaasFetch('/v2/bots', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot_name: botName,
        meeting_url: meetingUrl,
        allow_multiple_bots: false,
        transcription_enabled: true,
        transcription_config: {
          provider: 'gladia',
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();

      // Deduplication can return 409 when a bot already exists for this meeting URL.
      if (response.status === 409 && text.includes('FST_ERR_BOT_ALREADY_EXISTS')) {
        const existingBot = await findExistingBotForMeeting(meetingUrl);
        if (existingBot?.bot_id) {
          const existing = sessionsByBotId.get(existingBot.bot_id);
          sessionsByBotId.set(existingBot.bot_id, {
            botId: existingBot.bot_id,
            meetingUrl,
            status: existingBot.status ?? existing?.status ?? 'queued',
            userId,
            lines: existing?.lines ?? [],
            signatures: existing?.signatures ?? new Set<string>(),
            seq: existing?.seq ?? 0,
          });

          void upsertBotSessionRecord({
            botId: existingBot.bot_id,
            meetingUrl,
            status: existingBot.status ?? existing?.status ?? 'queued',
            userId,
          });

          return res.json({
            botId: existingBot.bot_id,
            status: existingBot.status ?? 'queued',
            meetingUrl,
            reused: true,
          });
        }
      }

      return res.status(response.status).json({
        error: `Meeting BaaS create bot failed: ${text}`,
      });
    }

    const json = (await response.json()) as {
      data?: {
        bot_id?: string;
      };
    };

    const botId = json.data?.bot_id;
    if (!botId) {
      return res.status(502).json({
        error: 'Meeting BaaS response missing bot_id.',
      });
    }

    const existing = sessionsByBotId.get(botId);
    sessionsByBotId.set(botId, {
      botId,
      meetingUrl,
      status: existing?.status ?? 'queued',
      userId,
      lines: existing?.lines ?? [],
      signatures: existing?.signatures ?? new Set<string>(),
      seq: existing?.seq ?? 0,
    });

    void upsertBotSessionRecord({
      botId,
      meetingUrl,
      status: existing?.status ?? 'queued',
      userId,
    });

    return res.json({
      botId,
      status: 'queued',
      meetingUrl,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

meetingBaasRouter.post('/api/bot/stop', async (req, res) => {
  const body = (req.body ?? {}) as BotStopBody;
  const botId = (body.botId ?? '').trim();

  if (!env.meetingBaasApiKey) {
    return res.status(400).json({
      error: 'MEETINGBAAS_API_KEY is not configured.',
    });
  }

  if (!botId) {
    return res.status(400).json({
      error: 'botId is required.',
    });
  }

  try {
    const response = await meetingBaasFetch(`/v2/bots/${encodeURIComponent(botId)}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: `Meeting BaaS stop bot failed: ${text}`,
      });
    }

    const session = sessionsByBotId.get(botId);
    if (session) {
      session.status = 'api_request_stop';
    }

    void updateBotSessionStatusRecord(botId, 'api_request_stop');

    return res.json({
      stopped: true,
      botId,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

meetingBaasRouter.get('/api/bot/status', async (req, res) => {
  const botId = String(req.query.botId ?? '').trim();
  if (!botId) {
    return res.status(400).json({ error: 'botId is required.' });
  }

  let local = sessionsByBotId.get(botId);
  if (!local) {
    local = {
      botId,
      meetingUrl: '',
      status: 'unknown',
      userId: undefined,
      lines: [],
      signatures: new Set<string>(),
      seq: 0,
    };
  }

  if (!env.meetingBaasApiKey) {
    const status = local.status || (await fetchBotSessionStatusRecord(botId)) || 'unknown';
    return res.json({
      botId,
      status,
      lineCount: local.lines.length,
    });
  }

  try {
    const details = await fetchBotDetails(botId);
    if (!details) {
      return res.json({
        botId,
        status: local.status || 'unknown',
        lineCount: local.lines.length,
      });
    }

    const status = String(details.status ?? '').trim() || local.status || 'unknown';
    local.status = status;

    const meetingUrl = String(details.meeting_url ?? '').trim();
    if (meetingUrl) {
      local.meetingUrl = meetingUrl;
    }

    if (TERMINAL_STATUSES.has(status.toLowerCase()) && local.lines.length === 0) {
      await hydrateSessionFromBotDetails(local);
    }

    sessionsByBotId.set(botId, local);
    await upsertBotSessionRecord({
      botId: local.botId,
      meetingUrl: local.meetingUrl,
      status: local.status,
      userId: local.userId,
    });

    void updateBotSessionStatusRecord(botId, status);

    return res.json({
      botId,
      status,
      lineCount: local.lines.length,
    });
  } catch {
    return res.json({
      botId,
      status: local.status || 'unknown',
      lineCount: local.lines.length,
    });
  }
});

meetingBaasRouter.get('/api/bot/transcript', async (req, res) => {
  const botId = String(req.query.botId ?? '').trim();
  const sinceSeqRaw = String(req.query.sinceSeq ?? '').trim();
  const sinceSeq = Number.isFinite(Number(sinceSeqRaw)) ? Number(sinceSeqRaw) : 0;

  if (!botId) {
    return res.status(400).json({ error: 'botId is required.' });
  }

  let session = sessionsByBotId.get(botId);
  if (!session) {
    session = {
      botId,
      meetingUrl: '',
      status: 'unknown',
      userId: undefined,
      lines: [],
      signatures: new Set<string>(),
      seq: 0,
    };
  }

  if (session.lines.length === 0) {
    await hydrateSessionFromBotDetails(session);
    sessionsByBotId.set(botId, session);
    await upsertBotSessionRecord({
      botId: session.botId,
      meetingUrl: session.meetingUrl,
      status: session.status,
      userId: session.userId,
    });
  }

  const memoryLines = session.lines.filter((line) => line.seq > sinceSeq).slice(0, 300);

  if (memoryLines.length > 0) {
    return res.json({
      botId,
      status: session.status ?? 'unknown',
      lines: memoryLines,
      latestSeq: session.seq ?? sinceSeq,
    });
  }

  const dbLines = await fetchTranscriptLinesRecord(botId, sinceSeq, 300);
  const dbStatus = await fetchBotSessionStatusRecord(botId);

  if (session.lines.length === 0 && dbLines.length === 0 && !dbStatus) {
    return res.json({
      botId,
      status: session.status ?? 'unknown',
      lines: [],
      latestSeq: session.seq ?? sinceSeq,
    });
  }

  const latestSeqFromDb = dbLines.length ? dbLines[dbLines.length - 1]?.seq ?? sinceSeq : sinceSeq;
  return res.json({
    botId,
    status: session.status ?? dbStatus ?? 'unknown',
    lines: dbLines,
    latestSeq: Math.max(session.seq ?? sinceSeq, latestSeqFromDb),
  });
});

meetingBaasRouter.post('/api/bot/webhook', async (req, res) => {
  const secretHeader =
    String(req.headers['x-meetingbaas-webhook-secret'] ?? req.headers['x-meeting-baas-webhook-secret'] ?? '').trim();

  if (env.meetingBaasWebhookSecret && secretHeader && secretHeader !== env.meetingBaasWebhookSecret) {
    return res.status(401).json({ error: 'Invalid webhook secret.' });
  }

  const payload = (req.body ?? {}) as {
    event?: string;
    type?: string;
    data?: {
      bot_id?: string;
      status?: string | { code?: string; created_at?: string };
      message?: string;
      text?: string;
      content?: string;
      speaker?: string;
      participant_name?: string;
      sender_name?: string;
      transcription?: string;
      timestamp?: string;
      sent_at?: string;
      meeting_url?: string;
    };
    bot_id?: string;
    status?: string;
    message?: string;
    text?: string;
    content?: string;
    speaker?: string;
    participant_name?: string;
    sender_name?: string;
    transcription?: string;
    timestamp?: string;
    sent_at?: string;
    meeting_url?: string;
  };

  const eventType = String(payload.event ?? payload.type ?? '').trim();
  const botId = String(payload.data?.bot_id ?? payload.bot_id ?? '').trim();
  if (!botId) {
    return res.json({ ok: true });
  }

  const meetingUrl = String(payload.data?.meeting_url ?? payload.meeting_url ?? '').trim();
  const statusFromData = payload.data?.status;
  const statusCode =
    typeof statusFromData === 'string'
      ? statusFromData
      : String(statusFromData?.code ?? payload.status ?? '').trim();
  const text = String(payload.data?.message ?? payload.data?.text ?? payload.data?.content ?? payload.message ?? payload.text ?? payload.content ?? '').trim();
  const speaker = String(
    payload.data?.speaker ??
      payload.data?.participant_name ??
      payload.data?.sender_name ??
      payload.speaker ??
      payload.participant_name ??
      payload.sender_name ??
      ''
  ).trim();
  const timestamp = String(payload.data?.timestamp ?? payload.data?.sent_at ?? payload.timestamp ?? payload.sent_at ?? new Date().toISOString());
  const transcriptionUrl = String(payload.data?.transcription ?? payload.transcription ?? '').trim();

  const existing = sessionsByBotId.get(botId);
  const session: BotSession =
    existing ?? {
      botId,
      meetingUrl,
      status: statusCode || eventType || 'unknown',
      userId: undefined,
      lines: [],
      signatures: new Set<string>(),
      seq: 0,
    };

  if (meetingUrl) {
    session.meetingUrl = meetingUrl;
  }

  if (existing?.userId) {
    session.userId = existing.userId;
  }

  if (statusCode) {
    session.status = statusCode;
  } else if (eventType) {
    session.status = eventType;
  }

  if (text && /chat_message|transcript|caption/i.test(eventType || '')) {
    appendLine(session, text, speaker || null, timestamp);
  }

  if (eventType === 'bot.completed') {
    if (transcriptionUrl) {
      hydrateSessionFromTranscriptionUrl(session, transcriptionUrl).catch(() => {
        // Ignore artifact fetch errors in webhook response path.
      });
    } else {
      hydrateSessionFromBotDetails(session).catch(() => {
        // Ignore API fetch errors in webhook response path.
      });
    }
  }

  sessionsByBotId.set(botId, session);
  await upsertBotSessionRecord({
    botId,
    meetingUrl: session.meetingUrl,
    status: session.status,
    userId: session.userId,
  });

  return res.json({ ok: true });
});

async function meetingBaasFetch(path: string, init: RequestInit): Promise<Response> {
  const base = env.meetingBaasBaseUrl.replace(/\/+$/, '');
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      'x-meeting-baas-api-key': env.meetingBaasApiKey,
      ...(init.headers ?? {}),
    },
  });
}

function appendLine(session: BotSession, text: string, speaker: string | null, timestamp: string): void {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }

  const signature = `${(speaker ?? '').toLowerCase()}|${normalizedText.toLowerCase()}`;
  if (!DISABLE_TRANSCRIPT_DEDUPE_FOR_DEBUG && session.signatures.has(signature)) {
    return;
  }

  if (!DISABLE_TRANSCRIPT_DEDUPE_FOR_DEBUG) {
    session.signatures.add(signature);
  }
  session.seq += 1;
  session.lines.push({
    seq: session.seq,
    text: normalizedText,
    speaker,
    timestamp,
  });

  void upsertTranscriptLineRecord({
    botId: session.botId,
    userId: session.userId,
    seq: session.seq,
    text: normalizedText,
    speaker,
    timestamp,
  });

  if (session.lines.length > 1500) {
    const overflow = session.lines.length - 1500;
    session.lines.splice(0, overflow);
  }
}

async function hydrateSessionFromTranscriptionUrl(
  session: BotSession,
  transcriptionUrl: string
): Promise<void> {
  const response = await fetch(transcriptionUrl);
  if (!response.ok) {
    return;
  }

  const data = (await response.json()) as unknown;
  const utterances = extractUtterances(data);
  for (const utterance of utterances) {
    const text = (utterance.text ?? '').trim();
    if (!text) {
      continue;
    }

    appendLine(
      session,
      text,
      utterance.speaker ? String(utterance.speaker) : null,
      new Date().toISOString()
    );
  }

  if (utterances.length === 0) {
    const fallbackText = extractTranscriptText(data);
    if (fallbackText) {
      for (const line of splitTranscriptIntoLines(fallbackText)) {
        appendLine(session, line, null, new Date().toISOString());
      }
    }
  }
}

type ExtractedUtterance = {
  text: string;
  speaker: string | null;
};

function extractUtterances(payload: unknown): ExtractedUtterance[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const candidateArrays: unknown[] = [];

  if (Array.isArray(record.utterances)) {
    candidateArrays.push(record.utterances);
  }
  if (Array.isArray(record.segments)) {
    candidateArrays.push(record.segments);
  }
  if (Array.isArray(record.transcript)) {
    candidateArrays.push(record.transcript);
  }
  if (Array.isArray(record.results)) {
    candidateArrays.push(record.results);
  }

  const resultNode =
    record.result && typeof record.result === 'object'
      ? (record.result as Record<string, unknown>)
      : null;
  if (resultNode) {
    if (Array.isArray(resultNode.utterances)) {
      candidateArrays.push(resultNode.utterances);
    }
    if (Array.isArray(resultNode.segments)) {
      candidateArrays.push(resultNode.segments);
    }
    if (Array.isArray(resultNode.transcript)) {
      candidateArrays.push(resultNode.transcript);
    }
    if (Array.isArray(resultNode.results)) {
      candidateArrays.push(resultNode.results);
    }
  }

  let best: ExtractedUtterance[] = [];
  for (const candidate of candidateArrays) {
    const extracted = normalizeUtteranceArray(candidate);
    if (extracted.length > best.length) {
      best = extracted;
    }
  }

  return best;
}

function normalizeUtteranceArray(candidate: unknown): ExtractedUtterance[] {
  if (!Array.isArray(candidate)) {
    return [];
  }

  const results: ExtractedUtterance[] = [];
  for (const item of candidate) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const row = item as Record<string, unknown>;
    const textValue =
      row.text ?? row.transcript ?? row.content ?? row.caption ?? row.message ?? row.value ?? '';
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    if (!text) {
      continue;
    }

    const speakerValue = row.speaker ?? row.speaker_name ?? row.participant_name ?? row.sender_name ?? null;
    const speaker = typeof speakerValue === 'string' && speakerValue.trim() ? speakerValue.trim() : null;
    results.push({ text, speaker });
  }

  return results;
}

function extractTranscriptText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const record = payload as Record<string, unknown>;
  const directText =
    record.transcript_text ??
    record.transcription_text ??
    record.text ??
    record.transcript ??
    record.content ??
    '';

  if (typeof directText === 'string') {
    return directText.trim();
  }

  if (Array.isArray(directText)) {
    const joined = directText
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
      .join('\n');
    if (joined) {
      return joined;
    }
  }

  const resultNode =
    record.result && typeof record.result === 'object'
      ? (record.result as Record<string, unknown>)
      : null;
  if (!resultNode) {
    return '';
  }

  const nestedText = resultNode.transcript_text ?? resultNode.transcription_text ?? resultNode.text ?? '';
  return typeof nestedText === 'string' ? nestedText.trim() : '';
}

function splitTranscriptIntoLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  const byLines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (byLines.length > 1) {
    return byLines;
  }

  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

type MeetingBaasBot = {
  bot_id?: string;
  status?: string;
  created_at?: string;
  meeting_url?: string;
  transcription?: string;
};

type MeetingBaasBotDetailsResponse = {
  data?: MeetingBaasBot;
};

async function findExistingBotForMeeting(meetingUrl: string): Promise<MeetingBaasBot | null> {
  const query = new URLSearchParams({
    limit: '25',
    meeting_url: meetingUrl,
  });

  const response = await meetingBaasFetch(`/v2/bots?${query.toString()}`, {
    method: 'GET',
  });

  if (!response.ok) {
    return null;
  }

  const json = (await response.json()) as { data?: MeetingBaasBot[] };
  const bots = (json.data ?? []).filter((bot) => bot.bot_id);
  if (!bots.length) {
    return null;
  }

  const sorted = [...bots].sort((a, b) => {
    const aTs = a.created_at ? Date.parse(a.created_at) : 0;
    const bTs = b.created_at ? Date.parse(b.created_at) : 0;
    return bTs - aTs;
  });

  const active = sorted.find((bot) => !TERMINAL_STATUSES.has((bot.status ?? '').toLowerCase()));
  return active ?? sorted[0] ?? null;
}

async function fetchBotDetails(botId: string): Promise<MeetingBaasBot | null> {
  if (!env.meetingBaasApiKey) {
    return null;
  }

  const response = await meetingBaasFetch(`/v2/bots/${encodeURIComponent(botId)}`, {
    method: 'GET',
  });

  if (!response.ok) {
    return null;
  }

  const json = (await response.json()) as MeetingBaasBotDetailsResponse;
  return json.data ?? null;
}

async function hydrateSessionFromBotDetails(session: BotSession): Promise<void> {
  const details = await fetchBotDetails(session.botId);
  if (!details) {
    return;
  }

  const status = String(details.status ?? '').trim();
  if (status) {
    session.status = status;
  }

  const meetingUrl = String(details.meeting_url ?? '').trim();
  if (meetingUrl) {
    session.meetingUrl = meetingUrl;
  }

  const transcriptionUrl = String(details.transcription ?? '').trim();
  if (transcriptionUrl) {
    await hydrateSessionFromTranscriptionUrl(session, transcriptionUrl);
  }
}
