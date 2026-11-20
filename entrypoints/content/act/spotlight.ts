const HOST_ID = 'browser-agent-act-root';

export type HighlightColor = 'focus' | 'success' | 'error' | 'scan';

export interface ActionItem {
  label: string;
  onClick: () => void;
}

export interface Spotlight {
  setActive(active: boolean): void;
  highlight(rect: DOMRect, color: HighlightColor, pulsing?: boolean): void;
  hideHighlight(): void;
  setLabel(text: string | null, rect?: DOMRect): void;
  setBanner(text: string | null): void;
  showActionBar(rect: DOMRect, actions: ActionItem[]): void;
  showFillBar(rect: DOMRect, onSubmit: (value: string) => void, onCancel: () => void): void;
  confirmBar(rect: DOMRect, text: string): Promise<boolean>;
  hideBar(): void;
}

export function mountSpotlight(css: string): Spotlight {
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = css;

  const root = document.createElement('div');
  root.className = 'baa-root';

  const highlight = document.createElement('div');
  highlight.className = 'baa-highlight';

  const label = document.createElement('div');
  label.className = 'baa-label';

  const bar = document.createElement('div');
  bar.className = 'baa-bar';

  const banner = document.createElement('div');
  banner.className = 'baa-banner';

  root.append(highlight, label, bar, banner);
  shadow.append(style, root);
  (document.body ?? document.documentElement).append(host);

  let barVisible = false;

  return {
    setActive(active) {
      root.classList.toggle('baa-active', active);
      if (!active) {
        barVisible = false;
        highlight.className = 'baa-highlight';
        highlight.style.display = 'none';
        label.style.display = 'none';
        bar.replaceChildren();
        banner.textContent = '';
      }
    },

    setBanner(text) {
      banner.textContent = text ?? '';
    },

    highlight(rect, color, pulsing = false) {
      highlight.className = `baa-highlight baa-${color}${pulsing ? ' baa-pulse' : ''}`;
      highlight.style.display = 'block';
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
    },

    hideHighlight() {
      highlight.style.display = 'none';
    },

    setLabel(text, rect) {
      if (!text || !rect) {
        label.style.display = 'none';
        return;
      }
      label.style.display = 'block';
      label.textContent = text;
      const above = rect.top > 34;
      label.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 340))}px`;
      label.style.top = above ? `${rect.top - 26}px` : `${rect.bottom + 6}px`;
    },

    showActionBar(rect, actions) {
      barVisible = true;
      bar.replaceChildren();
      bar.classList.remove('baa-fill');
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          action.onClick();
        });
        bar.append(button);
      }
      positionBar(rect);
    },

    showFillBar(rect, onSubmit, onCancel) {
      barVisible = true;
      bar.replaceChildren();
      bar.classList.add('baa-fill');
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Value to set…';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.textContent = 'Apply';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      apply.addEventListener('click', (event) => {
        event.stopPropagation();
        onSubmit(input.value);
      });
      cancel.addEventListener('click', (event) => {
        event.stopPropagation();
        onCancel();
      });
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') onSubmit(input.value);
        if (event.key === 'Escape') onCancel();
      });
      bar.append(input, apply, cancel);
      positionBar(rect);
      input.focus();
    },

    hideBar() {
      barVisible = false;
      bar.replaceChildren();
    },

    confirmBar(rect, text) {
      return new Promise<boolean>((resolve) => {
        barVisible = true;
        bar.replaceChildren();
        bar.classList.remove('baa-fill');
        bar.classList.add('baa-confirm');
        const message = document.createElement('span');
        message.className = 'baa-confirm-text';
        message.textContent = text;
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'baa-danger';
        confirm.textContent = 'Confirm';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        const finish = (value: boolean) => {
          bar.classList.remove('baa-confirm');
          bar.replaceChildren();
          resolve(value);
        };
        confirm.addEventListener('click', (event) => {
          event.stopPropagation();
          finish(true);
        });
        cancel.addEventListener('click', (event) => {
          event.stopPropagation();
          finish(false);
        });
        bar.append(message, confirm, cancel);
        positionBar(rect);
      });
    },
  };

  function positionBar(rect: DOMRect): void {
    if (!barVisible) return;
    bar.style.visibility = 'hidden';
    bar.style.display = 'flex';
    const barRect = bar.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const below = rect.bottom + barRect.height + 12 < viewportHeight;
    const top = below ? rect.bottom + 6 : rect.top - barRect.height - 6;
    const left = Math.max(
      6,
      Math.min(rect.left, window.innerWidth - barRect.width - 6),
    );
    bar.style.left = `${left}px`;
    bar.style.top = `${Math.max(6, top)}px`;
    bar.style.visibility = 'visible';
  }
}
