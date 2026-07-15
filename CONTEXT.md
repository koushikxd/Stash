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
- **Delivery over an encrypted relay, from anywhere.** The phone encrypts each
  shared item and publishes it to the free public **ntfy.sh** pub/sub relay; the Mac
  keeps a live subscription, decrypts, displays it, and publishes an encrypted
  **ack** back. Links deliver instantly whether the phone is on home Wi-Fi, office
  Wi-Fi, a friend's Wi-Fi, or mobile data — no VPN, no accounts, no setup.
- **Nothing is silently lost.** Every shared item is written to disk on the phone
  *before* the first network attempt, and is only marked **SENT** once the Mac's ack
  arrives (end-to-end). Until then it stays PENDING and is re-published as needed.
  The Android app has a **Links screen** showing Pending / Sent / Failed, with retry.
- **No pairing.** There is no QR scan, no IP entry, no "pair" screen. Both apps bake
  in the same **shared secret**; it is stretched into the encryption key *and* into
  the unguessable relay topic names, so only a device holding the secret can publish
  to, read from, or decrypt the relay. Nobody else can interfere.

### Why the relay (and not LAN)

stash used to deliver over the LAN (direct HTTP to the Mac, mDNS to find its IP).
That worked at home but was unfixable elsewhere: office Wi-Fi uses **AP/client
isolation** (devices on the same SSID can't reach each other at all) and routed
VLANs (mDNS never crosses them, and there was no way to seed a fallback IP). A relay
on the public internet is the only path that is always reachable from both sides, so
the LAN/mDNS/discovery/HTTP-server code was removed entirely in favour of ntfy.sh.

## 2. The two apps

```
┌──────────────────────────┐        ntfy.sh relay         ┌──────────────────────────┐
│  Android (stash-android)  │      (public internet)       │   Mac (stash-mac)         │
│  Kotlin, Views/XML        │                              │   Electron + TypeScript   │
│                           │  POST encrypted link ──────► │   menubar app             │
│  Share sheet → enqueue    │      (main topic)            │   live subscription       │
│  → encrypt → publish ─────┼──────────────────────────────┼─► decrypt → store → popover
│  (queue if offline)       │                              │                           │
│  mark SENT on ack ◄───────┼───── encrypted ack ──────────┼── publish ack (ack topic) │
└──────────────────────────┘                              └──────────────────────────┘
```

- **Transport:** HTTPS to `https://ntfy.sh`. Phone→Mac is the link stream; Mac→phone
  is acks only. Base URL is a single constant per app (`Relay.BASE_URL` /
  `NTFY_BASE_URL`) so it can be repointed at a self-hosted ntfy with a one-line edit.
- **Topics** (per direction), derived from the secret so they're unguessable:
  `"st-" + hex(SHA-256("topic:main:"+secret))[0..32)` and `…"topic:ack:"…`.
- **Encryption:** AES-256-GCM. Key = `SHA-256("key:"+secret)`. Body on the wire =
  `base64(IV(12) || ciphertext || GCM tag(16))`, no line wrapping. GCM auth doubles
  as sender authentication — anything that fails to decrypt is silently dropped.
- **Wire messages** (UTF-8 JSON, one ntfy message per record):
  - link: `{"v":1,"t":"link","id":"<uuid>","text":"…","url":"…"?,"createdAt":<ms>}`
  - ack:  `{"v":1,"t":"ack","ids":["<uuid>",…]}` (Mac batches, ≤50 ids, 1s debounce)
- **Size:** ntfy turns bodies >4096 bytes into attachments (which breaks decrypt), so
  shares are capped at 2800 bytes (`PayloadValidator.MAX_PAYLOAD_BYTES`) and any
  record whose built envelope still exceeds 4096 bytes is FAILED at publish time.

## 3. The shared secret (how "it knows it's me")

One constant string lives in both apps. It is **kept out of git** via gitignored
files, with an env-var override and a build-safe placeholder.

| App | Reads from (first hit wins) | File / field |
|-----|------------------------------|--------------|
| Android | `STASH_SHARED_SECRET` env → `secrets.properties` → placeholder | `stash-android/secrets.properties` key `STASH_SHARED_SECRET`, surfaced as `BuildConfig.STASH_SECRET` (wired in `app/build.gradle.kts`) |
| Mac | `STASH_SHARED_SECRET` env → `stash.secret.json` → placeholder | `stash-mac/stash.secret.json` field `sharedSecret`, read by `src/main/sharedSecret.ts` |

Both files are **gitignored** and must hold the *same* value. The secret is no
longer a bearer token — it is the input to both the AES key and the topic names
(`util/Crypto.kt` on Android, the crypto helpers in `src/main/ntfy.ts` on the Mac,
which derive identically). If the two sides disagree they publish to different topics
*and* can't decrypt each other, so delivery goes silent — if links never arrive,
check that both secret files exist and match.

> Putting an extractable secret in the APK is acceptable here: the app is personal
> and unpublished. Just never commit the real value.

## 4. Android implementation (`stash-android`)

Stack: Kotlin, **Views/XML** (not Compose), Material3, OkHttp, WorkManager.
`minSdk 29 / target 34`, JVM 17, `findViewById` (no viewBinding).

### Delivery flow

1. **Share sheet → `ShareActivity`** (`SEND` intent, translucent, no UI).
   `PayloadValidator.classify()` turns the shared text into a URL or plain text (or
   rejects it, including >2800 bytes), then hands it to `LinkSender.send()` on a
   background thread and toasts the outcome.
2. **`LinkSender`** (`net/LinkSender.kt`) is the core. `send()`:
   - **writes a PENDING record to disk first** (write-ahead — survives a mid-send
     process kill), then calls `flushQueue()`, then waits ~1.5s and polls the ack
     topic once so a normal share can toast "Sent to Mac" if the ack already landed.
   - Toast/`Result`: **Sent** (acked), **Published** ("Sent — Mac will confirm" — on
     the relay, ack pending), or **Queued** (offline; will publish on reconnect).
   - `flushQueue()`: retire oversize → **check acks** (poll the ack topic since the
     stored ntfy message id, decrypt, `markSentIfPending`) → publish every eligible
     PENDING record (never published, or last published > 11h ago — ntfy caches ~12h)
     FIFO. A publish failure records an attempt and aborts the loop (we're offline;
     WorkManager retries). Only publish failures count toward attempts/FAILED.
3. **`net/Relay.kt`** — transport only: OkHttp `publish(topic, body)` (POST) and
   `poll(topic, since)` (GET `…/json?poll=1&since=`, line-delimited JSON).
4. **`util/Crypto.kt`** — SHA-256 key/topic derivation + AES-256-GCM encrypt/decrypt
   (`android.util.Base64` NO_WRAP). Must stay byte-compatible with the Mac.
5. **`net/FlushQueueWorker`** (WorkManager) backs delivery: a one-time expedited
   request (`schedule`, kicked on reconnect/share) and a **15-min periodic** request
   (`schedulePeriodic`, unique `stash-ack-poll`, scheduled from `StashApp`) that polls
   acks and re-publishes stale records. Both run on `NetworkType.CONNECTED` (mobile
   data included), expire old records, and raise the **stuck** notification.
   Awaiting-ack is `success` (it must not spin the backoff); only publish failure
   `retry`s.
6. **`net/ConnectivityWatcher`** — flushes on regained connectivity, keyed on
   `NET_CAPABILITY_INTERNET` (any internet path delivers now, not just Wi-Fi).

### Durable record store

- **`data/LinkRecord.kt`** — one shared item: `id`, `text`, `url`, `kind`,
  `status ∈ {PENDING, SENT, FAILED, EXPIRED}`, timestamps, `publishedAt`, `attempts`,
  `lastError`. `MAX_ATTEMPTS = 8`. `id` is the ack + dedupe key.
- **`data/RecordStore.kt`** — the single source of truth, plain SharedPreferences
  (`stash-records.prefs`). Key ops: `enqueue` (write-ahead PENDING), `markPublished`
  (sets `publishedAt`, not attempts), `markSentIfPending(ids)` (idempotent ack
  application), `recordAttempt(id)`, `fail`, `requeue` (manual retry; resets
  `publishedAt`), `expireOlderThan(7 days)`. **PENDING records are never trimmed**
  (terminal capped at 300). `find(id)` fetches one record.
- **`data/RelayState.kt`** — `stash-relay.prefs`: the ntfy message id of the last ack
  we processed, polled with `since=<id>` (default `"all"` on first run). Message-id
  cursors mean **no wall clocks and no skew**.

### UI

- **`LinksActivity`** — launcher/home: Pending / Sent / Failed tabs over a
  RecyclerView, per-row Retry, Clear menu action, empty state. Expiry runs on resume.
- **`StuckNotification`** — fired by the worker when delivery is stuck.

## 5. Mac implementation (`stash-mac`)

Stack: Electron + TypeScript (strict). Menubar app. No native deps for transport.

- **`src/main/ntfy.ts`** — the whole relay client. Derives the key/topics (mirrors
  `util/Crypto.kt`), keeps a **streaming `fetch(…/json?since=)` subscription** to the
  main topic with an `AbortController`, splits newline-delimited JSON, and for each
  message: decrypt (silent drop on failure) → validate `v/t/id/text` → if the id is
  already in the `seen` set, **re-ack without re-storing** (lost-ack recovery) →
  else `store.addLink` → emit `link-added`/`link-updated` → enrich metadata → record
  seen → enqueue an ack. Acks are batched (≤50 ids, 1s debounce) and published
  encrypted to the ack topic. Reconnect uses exponential backoff (1s→60s) plus a
  watchdog that forces a reconnect if no event arrives for 150s (keepalives ~45s).
  Persists `{ since, seen[] }` to `userData/stash-relay.json` (`seen` FIFO-capped
  2000). `start` / `stop` / `restart` / `getStatus` are the exports.
- **`src/main/store.ts`** — link storage (`userData/stash-store.json`), dedupe by
  canonical URL/text, metadata updates. No port any more.
- **`src/main/sharedSecret.ts`** — resolves the shared secret (see §3).
- **`src/main/main.ts`** — lifecycle: `store.init()` → `tray.init()` → `ntfy.start()`.
  A 5s network-fingerprint poll and `powerMonitor 'resume'` both call `ntfy.restart()`
  so a Wi-Fi switch or wake reconnects the stream. `before-quit` → `ntfy.stop()`.
- **`src/main/tray.ts`** — menubar icon + popover; consumes `ntfy` events; IPC
  includes `stash:getRelayStatus` (`{ connected, lastEventAt, relayHost }`).
- **`src/renderer/settings.*`** — launch-at-login + a live relay-status pill
  ("Connected to relay" / "Connecting to relay…", polled every 3s). No IP/port.
- **`src/main/metadata.ts` / `favicon.ts`** — link preview enrichment (unchanged).

## 6. Build & run

**Mac:**
```bash
cd stash-mac && npm install && npm run build && npm start   # or: npm run dev
npx tsc -p tsconfig.json --noEmit                           # typecheck only
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
with the **same** secret value, or the two sides use different topics/keys and
nothing arrives.

## 7. Test matrix (the behaviors that must hold)

Watch the Mac popover **and** the Android Links screen:

1. **Both online** — share a URL → "Sent to Mac" toast in ~1s; link + metadata in the
   popover; record SENT. Share plain text → same, `text` kind.
2. **Mac quit** — share → "Sent — Mac will confirm"; record PENDING with `publishedAt`.
   Launch the Mac → the link appears (relay cache replay) and flips SENT on next flush.
3. **Phone offline** — airplane mode → share → "Saved"; restore connectivity **on
   mobile data** (not just Wi-Fi) → auto-delivers. *(The headline win.)*
4. **Office / hostile Wi-Fi** — same SSID with AP isolation → still delivers (relay).
5. **Restart Mac twice** — no duplicate links (`since`/`seen` persisted). Delete
   `since` in `stash-relay.json`, restart → replay is re-acked, still no dupes.
6. **Wrong secret** on one side → nothing on the Mac, no crash; record stays PENDING
   (→ EXPIRED at 7 days).
7. **Oversize** — a >2800-byte share is rejected at the share sheet.
8. **Mac Wi-Fi toggle / sleep-resume** — settings shows Connecting… → Connected;
   anything published meanwhile arrives after the reconnect.
9. **App killed mid-send** — record survives PENDING (write-ahead) and flushes later.
10. **Upgrade path** — pre-existing PENDING records (no `publishedAt`) publish
    immediately on the first flush.

## 8. Gotchas for future edits

- **Keep the crypto byte-compatible.** `util/Crypto.kt` and the helpers in `ntfy.ts`
  must agree exactly: key = `SHA-256("key:"+secret)`, topics from `"topic:main|ack:"`,
  body = `base64(IV(12)||ct||tag(16))` no-wrap. Change one side → change both.
- **ntfy's 4096-byte body limit is a hard wall** — larger bodies become attachments
  and can't be decrypted. That's why shares cap at 2800 and oversize envelopes FAIL.
- **`since` is always an ntfy message id, never a wall clock** — this is what makes
  the system skew-proof. The Mac stores `since` in `stash-relay.json`; the phone
  stores its ack cursor in `stash-relay.prefs`.
- **Dedupe is by record id** (`seen` on the Mac, `markSentIfPending` idempotency on
  the phone). Replays from the relay cache or a deleted `since` are always safe.
- **A record is only SENT on ack.** Publishing sets `publishedAt`; don't shortcut
  PENDING→SENT on publish success or the "nothing lost" guarantee breaks.
- **Never trim PENDING records.** Only terminal records are capped/cleared.
- **Never commit the real secret** (`secrets.properties` / `stash.secret.json` are
  gitignored).
- **Search with the `fff` MCP tools**, not raw grep/find (repo convention).
