import { launchDevApp, firstRendererWindow } from "./electron-harness.mjs";

const app = await launchDevApp({});
const win = await firstRendererWindow(app);
await win.waitForTimeout(10000);
const vis = await win.evaluate(() => ({ vis: document.visibilityState, hidden: document.hidden }));
console.log("visibility:", JSON.stringify(vis));
const bw = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  return w ? { visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(), bounds: w.getBounds() } : null;
});
console.log("browserwindow:", JSON.stringify(bw));
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w && !w.isVisible()) w.show();
  return w ? w.isVisible() : null;
});
await win.waitForTimeout(2000);
const rafProbe = await win.evaluate(
  () =>
    new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => {
        n++;
        if (n < 30) requestAnimationFrame(tick);
        else res(Math.round(((performance.now() - t0) / 30) * 10) / 10);
      };
      requestAnimationFrame(tick);
    }),
);
console.log("avg frame ms:", rafProbe);
const vis2 = await win.evaluate(() => document.visibilityState);
console.log("visibility after show:", vis2);
await app.close();
