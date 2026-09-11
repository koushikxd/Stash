type Item = {
  id: string;
  kind: 'link' | 'text';
  text: string;
  url: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  hostname: string;
  receivedAt: number;
};

type StashoverApi = {
  getLinks: () => Promise<Item[]>;
  removeLink: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  getReading: () => Promise<Item[]>;
  addReadingFromClipboard: () => Promise<{ added: boolean; text?: string }>;
  addReading: (text: string) => Promise<void>;
  updateReading: (id: string, text: string) => Promise<void>;
  removeReading: (id: string) => Promise<void>;
  clearReading: () => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getFavicon: (hostname: string) => Promise<string | null>;
  onLinksUpdated: (cb: () => void) => void;
  onReadingUpdated: (cb: () => void) => void;
  openSettings: () => Promise<void>;
};

const stashoverApi = (window as unknown as { stashApi: StashoverApi }).stashApi;

const list = document.getElementById('list') as HTMLUListElement;
const empty = document.getElementById('empty') as HTMLDivElement;
const emptyTitle = empty.querySelector('.empty-title') as HTMLDivElement;
const emptySub = empty.querySelector('.empty-sub') as HTMLDivElement;
const count = document.getElementById('count') as HTMLSpanElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings') as HTMLButtonElement;
const addBtn = document.getElementById('add') as HTMLButtonElement;
const tabBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
const confirmBar = document.getElementById('confirm') as HTMLDivElement;
const confirmTextEl = document.getElementById('confirmText') as HTMLSpanElement;
const confirmCancelBtn = document.getElementById('confirmCancel') as HTMLButtonElement;
const confirmOkBtn = document.getElementById('confirmOk') as HTMLButtonElement;

/** In memory only: the popover is preloaded, so it survives open and close. */
let activeTab: 'inbox' | 'reading' = 'inbox';
/** True while an inline input is open. render() is destructive, so it must stand down. */
let editing = false;
let currentCount = 0;
/** Discriminates overlapping render() passes so only the newest one writes the DOM. */
let renderToken = 0;

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSvg(paths: Array<{ d?: string; circle?: { cx: number; cy: number; r: number } }>, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const item of paths) {
    if (item.d) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', item.d);
      svg.appendChild(p);
    } else if (item.circle) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(item.circle.cx));
      c.setAttribute('cy', String(item.circle.cy));
      c.setAttribute('r', String(item.circle.r));
      svg.appendChild(c);
    }
  }
  return svg;
}

function arrowUpRightIcon(): SVGSVGElement {
  return makeSvg([{ d: 'M7 17 17 7' }, { d: 'M8 7h9v9' }], 14);
}

function checkIcon(): SVGSVGElement {
  return makeSvg([{ d: 'M20 6 9 17l-5-5' }], 16);
}

function textIcon(): SVGSVGElement {
  return makeSvg([{ d: 'M4 7h16' }, { d: 'M4 12h12' }, { d: 'M4 17h9' }], 15);
}

function pencilIcon(): SVGSVGElement {
  return makeSvg([{ d: 'M12 20h9' }, { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }], 14);
}

function trashIcon(): SVGSVGElement {
  return makeSvg([{ d: 'M3 6h18' }, { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }, { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }], 14);
}

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

function cardButton(icon: SVGSVGElement, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'card-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.appendChild(icon);
  return btn;
}

function renderCard(
  item: Item,
  opts: {
    onClick: (li: HTMLLIElement, wrap: HTMLDivElement) => void;
    extraActions?: HTMLButtonElement[];
  },
): HTMLLIElement {
  const li = document.createElement('li');

  const faviconWrap = document.createElement('div');
  faviconWrap.className = 'favicon-wrap';

  if (item.image) {
    const preview = document.createElement('img');
    preview.className = 'preview-image';
    preview.alt = '';
    preview.src = item.image;
    faviconWrap.appendChild(preview);
  } else if (item.url) {
    const favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.alt = '';
    if (item.hostname) {
      void stashoverApi.getFavicon(item.hostname).then((src) => {
        if (src) favicon.src = src;
      });
    }
    faviconWrap.appendChild(favicon);
  } else {
    faviconWrap.classList.add('text-wrap');
    faviconWrap.appendChild(textIcon());
  }

  const body = document.createElement('div');
  body.className = 'body';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.title || (item.url ? item.hostname || item.url : item.text);

  const summary = document.createElement('div');
  summary.className = 'summary';
  summary.textContent = item.description || (item.url ? item.text : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const source = item.siteName || item.hostname || (item.url ? '' : 'Text');
  const host = source ? `${source} · ` : '';
  meta.textContent = `${host}${relativeTime(item.receivedAt)}`;

  body.appendChild(title);
  if (summary.textContent) body.appendChild(summary);
  body.appendChild(meta);

  const openBtn = document.createElement('button');
  openBtn.className = 'open-btn';
  openBtn.title = 'Open in browser';
  openBtn.setAttribute('aria-label', 'Open in browser');
  openBtn.appendChild(arrowUpRightIcon());
  openBtn.hidden = !item.url;
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (item.url) void stashoverApi.openExternal(item.url);
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.appendChild(openBtn);
  for (const btn of opts.extraActions ?? []) actions.appendChild(btn);

  li.appendChild(faviconWrap);
  li.appendChild(body);
  li.appendChild(actions);

  li.addEventListener('click', () => opts.onClick(li, faviconWrap));

  return li;
}

/** Enter submits a non-empty value; Escape and blur cancel. */
function inputRow(initial: string, placeholder: string, onSubmit: (value: string) => void): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'input-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial;
  input.placeholder = placeholder;
  li.appendChild(input);

  editing = true;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    editing = false;
    void render();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const value = input.value.trim();
      if (!value) return;
      closed = true;
      editing = false;
      onSubmit(value);
      void render();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', close);

  return li;
}

