# browser-ui — dev-variant UI harness (Playwright)

Automated UI measation for the desktop renderer without touching the user's live app.

## What it is

1. **Playwright Electron driver** (`electron-harness.mjs`) — launches the built dev app
   (`packages/desktop/out`, i.e. the current source) with an isolated home at
   `D:/tmp/bb-dev-home` seeded from the real profile (DB + `.zcode`/`.blackbird` v2
   state, minus logs/caches). The real profile is never modified.
   - Trusted input via CDP (real clicks), no focus games for the *measured* window —
     the dev window is its own window; the live Blackbird stays untouched.
   - Occlusion/rAF throttling disabled with
     `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
     --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion`.
2. **Browser-only variant** (`harness.mjs` + `mock-preload-bridge.js`) — serves
   `out/renderer` over http and boots it in stock Chromium with a Proxy `window.zcode`
   stub. Boots the splash but the business root waits for the host MessagePort
   (DatabaseStartupState handshake), so full-app flows go through the Electron driver
   instead. Useful for pure-renderer/component work.
3. **Measurement helpers** — rAF gap sampler (frame drops; 165–175 Hz display ⇒ any
   frame > ~6 ms is a drop), LoAF observer (long animation frames), trusted clicks.

## Run

```bash
cd packages/desktop
node test/browser-ui/run-measure.mjs     # open the big session, page history, toggle perf
node test/browser-ui/run-ab.mjs          # toggle A/B: mask off, transitions off
node test/browser-ui/run-decompose.mjs   # toggle cost split: conversation vs sidebar vs shell
```

Prereqs: `packages/desktop` built (`pnpm run build:no-runtime-assets`), Playwright's
chromium present at `%LOCALAPPDATA%/ms-playwright/chromium-1248` (only needed for the
browser-only variant).

## Known flakiness

- The sidebar row click does not always navigate on the first try; `openSession()`
  retries. If the timeline never mounts, check the dev log
  (`D:/tmp/bb-dev-home/.blackbird/v2/logs/`) for the host agent spawn.
- First launch after seeding copies ~2 GB of profile state (once; marker `.seeded-v2`).
- Playwright's bundled Chromium version must match `playwright-core`'s expectation or
  pass `executablePath` (harness does).
