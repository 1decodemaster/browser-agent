import { onRpc } from '@/shared/rpc';
import { getSettings } from '@/shared/settings';
import { mountUi, prefillInput, togglePanel } from './panel';
import { configureAct, executeActions, mountAct, serializeIndex } from './act/act';
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
      switch (request.kind) {
        case 'panel:toggle':
          togglePanel();
          return true;
        case 'act:observe':
          return { index: serializeIndex() ?? '', url: location.href, title: document.title };
        case 'act:execute':
          return executeActions(request.actions, request.confirmMode);
        default:
          throw new Error(`Content script does not handle ${request.kind}`);
      }
    });
  },
});
