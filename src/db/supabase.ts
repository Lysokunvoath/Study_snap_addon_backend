import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from '../utils/logger';

type TranscriptLineRecord = {
  seq: number;
  text: string;
  speaker: string | null;
  timestamp: string;
};

type StudyFlashcard = {
  question: string;
  answer: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
};

type MeetingRow = {
  id: string;
  user_id: string | null;
  title: string | null;
  transcript: string | null;
  ai_notes: string | null;
  recording_url: string | null;
};

let supabaseClient: SupabaseClient | null = null;
const BOT_RECORDING_URL_PREFIX = 'meetingbaas://bot/';
const transcriptWriteQueueByBotId = new Map<string, Promise<void>>();

function getSupabaseClient(): SupabaseClient | null {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    return null;
  }

  if (supabaseClient) {
    return supabaseClient;
  }

  supabaseClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseClient;
}

export function isSupabaseEnabled(): boolean {
  return !!getSupabaseClient();
}

export async function upsertBotSessionRecord(input: {
  botId: string;
  meetingUrl: string;
  status: string;
  userId?: string;
}): Promise<void> {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }

  const meeting = await findMeetingByBotId(client, input.botId);

  if (!meeting) {
    return;
  }

  const requestedUserId = input.userId?.trim();
  if (requestedUserId && !meeting.user_id) {
    const { error: ownershipError } = await client
      .from('meetings')
      .update({
        user_id: requestedUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', meeting.id);

    if (ownershipError) {
      logger.warn('Supabase meeting ownership assignment failed', {
        botId: input.botId,
        toUserId: requestedUserId,
        error: ownershipError.message,
      });
    } else {
      meeting.user_id = requestedUserId;
    }
  }

  const title = deriveMeetingTitle(input.meetingUrl) || meeting.title || 'Meeting Transcript';
  const { error } = await client
    .from('meetings')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', meeting.id);

  if (error) {
    logger.warn('Supabase update meeting row failed', {
      botId: input.botId,
      error: error.message,
    });
  }
}

export async function updateBotSessionStatusRecord(botId: string, status: string): Promise<void> {
  // The current schema does not include a bot status column.
  // Keep this as a no-op so route behavior remains stable.
  void botId;
  void status;
}

export async function upsertTranscriptLineRecord(input: {
  botId: string;
  userId?: string;
  seq: number;
  text: string;
  speaker: string | null;
  timestamp: string;
}): Promise<void> {
  await enqueueTranscriptWrite(input.botId, async () => {
    const client = getSupabaseClient();
    if (!client) {
      return;
    }

    const meeting = await ensureMeetingForBot(input.botId, {
      userId: input.userId,
    });
    if (!meeting) {
      return;
    }

    const parsed = parseTranscriptBlob(meeting.transcript ?? '');
    parsed.set(input.seq, {
      seq: input.seq,
      text: input.text,
      speaker: input.speaker,
      timestamp: input.timestamp,
    });

    const transcript = serializeTranscriptBlob(parsed);
    const { error } = await client
      .from('meetings')
      .update({ transcript, updated_at: new Date().toISOString() })
      .eq('id', meeting.id);

    if (error) {
      logger.warn('Supabase update meeting transcript failed', {
        botId: input.botId,
        seq: input.seq,
        error: error.message,
      });
    }
  });
}

function enqueueTranscriptWrite(botId: string, operation: () => Promise<void>): Promise<void> {
  const previous = transcriptWriteQueueByBotId.get(botId) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      // Keep the queue alive even if a previous write failed.
    })
    .then(operation);

  transcriptWriteQueueByBotId.set(botId, next);

  return next.finally(() => {
    if (transcriptWriteQueueByBotId.get(botId) === next) {
      transcriptWriteQueueByBotId.delete(botId);
    }
  });
}

export async function fetchTranscriptLinesRecord(
  botId: string,
  sinceSeq: number,
  limit = 300
): Promise<TranscriptLineRecord[]> {
  const client = getSupabaseClient();
  if (!client) {
    return [];
  }

  const meeting = await findMeetingByBotId(client, botId);
  if (!meeting?.transcript) {
    return [];
  }

  return [...parseTranscriptBlob(meeting.transcript).values()]
    .sort((a, b) => a.seq - b.seq)
    .filter((line) => line.seq > sinceSeq)
    .slice(0, limit);
}

export async function fetchBotSessionStatusRecord(botId: string): Promise<string | null> {
  void botId;
  return null;
}

