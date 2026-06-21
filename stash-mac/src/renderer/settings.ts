type SettingsApi = {
  getNetworkInfo: () => Promise<{ port: number; host: string | null }>;
  getSettings: () => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  updateSettings: (settings: Partial<{ launchAtLogin: boolean; maxHistory: number }>) => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  setPort: (port: number) => Promise<void>;
};

const settingsApi = (window as unknown as { stashApi: SettingsApi }).stashApi;

const statusEl = document.getElementById('status') as HTMLDivElement;
const hostEl = document.getElementById('host') as HTMLElement;
const portEl = document.getElementById('port') as HTMLElement;
const launchInput = document.getElementById('launch') as HTMLInputElement;
const portInput = document.getElementById('portInput') as HTMLInputElement;
const restartEl = document.getElementById('restart') as HTMLDivElement;

function setStatus(host: string | null): void {
  if (host) {
    statusEl.textContent = 'Discoverable on your network';
    statusEl.classList.remove('pending');
    statusEl.classList.add('ok');
  } else {
    statusEl.textContent = 'Waiting for a network connection…';
    statusEl.classList.remove('ok');
    statusEl.classList.add('pending');
  }
}

async function refresh(): Promise<void> {
  let network: Awaited<ReturnType<SettingsApi['getNetworkInfo']>>;
  let settings: Awaited<ReturnType<SettingsApi['getSettings']>>;
  try {
    [network, settings] = await Promise.all([
      settingsApi.getNetworkInfo(),
      settingsApi.getSettings(),
    ]);
  } catch {
    setTimeout(() => void refresh(), 300);
    return;
  }
  hostEl.textContent = network.host ?? 'Not found';
  portEl.textContent = String(network.port);
  portInput.value = String(network.port);
  launchInput.checked = settings.launchAtLogin;
  restartEl.classList.remove('show');
  setStatus(network.host);
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

void refresh();
