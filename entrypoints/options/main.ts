import { getSettings, saveSettings } from '@/shared/settings';
import { normalizeEndpoint } from '@/shared/endpoint';
import type { Settings } from '@/shared/types';

const endpointInput = document.getElementById('endpointUrl') as HTMLInputElement;
const modelInput = document.getElementById('model') as HTMLInputElement;
const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
const actEndpointInput = document.getElementById('actEndpointUrl') as HTMLInputElement;
const actModelInput = document.getElementById('actModel') as HTMLInputElement;
const actEffortSelect = document.getElementById('actReasoningEffort') as HTMLSelectElement;
const actExtraInput = document.getElementById('actExtraInstructions') as HTMLTextAreaElement;
const sttEndpointInput = document.getElementById('sttEndpointUrl') as HTMLInputElement;
const sttModelInput = document.getElementById('sttModel') as HTMLInputElement;
const ttsAutoReadInput = document.getElementById('ttsAutoRead') as HTMLInputElement;
const firstTokenTimeoutInput = document.getElementById('llmFirstTokenTimeoutMs') as HTMLInputElement;
const totalTimeoutInput = document.getElementById('llmTotalTimeoutMs') as HTMLInputElement;
const workingMemoryInput = document.getElementById('agentWorkingMemory') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;
const testButton = document.getElementById('test') as HTMLButtonElement;
const form = document.getElementById('form') as HTMLFormElement;

void load();

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void save().then(() => setStatus('Saved.', 'ok'));
});

const actForm = document.getElementById('actForm') as HTMLFormElement;
actForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void save().then(() => setStatus('Saved.', 'ok'));
});

const voiceForm = document.getElementById('voiceForm') as HTMLFormElement;
voiceForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void save().then(() => setStatus('Saved.', 'ok'));
});

testButton.addEventListener('click', () => void testConnection());

async function load(): Promise<void> {
  const settings = await getSettings();
  endpointInput.value = settings.endpointUrl;
  modelInput.value = settings.model;
  apiKeyInput.value = settings.apiKey;
  actEndpointInput.value = settings.actEndpointUrl ?? '';
  actModelInput.value = settings.actModel ?? '';
  actEffortSelect.value = settings.actReasoningEffort ?? '';
  actExtraInput.value = settings.actExtraInstructions ?? '';
  sttEndpointInput.value = settings.sttEndpointUrl ?? '';
  sttModelInput.value = settings.sttModel ?? '';
  ttsAutoReadInput.checked = settings.ttsAutoRead === true;
  firstTokenTimeoutInput.value =
    settings.llmFirstTokenTimeoutMs != null ? String(settings.llmFirstTokenTimeoutMs) : '';
  totalTimeoutInput.value =
    settings.llmTotalTimeoutMs != null ? String(settings.llmTotalTimeoutMs) : '';
  workingMemoryInput.checked = settings.agentWorkingMemory === true;
}

async function collect(): Promise<Settings> {
  const stored = await getSettings();
  return {
    ...stored,
    endpointUrl: endpointInput.value.trim() || 'http://localhost:11434',
    model: modelInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    sites: stored.sites,
    actEndpointUrl: actEndpointInput.value.trim(),
    actModel: actModelInput.value.trim(),
    actReasoningEffort: actEffortSelect.value,
    actExtraInstructions: actExtraInput.value,
    sttEndpointUrl: sttEndpointInput.value.trim(),
    sttModel: sttModelInput.value.trim(),
    ttsAutoRead: ttsAutoReadInput.checked,
    llmFirstTokenTimeoutMs: parseTimeout(firstTokenTimeoutInput.value),
    llmTotalTimeoutMs: parseTimeout(totalTimeoutInput.value),
    agentWorkingMemory: workingMemoryInput.checked,
  };
}

function parseTimeout(raw: string): number | undefined {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= 1000 ? value : undefined;
}

async function save(): Promise<void> {
  await saveSettings(await collect());
}

function setStatus(message: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
}

async function testConnection(): Promise<void> {
  const settings = await collect();
  await saveSettings(settings);
  const base = normalizeEndpoint(settings.endpointUrl);
  setStatus(`Testing ${base} …`);
  try {
    const headers: Record<string, string> = {};
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const response = await fetch(`${base}/v1/models`, { headers });
    if (!response.ok) {
      setStatus(
        `HTTP ${response.status} ${response.statusText} - server reachable, but the request was rejected.`,
        'err',
      );
      return;
    }
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = Array.isArray(payload.data) ? payload.data : [];
    const names = models
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      .slice(0, 5)
      .join(', ');
    setStatus(
      `Connected. ${models.length} model(s)${names ? `: ${names}` : ''}${models.length > 5 ? ' …' : ''}`,
      'ok',
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setStatus(
      `Could not reach ${base} (${reason}). Check the server is running and that it allows this extension's origin - for Ollama set OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*"; in LM Studio enable CORS.`,
      'err',
    );
  }
}
