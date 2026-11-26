import { browser } from 'wxt/browser';

interface CaptureOptions {
  format: 'jpeg';
  quality: number;
}

export async function capturePageScreenshot(tabId: number): Promise<string> {
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
