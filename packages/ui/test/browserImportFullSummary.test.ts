import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ChromeBrowserDataImportResult } from "@zcode/shared";
import { formatImportSummary } from "../src/settings/browserImportSummary.js";

function formatMessage(descriptor: { id: string }, values?: Record<string, number | string>) {
  if (descriptor.id === "settings.browser.import.historySuffix") return ", plus history and bookmarks";
  if (descriptor.id === "settings.browser.import.success") {
    return (
      `Imported ${values?.["cookies"]} cookies, ${values?.["passwords"]} passwords and ` +
      `${values?.["entries"]} site entries from ${values?.["origins"]} sites${values?.["historySuffix"]}.`
    );
  }
  if (descriptor.id === "settings.browser.import.partialAppBound") return "PARTIAL-APPBOUND";
  return descriptor.id;
}

function fullResult(): ChromeBrowserDataImportResult {
  return {
    success: true,
    cookies: { imported: 120, skipped: 3, failed: 0 },
    localStorage: { originsImported: 8, entriesImported: 40, originsSkipped: 0, originsFailed: 0 },
    passwords: { imported: 5, skipped: 1, failed: 0 },
    history: { visitsCopied: true, bookmarksCopied: false, preferencesCopied: true },
  };
}

test("full pull summary counts passwords and history suffix", () => {
  const summary = formatImportSummary(fullResult(), formatMessage as never);
  assert.match(summary, /120 cookies/);
  assert.match(summary, /5 passwords/);
  assert.match(summary, /plus history and bookmarks/);
});

test("no history copied means no suffix", () => {
  const result = fullResult();
  result.history = { visitsCopied: false, bookmarksCopied: false, preferencesCopied: false };
  const summary = formatImportSummary(result, formatMessage as never);
  assert.doesNotMatch(summary, /plus history/);
});

test("app-bound partial path preserved", () => {
  const result = fullResult();
  result.issues = ["chrome_cookie_app_bound_decryption_failed"];
  const summary = formatImportSummary(result, formatMessage as never);
  assert.equal(summary, "PARTIAL-APPBOUND");
});
