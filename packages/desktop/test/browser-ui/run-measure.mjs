import { launchDevApp, firstRendererWindow } from "./electron-harness.mjs";

const TARGET_SESSION = "sess_f332e77a-04ab-4322-b483-f1d7932fbef1";

const INSTALL = () => {
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
};

const app = await launchDevApp({});
const win = await firstRendererWindow(app);

try {
  await win.waitForTimeout(9000);
  // dismiss first-run onboarding if present
  for (const sel of ["Skip", "Next", "Exit onboarding"]) {
    const btn =
      sel === "Exit onboarding"
        ? win.getByLabel(sel)
        : win.locator("button", { hasText: new RegExp(`^${sel}$`) });
    if (await btn.count()) {
      await btn.first().click().catch(() => {});
      await win.waitForTimeout(1200);
    }
  }
  await win.waitForTimeout(3000);

  // ── Part 1: open the big session and page history to the top ──
  const rows = win.locator(`[data-testid="task-item-${TARGET_SESSION}"]`);
  const rowCount = await rows.count();
  if (rowCount === 0) {
    console.log("open: row-not-found");
  } else {
    await rows.first().scrollIntoViewIfNeeded();
    await rows.first().click({ force: true });
    console.log("open: clicked (rows=" + rowCount + ")");
  }

  let mounted = null;
  for (let i = 0; i < 30; i++) {
    await win.waitForTimeout(3000);
    mounted = await win.evaluate(() => ({
      units: document.querySelectorAll("[data-v4-turn-unit]").length,
      vhH: Math.round(document.querySelector("[data-v4-timeline-virtual-history]")?.getBoundingClientRect().height ?? 0),
      firstTid: document.querySelector("[data-v4-turn-unit]")?.getAttribute("data-turn-id") ?? null,
    }));
    if (mounted.units > 0 && mounted.vhH > 8000) break;
  }
  console.log("mounted:", JSON.stringify(mounted));

  // page history up
  for (let i = 0; i < 10; i++) {
    await win.evaluate(() => {
      const vh = document.querySelector("[data-v4-timeline-virtual-history]");
      if (!vh) return;
      let e = vh;
      while (e && e !== document.body) {
        const cs = getComputedStyle(e);
        if (cs.overflowY !== "visible" && e.scrollHeight > e.clientHeight + 100) {
          e.scrollTop = 0;
          return;
        }
        e = e.parentElement;
      }
    });
    await win.waitForTimeout(2500);
    const s = await win.evaluate(() => ({
      units: document.querySelectorAll("[data-v4-turn-unit]").length,
      vhH: Math.round(document.querySelector("[data-v4-timeline-virtual-history]")?.getBoundingClientRect().height ?? 0),
      firstTid: document.querySelector("[data-v4-turn-unit]")?.getAttribute("data-turn-id") ?? null,
      firstText: (document.querySelector("[data-v4-turn-unit]")?.textContent ?? "").replace(/\s+/g, " ").slice(0, 60),
    }));
    console.log("page-up#" + i, JSON.stringify(s));
  }

  // ── Part 2: sidebar toggle framedrop in this heavy session ──
  await win.evaluate(INSTALL);
  await win.waitForTimeout(500);
  for (let i = 0; i < 4; i++) {
    const mark = await win.evaluate(() => Math.round(performance.now() - window.__toggle.t0));
    const toggleBtn = win.locator('button[aria-label="Toggle sidebar"]');
    const clicked = (await toggleBtn.count()) ? ((await toggleBtn.first().click({ force: true }).then(() => "ok").catch((e) => "err:" + e.message.slice(0, 60)))) : "no-button";
    await win.waitForTimeout(1600);
    const out = await win.evaluate(() => {
      const p = window.__toggle;
      const res = { deltas: p.deltas.slice(), loaf: p.loaf.slice() };
      p.deltas.length = 0;
      p.loaf.length = 0;
      return res;
    });
    const rel = out.deltas.filter((x) => x.t >= mark - 60 && x.t <= mark + 1650).map((x) => x.d);
    const maxGap = rel.length ? Math.max(...rel) : 0;
    console.log(
      `TOGGLE#${i} ${clicked} | maxGap=${Math.round(maxGap * 10) / 10}ms | >6.1ms=${rel.filter((d) => d > 6.1).length} | >16.7ms=${rel.filter((d) => d > 16.7).length} | loafMs=${out.loaf.reduce((a, b) => a + b, 0)}ms | loaf=${JSON.stringify(out.loaf.slice(0, 6))}`,
    );
  }
} finally {
  await app.close().catch(() => {});
}
