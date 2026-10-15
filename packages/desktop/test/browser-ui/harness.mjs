import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

/** Serve a directory over http://127.0.0.1:<port> with SPA fallback. */
export function serveDir(root, { port = 5175 } = {}) {
  const absRoot = resolve(root);
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = normalize(decodeURIComponent(url.pathname));
      if (path === "/" || path === "") path = "/index.html";
      let full = join(absRoot, path);
      if (!full.startsWith(absRoot)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(full) || statSync(full).isDirectory()) full = join(absRoot, "index.html");
      const body = readFileSync(full);
      res.writeHead(200, { "Content-Type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((r) =>
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address().port;
      r({ server, port: bound, url: `http://127.0.0.1:${bound}/` });
    }),
  );
}

const CHROMIUM_EXE = resolve(
  process.env.LOCALAPPDATA ?? "",
  "ms-playwright/chromium-1248/chrome-win64/chrome.exe",
);

/**
 * Boot the built renderer in a plain browser with the mock preload bridge.
 * `rendererDir` defaults to packages/desktop/out/renderer.
 */
export async function bootRenderer({
  rendererDir = resolve(here, "..", "..", "out", "renderer"),
  port = 0,
  headless = true,
  viewport = { width: 1479, height: 791 },
  mockBridgePath = resolve(here, "mock-preload-bridge.js"),
} = {}) {
  const { server, url } = await serveDir(rendererDir, { port });
  const browser = await chromium.launch({ headless, executablePath: CHROMIUM_EXE });
  const context = await browser.newContext({ viewport });
  await context.addInitScript({ path: mockBridgePath });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200));
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6000);
  return {
    browser,
    context,
    page,
    url,
    errors,
    async close() {
      await browser.close();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Install the sidebar-toggle perf harness (rAF gaps + LoAF) in the page. */
export async function installToggleHarness(page) {
  await page.evaluate(() => {
    const w = window;
    w.__toggle = { deltas: [], loaf: [], t0: performance.now(), lastT: null };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__toggle.loaf.push(Math.round(e.duration));
        if (w.__toggle.loaf.length > 60) w.__toggle.loaf.splice(0, w.__toggle.loaf.length - 60);
      }).observe({ type: "long-animation-frame", durationThreshold: 20 });
    } catch {}
    const rec = (t) => {
      if (w.__toggle) {
        const last = w.__toggle.lastT ?? t;
        const d = t - last;
        w.__toggle.deltas.push({ t: Math.round(t - w.__toggle.t0), d: Math.round(d * 10) / 10 });
        if (w.__toggle.deltas.length > 6000) w.__toggle.deltas.splice(0, 3000);
        w.__toggle.lastT = t;
      }
      requestAnimationFrame(rec);
    };
    requestAnimationFrame(rec);
  });
}

/** Click the sidebar toggle and return frame-gap stats for the window after it. */
export async function measureToggle(page, { settleMs = 1600 } = {}) {
  const mark = await page.evaluate(() => Math.round(performance.now() - window.__toggle.t0));
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => x.getAttribute("aria-label") === "Toggle sidebar",
    );
    if (!b) return "no-button";
    b.click();
    return "ok";
  });
  await page.waitForTimeout(settleMs);
  const out = await page.evaluate(() => {
    const p = window.__toggle;
    const res = { deltas: p.deltas.slice(), loaf: p.loaf.slice() };
    p.deltas.length = 0;
    p.loaf.length = 0;
    return res;
  });
  const rel = out.deltas.filter((x) => x.t >= mark - 60 && x.t <= mark + settleMs + 50).map((x) => x.d);
  return {
    clicked,
    maxGapMs: rel.length ? Math.max(...rel) : 0,
    over167: rel.filter((d) => d > 16.7).length,
    loafMs: out.loaf.reduce((a, b) => a + b, 0),
    loaf: out.loaf,
  };
}
