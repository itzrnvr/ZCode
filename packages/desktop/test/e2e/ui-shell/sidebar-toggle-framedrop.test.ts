import { clearAppData } from "../helpers/desktop-app.js";

// Sidebar toggle framedrop (issue 44): real trusted click through
// ChromeDriver, PerformanceObserver + rAF-gap measurement inside the
// page — no diagnostics channel, no focus tricks.
describe("sidebar toggle framedrop", () => {
  const INSTALL_HARNESS = `(function(){
    window.__toggle = { deltas: [], loaf: [], t0: performance.now(), lastT: null };
    try {
      new PerformanceObserver(function(l){
        var es = l.getEntries();
        for (var i = 0; i < es.length; i++) {
          window.__toggle.loaf.push(Math.round(es[i].duration));
        }
        if (window.__toggle.loaf.length > 40) window.__toggle.loaf.splice(0, window.__toggle.loaf.length - 40);
      }).observe({ type: "long-animation-frame", durationThreshold: 20 });
    } catch (err) {}
    var rec = function(t) {
      if (window.__toggle) {
        var last = window.__toggle.lastT || t;
        var d = t - last;
        window.__toggle.deltas.push({ t: Math.round(t - window.__toggle.t0), d: Math.round(d * 10) / 10 });
        if (window.__toggle.deltas.length > 6000) window.__toggle.deltas.splice(0, 3000);
        window.__toggle.lastT = t;
      }
      requestAnimationFrame(rec);
    };
    requestAnimationFrame(rec);
    return "installed";
  })()`;

  const CLICK_TOGGLE = `(function(){
    var b = [].find.call(document.querySelectorAll("button"), function(x){
      return x.getAttribute("aria-label") === "Toggle sidebar";
    });
    if (!b) return "no-button";
    b.click();
    return "ok";
  })()`;

  const READ_REPORT = `(function(){
    var p = window.__toggle || {};
    var out = { deltas: p.deltas ? p.deltas.slice() : [], loaf: p.loaf ? p.loaf.slice() : [] };
    if (p.deltas) p.deltas.length = 0;
    if (p.loaf) p.loaf.length = 0;
    return JSON.stringify(out);
  })()`;

  async function measureToggle(label: string) {
    const mark = JSON.parse(
      (await browser.execute(
        `JSON.stringify({t:Math.round(performance.now()-window.__toggle.t0)})`,
      )) as string,
    ).t as number;
    await browser.execute(CLICK_TOGGLE);
    await browser.pause(1600);
    const out = JSON.parse((await browser.execute(READ_REPORT)) as string) as {
      deltas: Array<{ t: number; d: number }>;
      loaf: number[];
    };
    const rel = out.deltas.filter((x) => x.t >= mark - 60 && x.t <= mark + 1650).map((x) => x.d);
    const maxGap = rel.length ? Math.max(...rel) : 0;
    const over167 = rel.filter((d) => d > 16.7).length;
    const loafMs = out.loaf.reduce((a, b) => a + b, 0);
    // eslint-disable-next-line no-console
    console.log(
      `${label} | maxGap=${Math.round(maxGap * 10) / 10}ms | >16.7ms=${over167} | loafMs=${loafMs}ms | loaf=${JSON.stringify(out.loaf)}`,
    );
    return { maxGap, over167, loafMs };
  }

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("toggle stays under budget in a heavy session", async () => {
    await browser.execute(INSTALL_HARNESS);
    await browser.pause(400);
    await measureToggle("WARMUP");
    const a = await measureToggle("T1");
    const b = await measureToggle("T2");
    for (const [name, r] of [
      ["T1", a],
      ["T2", b],
    ] as const) {
      expect(
        r.maxGap,
        `${name}: single toggle frame gap ${r.maxGap}ms exceeds 120ms budget`,
      ).toBeLessThan(120);
      expect(
        r.loafMs,
        `${name}: long-frame total ${r.loafMs}ms exceeds 200ms budget`,
      ).toBeLessThan(200);
    }
  });
});
