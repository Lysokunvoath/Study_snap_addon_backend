import { env } from '../config/env';
import { MockProvider } from './mockProvider';
import { ProviderCallbacks, TranscriptionProvider } from './types';

export function createTranscriptionProvider(
  callbacks: ProviderCallbacks
): TranscriptionProvider {
  void env;

  return new MockProvider(callbacks);
}
