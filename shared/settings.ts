import { storage } from 'wxt/utils/storage';
import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  endpointUrl: 'http://localhost:11434',
  model: 'llama3.2',
  apiKey: '',
  sites: {},
  actEndpointUrl: '',
  actModel: '',
  actReasoningEffort: '',
  actExtraInstructions: '',
  actVision: false,
  actMaxTurns: 15,
  sttEndpointUrl: '',
  sttModel: '',
  ttsAutoRead: false,
};

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export function getSettings(): Promise<Settings> {
  return settingsItem.getValue();
}

export function saveSettings(settings: Settings): Promise<void> {
  return settingsItem.setValue(settings);
}
