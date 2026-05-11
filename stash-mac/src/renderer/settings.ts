type SettingsApi = {
  getPairing: () => Promise<{ secret: string; port: number; paired: boolean; host: string | null }>;
  getSettings: () => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  updateSettings: (settings: Partial<{ launchAtLogin: boolean; maxHistory: number }>) => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  setPort: (port: number) => Promise<void>;
  resetSecret: () => Promise<{ secret: string; port: number }>;
  onPairedChanged: (cb: (paired: boolean) => void) => void;
};

const settingsApi = (window as unknown as { stashApi: SettingsApi }).stashApi;

const statusEl = document.getElementById('status') as HTMLDivElement;
const hostEl = document.getElementById('host') as HTMLElement;
const portEl = document.getElementById('port') as HTMLElement;
const secretEl = document.getElementById('secret') as HTMLElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const launchInput = document.getElementById('launch') as HTMLInputElement;
const portInput = document.getElementById('portInput') as HTMLInputElement;
const restartEl = document.getElementById('restart') as HTMLDivElement;

function setStatus(paired: boolean): void {
  if (paired) {
    statusEl.textContent = 'Paired ✓';
    statusEl.classList.remove('pending');
    statusEl.classList.add('ok');
  } else {
    statusEl.textContent = 'Waiting for phone…';
    statusEl.classList.remove('ok');
    statusEl.classList.add('pending');
  }
}

async function refresh(): Promise<void> {
  let pairing: Awaited<ReturnType<SettingsApi['getPairing']>>;
  let settings: Awaited<ReturnType<SettingsApi['getSettings']>>;
  try {
    [pairing, settings] = await Promise.all([
      settingsApi.getPairing(),
      settingsApi.getSettings(),
    ]);
  } catch {
    setTimeout(() => void refresh(), 300);
    return;
  }
  hostEl.textContent = pairing.host ?? 'Not found';
  portEl.textContent = String(pairing.port);
  portInput.value = String(pairing.port);
  secretEl.textContent = pairing.secret;
  launchInput.checked = settings.launchAtLogin;
  restartEl.classList.remove('show');
  setStatus(pairing.paired);

}

launchInput.addEventListener('change', async () => {
  await settingsApi.updateSettings({ launchAtLogin: launchInput.checked });
});

portInput.addEventListener('change', async () => {
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  await settingsApi.setPort(port);
  portEl.textContent = String(port);
  restartEl.classList.add('show');
});

resetBtn.addEventListener('click', async () => {
  const ok = confirm('Reset secret? Your phone will be unpaired and must run Find and Pair Mac again.');
  if (!ok) return;
  await settingsApi.resetSecret();
  await refresh();
});

settingsApi.onPairedChanged((paired) => {
  setStatus(paired);
  if (!paired) void refresh();
});

void refresh();
