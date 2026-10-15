import { launchDevApp, firstRendererWindow, dismissOnboarding, openSession, waitQuiet, frameHealth } from "./electron-harness.mjs";

const TARGET_SESSION = process.env.BB_SESSION ?? "sess_f332e77a-04ab-4322-b483-f1d7932fbef1";
const REPEATS = Number(process.env.BB_REPEATS ?? 6);

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

try {
  await win.waitForTimeout(8000);
  await dismissOnboarding(win);
  const mounted = await openSession(win, TARGET_SESSION);
  console.log("mounted:", JSON.stringify(mounted), "| frameHealth:", await frameHealth(win), "ms");

  await win.evaluate(INSTALL);
  await win.waitForTimeout(500);

  const results = [];
  for (let i = 0; i < REPEATS; i++) {
    await waitQuiet(win, { quietMs: 1500, maxWaitMs: 15_000 });
    const mark = await win.evaluate(() => Math.round(performance.now() - window.__toggle.t0));
    await win.locator('button[aria-label="Toggle sidebar"]').first().click({ timeout: 8_000 });
    await win.waitForTimeout(1700);
    const out = await win.evaluate(() => {
      const p = window.__toggle;
      const res = { deltas: p.deltas.slice(), loaf: p.loaf.slice() };
      p.deltas.length = 0;
      p.loaf.length = 0;
      return res;
    });
    const rel = out.deltas.filter((x) => x.t >= mark - 60 && x.t <= mark + 1750).map((x) => x.d);
    const r = {
      maxGap: rel.length ? Math.round(Math.max(...rel) * 10) / 10 : 0,
      over167: rel.filter((d) => d > 16.7).length,
      loafMs: out.loaf.reduce((a, b) => a + b, 0),
      loaf: out.loaf,
    };
    results.push(r);
    console.log(`T${i}: maxGap=${r.maxGap}ms >16.7ms=${r.over167} loafMs=${r.loafMs} ${JSON.stringify(r.loaf.slice(0, 6))}`);
  }

  console.log(
    `MEDIAN(${REPEATS}) | maxGap=${median(results.map((r) => r.maxGap))}ms | loafMs=${median(results.map((r) => r.loafMs))} | >=50ms frames total=${results.reduce((a, r) => a + r.loaf.filter((d) => d >= 50).length, 0)}`,
  );
} finally {
  await app.close().catch(() => {});
}
