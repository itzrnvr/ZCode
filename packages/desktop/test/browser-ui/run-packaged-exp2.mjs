import { readFileSync } from "node:fs";

const token = readFileSync("C:/Users/babys/AppData/Roaming/Blackbird/diagnostics-token", "utf8").trim();
const post = (expr) =>
  fetch(`http://127.0.0.1:3499/evaluate?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expression: expr }),
  })
    .then((r) => r.json())
    .then((j) => j.result);

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10; };

async function series(label, repeats = 4) {
  const results = [];
  for (let i = 0; i < repeats; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const mark = Number(await post(`Math.round(performance.now() - window.__t.t0)`));
    await post(`(function(){var b=[].find.call(document.querySelectorAll("button"),function(x){return x.getAttribute("aria-label")==="Toggle sidebar"});b.click();return "ok"})()`);
    await new Promise((r) => setTimeout(r, 1700));
    const out = JSON.parse(await post(`(function(){var p=window.__t;var res={deltas:p.deltas.slice(),loaf:p.loaf.slice()};p.deltas.length=0;p.loaf.length=0;return JSON.stringify(res)})()`));
    const rel = out.deltas.filter((x) => x.t >= mark - 60 && x.t <= mark + 1750).map((x) => x.d);
    results.push({
      maxGap: rel.length ? Math.round(Math.max(...rel) * 10) / 10 : 0,
      loafMs: out.loaf.reduce((a, b) => a + b, 0),
      loaf: out.loaf,
    });
  }
  console.log(`${label.padEnd(20)} | medianMaxGap=${med(results.map((r) => r.maxGap))}ms | medianLoaf=${med(results.map((r) => r.loafMs))}ms | ${JSON.stringify(results.map((r) => [r.maxGap, r.loaf]))}`);
}

const SET = (css) => `(function(){
  var s = document.getElementById("__exp") || document.createElement("style");
  s.id = "__exp"; s.textContent = ${JSON.stringify(css)};
  document.head.appendChild(s);
  return "set";
})()`;

await post(`(function(){
  if (window.__t) return "present";
  window.__t = { deltas: [], loaf: [], t0: performance.now(), lastT: null };
  new PerformanceObserver(function(l){
    var es = l.getEntries();
    for (var i = 0; i < es.length; i++) { window.__t.loaf.push(Math.round(es[i].duration)); }
    if (window.__t.loaf.length > 80) window.__t.loaf.splice(0, window.__t.loaf.length - 80);
  }).observe({ type: "long-animation-frame", durationThreshold: 20 });
  var rec = function(t) { if (window.__t) { var last = window.__t.lastT || t; var d = t - last;
    window.__t.deltas.push({ t: Math.round(t - window.__t.t0), d: Math.round(d * 10) / 10 });
    if (window.__t.deltas.length > 6000) window.__t.deltas.splice(0, 3000); window.__t.lastT = t; }
    requestAnimationFrame(rec); };
  requestAnimationFrame(rec);
  return "installed";
})()`);

console.log("--- A: baseline");
await series("BASE");
await post(SET(""));
await new Promise((r) => setTimeout(r, 500));

console.log("--- B: sidebar layout+paint skipped entirely");
await post(SET('aside { content-visibility: hidden !important; }'));
console.log("armed:", await post(`(function(){var a=document.querySelector("aside");return a?getComputedStyle(a).contentVisibility:null})()`));
await series("SIDEBAR-HIDDEN");
await post(SET(""));

console.log("--- C: conversation column strict-contained");
await post(SET('[data-v4-timeline-virtual-history] { contain: strict !important; }'));
await series("CONV-STRICT");
await post(SET(""));
