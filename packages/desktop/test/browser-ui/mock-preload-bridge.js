// Playwright init script: stand in for the Electron preload bridge so the
// renderer boots in a plain browser. Unknown methods resolve to undefined;
// on*/subscribe*/watch* return no-op unsubscribe functions.
(() => {
  const cache = Object.create(null);
  const makeMethod = (name) => {
    if (/^(on[A-Z])/.test(name) || /^subscribe/.test(name) || /^watch/.test(name)) {
      return (..._args) => () => {};
    }
    return (..._args) => Promise.resolve(undefined);
  };
  const zcode = new Proxy(cache, {
    get(target, key) {
      if (key === "then" || key === "toJSON" || typeof key === "symbol") return undefined;
      const name = String(key);
      if (!(name in target)) target[name] = makeMethod(name);
      return target[name];
    },
    has() {
      return true;
    },
  });
  window.zcode = zcode;

  // Diagnostics surface some code paths probe.
  window.__ZCODE_BROWSER_TEST__ = true;
})();
