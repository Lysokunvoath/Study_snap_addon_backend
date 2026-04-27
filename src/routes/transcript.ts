import { Router } from 'express';
import { upsertTranscriptTextRecord } from '../db/supabase';
import { logger } from '../utils/logger';

type TranscriptImportBody = {
  transcriptText?: string;
  botId?: string;
  userId?: string;
  meetingUrl?: string;
  title?: string;
};

export const transcriptRouter = Router();

transcriptRouter.post('/api/transcript/import', async (req, res) => {
  const body = (req.body ?? {}) as TranscriptImportBody;
  const raw = (body.transcriptText ?? '').trim();
  const botId = String(body.botId ?? '').trim() || undefined;
  const userId = String(body.userId ?? '').trim() || undefined;
  const meetingUrl = String(body.meetingUrl ?? '').trim() || undefined;
  const title = String(body.title ?? '').trim() || undefined;

  if (!raw) {
    return res.status(400).json({
      error: 'transcriptText is required.',
    });
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 500);

  let meetingId: string | null = null;
  let persistenceError: string | null = null;
  try {
    const result = await upsertTranscriptTextRecord({
      botId,
      userId,
      meetingUrl,
      title,
      transcriptText: raw,
    });
    meetingId = result.meetingId;

    if (!meetingId) {
      persistenceError =
        'Transcript received but not persisted. Ensure SUPABASE_DEFAULT_USER_ID is set or pass userId.';
    }
  } catch (error) {
    persistenceError = error instanceof Error ? error.message : 'Unknown persistence error';
    logger.warn('Transcript import persistence failed', {
      botId,
      userId,
      meetingUrl,
      error: persistenceError,
    });
  }

  return res.json({
    importedLineCount: lines.length,
    lines,
    meetingId,
    persisted: !!meetingId,
    persistenceError,
    title: title ?? 'Meeting Transcript',
  });
});
