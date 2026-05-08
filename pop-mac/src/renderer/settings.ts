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
  const [pairing, qr] = await Promise.all([
    window.popApi.getPairing(),
    window.popApi.getPairingQr(),
  ]);
  qrImg.src = qr;
  portEl.textContent = String(pairing.port);
  secretEl.textContent = pairing.secret;
  setStatus(pairing.paired);
}

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
