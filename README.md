# stash

Mac menubar receiver plus Android share target for sending links from phone to laptop on the same Wi-Fi. No cloud, no accounts, no database.

## Apps

- `stash-mac`: Electron menubar app. Receives authenticated HTTP posts, advertises via Bonjour, stores links locally.
- `stash-android`: Kotlin Android app. Appears in the Android share sheet, discovers the Mac via NSD, sends immediately or queues offline.

## Mac Development

```sh
cd stash-mac
npm install
npm run dev
```

The app hides from the Dock and opens from the menu bar. On first launch it opens Settings with a pairing QR.

## Android Development

Open `stash-android` in Android Studio, or build from the command line:

```sh
cd stash-android
./gradlew assembleDebug
```

Install the debug APK, open `stash`, scan the Mac QR, then share any HTTP/HTTPS link to `stash` from Android.

## Release Builds

Mac DMG:

```sh
cd stash-mac
npm run dist
```

Notarization uses these environment variables when present:

- `NOTARIZE_APPLE_ID`
- `NOTARIZE_APPLE_ID_PASSWORD`
- `NOTARIZE_TEAM_ID`

Android release APK:

```sh
cd stash-android
./gradlew assembleRelease
```

Configure signing credentials in Android Studio or a local Gradle signing config before distributing outside local sideloading.

## macOS Permissions

macOS 15+ requires local-network permission for Bonjour/local LAN traffic. `electron-builder.yml` includes:

- `NSLocalNetworkUsageDescription`
- `NSBonjourServices` with `_stash._tcp`

If discovery fails on a clean Mac, check System Settings permissions and the firewall prompt.

## Acceptance Checklist

- Pair a fresh Android install with the Mac QR in under 30 seconds.
- Share a link while Mac is awake; it appears in the stashover within 1 second.
- Click a row; it copies the URL and removes the row.
- Click the open icon; it opens the URL and keeps the row.
- Sleep or quit the Mac, share several links, wake the Mac; queued links flush in order.
- Enable notifications in Mac settings; new links show a native notification.
- Reset Mac secret; Android shows the re-pair path on the next unauthorized send.

## Troubleshooting

- Phone cannot find Mac: make sure both devices are on the same Wi-Fi and macOS local-network permission is allowed.
- Requests hang: verify the Mac firewall allowed incoming connections for `stash`.
- Android says bad secret: reset pairing by scanning the QR again.
- Titles or favicons are missing: some sites block local metadata fetches; the hostname fallback is expected.
