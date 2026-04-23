import { Router } from 'express';
import { upsertTranscriptTextRecord } from '../db/supabase';

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
  try {
    const result = await upsertTranscriptTextRecord({
      botId,
      userId,
      meetingUrl,
      title,
      transcriptText: raw,
    });
    meetingId = result.meetingId;
  } catch {
    // Keep the response path resilient even if transcript persistence fails.
  }

  return res.json({
    importedLineCount: lines.length,
    lines,
    meetingId,
    title: title ?? 'Meeting Transcript',
  });
});
