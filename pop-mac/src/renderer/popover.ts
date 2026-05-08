import type { PopApi } from '../main/preload';

declare global {
  interface Window {
    popApi: PopApi;
  }
}

const list = document.getElementById('list') as HTMLUListElement;
const empty = document.getElementById('empty') as HTMLDivElement;
const count = document.getElementById('count') as HTMLSpanElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings') as HTMLButtonElement;

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function render(): Promise<void> {
  const links = await window.popApi.getLinks();
  list.innerHTML = '';
  count.textContent = `${links.length} link${links.length === 1 ? '' : 's'}`;
  empty.classList.toggle('show', links.length === 0);

  for (const link of links) {
    const li = document.createElement('li');

    const favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.alt = '';
    if (link.hostname) {
      void window.popApi.getFavicon(link.hostname).then((src) => {
        if (src) favicon.src = src;
      });
    }

    const body = document.createElement('div');
    body.className = 'body';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = link.title || link.hostname || link.url;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const host = link.hostname ? `${link.hostname} · ` : '';
    meta.textContent = `${host}${relativeTime(link.receivedAt)}`;

    body.appendChild(title);
    body.appendChild(meta);

    const openBtn = document.createElement('button');
    openBtn.className = 'open-btn';
    openBtn.title = 'Open in browser';
    openBtn.textContent = '↗';
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void window.popApi.openExternal(link.url);
    });

    li.appendChild(favicon);
    li.appendChild(body);
    li.appendChild(openBtn);

    li.addEventListener('click', async () => {
      await window.popApi.copyToClipboard(link.url);
      li.classList.add('copied');
      title.textContent = 'Copied';
      setTimeout(() => {
        void window.popApi.removeLink(link.id);
      }, 220);
    });

    list.appendChild(li);
  }
}

clearBtn.addEventListener('click', async () => {
  await window.popApi.clearAll();
});

settingsBtn.addEventListener('click', () => {
  void window.popApi.openSettings();
});

window.popApi.onLinksUpdated(() => {
  void render();
});

void render();
