import type { PopApi } from '../main/preload';

declare global {
  interface Window {
    popApi: PopApi;
  }
}

const qrImg = document.getElementById('qr') as HTMLImageElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const portEl = document.getElementById('port') as HTMLElement;
const secretEl = document.getElementById('secret') as HTMLElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const launchInput = document.getElementById('launch') as HTMLInputElement;
const notificationsInput = document.getElementById('notifications') as HTMLInputElement;
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
  const [pairing, settings, qr] = await Promise.all([
    window.popApi.getPairing(),
    window.popApi.getSettings(),
    window.popApi.getPairingQr(),
  ]);
  qrImg.src = qr;
  portEl.textContent = String(pairing.port);
  portInput.value = String(pairing.port);
  secretEl.textContent = pairing.secret;
  launchInput.checked = settings.launchAtLogin;
  notificationsInput.checked = settings.notifications;
  restartEl.classList.remove('show');
  setStatus(pairing.paired);
}

launchInput.addEventListener('change', async () => {
  await window.popApi.updateSettings({ launchAtLogin: launchInput.checked });
});

notificationsInput.addEventListener('change', async () => {
  await window.popApi.updateSettings({ notifications: notificationsInput.checked });
});

portInput.addEventListener('change', async () => {
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  await window.popApi.setPort(port);
  portEl.textContent = String(port);
  restartEl.classList.add('show');
});

resetBtn.addEventListener('click', async () => {
  const ok = confirm('Reset secret? Your phone will be unpaired and must re-scan the QR.');
  if (!ok) return;
  await window.popApi.resetSecret();
  await refresh();
});

window.popApi.onPairedChanged((paired) => {
  setStatus(paired);
  if (!paired) void refresh();
});

void refresh();
