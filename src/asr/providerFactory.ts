import { ParakeetProvider } from './parakeetProvider';
import { ProviderCallbacks, TranscriptionProvider } from './types';

export function createTranscriptionProvider(
  callbacks: ProviderCallbacks
): TranscriptionProvider {
  return new ParakeetProvider(callbacks);
}
