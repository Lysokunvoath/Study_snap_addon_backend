import { v1 as speech } from '@google-cloud/speech';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  ProviderCallbacks,
  StreamConfig,
  TranscriptionProvider,
  TranscriptEvent,
} from './types';

type StreamingRecognizeStream = ReturnType<speech.SpeechClient['streamingRecognize']>;

export class GoogleCloudSpeechProvider implements TranscriptionProvider {
  private readonly callbacks: ProviderCallbacks;
  private startedAtMs: number | null = null;
  private isClosed = false;
  private chunkCounter = 0;
  private latestPartial = '';
  private client: speech.SpeechClient | null = null;
  private recognizeStream: StreamingRecognizeStream | null = null;

  constructor(callbacks: ProviderCallbacks) {
    this.callbacks = callbacks;
  }

  public async startStream(config: StreamConfig): Promise<void> {
    this.startedAtMs = Date.now();
    this.isClosed = false;

    this.client = buildSpeechClient();

    this.recognizeStream = this.client
      .streamingRecognize({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: config.sampleRate,
          languageCode: mapLanguageCode(config.language),
          model: env.googleSpeechModel,
          useEnhanced: false,
          enableAutomaticPunctuation: true,
        },
        interimResults: true,
        singleUtterance: false,
      })
      .on('error', (error: Error) => {
        this.callbacks.onError(error);
      })
      .on('data', (data: unknown) => {
        this.handleRecognitionData(data);
      });

    logger.info('Google Cloud Speech stream started', {
      language: config.language,
      sampleRate: config.sampleRate,
      model: env.googleSpeechModel,
      provider: env.asrProvider,
    });
  }

  public async sendAudio(chunk: Buffer): Promise<void> {
    if (this.isClosed || this.startedAtMs === null || !this.recognizeStream) {
      throw new Error('Google Cloud Speech stream is not active');
    }

    this.chunkCounter += 1;
    this.recognizeStream.write({ audioContent: chunk });
  }

  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;

    if (this.recognizeStream) {
      this.recognizeStream.end();
      this.recognizeStream.removeAllListeners();
      this.recognizeStream = null;
    }

    this.client = null;
    logger.info('Google Cloud Speech stream closed', { chunkCount: this.chunkCounter });
  }

  private handleRecognitionData(data: unknown): void {
    const response = data as {
      results?: Array<{
        isFinal?: boolean | null;
        alternatives?: Array<{ transcript?: string | null }>;
      }>;
    };
    const result = response.results?.[0];
    const alternative = result?.alternatives?.[0];
    const text = (alternative?.transcript ?? '').trim();

    if (!text) {
      return;
    }

    const event = this.buildTranscriptEvent(text);

    if (result?.isFinal) {
      this.latestPartial = '';
      this.callbacks.onFinal(event);
      return;
    }

    if (text !== this.latestPartial) {
      this.latestPartial = text;
      this.callbacks.onPartial(event);
    }
  }

  private buildTranscriptEvent(text: string): TranscriptEvent {
    const elapsed = this.startedAtMs ? Date.now() - this.startedAtMs : 0;
    return {
      text,
      startMs: Math.max(0, elapsed - 1500),
      endMs: Math.max(0, elapsed),
    };
  }
}

function buildSpeechClient(): speech.SpeechClient {
  if (!env.googleCredentialsJson) {
    return new speech.SpeechClient();
  }

  const credentials = JSON.parse(env.googleCredentialsJson) as {
    client_email: string;
    private_key: string;
  };

  return new speech.SpeechClient({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
    projectId: env.googleProjectId || undefined,
  });
}

function mapLanguageCode(language: string): string {
  const normalized = language.trim();
  if (!normalized) {
    return 'en-US';
  }

  if (normalized.length === 2) {
    return `${normalized.toLowerCase()}-${normalized.toUpperCase()}`;
  }

  return normalized;
}
