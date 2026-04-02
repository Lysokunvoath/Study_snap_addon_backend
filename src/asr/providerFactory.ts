import { env } from '../config/env';
import { MockProvider } from './mockProvider';
import { GoogleCloudSpeechProvider } from './googleCloudSpeechProvider';
import { ProviderCallbacks, TranscriptionProvider } from './types';

export function createTranscriptionProvider(
  callbacks: ProviderCallbacks
): TranscriptionProvider {
  if (env.asrProvider === 'google-cloud') {
    return new GoogleCloudSpeechProvider(callbacks);
  }

  return new MockProvider(callbacks);
}
