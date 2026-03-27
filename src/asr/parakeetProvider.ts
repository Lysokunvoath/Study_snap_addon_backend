import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  ProviderCallbacks,
  StreamConfig,
  TranscriptionProvider,
  TranscriptEvent,
} from './types';

export class ParakeetProvider implements TranscriptionProvider {
  private readonly callbacks: ProviderCallbacks;
  private startedAtMs: number | null = null;
  private chunkCounter = 0;
  private isClosed = false;
  private language = env.parakeetLanguage;
  private sampleRate = env.parakeetSampleRate;
  private pcmChunks: Buffer[] = [];
  private lastInferenceAtMs = 0;
  private inferenceInFlight = false;
  private latestTranscript = '';

  constructor(callbacks: ProviderCallbacks) {
    this.callbacks = callbacks;
  }

  public async startStream(config: StreamConfig): Promise<void> {
    if (!fs.existsSync(env.parakeetModelPath)) {
      throw new Error(`Parakeet model not found at ${env.parakeetModelPath}`);
    }

    if (!env.parakeetMockMode && !fs.existsSync(env.parakeetInferScriptPath)) {
      throw new Error(`Parakeet infer script not found at ${env.parakeetInferScriptPath}`);
    }

    this.startedAtMs = Date.now();
    this.language = config.language;
    this.sampleRate = config.sampleRate;
    logger.info('Parakeet stream started', {
      modelPath: env.parakeetModelPath,
      language: this.language,
      sampleRate: this.sampleRate,
      mockMode: env.parakeetMockMode,
    });
  }

  public async sendAudio(chunk: Buffer): Promise<void> {
    if (this.isClosed || this.startedAtMs === null) {
      throw new Error('Parakeet stream is not active');
    }

    this.chunkCounter += 1;

    // Mock transcript progression so websocket/frontend wiring can be validated safely.
    if (this.chunkCounter % 4 === 0) {
      const elapsed = Date.now() - this.startedAtMs;
      const partial: TranscriptEvent = {
        text: `listening (${this.chunkCounter} chunks, ${chunk.length} bytes latest)`,
        startMs: Math.max(0, elapsed - 1200),
        endMs: elapsed,
      };
      this.callbacks.onPartial(partial);
    }

    if (this.chunkCounter % 12 === 0) {
      const elapsed = Date.now() - this.startedAtMs;
      const finalEvent: TranscriptEvent = {
        text: `mock final transcript after ${this.chunkCounter} chunks`,
        startMs: Math.max(0, elapsed - 2200),
        endMs: elapsed,
      };
      this.callbacks.onFinal(finalEvent);
    }

    if (env.parakeetMockMode) {
      return;
    }

    this.pcmChunks.push(chunk);
    this.trimPcmBufferIfNeeded();

    const now = Date.now();
    if (
      !this.inferenceInFlight &&
      now - this.lastInferenceAtMs >= env.parakeetInferIntervalMs
    ) {
      this.lastInferenceAtMs = now;
      await this.runInference(false);
    }
  }

  public async close(): Promise<void> {
    if (!env.parakeetMockMode && this.pcmChunks.length > 0) {
      await this.runInference(true);
    }

    this.isClosed = true;
    logger.info('Parakeet stream closed');
  }

  private trimPcmBufferIfNeeded(): void {
    const maxBytes = Math.max(
      1,
      env.parakeetMaxBufferedSeconds * this.sampleRate * 2 // 16-bit mono PCM
    );

    let currentBytes = this.getBufferedByteCount();
    while (currentBytes > maxBytes && this.pcmChunks.length > 1) {
      const removed = this.pcmChunks.shift();
      currentBytes -= removed?.byteLength ?? 0;
    }
  }

  private getBufferedByteCount(): number {
    return this.pcmChunks.reduce((acc, item) => acc + item.byteLength, 0);
  }

  private async runInference(isFinal: boolean): Promise<void> {
    if (this.inferenceInFlight) {
      return;
    }

    this.inferenceInFlight = true;

    try {
      const pcm = Buffer.concat(this.pcmChunks);
      if (pcm.byteLength === 0) {
        return;
      }

      const wavBuffer = pcm16ToWav(pcm, this.sampleRate);
      const tempWavPath = path.join(
        os.tmpdir(),
        `study-snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`
      );

      await fs.promises.writeFile(tempWavPath, wavBuffer);

      try {
        const transcript = await runParakeetScript({
          wavPath: tempWavPath,
          language: this.language,
        });

        if (!transcript || transcript === this.latestTranscript) {
          return;
        }

        this.latestTranscript = transcript;
        const event = this.buildTranscriptEvent(transcript);

        if (isFinal) {
          this.callbacks.onFinal(event);
        } else {
          this.callbacks.onPartial(event);
        }
      } finally {
        await fs.promises.unlink(tempWavPath).catch(() => {
          // No-op cleanup fallback.
        });
      }
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? error : new Error('Unknown Parakeet runtime error')
      );
    } finally {
      this.inferenceInFlight = false;
    }
  }

  private buildTranscriptEvent(text: string): TranscriptEvent {
    const elapsed = this.startedAtMs ? Date.now() - this.startedAtMs : 0;
    return {
      text,
      startMs: 0,
      endMs: Math.max(elapsed, 0),
    };
  }
}

function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const wavHeader = Buffer.alloc(44);

  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + pcm.length, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(channels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([wavHeader, pcm]);
}

function runParakeetScript(params: {
  wavPath: string;
  language: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      env.parakeetPythonCommand,
      [
        env.parakeetInferScriptPath,
        '--model',
        env.parakeetModelPath,
        '--wav',
        params.wavPath,
        '--language',
        params.language,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `Parakeet inference timed out after ${env.parakeetInferenceTimeoutMs}ms`
        )
      );
    }, env.parakeetInferenceTimeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`Parakeet python process failed (${code}): ${stderr || stdout}`));
        return;
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const lastLine = lines[lines.length - 1];

      if (!lastLine) {
        reject(new Error('Parakeet python process returned empty output'));
        return;
      }

      try {
        const parsed = JSON.parse(lastLine) as { text?: string; error?: string };

        if (parsed.error) {
          reject(new Error(parsed.error));
          return;
        }

        resolve((parsed.text ?? '').trim());
      } catch (error) {
        reject(
          new Error(
            `Parakeet python output parse error: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
    });
  });
}
