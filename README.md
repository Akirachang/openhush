# OpenHush

Local, free AI noise removal for audio and video on your Mac. Drop in recordings and get back cleaned copies. Nothing is uploaded: everything runs on your machine with [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet). An optional **Heavy repair** mode uses [Resemble Enhance](https://github.com/resemble-ai/resemble-enhance) for badly damaged speech.

- **Formats:** `wav mp3 m4a flac` audio and `mp4 mov mkv` video.
- **Video:** the picture is copied bit-for-bit, never re-encoded. Only the main audio track is replaced, in sync. Subtitles, other audio tracks and metadata are kept.
- **Output:** cleaned files are saved next to the originals as `<name>_clean.<ext>`. Originals are never touched, and nothing is ever overwritten; you get `(2)`, `(3)` and so on instead.
- **Long files:** hour-long files work in constant memory, about 85 s for 70 minutes of stereo on an M5 Pro.

## Install

On a Mac with Apple Silicon, run:

```bash
brew install ffmpeg      # if you don't have it
curl -fsSL https://raw.githubusercontent.com/Akirachang/openhush/main/install.sh | bash
```

This installs the latest release into **Applications** after checking its SHA-256 checksum and signature, then opens it. From then on, OpenHush updates itself (see [Updates](#updates)).

On first launch it downloads the DeepFilterNet3 engine (28 MB, checked against a pinned SHA-256). After that it works offline.

### Build it yourself

You need [uv](https://docs.astral.sh/uv/) and Node 22+ as well:

```bash
cd ~/Desktop/coding/openhush
npm run setup                                       # installs JS + Python dependencies
npm run dist                                        # builds dist/mac-arm64/OpenHush.app
```

Then drag `dist/mac-arm64/OpenHush.app` into **Applications**.

### Launch without building the app

```bash
npm start      # builds the UI once and opens the app
npm run dev    # development: live-reloading UI
```

## Using it

1. **Add files.** Drop files or folders anywhere in the window, or press ⌘O.
2. **Preview** (centre panel):
   - Drag the highlighted part of the whole-file strip to choose a 15-second section, then press **Play** (Space).
   - **Tab** flips between **Original** and **Cleaned** at the same moment, so you can A/B them. **A** and **B** pick a side directly.
   - Click the waveform to jump around in the section.
3. **Settings** (right panel):
   - **Strength** is the most noise to remove (6–100 dB). Lower sounds more natural.
   - **Mix** blends some of the original back in. Changes are heard live; Strength changes re-render the preview automatically.
4. **Clean.** Press **Clean N files** (⌘↩). Progress and time left appear in the queue and the Batch section. **Cancel** stops right away and leaves no partial files. Double-click a finished file to show it in Finder.
5. **Appearance:** light, dark, or match the system. Use the title-bar button or View › Appearance.

### Heavy repair

Tick **Heavy repair** for very noisy or muffled speech.
- **First use:** it asks before a one-time 1.6 GB download (PyTorch plus the model) into its own environment.
- **Speed:** it runs on the Apple GPU at about 3× real time, compared with about 40× for normal cleaning.
- **The voice can change.** It rebuilds the voice, so the result can sound slightly different. That's also why Mix is fixed at 100%.

## Updates

OpenHush checks GitHub Releases when it starts and every 6 hours. You can also check yourself with **OpenHush › Check for Updates…**.

1. When a new version is out, a banner shows **OpenHush x.y.z is available**, with **Update** and **What's new**.
2. **Update** downloads it in the background and checks its SHA-256 checksum, signature and version before using it.
3. **Restart to update** quits OpenHush, swaps in the new version where the app lives, and reopens it. If you're cleaning files, it waits until they're finished.

Your settings, the downloaded engine and Heavy repair live outside the app, so nothing is downloaded again. If OpenHush can't replace itself (for example, it's running from a read-only folder or straight from Downloads), the banner links to the download instead.

Updates aren't fully silent, because that would need an Apple Developer ID.

## Releasing a new version

```bash
npm version minor          # or patch / major: bumps package.json and creates the matching v-tag
git push --follow-tags     # the Release workflow builds and publishes it
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds `OpenHush.app` on an Apple Silicon runner, then publishes `OpenHush-mac-arm64.zip` and its `.sha256` as a GitHub Release with notes generated from the commits. Installed copies pick it up at their next check.

## How it's built

```
openhush/
├── engine/    Python: decode → chunked DeepFilterNet3 → mix → encode/remux (ffmpeg); JSON-lines server
├── desktop/   Electron main process: window, menus, dialogs, spawns the engine, bridges it to the UI
├── ui/        Next.js (static export) + Tailwind: the interface (Web Audio for gapless A/B)
├── build/     icon, engine freezing script
└── tests/e2e/ Playwright tests that drive the real app
```

- **Engine ↔ app:** the engine is a separate process that speaks newline-delimited JSON over stdin/stdout. No network port is opened. When the app quits, the engine cancels its work and exits.
- **Packaged app:** the engine is frozen with PyInstaller and ships inside `OpenHush.app`, along with `uv` for installing Heavy repair.
- **Security:** the UI runs sandboxed with context isolation and a strict content-security policy. It can only reach the engine through a small preload API.

## Tests

```bash
npm run test:engine                       # engine: formats, video sync, errors, server protocol (~30 s)
(cd engine && uv run pytest -m slow)      # 70-minute files + Heavy repair (~5 min)
npm run test:e2e                          # the real app: add → preview → A/B → clean, cancel, crash recovery, keyboard
OPENHUSH_APP=dist/mac-arm64/OpenHush.app npx playwright test   # same, against the packaged app, plus self-update
```

`engine/scripts/make_test_media.py` generates the noisy test clips (macOS `say` plus synthetic noise). The tests create them automatically when needed.

## Where things live

| What | Where |
|---|---|
| Engine binary, Heavy repair | `~/Library/Application Support/OpenHush/engine/` |
| App settings | `~/Library/Application Support/OpenHush/` |
| Logs | `~/Library/Logs/OpenHush/` (`app.log`, `engine.log`, `heavy-worker.log`) |

To uninstall, delete `OpenHush.app` and the two folders above.

## Known limitations

- **Signing:** the app is ad-hoc signed, not with an Apple Developer ID. The installer and in-app updates download it themselves, so macOS doesn't warn. If you download the zip from the Releases page in a browser instead, open the app the first time with right-click › Open.
- **Platform:** it's tested on Apple Silicon only.
- **Video:** only the main (default) audio track of a video is cleaned.
- **Heavy repair:** the repaired voice is mono, copied to every channel.

## License

OpenHush is released under the [MIT License](LICENSE).

It relies on other projects, which keep their own licenses. None of them are stored in this repository:

| Component | License | How OpenHush uses it |
|---|---|---|
| [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (code and model weights) | MIT or Apache-2.0 | `deep-filter` binary downloaded on first launch |
| [Resemble Enhance](https://github.com/resemble-ai/resemble-enhance) | MIT | Downloaded only if you install Heavy repair |
| [ffmpeg](https://ffmpeg.org) | LGPL/GPL, depending on the build | Your own installed copy (e.g. Homebrew); not bundled |
| [uv](https://github.com/astral-sh/uv) | MIT or Apache-2.0 | Bundled inside the packaged app to install Heavy repair |
| Electron, Next.js, React, numpy, soundfile and other dependencies | Their own (mostly MIT/BSD) | Installed from npm and PyPI |
