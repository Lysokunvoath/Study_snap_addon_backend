export type TranscriptEvent = {
  text: string;
  startMs: number;
  endMs: number;
};

export type StreamConfig = {
  language: string;
  sampleRate: number;
};

export type ProviderCallbacks = {
  onPartial: (event: TranscriptEvent) => void;
  onFinal: (event: TranscriptEvent) => void;
  onError: (error: Error) => void;
};

export interface TranscriptionProvider {
  startStream(config: StreamConfig): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  close(): Promise<void>;
}
