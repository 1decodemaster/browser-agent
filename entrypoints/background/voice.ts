import { getSettings } from '@/shared/settings';
import { normalizeEndpoint } from '@/shared/endpoint';

const STT_TIMEOUT_MS = 60_000;

export interface TranscribeRequest {
  audioBase64: string;
  mimeType: string;
}

export async function transcribeAudio({
  audioBase64,
  mimeType,
}: TranscribeRequest): Promise<string> {
  const settings = await getSettings();
  if (!settings.sttEndpointUrl) {
    throw new Error('No STT endpoint configured - set it in the Options page (Voice section).');
  }
  const base = normalizeEndpoint(settings.sttEndpointUrl);
  const form = new FormData();
  form.append('file', new Blob([base64ToBytes(audioBase64)], { type: mimeType }), audioFileName(mimeType));
  form.append('model', settings.sttModel || 'whisper-1');
  const headers: Record<string, string> = {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `STT endpoint returned HTTP ${response.status}${detail ? ` - ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const payload = (await response.json()) as { text?: string };
  const text = (payload.text ?? '').trim();
  if (!text) throw new Error('STT endpoint returned no text');
  return text;
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function audioFileName(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'audio.mp4';
  return 'audio.webm';
}
