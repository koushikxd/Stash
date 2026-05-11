type StashoverApi = {
  getLinks: () => Promise<Array<{ id: string; url: string; title: string | null; hostname: string; receivedAt: number }>>;
  removeLink: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getFavicon: (hostname: string) => Promise<string | null>;
  onLinksUpdated: (cb: () => void) => void;
  openSettings: () => Promise<void>;
};

const stashoverApi = (window as unknown as { stashApi: StashoverApi }).stashApi;

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
  let links: Awaited<ReturnType<StashoverApi['getLinks']>>;
  try {
    links = await stashoverApi.getLinks();
  } catch {
    setTimeout(() => void render(), 300);
    return;
  }
  list.innerHTML = '';
  count.textContent = `${links.length} link${links.length === 1 ? '' : 's'}`;
  empty.classList.toggle('show', links.length === 0);

  for (const link of links) {
    const li = document.createElement('li');

    const favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.alt = '';
    if (link.hostname) {
      void stashoverApi.getFavicon(link.hostname).then((src) => {
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
      void stashoverApi.openExternal(link.url);
    });

    li.appendChild(favicon);
    li.appendChild(body);
    li.appendChild(openBtn);

    li.addEventListener('click', async () => {
      await stashoverApi.copyToClipboard(link.url);
      li.classList.add('copied');
      title.textContent = 'Copied';
      setTimeout(() => {
        void stashoverApi.removeLink(link.id);
      }, 220);
    });

    list.appendChild(li);
  }
}

clearBtn.addEventListener('click', async () => {
  await stashoverApi.clearAll();
});

settingsBtn.addEventListener('click', () => {
  void stashoverApi.openSettings();
});

stashoverApi.onLinksUpdated(() => {
  void render();
});

void render();
