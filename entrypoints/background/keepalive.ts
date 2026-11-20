import { browser } from 'wxt/browser';

let refCount = 0;
let timer: number | undefined;

function tick(): void {
  void browser.runtime.getPlatformInfo();
}

export function acquireKeepalive(): void {
  refCount++;
  if (timer === undefined) {
    timer = setInterval(tick, 20_000);
  }
}

export function releaseKeepalive(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
