# stash — what this app is and how it works

> Orientation doc for any future Claude agent (or human) touching this repo.
> Read this first, then dive into the code.

## 1. The point of the app

**stash** lets me share a link (or any text) from my **Android phone** and have it
waiting in a **menubar popover on my Mac** — so a thing I find on my phone is
there on my laptop, with zero friction.

Key facts about the product:

- **Single user, personal, unpublished.** One phone, one Mac, both mine. There are
  no accounts, no other users, and the app is never shipped to a store.
- **Delivery over an encrypted relay, from anywhere.** The phone encrypts each
  shared item and appends it to an **Upstash Redis Stream**; the Mac polls that
  stream, decrypts, and shows it. Links deliver whether the phone is on home Wi-Fi,
  office Wi-Fi, a friend's Wi-Fi, or mobile data — no VPN, no accounts, no setup.
  Because entries are *stored* (30-day retention) rather than broadcast, anything
  shared while the Mac is asleep, quit, or offline is still waiting on its next poll.
- **Nothing is silently lost.** Every shared item is written to disk on the phone
  *before* the first network attempt. A successful `XADD` **is** the delivery
  guarantee: the entry is durably stored and the Mac's persisted cursor reads it
  exactly once, so the record goes straight to SENT. If the phone is offline the
  record stays PENDING and publishes later. The Android app has a **Links screen**
  showing Pending / Sent / Failed, with retry.
- **The Mac UI is a menubar popover.** A `menubar` BrowserWindow rendering metadata
  cards (favicon, title, description, source), plus a separate Settings window. See §5.
- **No pairing.** There is no QR scan, no IP entry, no "pair" screen. Both apps bake
  in the same **shared secret**; it is stretched into the encryption key *and* into
  the unguessable relay stream names, so only a device holding the secret can read
  or decrypt the traffic. Nobody else can interfere.

### Why the relay (and not LAN)

