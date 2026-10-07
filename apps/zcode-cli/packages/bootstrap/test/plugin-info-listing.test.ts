import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEntryStoreListing } from "@zcode/adapters/plugins";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, type PluginMetadata } from "@zcode/contracts";
import { zcodePluginsListResultSchema } from "@zcode/shared";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { loadPluginListingsById } from "../src/plugins.js";
import { toPluginInfo } from "../src/zcode-protocol/plugins.js";

/**
 * plugins/list 必须把商店 listing 一起下发（Defect 2）。
 *
 * 实测症状：内置插件即使被发现，商店卡片也只显示 slug（documents / pdf），没有图标、
 * 没有描述、没有分类——因为 `toPluginInfo` 只投影运行时字段，listing 在协议边界被丢掉，
 * UI 的 `resolvePluginDisplayName` 只能退回 `formatCanonicalPluginName`。
 * 裁剪构建里这些插件还没有 bundled 目录条目，所以 listing 只能来自 official definition seed。
 */

const DOCUMENTS_ID = `documents@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

function definitionListing(name: string) {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `official plugin definition must exist: ${name}`);
  assert.ok(definition.listing, `${name} must ship a store listing seed`);
  const listing = parseEntryStoreListing({ name: definition.name, ...definition.listing });
  assert.ok(listing, `${name} listing seed must parse`);
  return listing;
}

function pluginMetadata(overrides: Partial<PluginMetadata> = {}): PluginMetadata {
  return {
    commandRootCount: 0,
    components: [],
    configuredOptions: {},
    dataPath: join(tmpdir(), "zcode-plugin-data", "documents"),
    declaredMcpServerNames: [],
    description: "DOCX document production skills",
    enabled: true,
    hookDetails: [],
    id: DOCUMENTS_ID,
    manifestPath: join(tmpdir(), "plugin.json"),
    marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    mcpServerNames: [],
    name: "documents",
    rootPath: join(tmpdir(), "documents"),
    skillCount: 1,
    skillRootCount: 1,
    source: "official",
    version: "0.1.7",
    ...overrides,
  };
}

test("toPluginInfo carries the store listing through to the wire payload", () => {
  const listing = definitionListing("documents");
  const info = toPluginInfo(pluginMetadata(), undefined, listing);

  assert.equal(info.listing?.displayName, "Documents");
  assert.equal(info.listing?.category, "productivity");
  assert.ok(info.listing?.icon, "icon must survive the projection");
  assert.ok(
    info.listing?.displayNameI18n && Object.keys(info.listing.displayNameI18n).length > 0,
    "localized display names must survive the projection",
  );
  assert.ok(
    info.listing?.descriptionI18n && Object.keys(info.listing.descriptionI18n).length > 0,
    "localized descriptions must survive the projection",
  );
  assert.deepEqual(info.listing, listing);
});

test("toPluginInfo omits listing entirely when none is known", () => {
  const info = toPluginInfo(pluginMetadata());
  assert.equal("listing" in info, false, "absent listing must not be sent as an empty object");
});

test("the strict wire schema accepts and preserves listing", () => {
  const info = toPluginInfo(pluginMetadata(), undefined, definitionListing("pdf"));
  const parsed = zcodePluginsListResultSchema.parse({ diagnostics: [], plugins: [info] });

  assert.equal(parsed.plugins[0]?.listing?.displayName, "PDF");
  assert.deepEqual(parsed.plugins[0]?.listing, info.listing);
  // strict() 没有被放宽：未知字段仍然必须被拒绝，否则协议就失去了版本漂移的检测能力。
  assert.throws(() =>
    zcodePluginsListResultSchema.parse({
      diagnostics: [],
      plugins: [{ ...info, unknownField: true }],
    }),
  );
});

test("listing lookup resolves built-ins from the definition seed when no catalog entry exists", () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "zcode-plugin-listings-"));
  try {
    // 空 storage root == 裁剪构建的目录状态：没有任何 marketplace 快照可 join。
    const listings = loadPluginListingsById(storageRoot);
    assert.equal(listings[DOCUMENTS_ID]?.displayName, "Documents");
    assert.equal(listings[`pdf@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`]?.displayName, "PDF");
    assert.equal(
      listings[`presentations@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`]?.displayName,
      "Presentations",
    );
    assert.equal(
      listings[`spreadsheets@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`]?.displayName,
      "Spreadsheets",
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("a catalog entry still overrides the definition seed for the same plugin id", () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "zcode-plugin-listings-"));
  try {
    writeFileSync(
      join(storageRoot, "known_marketplaces.json"),
      `${JSON.stringify(
        {
          marketplaces: [
            {
              addedAt: new Date(0).toISOString(),
              id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
              name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
              pluginCount: 1,
              source: { source: "url", url: "https://example.invalid/marketplace.json" },
            },
          ],
          version: 1,
        },
        null,
        2,
      )}\n`,
    );
    const manifestDir = join(storageRoot, "marketplaces", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "marketplace.json"),
      `${JSON.stringify(
        {
          name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
          plugins: [{ displayName: "Catalog Documents", name: "documents", version: "9.9.9" }],
          version: 1,
        },
        null,
        2,
      )}\n`,
    );

    const listings = loadPluginListingsById(storageRoot);
    assert.equal(listings[DOCUMENTS_ID]?.displayName, "Catalog Documents");
    // 目录没覆盖到的内置插件继续用 seed，不能被一个条目整体顶掉。
    assert.equal(listings[`pdf@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`]?.displayName, "PDF");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});
