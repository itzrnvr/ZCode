import { readFileSync } from "node:fs";

const TARGET = "sess_f332e77a-04ab-4322-b483-f1d7932fbef1";
let token = "";
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    token = readFileSync("C:/Users/babys/AppData/Roaming/Blackbird/diagnostics-token", "utf8").trim();
    const h = await fetch(`http://127.0.0.1:3499/health?token=${token}`).then((r) => r.json());
    if (h.ok && h.windows?.length) break;
  } catch {}
}
const post = (expr) =>
  fetch(`http://127.0.0.1:3499/evaluate?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expression: expr }),
  })
    .then((r) => r.json())
    .then((j) => j.result);

// wait for renderer interactivity
for (let i = 0; i < 30; i++) {
  const n = Number(await post(`document.querySelectorAll("button").length`));
  if (n > 5) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const OPEN = `(function(){
  var rows = [].slice.call(document.querySelectorAll('[data-testid="task-item-${TARGET}"]'));
  if (!rows.length) return "row-not-found";
  var row = rows[rows.length - 1];
  row.scrollIntoView({ block: "center" });
  var t = row.querySelector(".truncate") || row;
  var r = t.getBoundingClientRect();
  var opts = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
  t.dispatchEvent(new PointerEvent("pointerdown", opts));
  t.dispatchEvent(new MouseEvent("mousedown", opts));
  t.dispatchEvent(new PointerEvent("pointerup", opts));
  t.dispatchEvent(new MouseEvent("mouseup", opts));
  t.dispatchEvent(new MouseEvent("click", opts));
  return "clicked";
})()`;
console.log("open:", await post(OPEN));

let mounted = null;
for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  mounted = JSON.parse(await post(`(function(){
    var u = document.querySelectorAll("[data-v4-turn-unit]");
    var vh = document.querySelector("[data-v4-timeline-virtual-history]");
    return JSON.stringify({ units: u.length, vhH: vh ? Math.round(vh.getBoundingClientRect().height) : 0 });
  })()`));
  if (mounted.units > 0) break;
}
console.log("mounted:", JSON.stringify(mounted));

await post(`(function(){
  window.__t = { deltas: [], loaf: [], t0: performance.now(), lastT: null };
  new PerformanceObserver(function(l){
    var es = l.getEntries();
    for (var i = 0; i < es.length; i++) { window.__t.loaf.push(Math.round(es[i].duration)); }
    if (window.__t.loaf.length > 80) window.__t.loaf.splice(0, window.__t.loaf.length - 80);
  }).observe({ type: "long-animation-frame", durationThreshold: 20 });
  var rec = function(t) {
    if (window.__t) {
      var last = window.__t.lastT || t;
      var d = t - last;
      window.__t.deltas.push({ t: Math.round(t - window.__t.t0), d: Math.round(d * 10) / 10 });
      if (window.__t.deltas.length > 6000) window.__t.deltas.splice(0, 3000);
      window.__t.lastT = t;
    }
    requestAnimationFrame(rec);
  };
  requestAnimationFrame(rec);
  return "installed";
})()`);

const results = [];
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const mark = Number(await post(`Math.round(performance.now() - window.__t.t0)`));
  await post(`(function(){var b=[].find.call(document.querySelectorAll("button"),function(x){return x.getAttribute("aria-label")==="Toggle sidebar"});if(!b)return "no-button";b.click();return "ok"})()`);
  await new Promise((r) => setTimeout(r, 1700));
  const out = JSON.parse(await post(`(function(){var p=window.__t;var res={deltas:p.deltas.slice(),loaf:p.loaf.slice()};p.deltas.length=0;p.loaf.length=0;return JSON.stringify(res)})()`));
  const rel = out.deltas.filter((x) => x.t >= mark - 60 && x.t <= mark + 1750).map((x) => x.d);
  const r = {
    maxGap: rel.length ? Math.round(Math.max(...rel) * 10) / 10 : 0,
    loafMs: out.loaf.reduce((a, b) => a + b, 0),
    loaf: out.loaf,
  };
  results.push(r);
  console.log(`T${i}: maxGap=${r.maxGap}ms loafMs=${r.loafMs} ${JSON.stringify(r.loaf.slice(0, 6))}`);
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10; };
console.log(`MEDIAN | maxGap=${med(results.map((r) => r.maxGap))}ms | loafMs=${med(results.map((r) => r.loafMs))}ms | frames>=50ms=${results.reduce((a, r) => a + r.loaf.filter((d) => d >= 50).length, 0)}`);
