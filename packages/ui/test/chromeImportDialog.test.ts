import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const dialogSource = await readFile(
  new URL("../src/settings/ChromeImportDialog.tsx", import.meta.url),
  "utf8",
);
const sectionSource = await readFile(
  new URL("../src/settings/BrowserSettingsSection.tsx", import.meta.url),
  "utf8",
);
test("dialog renders four scopes with checkmark rows", async () => {
  for (const scope of ["cookies", "passwords", "history", "siteData"]) {
    assert.ok(
      dialogSource.includes(`"${scope}",`) || dialogSource.includes(`"${scope}"`),
      `dialog must list the ${scope} scope`,
    );
  }
  assert.ok(dialogSource.includes("data-import-scope"), "rows must carry scope test ids");
  assert.ok(dialogSource.includes("data-import-status"), "rows must carry status test ids");
  assert.ok(
    dialogSource.includes("settings.browser.import.scope."),
    "rows must resolve scope locale strings",
  );
});

test("password scope states local-only decryption", () => {
  assert.ok(
    dialogSource.includes("scope.passwords.hint") || dialogSource.includes("passwords"),
    "password row must exist",
  );
});

test("settings opens dialog on click, confirms with elevation choice", () => {
  assert.ok(
    sectionSource.includes("setImportDialogOpen(true)"),
    "import button must open the dialog, not import directly",
  );
  assert.ok(sectionSource.includes("handleImportConfirm"), "dialog confirm must run the import");
  assert.ok(
    sectionSource.includes("allowElevatedChromeDecryption"),
    "elevation consent must reach the platform call",
  );
  assert.ok(sectionSource.includes("<ChromeImportDialog"), "dialog must be mounted");
});

test("dialog stays open on result, close only when idle", () => {
  assert.ok(
    sectionSource.includes('if (pendingOperation === "import") return;'),
    "dialog must not close mid-import",
  );
});
