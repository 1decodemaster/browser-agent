import { onRpc } from '@/shared/rpc';
import { getSettings } from '@/shared/settings';
import { mountUi, prefillInput, togglePanel } from './panel';
import { configureAct, mountAct } from './act/act';
import styles from './panel.css?inline';
import actStyles from './act/act.css?inline';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  async main() {
    const settings = await getSettings();
    if (settings.sites[location.origin] === false) return;

    mountUi(styles);
    mountAct(actStyles);
    configureAct({ onAsk: prefillInput });

    onRpc(async (request) => {
      if (request.kind !== 'panel:toggle') {
        throw new Error(`Content script does not handle ${request.kind}`);
      }
      togglePanel();
      return true;
    });
  },
});