function focusRow(row: HTMLLIElement): void {
  const input = row.querySelector('input') as HTMLInputElement;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function hideConfirm(): void {
  confirmBar.hidden = true;
}

function readingCard(item: Item): HTMLLIElement {
  const editBtn = cardButton(pencilIcon(), 'Edit');
  const deleteBtn = cardButton(trashIcon(), 'Delete');

  const card = renderCard(item, {
    extraActions: [editBtn, deleteBtn],
    onClick: (li, wrap) => {
      // Copying a reading item does not consume it, unlike an inbox link.
      if (li.classList.contains('copied')) return;
      const original = Array.from(wrap.childNodes);
      void stashoverApi.copyToClipboard(item.url || item.text).then(() => {
        li.classList.add('copied');
        wrap.replaceChildren(checkIcon());
        setTimeout(() => {
          wrap.replaceChildren(...original);
          li.classList.remove('copied');
        }, 700);
      });
    },
  });

  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = inputRow(item.url || item.text, 'Link or note', (value) => {
      void stashoverApi.updateReading(item.id, value);
    });
    card.replaceWith(row);
    focusRow(row);
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void stashoverApi.removeReading(item.id);
  });

  return card;
}

function inboxCard(item: Item): HTMLLIElement {
  return renderCard(item, {
    onClick: (li, wrap) => {
      void stashoverApi.copyToClipboard(item.url || item.text).then(() => {
        li.classList.add('copied');
        wrap.replaceChildren(checkIcon());
        setTimeout(() => {
          void stashoverApi.removeLink(item.id);
        }, 220);
      });
    },
  });
}

async function render(): Promise<void> {
  if (editing) return;
  const token = ++renderToken;
  const tab = activeTab;
  let items: Item[];
  try {
    items = tab === 'inbox' ? await stashoverApi.getLinks() : await stashoverApi.getReading();
  } catch {
    setTimeout(() => void render(), 300);
    return;
  }
  // The fetch above yields, so the world can move underneath it: a newer render can
  // start, the tab can change, or an input can open. Any of those makes this pass stale,
  // and writing it out anyway would show the wrong list or wipe a focused input.
  if (token !== renderToken || tab !== activeTab || editing) return;

  currentCount = items.length;
  list.innerHTML = '';
  count.textContent = items.length === 0 ? '' : String(items.length);
  empty.classList.toggle('show', items.length === 0);
  emptyTitle.textContent = tab === 'inbox' ? 'No links yet' : 'Nothing to read';
  emptySub.textContent = tab === 'inbox' ? 'Share something from your phone' : 'Copy a link, then hit +';
  clearBtn.disabled = items.length === 0;
  if (items.length === 0) hideConfirm();

  for (const item of items) {
    list.appendChild(tab === 'inbox' ? inboxCard(item) : readingCard(item));
  }
}

for (const btn of tabBtns) {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab === 'reading' ? 'reading' : 'inbox';
    if (tab === activeTab) return;
    activeTab = tab;
    editing = false;
    hideConfirm();
    for (const other of tabBtns) other.classList.toggle('is-active', other === btn);
    addBtn.hidden = activeTab !== 'reading';
    void render();
  });
}

addBtn.addEventListener('click', async () => {
  const result = await stashoverApi.addReadingFromClipboard();
  if (result.added) return;
  hideConfirm();
  empty.classList.remove('show');
  const row = inputRow(result.text ?? '', 'Paste or type a link', (value) => {
    void stashoverApi.addReading(value);
  });
  list.prepend(row);
  focusRow(row);
});

// A native dialog would blur the menubar window, which hides the popover.
clearBtn.addEventListener('click', () => {
  if (currentCount === 0) return;
  const noun = activeTab === 'inbox' ? 'link' : 'reading item';
  confirmTextEl.textContent = `Clear all ${currentCount} ${noun}${currentCount === 1 ? '' : 's'}?`;
  confirmBar.hidden = false;
});

confirmCancelBtn.addEventListener('click', () => {
  hideConfirm();
});

confirmOkBtn.addEventListener('click', async () => {
  hideConfirm();
  await (activeTab === 'inbox' ? stashoverApi.clearAll() : stashoverApi.clearReading());
});

settingsBtn.addEventListener('click', () => {
  void stashoverApi.openSettings();
});

stashoverApi.onLinksUpdated(() => {
  void render();
});

stashoverApi.onReadingUpdated(() => {
  void render();
});

void render();
