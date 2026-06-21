# stash — what this app is and how it works

> Orientation doc for any future Claude agent (or human) touching this repo.
> Read this first, then dive into the code.

## 1. The point of the app

**stash** lets me share a link (or any text) from my **Android phone** and have it
pop up in a small **menubar popover on my Mac** — so a thing I find on my phone is
waiting for me on my laptop, with zero friction.

Key facts about the product:

- **Single user, personal, unpublished.** One phone, one Mac, both mine. There are
  no accounts, no other users, and the app is never shipped to a store.
- **Fully LAN-only. No cloud, no relay, no server I run.** Delivery is a direct
  HTTP POST from the phone to the Mac over the local Wi-Fi network. If they're not
  on the same network, the phone *queues* the link and delivers it the moment they
  are reunited.
- **No pairing.** There is deliberately no QR scan, no manual IP entry, no
  "pair" screen. The two apps share a **baked-in secret** so the Mac just knows a
  link came from me. Discovery (mDNS/Bonjour) is used only to learn the Mac's
  *current* IP address, not to establish trust.
- **Nothing is silently lost.** Every shared link is written to disk on the phone
  *before* the first network attempt, with an explicit status. The Android app has
  a **Links screen** showing what's Pending / Sent / Failed, with retry.

### The bug this architecture was built to kill

Links used to *only sometimes* arrive — especially after switching Wi-Fi or using
mobile data. Root cause was three stacked defects, all now fixed (see §5):

1. The background retry worker required an **unmetered** network, so queued links
   never flushed on mobile data and were flaky even on Wi-Fi.
2. The phone trusted a **stale cached IP** for the Mac after a Wi-Fi switch and
   pinged a dead address.
3. The Mac only re-advertised its mDNS service on sleep/wake, so if its **IP
   changed while awake**, discovery pointed at the wrong address.

## 2. The two apps

```
┌─────────────────────────┐         Wi-Fi LAN          ┌──────────────────────────┐
│  Android (stash-android) │                            │   Mac (stash-mac)         │
│  Kotlin, Views/XML       │   mDNS: find Mac's IP:port │   Electron + TypeScript   │
│                          │ ─────────────────────────> │   menubar app             │
│  Share sheet → enqueue   │                            │   HTTP server 0.0.0.0:7891│
│  → POST /links/batch ────┼──── Bearer <shared secret> ┼─> validate → store → popover
│  (queue if Mac absent)   │ <───── { accepted: N } ─── │   Bonjour advertise       │
└─────────────────────────┘                            └──────────────────────────┘
```

- **Transport:** HTTP over the LAN, plaintext by IP (`usesCleartextTraffic=true` on
  Android is intentional and required — we talk to a bare `192.168.x.x:7891`).
- **Discovery:** mDNS/Bonjour. Mac advertises `_stash._tcp`; Android resolves it to
  get the live IP:port. The `.local` hostname is only an identity hint, never dialed.
- **Auth:** `Authorization: Bearer <shared secret>`, compared on the Mac with a
  constant-time check. Same secret baked into both apps.
- **Port:** `7891` on both sides by default.

## 3. The shared secret (how "it knows it's me")

One constant string lives in both apps. It is **kept out of git** via gitignored
files, with an env-var override and a build-safe placeholder.

| App | Reads from (first hit wins) | File / field |
|-----|------------------------------|--------------|
| Android | `STASH_SHARED_SECRET` env → `secrets.properties` → placeholder | `stash-android/secrets.properties` key `STASH_SHARED_SECRET`, surfaced as `BuildConfig.STASH_SECRET` (wired in `app/build.gradle.kts`) |
| Mac | `STASH_SHARED_SECRET` env → `stash.secret.json` → placeholder | `stash-mac/stash.secret.json` field `sharedSecret`, read by `src/main/sharedSecret.ts` |

Both files are **gitignored** and currently hold the *same* value. The placeholder
(`stash-unconfigured-shared-secret`) lets the projects build without secrets but
will not authenticate — if links 401, check that both files exist and match.

> Putting an extractable secret in the APK is acceptable here: the app is personal,
> unpublished, and LAN-only. Just never commit the real value.

## 4. Android implementation (`stash-android`)

Stack: Kotlin, **Views/XML** (not Compose), Material3, OkHttp, Android NSD,
WorkManager. `minSdk 29 / target 34`, JVM 17, `findViewById` (no viewBinding).

### Delivery flow

1. **Share sheet → `ShareActivity`** (`SEND` intent, translucent, no UI).
   `PayloadValidator.classify()` turns the shared text into a URL or plain text
   (or rejects it), then hands it to `LinkSender.send()` on a background thread and
   toasts the outcome (Sent / queued / offline).
2. **`LinkSender`** (`net/LinkSender.kt`) is the core. `send()`:
   - **writes a PENDING record to disk first** (write-ahead — survives a mid-send
     process kill), then
   - calls `flushQueue()`, which reads all PENDING records (FIFO by `createdAt`),
     resolves the Mac's endpoint, and POSTs them as one batch to `/links/batch`.
   - **Endpoint resolution** (`resolveEndpoint`): try the cached host with a fast
     `/ping`; if that fails, re-run mDNS discovery (`NsdHelper.findMac`, ~4s) and
     persist the fresh IP; if discovery misses, fall back to a **subnet-keyed pin**
     (`NetworkPinStore`) and ping that. This is what fixes the stale-IP bug and
     covers routers that block multicast.
   - On HTTP 200 the Mac returns `{ accepted: N }` (a count, not IDs); we mark the
     **first N pending records by creation order** as SENT. On failure we record an
     attempt against the pending records.
