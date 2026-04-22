import { Router } from 'express';
import { google } from 'googleapis';
import { env } from '../config/env';
import { insertStudyArtifactRecord } from '../db/supabase';

type StudyGenerateBody = {
  transcriptText?: string;
  title?: string;
  flashcardCount?: number;
  botId?: string;
  userId?: string;
};

type StudyOutput = {
  title: string;
  summary: {
    tldr: string[];
    keyPoints: string[];
    actionItems: string[];
  };
  notes: Array<{
    heading: string;
    bullets: string[];
  }>;
  flashcards: Array<{
    question: string;
    answer: string;
    difficulty: 'easy' | 'medium' | 'hard';
    tags: string[];
  }>;
};

const FLASHCARD_MIN = 5;
const FLASHCARD_MAX = 30;

export const studyRouter = Router();

studyRouter.post('/api/study/generate', async (req, res) => {
  const body = (req.body ?? {}) as StudyGenerateBody;
  const transcriptText = (body.transcriptText ?? '').trim();

  if (!transcriptText) {
    return res.status(400).json({
      error: 'transcriptText is required.',
    });
  }

  if (!env.googleProjectId) {
    return res.status(400).json({
      error: 'GOOGLE_CLOUD_PROJECT_ID is required for Vertex AI.',
    });
  }

  const flashcardCount = Math.min(
    FLASHCARD_MAX,
    Math.max(FLASHCARD_MIN, Number(body.flashcardCount ?? 12) || 12)
  );

  try {
    const title = (body.title ?? 'Meeting Transcript').trim() || 'Meeting Transcript';
    const output = await generateStudyArtifacts({
      transcriptText,
      title,
      flashcardCount,
    });

    await insertStudyArtifactRecord({
      botId: (body.botId ?? '').trim() || null,
      userId: (body.userId ?? '').trim() || undefined,
      title,
      transcriptLength: transcriptText.length,
      summary: output.summary,
      notes: output.notes,
      flashcards: output.flashcards,
    });

    return res.json(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      error: `Study generation failed: ${message}`,
    });
  }
});

async function generateStudyArtifacts(input: {
  transcriptText: string;
  title: string;
  flashcardCount: number;
}): Promise<StudyOutput> {
  const accessToken = await getVertexAccessToken();
  const endpoint = `https://${env.vertexAiLocation}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(
    env.googleProjectId
  )}/locations/${encodeURIComponent(env.vertexAiLocation)}/publishers/google/models/${encodeURIComponent(
    env.vertexAiModel
  )}:generateContent`;

  const prompt = buildPrompt(input);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vertex AI request failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const raw = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (!raw.trim()) {
    throw new Error('Vertex AI returned empty content.');
  }

  return parseStudyOutput(raw);
}

async function getVertexAccessToken(): Promise<string> {
  const credentials = safeParseCredentials(env.googleCredentialsJson);

  const auth = new google.auth.GoogleAuth({
    credentials: credentials ?? undefined,
    projectId: env.googleProjectId || undefined,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;

  if (!token) {
    throw new Error('Failed to acquire Vertex AI access token.');
  }

  return token;
}

function safeParseCredentials(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS_JSON is not valid JSON.');
  }
}

function buildPrompt(input: { transcriptText: string; title: string; flashcardCount: number }): string {
  return [
    'You are an educational assistant.',
    `Use the transcript below to generate summary, structured notes, and exactly ${input.flashcardCount} study flashcards.`,
    'Return only valid JSON with this exact shape:',
    '{',
    '  "title": string,',
    '  "summary": { "tldr": string[], "keyPoints": string[], "actionItems": string[] },',
    '  "notes": [{ "heading": string, "bullets": string[] }],',
    '  "flashcards": [{ "question": string, "answer": string, "difficulty": "easy"|"medium"|"hard", "tags": string[] }]',
    '}',
    'Constraints:',
    '- Keep all facts grounded in transcript content only.',
    '- Make flashcards concise and testable.',
    '- Use plain language for students.',
    `- Title should be: ${input.title}`,
    '',
    'Transcript:',
    input.transcriptText.slice(0, 120_000),
  ].join('\n');
}

function parseStudyOutput(raw: string): StudyOutput {
  const normalized = raw.trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(normalized) as StudyOutput;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid study output format from model.');
  }

  return {
    title: String(parsed.title ?? 'Meeting Transcript'),
    summary: {
      tldr: Array.isArray(parsed.summary?.tldr)
        ? parsed.summary.tldr.map((item) => String(item)).filter(Boolean)
        : [],
      keyPoints: Array.isArray(parsed.summary?.keyPoints)
        ? parsed.summary.keyPoints.map((item) => String(item)).filter(Boolean)
        : [],
      actionItems: Array.isArray(parsed.summary?.actionItems)
        ? parsed.summary.actionItems.map((item) => String(item)).filter(Boolean)
        : [],
    },
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.map((note) => ({
          heading: String(note.heading ?? 'Untitled'),
          bullets: Array.isArray(note.bullets)
            ? note.bullets.map((bullet) => String(bullet)).filter(Boolean)
            : [],
        }))
      : [],
    flashcards: Array.isArray(parsed.flashcards)
      ? parsed.flashcards.map((card) => ({
          question: String(card.question ?? ''),
          answer: String(card.answer ?? ''),
          difficulty: toDifficulty(card.difficulty),
          tags: Array.isArray(card.tags) ? card.tags.map((tag) => String(tag)).filter(Boolean) : [],
        }))
      : [],
  };
}

function toDifficulty(value: unknown): 'easy' | 'medium' | 'hard' {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'easy' || normalized === 'hard') {
    return normalized;
  }

  return 'medium';
}
