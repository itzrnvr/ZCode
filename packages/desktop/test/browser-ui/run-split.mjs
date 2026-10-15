import { launchDevApp, firstRendererWindow, dismissOnboarding, openSession, waitQuiet, frameHealth } from "./electron-harness.mjs";

const TARGET_SESSION = process.env.BB_SESSION ?? "sess_f332e77a-04ab-4322-b483-f1d7932fbef1";
const app = await launchDevApp({});
const win = await firstRendererWindow(app);

const INSTALL = () => {
  const w = window;
  w.__toggle = { deltas: [], loaf: [], t0: performance.now(), lastT: null };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__toggle.loaf.push(Math.round(e.duration));
      if (w.__toggle.loaf.length > 80) w.__toggle.loaf.splice(0, w.__toggle.loaf.length - 80);
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
};

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};

async function runSeries(label, action, repeats = 4) {
  const results = [];
  for (let i = 0; i < repeats; i++) {
    await waitQuiet(win, { quietMs: 1200, maxWaitMs: 12_000 });
    const mark = await win.evaluate(() => Math.round(performance.now() - window.__toggle.t0));
    await action(i);
    await win.waitForTimeout(1700);
    const out = await win.evaluate(() => {
      const p = window.__toggle;
      const res = { deltas: p.deltas.slice(), loaf: p.loaf.slice() };
      p.deltas.length = 0;
      p.loaf.length = 0;
      return res;
    });
    const rel = out.deltas.filter((x) => x.t >= mark - 60 && x.t <= mark + 1750).map((x) => x.d);
    results.push({
      maxGap: rel.length ? Math.round(Math.max(...rel) * 10) / 10 : 0,
      loafMs: out.loaf.reduce((a, b) => a + b, 0),
      loaf: out.loaf,
    });
  }
  console.log(
    `${label.padEnd(20)} | medianMaxGap=${median(results.map((r) => r.maxGap))}ms | medianLoaf=${median(results.map((r) => r.loafMs))}ms | details=${JSON.stringify(results.map((r) => [r.maxGap, r.loaf]))}`,
  );
}

try {
  await win.waitForTimeout(8000);
  await dismissOnboarding(win);
  const mounted = await openSession(win, TARGET_SESSION);
  console.log("mounted:", JSON.stringify(mounted), "| frameHealth:", await frameHealth(win), "ms");
  await win.evaluate(INSTALL);
  await win.waitForTimeout(500);

  // A: real React toggle
  await runSeries("REACT-TOGGLE", async () => {
    await win.locator('button[aria-label="Toggle sidebar"]').first().click({ timeout: 8_000 });
  });

  // B: pure CSS var flip (no React at all)
  await runSeries("VAR-ONLY", async (i) => {
    await win.evaluate((collapse) => {
      const shell = document.querySelector('[data-workspace-shell="true"]');
      if (!shell) return;
      shell.style.setProperty("--workspace-sidebar-panel-width", collapse ? "4px" : "264px");
    }, i % 2 === 0);
  });

  // C: real toggle with the width transition disabled
  await win.evaluate(() => {
    const s = document.createElement("style");
    s.id = "__noTrans";
    s.textContent =
      '[data-workspace-sidebar-panel="true"] { transition-property: opacity !important; } ' +
      '[data-v4-timeline-content-column="true"] { transition-property: transform !important; }';
    document.head.appendChild(s);
  });
  await runSeries("REACT-NOTRANSITION", async () => {
    await win.locator('button[aria-label="Toggle sidebar"]').first().click({ timeout: 8_000 });
  });
} finally {
  await app.close().catch(() => {});
}
