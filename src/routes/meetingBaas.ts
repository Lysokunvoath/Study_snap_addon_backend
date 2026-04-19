import { Router } from 'express';
import { env } from '../config/env';

type BotStartBody = {
  meetingUrl?: string;
  botName?: string;
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

export const meetingBaasRouter = Router();

meetingBaasRouter.post('/api/bot/start', async (req, res) => {
  const body = (req.body ?? {}) as BotStartBody;
  const meetingUrl = (body.meetingUrl ?? '').trim();
  const botName = (body.botName ?? env.meetingBaasBotName).trim() || env.meetingBaasBotName;

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
            lines: existing?.lines ?? [],
            signatures: existing?.signatures ?? new Set<string>(),
            seq: existing?.seq ?? 0,
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
      lines: existing?.lines ?? [],
      signatures: existing?.signatures ?? new Set<string>(),
      seq: existing?.seq ?? 0,
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

  const local = sessionsByBotId.get(botId);

  if (!env.meetingBaasApiKey) {
    return res.json({
      botId,
      status: local?.status ?? 'unknown',
      lineCount: local?.lines.length ?? 0,
    });
  }

  try {
    const response = await meetingBaasFetch(`/v2/bots/${encodeURIComponent(botId)}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return res.json({
        botId,
        status: local?.status ?? 'unknown',
        lineCount: local?.lines.length ?? 0,
      });
    }

    const json = (await response.json()) as {
      data?: {
        status?: string;
      };
    };

    const status = json.data?.status ?? local?.status ?? 'unknown';
    if (local) {
      local.status = status;
    }

    return res.json({
      botId,
      status,
      lineCount: local?.lines.length ?? 0,
    });
  } catch {
    return res.json({
      botId,
      status: local?.status ?? 'unknown',
      lineCount: local?.lines.length ?? 0,
    });
  }
});

meetingBaasRouter.get('/api/bot/transcript', (req, res) => {
  const botId = String(req.query.botId ?? '').trim();
  const sinceSeqRaw = String(req.query.sinceSeq ?? '').trim();
  const sinceSeq = Number.isFinite(Number(sinceSeqRaw)) ? Number(sinceSeqRaw) : 0;

  if (!botId) {
    return res.status(400).json({ error: 'botId is required.' });
  }

  const session = sessionsByBotId.get(botId);
  if (!session) {
    return res.status(404).json({ error: 'Unknown botId.' });
  }

  const lines = session.lines.filter((line) => line.seq > sinceSeq).slice(0, 300);
  return res.json({
    botId,
    status: session.status,
    lines,
    latestSeq: session.seq,
  });
});

meetingBaasRouter.post('/api/bot/webhook', (req, res) => {
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
      status?: string;
      message?: string;
      text?: string;
      content?: string;
      speaker?: string;
      participant_name?: string;
      timestamp?: string;
      meeting_url?: string;
    };
    bot_id?: string;
    status?: string;
    message?: string;
    text?: string;
    content?: string;
    speaker?: string;
    participant_name?: string;
    timestamp?: string;
    meeting_url?: string;
  };

  const eventType = String(payload.event ?? payload.type ?? '').trim();
  const botId = String(payload.data?.bot_id ?? payload.bot_id ?? '').trim();
  if (!botId) {
    return res.json({ ok: true });
  }

  const meetingUrl = String(payload.data?.meeting_url ?? payload.meeting_url ?? '').trim();
  const status = String(payload.data?.status ?? payload.status ?? '').trim();
  const text = String(payload.data?.message ?? payload.data?.text ?? payload.data?.content ?? payload.message ?? payload.text ?? payload.content ?? '').trim();
  const speaker = String(payload.data?.speaker ?? payload.data?.participant_name ?? payload.speaker ?? payload.participant_name ?? '').trim();
  const timestamp = String(payload.data?.timestamp ?? payload.timestamp ?? new Date().toISOString());

  const existing = sessionsByBotId.get(botId);
  const session: BotSession =
    existing ?? {
      botId,
      meetingUrl,
      status: status || eventType || 'unknown',
      lines: [],
      signatures: new Set<string>(),
      seq: 0,
    };

  if (meetingUrl) {
    session.meetingUrl = meetingUrl;
  }

  if (status) {
    session.status = status;
  } else if (eventType) {
    session.status = eventType;
  }

  if (text && /chat_message|transcript|caption/i.test(eventType || '')) {
    const signature = `${speaker.toLowerCase()}|${text.toLowerCase()}`;
    if (!session.signatures.has(signature)) {
      session.signatures.add(signature);
      session.seq += 1;
      session.lines.push({
        seq: session.seq,
        text,
        speaker: speaker || null,
        timestamp,
      });

      if (session.lines.length > 1500) {
        const overflow = session.lines.length - 1500;
        session.lines.splice(0, overflow);
      }
    }
  }

  sessionsByBotId.set(botId, session);
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

type MeetingBaasBot = {
  bot_id?: string;
  status?: string;
  created_at?: string;
  meeting_url?: string;
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
