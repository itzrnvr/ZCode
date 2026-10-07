import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStoreItems,
  isPublicStoreMarketplaceId,
  resolveItemDescription,
  resolveItemDisplayName,
} from "../src/settings/pluginStoreListing.js";
import type {
  ZCodeAvailablePluginSummary,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
} from "@zcode/shared";

/**
 * 商店条目 join 的 listing 提升（Defect 2 的 UI 侧）。
 *
 * 内置插件（documents / pdf / presentations / spreadsheets）在裁剪构建里没有目录条目，
 * 只能走 buildStoreItems 的第三条循环（运行时发现的插件）。这条循环过去不把 `info.listing`
 * 提升成条目级 listing，而 `resolveItemDisplayName` / `resolveItemDescription` / 卡片头像
 * 只读 `item.listing` —— 结果即便协议已经带上 listing，卡片仍然显示 slug（"Pdf"）且没有描述。
 */

const OFFICIAL_MARKETPLACE = "zcode-plugins-official";

function pluginInfo(overrides: Partial<ZCodePluginInfo> & { id: string }): ZCodePluginInfo {
  const separatorIndex = overrides.id.lastIndexOf("@");
  return {
    commandRootCount: 0,
    enabled: true,
    marketplace: overrides.id.slice(separatorIndex + 1),
    mcpServerNames: [],
    name: overrides.id.slice(0, separatorIndex),
    rootPath: "C:/cache",
    skillRootCount: 1,
    source: "official",
    ...overrides,
  };
}

function marketplaceSummary(
  overrides: Partial<ZCodePluginMarketplaceSummary> = {},
): ZCodePluginMarketplaceSummary {
  return {
    id: OFFICIAL_MARKETPLACE,
    isOfficial: true,
    name: OFFICIAL_MARKETPLACE,
    pluginCount: 1,
    source: { source: "url", url: "https://example.invalid/marketplace.json" },
    ...overrides,
  };
}

function build(input: {
  availablePlugins?: ZCodeAvailablePluginSummary[];
  plugins?: ZCodePluginInfo[];
  restorableBuiltins?: ZCodeAvailablePluginSummary[];
}) {
  return buildStoreItems({
    availablePlugins: input.availablePlugins ?? [],
    installedPlugins: [],
    marketplaceAvailabilityKnown: true,
    marketplaces: [marketplaceSummary()],
    plugins: input.plugins ?? [],
    restorableBuiltins: input.restorableBuiltins ?? [],
  });
}

const PDF_LISTING = {
  category: "productivity",
  displayName: "PDF",
  icon: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/document-skills/icon.png",
};

const DOCUMENTS_LISTING = {
  category: "productivity",
  descriptionI18n: { "zh-CN": "创建、编辑与审阅Word文档（DOCX）。" },
  displayName: "Documents",
  displayNameI18n: { "zh-CN": "Word文档" },
};

test("a discovered built-in carries its runtime listing into the store item", () => {
  const items = build({
    plugins: [
      pluginInfo({ id: `pdf@${OFFICIAL_MARKETPLACE}`, listing: PDF_LISTING }),
      pluginInfo({ id: `documents@${OFFICIAL_MARKETPLACE}`, listing: DOCUMENTS_LISTING }),
    ],
  });

  assert.deepEqual(
    items.map((item) => item.id),
    [`pdf@${OFFICIAL_MARKETPLACE}`, `documents@${OFFICIAL_MARKETPLACE}`],
  );
  const pdf = items[0]!;
  const documents = items[1]!;
  assert.equal(pdf.installed, true, "a discovered built-in is installed");
  assert.equal(pdf.restorable, false);
  assert.equal(pdf.orphaned, false, "official source must not be inferred orphaned");
  assert.deepEqual(pdf.listing, PDF_LISTING);
  assert.ok(
    isPublicStoreMarketplaceId(pdf.marketplace),
    "built-ins belong to the store's public segment",
  );

  // "PDF" 只能来自 listing：slug 回退会把 pdf 渲染成 "Pdf"。
  assert.equal(resolveItemDisplayName(pdf, "en-US"), "PDF");
  assert.equal(resolveItemDisplayName(documents, "zh-CN"), "Word文档");
  assert.equal(resolveItemDescription(documents, "zh-CN"), "创建、编辑与审阅Word文档（DOCX）。");
});

test("without a listing the item degrades to the canonical slug instead of disappearing", () => {
  const [item] = build({ plugins: [pluginInfo({ id: `pdf@${OFFICIAL_MARKETPLACE}` })] });
  assert.ok(item);
  assert.equal(item.listing, undefined);
  assert.equal(resolveItemDisplayName(item, "en-US"), "Pdf");
});

test("a catalog entry keeps precedence over the runtime listing for the same id", () => {
  const items = build({
    availablePlugins: [
      {
        id: `pdf@${OFFICIAL_MARKETPLACE}`,
        installed: true,
        listing: { ...PDF_LISTING, displayName: "Catalog PDF" },
        marketplace: OFFICIAL_MARKETPLACE,
        name: "pdf",
      },
    ],
    plugins: [pluginInfo({ id: `pdf@${OFFICIAL_MARKETPLACE}`, listing: PDF_LISTING })],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.listing?.displayName, "Catalog PDF");
  assert.ok(items[0]?.summary, "the catalog summary must stay attached");
});

test("packageStatus missing stays excluded even when a listing is known", () => {
  const items = build({
    plugins: [
      pluginInfo({
        id: `document-skills@${OFFICIAL_MARKETPLACE}`,
        listing: DOCUMENTS_LISTING,
        packageStatus: "missing",
      }),
    ],
  });
  assert.deepEqual(items, [], "a declared-but-unmaterialized package is not a store entry");
});

test("a suppressed built-in stays restorable with its catalog listing", () => {
  const items = build({
    restorableBuiltins: [
      {
        id: `documents@${OFFICIAL_MARKETPLACE}`,
        installed: false,
        listing: DOCUMENTS_LISTING,
        marketplace: OFFICIAL_MARKETPLACE,
        name: "documents",
      },
    ],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.restorable, true);
  assert.equal(items[0]?.installed, false);
  assert.equal(resolveItemDisplayName(items[0]!, "zh-CN"), "Word文档");
});