3. **`FlushQueueWorker`** (WorkManager) retries the queue in the background:
   `NetworkType.CONNECTED` (works on mobile data too), expedited as
   non-expedited fallback, exponential 10s backoff. Scheduled by
   `ConnectivityWatcher` whenever the device regains connectivity. It also expires
   old records and fires the **stuck** notification if any record has exhausted its
   attempts.

### Durable record store

- **`data/LinkRecord.kt`** — one shared link: `id`, `text`, `url`, `kind`,
  `status ∈ {PENDING, SENT, FAILED, EXPIRED}`, timestamps, `attempts`, `lastError`.
  `MAX_ATTEMPTS = 8`.
- **`data/RecordStore.kt`** — the single source of truth, plain SharedPreferences
  (`stash-records.prefs`). Newest-first reads, FIFO pending, status counts.
  Rules: a record is written **before** its first send; **PENDING records are never
  trimmed** (only terminal ones are capped at 300); `expireOlderThan(7 days)` moves
  stale PENDING → EXPIRED. One-time migration absorbs the legacy `stash-queue` /
  `stash-history` prefs. `requeue(id)` resets a terminal record to PENDING for a
  manual retry.

### UI

- **`LinksActivity`** is the launcher/home screen (replaced the old pairing screen).
  A Material `ChipGroup` with **Pending / Sent / Failed** tabs over a RecyclerView
  (`LinksAdapter` + `item_link.xml`). The Pending chip shows a live count badge.
  Per-row **Retry** (requeue + schedule worker), a **Clear** menu action (drops
  terminal records), and an empty state. Expiry runs on resume.
- **`StuckNotification`** — fired by the worker when delivery is stuck; tapping it
  opens `LinksActivity`.

### Discovery / network helpers (`net/`)

- `NsdHelper` — Android NSD resolve of `_stash._tcp`; returns `Mac(host, port, hostname)`.
- `NetworkPinStore` — remembers last-good `host:port` keyed on the current subnet
  (derived from `LinkProperties`, **no location permission**), for multicast-blocked routers.
- `Secret.kt` — now just the host/port cache (`stash-endpoint.prefs`) plus
  `secret() = BuildConfig.STASH_SECRET`. No more encrypted store, no pairing state.

## 5. Mac implementation (`stash-mac`)

Stack: Electron + TypeScript (strict), `bonjour-service` for mDNS. Menubar app.

- **`src/main/server.ts`** — HTTP server on `0.0.0.0:7891`. Routes (all
  Bearer-authenticated against the shared secret, constant-time):
  - `GET /ping` → `{ ok, version }` (the phone's reachability check)
  - `POST /links` → add one link
  - `POST /links/batch` → add many; returns `{ accepted: N }`
  Payloads are `{ url?, text?, title?, sentAt? }`; `text` falls back to `url`.
  Added links emit events that drive the popover and optional metadata enrichment.
- **`src/main/sharedSecret.ts`** — resolves the shared secret (see §3).
- **`src/main/auth.ts`** — `verifyBearer` with `timingSafeEqual`.
- **`src/main/mdns.ts`** — advertises `_stash._tcp` with TXT `{ version, name: hostname }`.
- **`src/main/main.ts`** — app lifecycle; **watches for network changes and
  re-advertises** mDNS when the Mac's IP changes (fixes defect #3), in addition to
  the sleep/wake re-advertise.
- **`src/main/tray.ts`** — menubar icon + popover. **`src/renderer/stashover.*`** is
  the popover UI; **`src/renderer/settings.*`** is settings (port, launch-at-login,
  a simple "discoverable" status — no secret display, no re-pair).
- **`src/main/store.ts`** — link storage + `getSecret()` (proxies the shared secret).

## 6. Build & run

**Mac:**
```bash
cd stash-mac && npm install && npm run build && npm start   # or: npm run dev
```

**Android:** requires a **JDK 17–21** (Gradle 8.5 cannot parse JDK 26 — if you see
`IllegalArgumentException: 26` at settings evaluation, that's the JDK). The Android
Studio JBR works:
```bash
cd stash-android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug      # or installDebug onto a device
```

Make sure `stash-android/secrets.properties` and `stash-mac/stash.secret.json` exist
with the **same** secret value, or links will 401.

## 7. Test matrix (the behaviors that must hold)

Watch the Mac popover **and** the Android Links screen:

1. **Same Wi-Fi** — share → appears in ~1s; record SENT.
2. **Wi-Fi A → B switch** — delivers without re-pairing (stale-IP rediscovery).
3. **Mobile data → home Wi-Fi** — queues PENDING on mobile, flushes within seconds
   on rejoining Wi-Fi. *(The headline bug.)*
4. **Mac asleep → wake** — queues, then delivers on reconnect.
5. **Mac IP changes while awake** — Mac re-advertises; next share still lands.
6. **Multicast-blocked router** — after one good delivery, the subnet pin delivers.
7. **App killed mid-send** — record survives as PENDING (write-ahead) and flushes later.
8. **Expiry** — a PENDING link with the Mac permanently off becomes EXPIRED after
   7 days, visible and retryable in the Links screen.

## 8. Gotchas for future edits

- **Keep `usesCleartextTraffic=true`** — we talk HTTP to a bare IP.
- **Batch returns a count, not IDs** — SENT-marking relies on `createdAt` order
  matching send order. Don't reorder the queue between building the batch and marking.
- **`.local` is not directly resolvable on Android** — "fresh resolve" means re-run
  NSD; the hostname is only an identity hint.
- **Never trim PENDING records.** Only terminal records are capped/cleared.
- **Never commit the real secret** (`secrets.properties` / `stash.secret.json` are gitignored).
- **Search with the `fff` MCP tools**, not raw grep/find (repo convention).
