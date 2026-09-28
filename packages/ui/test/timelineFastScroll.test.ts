import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_TIMELINE_FAST_SCROLL_STATE,
  TIMELINE_FAST_SCROLL_ENTER_STREAK,
  TIMELINE_FAST_SCROLL_EXIT_STREAK,
  TIMELINE_FAST_SCROLL_VIEWPORT_FRACTION,
  advanceTimelineFastScrollState,
  classifyTimelineScrollDelta,
} from "../src/v4/timelineFastScroll.js";
import type { TimelineFastScrollState } from "../src/v4/timelineFastScroll.js";

const VIEWPORT = 800;
const fastDelta = VIEWPORT * TIMELINE_FAST_SCROLL_VIEWPORT_FRACTION + 1;
const slowDelta = VIEWPORT * 0.35;

function run(
  deltas: number[],
  start: TimelineFastScrollState = INITIAL_TIMELINE_FAST_SCROLL_STATE,
): TimelineFastScrollState[] {
  let state = start;
  const states: TimelineFastScrollState[] = [];
  for (const deltaPx of deltas) {
    state = advanceTimelineFastScrollState(state, { deltaPx, viewportHeight: VIEWPORT });
    states.push(state);
  }
  return states;
}

test("classify uses the viewport fraction and treats bad geometry as slow", () => {
  assert.equal(classifyTimelineScrollDelta({ deltaPx: fastDelta, viewportHeight: VIEWPORT }), "fast");
  assert.equal(
    classifyTimelineScrollDelta({ deltaPx: -fastDelta, viewportHeight: VIEWPORT }),
    "fast",
    "direction must not matter",
  );
  assert.equal(classifyTimelineScrollDelta({ deltaPx: slowDelta, viewportHeight: VIEWPORT }), "slow");
  assert.equal(
    classifyTimelineScrollDelta({
      deltaPx: VIEWPORT * TIMELINE_FAST_SCROLL_VIEWPORT_FRACTION,
      viewportHeight: VIEWPORT,
    }),
    "fast",
    "exactly at the threshold counts as fast",
  );
  assert.equal(classifyTimelineScrollDelta({ deltaPx: 5000, viewportHeight: 0 }), "slow");
  assert.equal(
    classifyTimelineScrollDelta({ deltaPx: Number.NaN, viewportHeight: VIEWPORT }),
    "slow",
  );
});

test("paint skipping needs the enter streak, not a single spike", () => {
  const states = run([fastDelta, fastDelta, fastDelta]);
  assert.equal(states[0]?.skipping, false, "one fast frame must not hide content");
  assert.equal(states[1]?.skipping, true);
  assert.equal(states[2]?.skipping, true);
  assert.equal(TIMELINE_FAST_SCROLL_ENTER_STREAK, 2);
});

test("a single slow frame does not unhide (hysteresis), the exit streak does", () => {
  const entered = run([fastDelta, fastDelta])[1]!;
  assert.equal(entered.skipping, true);
  const afterOneSlow = advanceTimelineFastScrollState(entered, {
    deltaPx: slowDelta,
    viewportHeight: VIEWPORT,
  });
  assert.equal(afterOneSlow.skipping, true, "one slow frame keeps the skip to avoid flicker");
  const afterTwoSlow = advanceTimelineFastScrollState(afterOneSlow, {
    deltaPx: slowDelta,
    viewportHeight: VIEWPORT,
  });
  assert.equal(afterTwoSlow.skipping, false);
  assert.equal(TIMELINE_FAST_SCROLL_EXIT_STREAK, 2);
});

test("streaks reset when the direction of travel changes speed class", () => {
  const states = run([fastDelta, slowDelta, fastDelta, fastDelta]);
  assert.equal(states[0]?.fastStreak, 1);
  assert.equal(states[1]?.fastStreak, 0);
  assert.equal(states[1]?.slowStreak, 1);
  assert.equal(states[2]?.fastStreak, 1);
  assert.equal(states[2]?.skipping, false);
  assert.equal(states[3]?.skipping, true);
});

test("normal-speed scrolling never hides content", () => {
  const states = run(Array.from({ length: 12 }, () => slowDelta));
  assert.ok(states.every((state) => state.skipping === false));
});

test("idle (zero delta) releases the skip", () => {
  const entered = run([fastDelta, fastDelta])[1]!;
  const states = run([0, 0], entered);
  assert.equal(states[1]?.skipping, false);
});
