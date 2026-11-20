import { browser } from 'wxt/browser';
import { onRpc, type RpcSender } from '@/shared/rpc';
import { getHistory, watchChatPorts } from './chat';

export default defineBackground(() => {
  watchChatPorts();

  onRpc(async (request, sender) => {
    switch (request.kind) {
      case 'chat:history':
        return getHistory(requireTab(sender));
      case 'screenshot:capture':
        return { dataUrl: await captureScreenshot(requireTab(sender)) };
      case 'panel:toggle':
        return true;
      default: {
        const unreachable: never = request;
        throw new Error(`Unhandled request: ${JSON.stringify(unreachable)}`);
      }
    }
  });

  browser.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-panel') return;
    void togglePanelOnActiveTab();
  });
});

function requireTab(sender: RpcSender): number {
  const tabId = sender.tab?.id;
  if (tabId == null) throw new Error('Request did not come from a tab');
  return tabId;
}

interface CaptureOptions {
  format: 'jpeg';
  quality: number;
}

async function captureScreenshot(tabId: number): Promise<string> {
  const tab = await browser.tabs.get(tabId);
  const options: CaptureOptions = { format: 'jpeg', quality: 70 };
  const firefoxTabs = browser.tabs as unknown as {
    captureTab?: (tabId: number, options: CaptureOptions) => Promise<string>;
  };
  if (typeof firefoxTabs.captureTab === 'function') {
    return firefoxTabs.captureTab(tabId, options);
  }
  return browser.tabs.captureVisibleTab(tab.windowId, options);
}

async function togglePanelOnActiveTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id == null) return;
  try {
    await browser.tabs.sendMessage(tab.id, { __rpc: true, request: { kind: 'panel:toggle' } });
  } catch (error) {
    console.debug('[browser-agent] no content script to receive toggle:', error);
  }
}
