import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'Browser Agent',
    description: 'Chat with a local LLM about the page you are on.',
    permissions: ['storage', 'tabs', 'activeTab', 'scripting', 'commands'],
    host_permissions: ['<all_urls>'],
    browser_specific_settings: {
      gecko: {
        id: 'browser-agent@example.com',
        strict_min_version: '128.0',
      },
    },
    commands: {
      'toggle-panel': {
        suggested_key: { default: 'Alt+Shift+B', mac: 'MacCtrl+Shift+B' },
        description: 'Toggle the Browser Agent panel',
      },
    },
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      if (_wxt.config.browser === 'chrome') delete manifest.browser_specific_settings;
    },
  },
});
