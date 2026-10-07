import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createConfig, type ConfigResult } from "@zcode/adapters/config";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  type OfficialPluginDefinition,
} from "../src/app/official-plugin-definitions.js";
import { getZCodePluginsOverview, resolveZCodePlugins } from "../src/plugins.js";

/**
 * 内置官方插件（documents / pdf / presentations / spreadsheets）在裁剪构建里整体消失的回归。
 *
 * 实测症状：这类插件的 cache 明明躺在 `~/.zcode/cli/plugins/cache/zcode-plugins-official/<name>/<version>`
 * 且版本与 definition 对得上，但桌面的插件商店「公开」分段里一个都看不到，插件列表也没有。
 * 原因不在配置：用户配置里根本没有它们的声明，`enabledPlugins[id] ?? defaultEnabled` 这条
 * 默认开启路径是对的。真正的门是 discovery 的两条官方候选路径同时断了——
 * `scanOfficialCache` 只认 bundled 分片里列出的 cachePath，而 bundled 分片只包含
 * 「本构建能解析出 seed 源」的定义；fork/裁剪包没有 stage `packages/documents-plugin` 这些
 * 目录，定义拿不到 seed 源，于是既不写分片也不进 failedSeeds，回退路径也就永远不会看它们。
 *
 * 这里的断言全部落在可观察结果上（root 是否被解析出来、插件是否被发现并默认启用、
 * 抑制态是否仍然可恢复），不钉实现细节：将来某个构建真的 stage 了这些 package，
 * seed 会写出同一个 pinned 路径，断言依然成立。
 */

