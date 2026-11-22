import { getSettings } from '@/shared/settings';
import { normalizeEndpoint } from '@/shared/endpoint';
import type { SpeakResult } from '@/shared/types';

const STT_TIMEOUT_MS = 60_000;
const TTS_TIMEOUT_MS = 60_000;

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
  const response = await fetch(`${base}/v1/audio/transcriptions`, {
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

export async function synthesizeSpeech({ text }: { text: string }): Promise<SpeakResult> {
  const settings = await getSettings();
  if (!settings.ttsEndpointUrl) {
    throw new Error('No TTS endpoint configured - set it in the Options page (Voice section).');
  }
  const base = normalizeEndpoint(settings.ttsEndpointUrl);
  const body: Record<string, unknown> = {
    model: settings.ttsModel?.trim() || 'kokoro',
    input: text,
    response_format: 'mp3',
  };
  const voice = settings.ttsVoice?.trim();
  if (voice) body.voice = voice;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const response = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `TTS endpoint returned HTTP ${response.status}${detail ? ` - ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg';
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { audioBase64: bytesToBase64(bytes), mimeType };
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function audioFileName(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'audio.mp4';
  return 'audio.webm';
}