export async function insertStudyArtifactRecord(input: {
  botId: string | null;
  userId?: string;
  title: string;
  transcriptLength: number;
  summary: unknown;
  notes: unknown;
  flashcards: unknown;
}): Promise<void> {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }

  let meeting: MeetingRow | null = null;
  if (input.botId) {
    meeting = await ensureMeetingForBot(input.botId, {
      userId: input.userId,
      meetingUrl: '',
    });
  }

  const aiNotes = formatAiNotes(input.summary, input.notes, input.flashcards);
  if (meeting) {
    const { error } = await client
      .from('meetings')
      .update({
        title: input.title,
        ai_notes: aiNotes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', meeting.id);

    if (error) {
      logger.warn('Supabase update meeting ai notes failed', {
        botId: input.botId,
        error: error.message,
      });
    }
  }

  const effectiveUserId = input.userId ?? meeting?.user_id ?? env.supabaseDefaultUserId;
  const cards = normalizeFlashcards(input.flashcards);
  if (!effectiveUserId || cards.length === 0) {
    return;
  }

  const deckInsert = await client
    .from('flashcard_decks')
    .insert({
      user_id: effectiveUserId,
      title: input.title,
      description: `Auto-generated from transcript (${input.transcriptLength} chars).`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (deckInsert.error || !deckInsert.data?.id) {
    logger.warn('Supabase create flashcard deck failed', {
      userId: effectiveUserId,
      error: deckInsert.error?.message ?? 'missing deck id',
    });
    return;
  }

  const deckId = String(deckInsert.data.id);
  const { error: cardError } = await client.from('flashcards').insert(
    cards.map((card) => ({
      deck_id: deckId,
      front: card.question,
      back: card.answer,
      difficulty: card.difficulty,
      review_count: 0,
    }))
  );

  if (cardError) {
    logger.warn('Supabase insert flashcards failed', {
      deckId,
      error: cardError.message,
    });
  }
}

export async function upsertTranscriptTextRecord(input: {
  botId?: string | null;
  userId?: string;
  meetingUrl?: string;
  title?: string;
  transcriptText: string;
}): Promise<{ meetingId: string | null; title: string }> {
  const client = getSupabaseClient();
  const cleanTranscript = String(input.transcriptText ?? '').trim();
  const title = String(input.title ?? '').trim() || 'Meeting Transcript';

  if (!client || !cleanTranscript) {
    return { meetingId: null, title };
  }

  const timestamp = new Date().toISOString();

  if (input.botId) {
    const meeting = await ensureMeetingForBot(input.botId, {
      userId: input.userId,
      meetingUrl: input.meetingUrl,
    });

    if (meeting) {
      const { data, error } = await client
        .from('meetings')
        .update({
          title: title || meeting.title || deriveMeetingTitle(input.meetingUrl ?? ''),
          transcript: cleanTranscript,
          updated_at: timestamp,
        })
        .eq('id', meeting.id)
        .select('id')
        .maybeSingle();

      if (!error && data?.id) {
        return { meetingId: String(data.id), title };
      }
    }
  }

  const effectiveUserId = input.userId ?? env.supabaseDefaultUserId ?? undefined;
  if (!effectiveUserId) {
    return { meetingId: null, title };
  }

  const { data, error } = await client
    .from('meetings')
    .insert({
      ...(effectiveUserId ? { user_id: effectiveUserId } : {}),
      title,
      transcript: cleanTranscript,
      ai_notes: '',
      recording_url: input.botId ? botRecordingUrlMarker(input.botId) : null,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    logger.warn('Supabase upsert transcript text failed', {
      botId: input.botId ?? null,
      error: error?.message ?? 'missing meeting id',
    });
    return { meetingId: null, title };
  }

  return { meetingId: String(data.id), title };
}

async function ensureMeetingForBot(
  botId: string,
  options: { userId?: string; meetingUrl?: string }
): Promise<MeetingRow | null> {
  const client = getSupabaseClient();
  if (!client) {
    return null;
  }

  const existing = await findMeetingByBotId(client, botId);
  if (existing) {
    const requestedUserId = options.userId?.trim();
    if (requestedUserId && !existing.user_id) {
      const { error: ownershipError } = await client
        .from('meetings')
        .update({
          user_id: requestedUserId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (ownershipError) {
        logger.warn('Supabase meeting ownership assignment failed', {
          botId,
          toUserId: requestedUserId,
          error: ownershipError.message,
        });
      } else {
        existing.user_id = requestedUserId;
      }
    }

    return existing;
  }

  const userId = options.userId ?? env.supabaseDefaultUserId ?? undefined;
  const inserted = await client
    .from('meetings')
    .insert({
      ...(userId ? { user_id: userId } : {}),
      title: deriveMeetingTitle(options.meetingUrl ?? ''),
      transcript: '',
      ai_notes: '',
      recording_url: botRecordingUrlMarker(botId),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id,user_id,title,transcript,ai_notes,recording_url')
    .maybeSingle();

  if (inserted.error || !inserted.data) {
    logger.warn('Supabase create meeting row failed', {
      botId,
      error: inserted.error?.message ?? 'missing meeting row',
      hint:
        'If meetings.user_id is NOT NULL, pass userId in /api/bot/start or set SUPABASE_DEFAULT_USER_ID.',
    });
    return null;
  }

  return {
    id: String(inserted.data.id),
    user_id: inserted.data.user_id ? String(inserted.data.user_id) : null,
    title: inserted.data.title ? String(inserted.data.title) : null,
    transcript: inserted.data.transcript ? String(inserted.data.transcript) : null,
    ai_notes: inserted.data.ai_notes ? String(inserted.data.ai_notes) : null,
    recording_url: inserted.data.recording_url ? String(inserted.data.recording_url) : null,
  };
}

async function findMeetingByBotId(client: SupabaseClient, botId: string): Promise<MeetingRow | null> {
  const { data, error } = await client
    .from('meetings')
    .select('id,user_id,title,transcript,ai_notes,recording_url')
    .eq('recording_url', botRecordingUrlMarker(botId))
    .maybeSingle();

  if (error) {
    logger.warn('Supabase fetch meeting by bot id failed', {
      botId,
      error: error.message,
    });
    return null;
  }

  if (!data) {
    return null;
  }

  return {
    id: String(data.id),
    user_id: data.user_id ? String(data.user_id) : null,
    title: data.title ? String(data.title) : null,
    transcript: data.transcript ? String(data.transcript) : null,
    ai_notes: data.ai_notes ? String(data.ai_notes) : null,
    recording_url: data.recording_url ? String(data.recording_url) : null,
  };
}

function botRecordingUrlMarker(botId: string): string {
  return `${BOT_RECORDING_URL_PREFIX}${botId}`;
}

function deriveMeetingTitle(meetingUrl: string): string {
  const trimmed = meetingUrl.trim();
  if (!trimmed) {
    return 'Meeting Transcript';
  }

  try {
    const parsed = new URL(trimmed);
    const code = parsed.pathname.split('/').filter(Boolean).pop();
    if (code) {
      return `Meeting ${code}`;
    }
  } catch {
    // Keep a safe fallback title for malformed URLs.
  }

  return 'Meeting Transcript';
}

function parseTranscriptBlob(raw: string): Map<number, TranscriptLineRecord> {
  const result = new Map<number, TranscriptLineRecord>();
  const normalized = String(raw ?? '').trim();
  if (!normalized) {
    return result;
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const row = item as Record<string, unknown>;
        const seq = Number(row.seq ?? row.sequence ?? 0);
        const text = String(row.text ?? '').trim();
        if (!Number.isFinite(seq) || seq <= 0 || !text) {
          continue;
        }

        const timestamp = String(row.timestamp ?? new Date().toISOString()).trim() || new Date().toISOString();
        const speakerValue = row.speaker ?? row.speaker_name ?? null;
        const speaker = typeof speakerValue === 'string' && speakerValue.trim() ? speakerValue.trim() : null;

        result.set(seq, { seq, text, speaker, timestamp });
      }

      if (result.size > 0) {
        return result;
      }
    }
  } catch {
    // Fall back to the legacy line-based blob format.
  }

  const rows = normalized.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);

  if (rows.length === 0) {
    return result;
  }

  for (const row of rows) {
    const parts = row.split('\t');
    if (parts.length !== 4 || !Number.isFinite(Number(parts[0]))) {
      continue;
    }

    const seq = Number(parts[0]);
    const timestamp = parts[1] || new Date().toISOString();
    const speakerRaw = decodeBlobField(parts[2]);
    const text = decodeBlobField(parts[3]);
    if (!text.trim()) {
      continue;
    }

    result.set(seq, {
      seq,
      text,
      speaker: speakerRaw || null,
      timestamp,
    });
  }

  // Backward compatibility for plain transcript text.
  if (result.size === 0) {
    rows.forEach((line, index) => {
      result.set(index + 1, {
        seq: index + 1,
        text: line,
        speaker: null,
        timestamp: new Date().toISOString(),
      });
    });
  }

  return result;
}

function serializeTranscriptBlob(lines: Map<number, TranscriptLineRecord>): string {
  return JSON.stringify(
    [...lines.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      seq: line.seq,
      timestamp: line.timestamp,
      speaker: line.speaker,
      text: line.text,
    }))
  );
}

function encodeBlobField(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodeBlobField(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return value;
  }
}

function formatAiNotes(summary: unknown, notes: unknown, flashcards: unknown): string {
  return [
    'Summary:',
    stringifyForStorage(summary),
    '',
    'Notes:',
    stringifyForStorage(notes),
    '',
    'Flashcards:',
    stringifyForStorage(flashcards),
  ].join('\n');
}

function stringifyForStorage(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function normalizeFlashcards(value: unknown): StudyFlashcard[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const card = item as {
        question?: unknown;
        answer?: unknown;
        difficulty?: unknown;
        tags?: unknown;
      };

      const question = String(card.question ?? '').trim();
      const answer = String(card.answer ?? '').trim();
      if (!question || !answer) {
        return null;
      }

      const difficultyRaw = String(card.difficulty ?? 'medium').toLowerCase();
      const difficulty: 'easy' | 'medium' | 'hard' =
        difficultyRaw === 'easy' || difficultyRaw === 'hard' ? difficultyRaw : 'medium';

      const tags = Array.isArray(card.tags)
        ? card.tags.map((tag) => String(tag)).filter(Boolean)
        : [];

      return {
        question,
        answer,
        difficulty,
        tags,
      };
    })
    .filter((item): item is StudyFlashcard => item !== null);
}