const DOCUMENTS = requireDefinition("documents");
const ZCODE_GUIDE = requireDefinition("zcode-guide");
const COMPUTER_USE = requireDefinition("computer-use");
const DOCUMENTS_ID = `${DOCUMENTS.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

function requireDefinition(name: string): OfficialPluginDefinition {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `official plugin definition must exist: ${name}`);
  return definition;
}

function fixtureAssetBody(relativePath: string): string {
  if (!relativePath.endsWith(".md")) return "{}\n";
  const name = basename(relativePath, ".md");
  return `---\nname: ${name}\ndescription: fixture asset for ${name}\n---\n\nFixture body.\n`;
}

/**
 * 写一份「可用」的官方插件 cache：manifest name 与 definition 对齐，requiredSeedPaths 齐全。
 * 故意不写 `.zcode-plugin-seed.json` marker —— 本构建从未 seed 过它，正是被测场景。
 */
function writeOfficialCacheFixture(
  storageRoot: string,
  definition: OfficialPluginDefinition,
  options: { version?: string; incomplete?: boolean } = {},
): string {
  const version = options.version ?? definition.version;
  const root = join(
    storageRoot,
    "cache",
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    definition.name,
    version,
  );
  mkdirSync(join(root, ".zcode-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".zcode-plugin", "plugin.json"),
    `${JSON.stringify(
      { description: `Fixture ${definition.name}`, name: definition.name, version },
      null,
      2,
    )}\n`,
  );
  const required = definition.requiredSeedPaths ?? [];
  // incomplete 用来造一个「更高版本但缺资产」的目录，验证解析按 definition pin 而不是最高 semver。
  const paths = options.incomplete === true ? required.slice(1) : required;
  for (const relativePath of paths) {
    const fullPath = join(root, ...relativePath.split("/"));
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, fixtureAssetBody(relativePath));
  }
  return root;
}

interface Fixture {
  storageRoot: string;
  workspaceDir: string;
  cleanup: () => void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "zcode-plugin-store-"));
  const storageRoot = join(root, "plugins");
  const workspaceDir = join(root, "ws");
  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  return {
    storageRoot,
    workspaceDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 全新配置视图：不加载任何 user config 文件，plugins 全部走系统默认值。 */
function createFreshConfig(fixture: Fixture, userConfigPath?: string): ConfigResult {
  return createConfig({
    env: {},
    workingDirectory: fixture.workspaceDir,
    ...(userConfigPath ? { userConfigPath } : { skipUserConfig: true }),
  });
}

function createUserConfig(fixture: Fixture, name: string, contents: unknown): string {
  const path = join(fixture.workspaceDir, name);
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  return path;
}

function discover(fixture: Fixture, configResult: ConfigResult) {
  return resolveZCodePlugins({
    configResult,
    env: {},
    pluginStorageRoot: fixture.storageRoot,
    workingDirectory: fixture.workspaceDir,
  });
}

function overview(fixture: Fixture, configResult: ConfigResult) {
  return getZCodePluginsOverview({
    configResult,
    env: {},
    pluginStorageRoot: fixture.storageRoot,
    workingDirectory: fixture.workspaceDir,
  });
}

test("official cache of an unseeded definition is resolved as a plugin root", () => {
  const fixture = createFixture();
  try {
    const documentsRoot = writeOfficialCacheFixture(fixture.storageRoot, DOCUMENTS);
    // 一个更高版本但缺 requiredSeedPaths 的目录：官方回滚/升级遗留物，绝不能被选中。
    writeOfficialCacheFixture(fixture.storageRoot, ZCODE_GUIDE, {
      version: "9.9.9",
      incomplete: true,
    });
    const guideRoot = writeOfficialCacheFixture(fixture.storageRoot, ZCODE_GUIDE);

    const roots = resolveOfficialPluginRoots({
      env: {},
      storageRoot: fixture.storageRoot,
    }).map((root) => resolve(root));

    assert.ok(
      roots.includes(resolve(documentsRoot)),
      `pinned cache root must be resolvable: ${documentsRoot}`,
    );
    assert.ok(
      roots.includes(resolve(guideRoot)),
      `definition-pinned version must win over a higher unusable cache: ${guideRoot}`,
    );
    assert.ok(
      !roots.some((root) => root.endsWith("9.9.9")),
      "an incomplete higher-version cache must not be registered",
    );
    // CUA 的 frame contract 随 producer 原子升级：开关关闭时即便 cache 可用也不注册。
    writeOfficialCacheFixture(fixture.storageRoot, COMPUTER_USE);
    const rootsWithoutCua = resolveOfficialPluginRoots({
      env: {},
      storageRoot: fixture.storageRoot,
    }).map((root) => resolve(root));
    assert.ok(
      !rootsWithoutCua.some((root) => root.includes(COMPUTER_USE.name)),
      "computer-use must stay gated behind its feature flag",
    );
  } finally {
    fixture.cleanup();
  }
});

test("fresh config discovers defaultEnabled built-ins and enables them without any declaration", () => {
  const fixture = createFixture();
  try {
    writeOfficialCacheFixture(fixture.storageRoot, DOCUMENTS);
    const configResult = createFreshConfig(fixture);

    // 前置条件：defaultEnabled 是唯一的开启来源，配置里没有任何插件声明。
    assert.deepEqual(configResult.config.plugins.enabledPlugins, {});
    assert.deepEqual(configResult.config.plugins.suppressedBuiltins, []);

    const documents = discover(fixture, configResult).plugins.find(
      (plugin) => plugin.id === DOCUMENTS_ID,
    );
    assert.ok(documents, `${DOCUMENTS_ID} must be discovered from the official cache`);
    assert.equal(documents.enabled, true, "defaultEnabled must apply with an empty config");
    assert.equal(documents.source, "official");
    assert.equal(documents.version, DOCUMENTS.version);
  } finally {
    fixture.cleanup();
  }
});

test("explicit enabledPlugins declaration still wins over defaultEnabled", () => {
  const fixture = createFixture();
  try {
    writeOfficialCacheFixture(fixture.storageRoot, DOCUMENTS);
    const userConfigPath = createUserConfig(fixture, "user-config.json", {
      plugins: { enabledPlugins: { [DOCUMENTS_ID]: false } },
    });
    const configResult = createFreshConfig(fixture, userConfigPath);

    const documents = discover(fixture, configResult).plugins.find(
      (plugin) => plugin.id === DOCUMENTS_ID,
    );
    assert.ok(documents, "a disabled built-in is still discovered so the store can toggle it");
    assert.equal(documents.enabled, false);
  } finally {
    fixture.cleanup();
  }
});

test("discovered built-ins are not restorable; suppressed ones stay restorable with their listing", () => {
  const fixture = createFixture();
  try {
    writeOfficialCacheFixture(fixture.storageRoot, DOCUMENTS);

    const discovered = overview(fixture, createFreshConfig(fixture));
    assert.deepEqual(
      discovered.restorableBuiltins.map((plugin) => plugin.id),
      [],
      "a loaded built-in is installed, not restorable",
    );

    const userConfigPath = createUserConfig(fixture, "suppressed-config.json", {
      plugins: { suppressedBuiltins: [DOCUMENTS_ID] },
    });
    const suppressed = overview(fixture, createFreshConfig(fixture, userConfigPath));

    assert.deepEqual(
      suppressed.restorableBuiltins.map((plugin) => plugin.id),
      [DOCUMENTS_ID],
      "uninstall (suppress) must keep a restore entry in the store",
    );
    const restorable = suppressed.restorableBuiltins[0];
    assert.equal(restorable.listing?.displayName, "Documents");
    assert.equal(restorable.listing?.category, "productivity");
    assert.ok(restorable.listing?.icon, "definition seed must carry the store icon");
    assert.ok(
      !Object.keys(restorable.listing ?? {}).some((key) => key.endsWith("_i18n")),
      "wire listing must expose camelCase i18n keys, not the raw catalog key names",
    );
    assert.ok(
      restorable.listing?.displayNameI18n &&
        Object.keys(restorable.listing.displayNameI18n).length > 0,
      "localized display names must survive the seed -> listing projection",
    );
    assert.equal(
      discover(fixture, createFreshConfig(fixture, userConfigPath)).plugins.some(
        (plugin) => plugin.id === DOCUMENTS_ID,
      ),
      false,
      "a suppressed built-in must not be discovered",
    );
  } finally {
    fixture.cleanup();
  }
});

test("reading the plugin catalog never creates or rewrites user config", () => {
  const fixture = createFixture();
  try {
    writeOfficialCacheFixture(fixture.storageRoot, DOCUMENTS);

    // 不存在的 user config 文件：任何一次 list/overview 之后都不允许被创建出来。
    const missingConfigPath = join(fixture.workspaceDir, "never-written-config.json");
    overview(fixture, createFreshConfig(fixture, missingConfigPath));
    discover(fixture, createFreshConfig(fixture, missingConfigPath));
    assert.equal(
      existsSync(missingConfigPath),
      false,
      "defaultEnabled must not be materialized into user config by a read",
    );

    const userConfigPath = createUserConfig(fixture, "existing-config.json", {
      plugins: { suppressedBuiltins: [DOCUMENTS_ID] },
    });
    const before = readFileSync(userConfigPath, "utf8");
    overview(fixture, createFreshConfig(fixture, userConfigPath));
    discover(fixture, createFreshConfig(fixture, userConfigPath));
    assert.equal(readFileSync(userConfigPath, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});
