type SettingsApi = {
  getRelayStatus: () => Promise<{ connected: boolean; lastEventAt: number; relayHost: string }>;
  getSettings: () => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  updateSettings: (settings: Partial<{ launchAtLogin: boolean; maxHistory: number }>) => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
};

const settingsApi = (window as unknown as { stashApi: SettingsApi }).stashApi;

const statusEl = document.getElementById('status') as HTMLDivElement;
const relayHostEl = document.getElementById('relayHost') as HTMLElement;
const launchInput = document.getElementById('launch') as HTMLInputElement;

function setStatus(connected: boolean): void {
  if (connected) {
    statusEl.textContent = 'Connected to relay';
    statusEl.classList.remove('pending');
    statusEl.classList.add('ok');
  } else {
    statusEl.textContent = 'Connecting to relay…';
    statusEl.classList.remove('ok');
    statusEl.classList.add('pending');
  }
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await settingsApi.getRelayStatus();
    relayHostEl.textContent = status.relayHost;
    setStatus(status.connected);
  } catch {
    // main not ready yet — try again shortly
  }
}

async function loadSettings(): Promise<void> {
  try {
    const settings = await settingsApi.getSettings();
    launchInput.checked = settings.launchAtLogin;
  } catch {
    setTimeout(() => void loadSettings(), 300);
  }
}

launchInput.addEventListener('change', async () => {
  await settingsApi.updateSettings({ launchAtLogin: launchInput.checked });
});

void loadSettings();
void refreshStatus();
setInterval(() => void refreshStatus(), 3000);
