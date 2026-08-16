# stash

Send links and text from your Android phone to a Mac menubar app — from **any** network (home Wi-Fi, office, mobile data). No accounts, no cloud database, no pairing, no same-Wi-Fi requirement.

Delivery rides on an [Upstash](https://upstash.com) Redis Stream, but everything is **end-to-end encrypted** (AES-256-GCM). A single shared secret — baked into both apps at build time — is the only thing that ties your phone to your Mac. The relay only ever stores ciphertext.

Because the relay *stores* messages (30-day retention) rather than broadcasting them, your Mac doesn't have to be awake. Share something with the laptop shut; it's waiting there the next time the app polls.

## Apps

- `stash-mac`: Electron menubar app. Polls the relay stream, decrypts incoming links, and lists them in a **menubar popover** with title, description, and favicon.
- `stash-android`: Kotlin app. Appears in the Android share sheet, encrypts what you share, publishes it to the relay, and queues on disk if you're offline.

---

## Setup

### Step 1 — Create the shared secret (do this first)

Both apps must be built with the **exact same** secret. Generate one:

```sh
openssl rand -base64 24
```

Then write that identical value into **both** files (both are gitignored — the secret never lands in git):

### Step 2 — Create an Upstash Redis database

Create a free Redis database at [console.upstash.com](https://console.upstash.com) and copy its **REST URL** and **REST token**. This is the relay; both apps talk to it directly over HTTPS.

### Step 3 — Write both into the two gitignored files

**`stash-mac/stash.secret.json`**
```json
{
  "sharedSecret": "PASTE_THE_SAME_SECRET_HERE",
  "upstashRedisRestUrl": "https://your-db.upstash.io",
  "upstashRedisRestToken": "PASTE_THE_REST_TOKEN"
}
```

**`stash-android/secrets.properties`**
```properties
STASH_SHARED_SECRET=PASTE_THE_SAME_SECRET_HERE
UPSTASH_REDIS_REST_URL=https://your-db.upstash.io
UPSTASH_REDIS_REST_TOKEN=PASTE_THE_REST_TOKEN
```

> If the shared secrets differ by even one character, the apps derive different relay streams and encryption keys, and nothing will arrive. This is the #1 thing to double-check.

Both apps also accept `STASH_SHARED_SECRET`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` as environment variables, which take priority over the files.

### Step 4 — Install on Mac

Requires Node.js + [pnpm](https://pnpm.io).

```sh
cd stash-mac
pnpm install
pnpm run dist
open release/stash-0.1.0-arm64.dmg
```

In the DMG window, drag `stash` into **Applications**, then launch it. It runs **in the menu bar only**: no dock icon, no window at all. Everything in `stash.secret.json` (shared secret *and* relay credentials) is bundled into the app automatically, so the installed app needs no configuration.

Because the build is unsigned, macOS Gatekeeper blocks it on first launch. Either:

- Right-click the app in Applications → **Open** → **Open**, or
- Clear the quarantine flag:
  ```sh
  xattr -dr com.apple.quarantine /Applications/stash.app
  ```

### Step 5 — Install on Android

Open `stash-android` in **Android Studio**, connect your phone (USB debugging on), pick it in the device picker, and click **Run**. Android Studio handles the JDK and build; the secret and relay credentials from `secrets.properties` are compiled in automatically.

### Step 6 — Use it

From any app on your phone, tap **Share** → **stash**. The link (or text) appears in the Mac menubar menu on its next poll, from any network.

- **Sent to Mac** → it's on the relay stream. Delivery is guaranteed from here: the entry is stored for 30 days and the Mac reads it whenever it next runs.
- **Saved, will send when back online** → your *phone* had no connection. It's on disk and goes out as soon as connectivity returns (or on your next share).

Click the menubar icon to open the popover. Each card shows the favicon, title, description, and source. **Click a card to copy the link — this also removes it from the list.** Use the open button to send it to your browser instead, the trash icon to clear everything, and the gear for settings.

Polling is every 30 seconds while you're using the Mac, backing off to 5 minutes once it's been idle for a while. Waking, unlocking, or just opening the popover forces an immediate check, so nothing sits waiting when you actually go looking for it.

---

## Rotating the secret

Pick a new value, update **both** `stash.secret.json` and `secrets.properties`, then rebuild and reinstall both apps. Old in-flight messages keyed to the previous secret will simply be ignored (they sit in the old streams until the 30-day trim removes them).

The same applies to the Upstash token: rotate it in the console, update both files, rebuild both apps. Note that both the secret and the token are extractable from the APK and the DMG, so treat build artifacts as sensitive.

## Release builds

**Android release APK** (configure signing in Android Studio or a Gradle signing config first):

```sh
cd stash-android
./gradlew assembleRelease
```

**Mac** builds are currently unsigned/un-notarized (fine for personal use). For a signed/notarized build you'd need an Apple Developer ID; the packaging metadata lives in `stash-mac/package.json` under the `build` field.

## Troubleshooting

- **Nothing arrives on the Mac.** Almost always a secret mismatch — verify `stash.secret.json` and `secrets.properties` hold byte-for-byte identical values, then rebuild both. The Mac logs `shared secret configured = true` and `relay credentials configured = true` on startup; if either says `false` (or it warns about a PLACEHOLDER), that file wasn't found or is missing a field.
- **The popover header says "Offline".** The Mac can't reach the relay: check the Upstash URL/token, and that the database still exists in the console. Note the phone will still say "Sent to Mac" in this case, because publishing succeeded; the phone has no way to know the Mac is unreachable.
- **A link takes up to 30 seconds to appear.** That's the poll interval, by design (5 minutes if the Mac has been idle). Opening the popover, waking, or unlocking forces an immediate poll.
- **No menubar icon after install.** Reinstall from the latest `release/stash-0.1.0-arm64.dmg` (quit the old copy first with `killall stash`), then replace the app in Applications.
- **App shows in the dock.** It shouldn't — the packaged app sets `LSUIElement`, making it menubar-only. If you see a dock icon, you're running an older build; rebuild and reinstall.
- **Gatekeeper won't open it.** See the `xattr` command in Step 2.
- **Titles are missing.** Some sites block metadata fetches; the hostname fallback is expected.

## Architecture

See [`CONTEXT.md`](CONTEXT.md) for the full design: the encrypted wire protocol, how the secret derives the relay stream name and key, why delivery needs no acknowledgements, and per-app implementation notes.
