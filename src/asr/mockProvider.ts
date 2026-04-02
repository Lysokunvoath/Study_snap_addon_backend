import { ProviderCallbacks, StreamConfig, TranscriptionProvider, TranscriptEvent } from './types';

export class MockProvider implements TranscriptionProvider {
  private readonly callbacks: ProviderCallbacks;
  private startedAtMs: number | null = null;
  private chunkCounter = 0;
  private isClosed = false;
  private latestTranscript = '';

  constructor(callbacks: ProviderCallbacks) {
    this.callbacks = callbacks;
  }

  public async startStream(_config: StreamConfig): Promise<void> {
    this.startedAtMs = Date.now();
    this.isClosed = false;
  }

  public async sendAudio(chunk: Buffer): Promise<void> {
    if (this.isClosed || this.startedAtMs === null) {
      throw new Error('Mock stream is not active');
    }

    this.chunkCounter += 1;

    if (this.chunkCounter % 4 === 0) {
      const partial = this.buildTranscriptEvent(
        `listening (${this.chunkCounter} chunks, ${chunk.length} bytes latest)`
      );
      this.callbacks.onPartial(partial);
    }

    if (this.chunkCounter % 12 === 0) {
      const finalEvent = this.buildTranscriptEvent(
        `mock final transcript after ${this.chunkCounter} chunks`
      );

      if (finalEvent.text !== this.latestTranscript) {
        this.latestTranscript = finalEvent.text;
        this.callbacks.onFinal(finalEvent);
      }
    }
  }

  public async close(): Promise<void> {
    this.isClosed = true;
  }

  private buildTranscriptEvent(text: string): TranscriptEvent {
    const elapsed = this.startedAtMs ? Date.now() - this.startedAtMs : 0;
    return {
      text,
      startMs: Math.max(0, elapsed - 1200),
      endMs: Math.max(0, elapsed),
    };
  }
}