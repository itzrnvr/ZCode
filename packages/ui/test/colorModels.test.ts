import assert from "node:assert/strict";
import test from "node:test";
import {
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  parseHexColor,
  rgbToHex,
  rgbToHsv,
} from "../src/lib/colorModels.js";

/** 最短弧角差：拖拽落点只关心色相是否等价，不受 ±360 表示影响。 */
const hueDistance = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test("parseHexColor accepts #rgb / #rrggbb and rejects anything else", () => {
  assert.deepEqual(parseHexColor("#abc"), { r: 170, g: 187, b: 204 });
  assert.deepEqual(parseHexColor("ABCDEF"), { r: 171, g: 205, b: 239 });
  assert.deepEqual(parseHexColor("#000000"), { r: 0, g: 0, b: 0 });
  assert.equal(parseHexColor("nope"), null);
  assert.equal(parseHexColor("#12"), null);
  assert.equal(parseHexColor("rgb(1,2,3)"), null);
});

test("hex -> hsv -> hex is lossless for every channel combination the picker can emit", () => {
  for (const hex of [
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#ffffff",
    "#000000",
    "#808080",
    "#8b5cf6",
    "#0f172a",
    "#14b8a6",
    "#010203",
    "#fefdfc",
  ]) {
    const hsv = hexToHsv(hex);
    assert.ok(hsv, `${hex} should parse`);
    assert.equal(hsvToHex(hsv), hex, `${hex} must round-trip through HSV`);
  }
});

test("hsv -> rgb -> hsv keeps hue, saturation and brightness", () => {
  const hsv = { h: 222.22222222222223, s: 0.6428571428571429, v: 0.16470588235294117 };
  const back = rgbToHsv(hsvToRgb(hsv));
  assert.ok(hueDistance(back.h, hsv.h) < 1e-6, `hue drifted: ${back.h}`);
  assert.ok(Math.abs(back.s - hsv.s) < 1e-9, `saturation drifted: ${back.s}`);
  assert.ok(Math.abs(back.v - hsv.v) < 1e-9, `brightness drifted: ${back.v}`);
});

test("every point of the SV panel and hue track yields a valid, stable hex", () => {
  for (let h = 0; h <= 360; h += 7) {
    for (const s of [0, 0.5, 1]) {
      for (const v of [0, 0.33, 1]) {
        const hex = hsvToHex({ h, s, v });
        assert.match(hex, /^#[0-9a-f]{6}$/, `h=${h} s=${s} v=${v} produced ${hex}`);
        assert.equal(hsvToHex(hexToHsv(hex)), hex, `h=${h} s=${s} v=${v} is not stable`);
      }
    }
  }
});

test("rgbToHex clamps out-of-range channels instead of emitting invalid hex", () => {
  assert.equal(rgbToHex({ r: 300, g: -20, b: 127.6 }), "#ff0080");
});