stash used to deliver over the LAN (direct HTTP to the Mac, mDNS to find its IP).
That worked at home but was unfixable elsewhere: office Wi-Fi uses **AP/client
isolation** (devices on the same SSID can't reach each other at all) and routed
VLANs (mDNS never crosses them, and there was no way to seed a fallback IP). A relay
on the public internet is the only path that is always reachable from both sides, so
the LAN/mDNS/discovery/HTTP-server code was removed entirely in favour of a relay.

### Why Redis Streams (and not ntfy)

The relay was originally **ntfy.sh** pub/sub, which only *cached* messages for ~12h
and needed a live subscription to feel instant. Redis Streams replaced it because an
entry is durable storage: the Mac reads from a cursor at its own pace, so a laptop
that was closed for a week still receives everything in order.

That durability is also why the **ack stream was removed**. Acks existed because ntfy
was fire-and-forget broadcast, so the phone had no way to know a message survived;
that cost a second stream, an ack cursor, an 11-hour republish loop, a dedupe set on
the Mac, and a 1.5s stall in the share sheet. With a stream, `XADD` already proves
durability and the cursor already guarantees exactly-once reads, so all of it was
deleted. The encrypted wire format for links is unchanged.

## 2. The two apps

```
┌──────────────────────────┐       Upstash Redis Stream   ┌──────────────────────────┐
│  Android (stash-android)  │      (public internet)       │   Mac (stash-mac)         │
│  Kotlin, Views/XML        │                              │   Electron + TypeScript   │
│                           │  XADD encrypted link ──────► │   menubar app             │
│  Share sheet → enqueue    │       (one stream)           │   XRANGE poll (30s / 5m)  │
│  → encrypt → publish ─────┼──────────────────────────────┼─► decrypt → store → menu  │
│  (queue if offline)       │                              │                           │
│  SENT on XADD success     │                              │   cursor = exactly-once   │
└──────────────────────────┘                              └──────────────────────────┘
```

- **Transport:** HTTPS POSTs of JSON command arrays to the **Upstash Redis REST**
  endpoint (`["XADD", …]`), authenticated with `Authorization: Bearer <token>`. No
  Redis SDK on either side — OkHttp on Android, `fetch` on the Mac. One stream,
  phone→Mac. There is no return channel.
- **Commands used:** `XADD <stream> * body <envelope>` to publish;
  `XRANGE <stream> - + COUNT 100` for a first read and `XRANGE <stream> (<cursor> +
  COUNT 100` thereafter (exclusive cursor); a full page is drained immediately rather
  than waiting for the next poll. After a non-empty read the Mac fires a best-effort
  `XTRIM <stream> MINID ~ <now-30d>-0`; a failed trim never fails the read. Retention
  has exactly one owner — the Mac is the only reader, and making the phone trim too
  would cost a second blocking round trip on every share for nothing.
- **Stream key**, derived from the secret so it's unguessable — unchanged from the
  ntfy topic name: `"st-" + hex(SHA-256("topic:main:"+secret))[0..32)`. (The old
  `topic:ack:` stream is simply no longer used; any leftover entries age out.)
- **Encryption:** AES-256-GCM. Key = `SHA-256("key:"+secret)`. Body on the wire =
  `base64(IV(12) || ciphertext || GCM tag(16))`, no line wrapping. GCM auth doubles
  as sender authentication — anything that fails to decrypt is silently dropped.
- **Wire message** (UTF-8 JSON, one stream entry per record, in the `body` field):
  `{"v":1,"t":"link","id":"<uuid>","text":"…","url":"…"?,"createdAt":<ms>}`.
  The Mac ignores `id`; the phone still sends it, and it remains that record's local
  identity on the phone.
- **Delivery identity is the cursor.** The Redis stream id (`<ms>-<seq>`) is what
  makes delivery exactly-once. If the cursor is ever lost the retained window replays,
  and `store.addLink`'s canonical url/text dedupe absorbs it.
- **Size:** shares are capped at 2800 bytes (`PayloadValidator.MAX_PAYLOAD_BYTES`) and
  any record whose built envelope exceeds 4096 bytes is FAILED at publish time. Redis
  itself has no such limit; the caps are kept because they bound relay usage and were
  already the tested behavior.

## 3. The shared secret (how "it knows it's me") + relay credentials

One constant string lives in both apps. It is **kept out of git** via gitignored
files, with an env-var override and a build-safe placeholder.

| App | Reads from (first hit wins) | File / field |
|-----|------------------------------|--------------|
| Android | `STASH_SHARED_SECRET` env → `secrets.properties` → placeholder | `stash-android/secrets.properties` key `STASH_SHARED_SECRET`, surfaced as `BuildConfig.STASH_SECRET` (wired in `app/build.gradle.kts`) |
| Mac | `STASH_SHARED_SECRET` env → `stash.secret.json` → placeholder | `stash-mac/stash.secret.json` field `sharedSecret`, read by `src/main/sharedSecret.ts` |

Both files are **gitignored** and must hold the *same* value. The secret is no
longer a bearer token — it is the input to both the AES key and the stream names
(`util/Crypto.kt` on Android, the crypto helpers in `src/main/relay.ts` on the Mac,
which derive identically). If the two sides disagree they use different streams *and*
can't decrypt each other, so delivery goes silent — if links never arrive, check that
both secret files exist and match.

The **Upstash credentials** live in the same two files but are deliberately separate
values: they authenticate the transport and never feed the encryption key.

| App | Reads from (first hit wins) | File / field |
|-----|------------------------------|--------------|
| Android | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` env → `secrets.properties` → empty | same keys in `stash-android/secrets.properties`, surfaced as `BuildConfig.UPSTASH_REDIS_REST_URL` / `…_TOKEN` |
| Mac | same env vars → `stash.secret.json` → empty | fields `upstashRedisRestUrl` / `upstashRedisRestToken` |

Absent credentials build fine; the relay simply reports disconnected and nothing is
delivered. The Mac's packaged app gets the file via `extraResources` (read from
`process.resourcesPath`), so a DMG install needs no configuration.

> Putting extractable secrets in the APK/DMG is acceptable here: the app is personal
> and unpublished. Anyone holding a build artifact can read both the shared secret and
> the relay token. Just never commit the real values.

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
     process kill), then calls `flushQueue()` and reports the record's status. There
     is no waiting on the network beyond the publish itself.
   - Toast/`Result`: **Sent** (on the stream, delivery guaranteed) or **Queued**
     (offline; publishes on reconnect).
   - `flushQueue()`: publish every PENDING record FIFO, marking each **SENT** on `XADD`
     success. A publish failure records an attempt and aborts the loop (we're offline;
     WorkManager retries). A record whose encrypted envelope exceeds 4096 bytes is
     marked FAILED and skipped — retrying can't shrink it — and `send()` surfaces that
     as its own toast rather than lying about being queued.
3. **`net/Relay.kt`** — transport only, and write-only: one authenticated `command(args)`
   executor over the Upstash REST endpoint plus `publish(stream, body)` (XADD). The
   phone never reads the stream, so there is no XRANGE or XTRIM here. Errors are generic
   by design: no token, command, stream name, or payload is ever logged.
4. **`util/Crypto.kt`** — SHA-256 key/stream-name derivation + AES-256-GCM encrypt/decrypt
   (`android.util.Base64` NO_WRAP). Must stay byte-compatible with the Mac.
5. **`net/FlushQueueWorker`** (WorkManager) backs delivery: a one-time expedited
   request (`schedule`, kicked on reconnect/share) and a **15-min periodic** sweep
   (`schedulePeriodic`, unique `stash-flush-periodic`, scheduled from `StashApp`; it
   cancels the legacy `stash-ack-poll` schedule on first run). Both run on
   `NetworkType.CONNECTED` (mobile data included), expire old records, and raise the
   **stuck** notification. Both exit immediately when nothing is pending, so with an
   empty queue they cost no network at all.
6. **`net/ConnectivityWatcher`** — flushes on regained connectivity, keyed on
   `NET_CAPABILITY_INTERNET` (any internet path delivers now, not just Wi-Fi).

### Durable record store

- **`data/LinkRecord.kt`** — one shared item: `id`, `text`, `url`, `kind`,
  `status ∈ {PENDING, SENT, FAILED, EXPIRED}`, timestamps, `attempts`, `lastError`.
  `MAX_ATTEMPTS = 8`.
- **`data/RecordStore.kt`** — the single source of truth, plain SharedPreferences
  (`stash-records.prefs`). Key ops: `enqueue` (write-ahead PENDING), `markSent`,
  `recordAttempt(id)`, `fail`, `requeue` (manual retry), `expireOlderThan(30 days)`
  (matches Redis retention). **PENDING records are never trimmed** (terminal capped at
  300). `find(id)` fetches one record.
- There is no relay-state preference file any more. `data/RelayState.kt` held the ack
  cursor and was deleted with the ack stream; the phone never reads from Redis.

### UI

- **`LinksActivity`** — launcher/home: Pending / Sent / Failed tabs over a
  RecyclerView, per-row Retry, Clear menu action, empty state. Expiry runs on resume.
- **`StuckNotification`** — fired by the worker when delivery is stuck.

## 5. Mac implementation (`stash-mac`)

Stack: Electron + TypeScript (strict). Menubar app. No native deps for transport.

The UI is a **preloaded menubar popover** (`menubar` package) plus a separate Settings
window, talking to the main process over a `contextIsolation` preload bridge. Keeping
the window preloaded costs resident memory (measured ~344 MB across 4 processes,
packaged, at 20s uptime) and buys an instant popover that can render metadata cards.

- **`src/main/relay.ts`** — the whole relay client (was `ntfy.ts`). Derives the
  key/stream name (mirrors `util/Crypto.kt`) and runs a **non-overlapping recursive
  poll**: each pass XRANGEs the stream from the stored cursor and only schedules the
  next pass after it finishes, so a slow request can't stack. The interval is
  **30s when the Mac is in use, 5 min once `powerMonitor.getSystemIdleTime()` passes
  5 minutes** — a backlog is never lost, only delayed, and wake/unlock/popover-open force
  an immediate poll. An `AbortController` + 20s request timeout keep `stop`/`pollNow`
  immediate. For each entry: decrypt (silent drop on failure) → validate `v/t/text` →
  `store.addLink` → emit `link-added`/`link-updated` → enrich metadata; the cursor is
  persisted per handled entry, and a *storage* failure stops the pass without advancing
  it. Wake, unlock, and popover-open all force an immediate poll. Status: any answered request — **including an empty page** — sets connected and
  `lastEventAt`; a failure sets disconnected but preserves the last successful
  timestamp. Persists `{ cursor }` to `userData/stash-relay.json`. Exports `events` /
  `start` / `stop` / `pollNow` / `getStatus` / `getRelayHost`.
- **`src/main/store.ts`** — link storage (`userData/stash-store.json`), dedupe by
  canonical URL/text, metadata updates. Emits `links-changed` on removal and clear;
  arrivals reach the tray through the relay's own `link-added`. Between them the tray
  icon stays in sync.
- **`src/main/sharedSecret.ts`** — resolves the shared secret *and* the Upstash
  URL/token (see §3), parsing `stash.secret.json` once and caching it.
- **`src/main/main.ts`** — lifecycle: `disableHardwareAcceleration()` →
  `store.init()` → `tray.init()` → `relay.start()`. `powerMonitor` `resume` and
  `unlock-screen` call `relay.pollNow()`. `before-quit` → `relay.stop()`. There is
  deliberately **no network-change watcher**: with polling, a failed poll just succeeds
  on the next one, so the old 5s interface-fingerprint timer was pure overhead.
- **`src/main/tray.ts`** — owns the menubar popover, the Settings window, and every
  `stash:*` IPC handler. Opening the popover fires `pollNow()`. The renderer is pushed
  a fresh list on `link-added` / `link-updated` / `links-changed`; the tray icon
  switches between idle and unread on the same signals.
- **`src/renderer/stashover.*`** — the popover itself: one card per link (favicon,
  title, description, source · age), a trash button that clears all, and a gear that
  opens Settings. **Clicking a card copies the link and then removes it** (a 220ms
  checkmark, then `removeLink`); the open-in-browser button stops propagation.
- **`src/main/favicon.ts`** — per-hostname favicon fetch + cache for the popover cards.
- **`src/main/metadata.ts`** — link title/description/`og:site_name` enrichment, fetched
  once per link on arrival and written back through `store.updateLinkMetadata`.

## 6. Build & run

**Mac:**
```bash
cd stash-mac && pnpm install && npm run build && npm start   # or: npm run dev
./node_modules/.bin/tsc -p tsconfig.json --noEmit            # typecheck only
npm run dist                                                 # DMG → release/
```

`pnpm-workspace.yaml` must keep `allowBuilds: electron: true`, or pnpm skips
Electron's postinstall and the binary is never downloaded ("Electron failed to install
correctly"). Packaging is configured by the **`build` field in `package.json`**;
`electron-builder.yml` is stale and ignored (electron-builder logs which one it
loaded). Only `package.json` carries the `extraResources` entry that bundles
`stash.secret.json`, which is why a DMG install needs no configuration.

**Android:** requires a **JDK 17–21** (Gradle 8.5 cannot parse JDK 26 — if you see
`IllegalArgumentException: 26` at settings evaluation, that's the JDK). The Android
Studio JBR works:
```bash
cd stash-android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug      # or installDebug onto a device
```

Make sure `stash-android/secrets.properties` and `stash-mac/stash.secret.json` exist
with the **same** secret value (or the two sides use different streams/keys and
nothing arrives) **and** with the same Upstash URL/token (or there's no relay to talk
to at all).

## 7. Test matrix (the behaviors that must hold)

Watch the Mac menu **and** the Android Links screen:

1. **Both online** — share a URL → toast "Sent to Mac" immediately (no network wait
   beyond the publish) → the link appears in the menu within a poll cycle (≤30s while
   the Mac is in use, sooner if you open the menu). Share plain text → same, `text`
   kind.
2. **Mac quit / asleep** — share → still "Sent to Mac", because the entry is durably
   stored. Launch or wake the Mac → it polls immediately and drains everything that
   accumulated, in order, 100 entries per page, back to back. Works up to the 30-day
   retention.
3. **Phone offline** — airplane mode → share → "Saved, will send when back online";
   restore connectivity **on mobile data** (not just Wi-Fi) → auto-delivers, and the
   next share also flushes the backlog. *(The headline win.)*
4. **Office / hostile Wi-Fi** — same SSID with AP isolation → still delivers (relay).
5. **Restart Mac twice** — no duplicate links (`cursor` persisted). Delete `cursor` in
   `stash-relay.json`, restart → the retained stream replays and still produces no
   dupes, because `store.addLink` dedupes by canonical url/text.
6. **Wrong secret** on one side → nothing on the Mac, no crash. Note the phone still
   reports SENT: it published successfully, and it has no way to know the Mac can't
   read it. Mismatched secrets are silent by design.
7. **Oversize** — a >2800-byte share is rejected at the share sheet.
8. **Mac Wi-Fi toggle / sleep-resume** — the menu's status row flips to Connected on
   the next answered poll; anything published meanwhile arrives on that same poll.
9. **Garbage in the stream** — `XADD` an entry with a junk `body` (or no `body` field)
   by hand; the Mac drops it, advances past it, and later valid entries still arrive.
10. **App killed mid-send** — record survives PENDING (write-ahead) and flushes later.
11. **Menu behavior** — >15 links produces an `Older (n)` submenu; clicking a row
    copies it and removes it; ⌥-clicking opens it in the browser and removes it;
    Launch at Login round-trips through `store.updateSettings`.
12. **Idle backoff** — leave the Mac untouched >5 min and confirm polls space out to
    5 min, then that touching it (or opening the menu) resumes 30s polling.

## 8. Gotchas for future edits

- **Keep the crypto byte-compatible.** `util/Crypto.kt` and the helpers in `relay.ts`
  must agree exactly: key = `SHA-256("key:"+secret)`, stream name from `"topic:main:"`
  (the `topic:` prefix is kept so existing streams still resolve), body =
  `base64(IV(12)||ct||tag(16))` no-wrap. Change one side → change both.
- **The 2800/4096-byte caps are ours, not the relay's** — kept from the ntfy era to
  bound payload size. Oversize envelopes FAIL at publish time.
- **The cursor is always a Redis stream id, never a wall clock** — this is what makes
  the system skew-proof. The Mac stores `cursor` in `stash-relay.json`. The only
  wall-clock use is the 30-day `XTRIM MINID`, which is best-effort by design.
- **A bad entry must never wedge the stream.** Undecryptable/malformed entries are
  dropped *and* the cursor advances past them. The one exception is a local storage
  failure, which holds the cursor so the entry is retried.
- **Don't reintroduce acks.** SENT-on-publish is correct *because* the stream is
  durable and the cursor is exactly-once. If you ever need "the Mac has seen this",
  that is a new feature, not a fix.
- **Removal is silent and unconfirmed.** Clicking a card deletes it, and the trash
  button clears everything with no dialog. There are no backups of
  `stash-store.json`. Treat any change near removal as data-loss-sensitive.
- **Never trim PENDING records.** Only terminal records are capped/cleared.
- **Never commit the real secret** (`secrets.properties` / `stash.secret.json` are
  gitignored).
- **Search with the `fff` MCP tools**, not raw grep/find (repo convention).
