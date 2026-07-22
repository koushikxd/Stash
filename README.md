# stash

Send links and text from your Android phone to a Mac menubar app — instantly, from **any** network (home Wi-Fi, office, mobile data). No accounts, no cloud database, no pairing, no same-Wi-Fi requirement.

Delivery rides on the free public [ntfy.sh](https://ntfy.sh) relay, but everything is **end-to-end encrypted** (AES-256-GCM). A single shared secret — baked into both apps at build time — is the only thing that ties your phone to your Mac. ntfy only ever sees ciphertext, and neither side needs an ntfy account.

## Apps

- `stash-mac`: Electron menubar app. Subscribes to the relay, decrypts incoming links, shows them in a popover, and sends encrypted delivery acks.
- `stash-android`: Kotlin app. Appears in the Android share sheet, encrypts what you share, publishes to the relay, and queues offline until it's confirmed delivered.

---

## Setup

### Step 1 — Create the shared secret (do this first)

Both apps must be built with the **exact same** secret. Generate one:

```sh
openssl rand -base64 24
```

Then write that identical value into **both** files (both are gitignored — the secret never lands in git):

**`stash-mac/stash.secret.json`**
```json
{ "sharedSecret": "PASTE_THE_SAME_SECRET_HERE" }
```

**`stash-android/secrets.properties`**
```properties
STASH_SHARED_SECRET=PASTE_THE_SAME_SECRET_HERE
```

> If the two values differ by even one character, the apps derive different relay topics and encryption keys, and nothing will arrive. This is the #1 thing to double-check.

### Step 2 — Install on Mac

Requires Node.js + [pnpm](https://pnpm.io).

```sh
cd stash-mac
pnpm install
pnpm run dist
open release/stash-0.1.0-arm64.dmg
```

In the DMG window, drag `stash` into **Applications**, then launch it. It runs **in the menu bar only** — there is no dock icon. The secret from `stash.secret.json` is bundled into the app automatically.

Because the build is unsigned, macOS Gatekeeper blocks it on first launch. Either:

- Right-click the app in Applications → **Open** → **Open**, or
- Clear the quarantine flag:
  ```sh
  xattr -dr com.apple.quarantine /Applications/stash.app
  ```

### Step 3 — Install on Android

Open `stash-android` in **Android Studio**, connect your phone (USB debugging on), pick it in the device picker, and click **Run**. Android Studio handles the JDK and build; the secret from `secrets.properties` is compiled in automatically.

### Step 4 — Use it

From any app on your phone, tap **Share** → **stash**. The link (or text) appears in the Mac menubar popover within a couple of seconds — from any network.

- **Sent** toast → the Mac confirmed delivery.
- **Sent — Mac will confirm** → published to the relay; it'll flip to confirmed once the Mac (which may be asleep/offline) picks it up.
- **Saved** toast → phone is offline; it auto-delivers the moment connectivity returns.

In the Mac popover, click a row to copy the URL (and remove it), or the open icon to launch it in your browser.

---

## Rotating the secret

Pick a new value, update **both** `stash.secret.json` and `secrets.properties`, then rebuild and reinstall both apps. Old in-flight messages keyed to the previous secret will simply be ignored.

## Release builds

**Android release APK** (configure signing in Android Studio or a Gradle signing config first):

```sh
cd stash-android
./gradlew assembleRelease
```

**Mac** builds are currently unsigned/un-notarized (fine for personal use). For a signed/notarized build you'd need an Apple Developer ID; the packaging metadata lives in `stash-mac/package.json` under the `build` field.

## Troubleshooting

- **Nothing arrives on the Mac.** Almost always a secret mismatch — verify `stash.secret.json` and `secrets.properties` hold byte-for-byte identical values, then rebuild both. The Mac logs `shared secret configured = true` on startup; if it says `false` (or warns about a PLACEHOLDER), the secret file wasn't found.
- **No menubar icon after install.** Reinstall from the latest `release/stash-0.1.0-arm64.dmg` (quit the old copy first with `killall stash`), then replace the app in Applications.
- **App shows in the dock.** It shouldn't — the packaged app sets `LSUIElement`, making it menubar-only. If you see a dock icon, you're running an older build; rebuild and reinstall.
- **Gatekeeper won't open it.** See the `xattr` command in Step 2.
- **Titles or favicons are missing.** Some sites block metadata fetches; the hostname fallback is expected.

## Architecture

See [`CONTEXT.md`](CONTEXT.md) for the full design: the encrypted wire protocol, how the secret derives relay topics and keys, the end-to-end ack/retry model, and per-app implementation notes.
