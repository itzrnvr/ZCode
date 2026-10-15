import { launchDevApp, firstRendererWindow } from "./electron-harness.mjs";

const TARGET_SESSION = "sess_f332e77a-04ab-4322-b483-f1d7932fbef1";
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

async function toggleOnce(label) {
  const mark = await win.evaluate(() => Math.round(performance.now() - window.__toggle.t0));
  const btn = win.locator('button[aria-label="Toggle sidebar"]');
  await btn.first().click({ force: true });
  await win.waitForTimeout(1700);
  const out = await win.evaluate(() => {
    const p = window.__toggle;
    const res = { deltas: p.deltas.slice(), loaf: p.loaf.slice() };
    p.deltas.length = 0;
    p.loaf.length = 0;
    return res;
  });
  const rel = out.deltas.filter((x) => x.t >= mark - 60 && x.t <= mark + 1750).map((x) => x.d);
  const maxGap = rel.length ? Math.max(...rel) : 0;
  console.log(
    `${label.padEnd(14)} | maxGap=${Math.round(maxGap * 10) / 10}ms | >16.7ms=${rel.filter((d) => d > 16.7).length} | loafMs=${out.loaf.reduce((a, b) => a + b, 0)}ms | loaf=${JSON.stringify(out.loaf.slice(0, 8))}`,
  );
}

async function setCss(css) {
  await win.evaluate((c) => {
    const s = document.getElementById("__exp") || document.createElement("style");
    s.id = "__exp";
    s.textContent = c;
    document.head.appendChild(s);
  }, css);
}

try {
  await win.waitForTimeout(8000);
  for (const sel of ["Skip", "Next"]) {
    const b = win.locator("button", { hasText: new RegExp(`^${sel}$`) });
    if (await b.count()) { await b.first().click().catch(() => {}); await win.waitForTimeout(1000); }
  }
  const exit = win.getByLabel("Exit onboarding");
  if (await exit.count()) { await exit.first().click().catch(() => {}); await win.waitForTimeout(1000); }

  // resize dev window to match the user's real window
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setBounds({ x: 60, y: 40, width: 1479, height: 791 });
  });
  await win.waitForTimeout(1500);

  const rows = win.locator(`[data-testid="task-item-${TARGET_SESSION}"]`);
  if (await rows.count()) { await rows.first().scrollIntoViewIfNeeded(); await rows.first().click({ force: true }); }
  let m = null;
  for (let i = 0; i < 20; i++) {
    await win.waitForTimeout(3000);
    m = await win.evaluate(() => ({
      units: document.querySelectorAll("[data-v4-turn-unit]").length,
      vhH: Math.round(document.querySelector("[data-v4-timeline-virtual-history]")?.getBoundingClientRect().height ?? 0),
      w: Math.round(document.querySelector("[data-v4-timeline-virtual-history]")?.getBoundingClientRect().width ?? 0),
    }));
    if (m.units > 0) break;
  }
  console.log("mounted:", JSON.stringify(m));
  const width = await win.evaluate(() => window.innerWidth);
  console.log("window inner width:", width);

  await win.evaluate(INSTALL);
  await win.waitForTimeout(2500);

  console.log("--- baseline (shipped css)");
  await toggleOnce("BASE#0");
  await toggleOnce("BASE#1");

  console.log("--- mask disabled");
  await setCss('[class*="mask"] { -webkit-mask-image: none !important; mask-image: none !important; } [style*="mask"] { -webkit-mask-image: none !important; mask-image: none !important; }');
  await toggleOnce("NOMASK#0");
  await toggleOnce("NOMASK#1");

  console.log("--- all transitions off");
  await setCss('* { transition: none !important; }');
  await toggleOnce("NOTRANS#0");
  await toggleOnce("NOTRANS#1");

  await setCss("");
} finally {
  await app.close().catch(() => {});
}
