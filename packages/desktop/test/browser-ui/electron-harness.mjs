import { _electron as electron } from "playwright-core";
import { existsSync, mkdirSync, copyFileSync, cpSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "D:/ZCode-src";
const ELECTRON_EXE = resolve(REPO, "node_modules/electron/dist/electron.exe");
const DESKTOP = resolve(REPO, "packages/desktop");

/**
 * Launch the built desktop app under Playwright's Electron driver with an
 * isolated profile. Trusted input via CDP; the real user profile is untouched.
 *
 * @param {object} opts
 * @param {string} opts.homeDir isolated HOME — holds .zcode (db, logs, sessions)
 * @param {boolean} [opts.copyRealDb] seed the isolated home with the real db
 * @param {string[]} [opts.extraArgs]
 */
export async function launchDevApp({
  homeDir = "D:/tmp/bb-dev-home",
  copyRealDb = true,
  extraArgs = [],
} = {}) {
  const home = resolve(homeDir);
  const zcodeDir = resolve(home, ".zcode/cli/db");
  mkdirSync(zcodeDir, { recursive: true });
  mkdirSync(resolve(home, "AppData/Roaming"), { recursive: true });
  mkdirSync(resolve(home, "AppData/Local"), { recursive: true });
  if (copyRealDb) {
    for (const f of ["db.sqlite", "db.sqlite-shm", "db.sqlite-wal"]) {
      const src = resolve("C:/Users/babys/.zcode/cli/db", f);
      if (existsSync(src)) copyFileSync(src, resolve(zcodeDir, f));
    }
    // Workspace/session-list/onboarding state lives in the v2 trees, not the DB.
    if (!existsSync(resolve(home, ".seeded-v2"))) {
      const skip = new Set([
        "logs",
        "log",
        "cache",
        "caches",
        "crash",
        "bot-attachments",
        "image-cache",
        "pdf-cache",
        "tmp",
        "node_modules",
        "debug",
      ]);
      const filter = (src) => !src.split(/[\\/]/).some((seg) => skip.has(seg));
      for (const tree of ["C:/Users/babys/.zcode", "C:/Users/babys/.blackbird"]) {
        if (!existsSync(tree)) continue;
        const name = tree.endsWith(".blackbird") ? ".blackbird" : ".zcode";
        cpSync(tree, resolve(home, name), { recursive: true, filter, force: true, errorOnExist: false });
      }
      writeFileSync(resolve(home, ".seeded-v2"), String(Date.now()));
    }
  }

  const app = await electron.launch({
    executablePath: ELECTRON_EXE,
    cwd: DESKTOP,
    args: [
      ".",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
      ...extraArgs,
    ],
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      APPDATA: resolve(home, "AppData/Roaming"),
      LOCALAPPDATA: resolve(home, "AppData/Local"),
      ZCODE_FORK_IDENTITY: "blackbird",
    },
    timeout: 60_000,
  });
  return app;
}

/** Wait for the main window whose URL is the renderer index. */
export async function firstRendererWindow(app, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const w of app.windows()) {
      const url = w.url();
      if (url.includes("renderer/index.html") || url.startsWith("file://")) {
        return w;
      }
    }
    if (Date.now() > deadline) throw new Error("renderer window not found");
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Dismiss first-run onboarding if it is showing. */
export async function dismissOnboarding(win) {
  for (const sel of ["Skip", "Next"]) {
    const b = win.locator("button", { hasText: new RegExp(`^${sel}$`) });
    if (await b.count()) {
      await b.first().click().catch(() => {});
      await win.waitForTimeout(900);
    }
  }
  const exit = win.getByLabel("Exit onboarding");
  if (await exit.count()) {
    await exit.first().click().catch(() => {});
    await win.waitForTimeout(900);
  }
}

/**
 * Open a session by its sidebar row testid, retrying until the timeline mounts.
 * Returns the mounted state ({units, vhH}).
 */
export async function openSession(win, sessionId, { attempts = 5, timeoutMs = 90_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const row = win.locator(`[data-testid="task-item-${sessionId}"]`);
    if (await row.count()) {
      await row.first().scrollIntoViewIfNeeded().catch(() => {});
      await row.first().click({ force: true, timeout: 10_000 }).catch(() => {});
    }
    const deadline = Date.now() + timeoutMs / attempts;
    for (;;) {
      const state = await win.evaluate(() => ({
        units: document.querySelectorAll("[data-v4-turn-unit]").length,
        vhH: Math.round(
          document.querySelector("[data-v4-timeline-virtual-history]")?.getBoundingClientRect().height ?? 0,
        ),
      }));
      if (state.units > 0) return state;
      if (Date.now() > deadline) break;
      await win.waitForTimeout(1500);
    }
  }
  return { units: 0, vhH: 0 };
}
