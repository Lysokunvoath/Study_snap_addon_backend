import { Router } from 'express';

type TranscriptImportBody = {
  transcriptText?: string;
};

export const transcriptRouter = Router();

transcriptRouter.post('/api/transcript/import', (req, res) => {
  const body = (req.body ?? {}) as TranscriptImportBody;
  const raw = (body.transcriptText ?? '').trim();

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

  return res.json({
    importedLineCount: lines.length,
    lines,
  });
});
