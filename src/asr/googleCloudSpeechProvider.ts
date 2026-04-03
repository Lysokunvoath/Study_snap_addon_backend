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
  private streamWritable = false;
  private streamConfigSent = false;
  private client: speech.SpeechClient | null = null;
  private recognizeStream: StreamingRecognizeStream | null = null;

  constructor(callbacks: ProviderCallbacks) {
    this.callbacks = callbacks;
  }

  public async startStream(config: StreamConfig): Promise<void> {
    this.startedAtMs = Date.now();
    this.isClosed = false;
    this.streamWritable = true;
    this.streamConfigSent = false;

    this.client = buildSpeechClient();

    this.recognizeStream = this.client
      .streamingRecognize()
      .on('error', (error: Error) => {
        this.streamWritable = false;
        this.callbacks.onError(error);
      })
      .on('close', () => {
        this.streamWritable = false;
      })
      .on('end', () => {
        this.streamWritable = false;
      })
      .on('data', (data: unknown) => {
        this.handleRecognitionData(data);
      });

    this.recognizeStream.write({
      streamingConfig: {
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
      },
    });
    this.streamConfigSent = true;

    logger.info('Google Cloud Speech stream started', {
      language: config.language,
      sampleRate: config.sampleRate,
      model: env.googleSpeechModel,
      provider: env.asrProvider,
    });
  }

  public async sendAudio(chunk: Buffer): Promise<void> {
    if (this.isClosed || this.startedAtMs === null || !this.recognizeStream) {
      return;
    }

    if (!this.streamWritable || !canWriteToStream(this.recognizeStream)) {
      return;
    }

    if (!this.streamConfigSent) {
      return;
    }

    this.chunkCounter += 1;

    try {
      this.recognizeStream.write({ audioContent: chunk });
    } catch {
      this.streamWritable = false;
    }
  }

  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.streamWritable = false;

    if (this.recognizeStream) {
      try {
        this.recognizeStream.end();
      } catch {
        // Ignore shutdown races for already-destroyed streams.
      }

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

function canWriteToStream(stream: StreamingRecognizeStream): boolean {
  const candidate = stream as unknown as {
    destroyed?: boolean;
    writable?: boolean;
    writableEnded?: boolean;
    writableFinished?: boolean;
  };

  if (candidate.destroyed) {
    return false;
  }

  if (candidate.writableEnded || candidate.writableFinished) {
    return false;
  }

  if (candidate.writable === false) {
    return false;
  }

  return true;
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
