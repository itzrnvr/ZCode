import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { registerMcpTools, traceContextToLogContext } from "../deps.js";
import type {
  McpConnectionSnapshot,
  McpServerConfig,
  McpToolDescriptor,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { settleWithin } from "../withDeadline.js";
import type { PluginReferenceCatalog } from "@zcode/contracts";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

/**
 * 首个 turn 等待 MCP 工具注册的上限。健康 server 通常 1s 内连上；死端点或卡住的
 * OAuth 不该把 provider 请求拖到 session 级的 15s 预算。超时后按当前已连接的部分
 * 先注册，其余 server settle 后再补注册；工具真正被调用时连接仍未就绪会由
 * callTool 在调用点报错，而不是阻塞会话/轮次。
 */
const MCP_TOOL_REGISTRATION_WAIT_MS = 1_500;

/**
 * 只有同时携带 resolver 注入的官方 plugin id 和本进程私有 authority 的 server 才能共享
 * Computer Use 项目授权。server 名、tool 名和 manifest env 都可被第三方仿造，不能单独作为信任依据。
 */
export function computeOfficialCuaServerNames(
  servers: Record<string, McpServerConfig>,
  trustedServerNames: ReadonlySet<string>,
): Set<string> {
  const expectedAuthority = getCapturedZCodeCuaBrokerCredentials().pluginAuthority;
  const names = new Set<string>();
  if (!expectedAuthority) return names;

  for (const [name, config] of Object.entries(servers)) {
    if (!trustedServerNames.has(name)) continue;
    if (config.type !== "stdio") continue;
    if (
      config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() !==
        ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
      config.env?.[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim() !== expectedAuthority
    ) {
      continue;
    }
    names.add(name);
  }
  return names;
}

/**
 * #4：MCP 连接是否在 runtime 构造期/context 初始化就启动。
 *
 * 冷恢复会话（bootstrap 置位 `mcp.deferStartupUntilResumed`）的激活关键路径包含
 * record materialize 与整段 resume hydration；在其间启动 MCP 会让 stdio 子进程
 * spawn + 握手突发与 hydration 争用同一个事件循环（实测首开 3–5 s 的主要成分）。
 * 这类会话改由 `resumeFromStore` 收尾启动，首轮 `initializeMcp` 仍幂等兜底，
 * 因此“构造了但从未 resume”的会话不会永久失去 MCP。
 */
export function shouldStartMcpStartupEagerly(config: {
  mcp?: { deferStartupUntilResumed?: boolean };
}): boolean {
  return config.mcp?.deferStartupUntilResumed !== true;
}

export function startMcpStartup(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<McpConnectionSnapshot> | undefined {
  if (this.mcpInitialized) return this.mcpStartupPromise;
  this.mcpInitialized = true;

  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    this.mcpToolsRegistered = true;
    return undefined;
  }

  const servers = this.config.mcp?.servers ?? {};
  if (Object.keys(servers).length === 0) {
    const startup = Promise.all([this.mcpPort.status(), this.mcpPort.listTools()])
      .then(([statuses, tools]) => ({ statuses, tools }))
      .catch((error) => {
        this.logger?.warn("MCP existing tool discovery failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.existing_tools.failed",
          module: "core.runtime",
          status: "failed",
        });
        return { statuses: {}, tools: [] };
      });
    this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
    return this.mcpStartupPromise;
  }

  const startedAt = Date.now();
  const startup = this.mcpPort
    .connectConfiguredServers(servers, {
      // authorization_code MCP 无人完成浏览器授权时，session 启动过去会等默认 5 分钟，
      // 导致模型请求迟迟不发出；session 只等 15s，授权入口由设置页 mcp/list 展示。
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: traceContext,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    })
    .then((snapshot) => {
      const statusCounts = Object.values(snapshot.statuses).reduce<Record<string, number>>(
        (counts, status) => {
          counts[status.status] = (counts[status.status] ?? 0) + 1;
          return counts;
        },
        {},
      );
      this.logger?.info("MCP startup completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "mcp.startup.completed",
        module: "core.runtime",
        serverCount: Object.keys(servers).length,
        status: "completed",
        statusCounts,
        toolCount: snapshot.tools.length,
      });
      return snapshot;
    })
    .catch((error) => {
      this.logger?.warn("MCP startup failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.startup.failed",
        module: "core.runtime",
        status: "failed",
      });
      return { statuses: {}, tools: [] };
    });
  this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
  this.logger?.debug("MCP startup scheduled", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.startup.scheduled",
    module: "core.runtime",
    serverCount: Object.keys(servers).length,
    status: "started",
  });
  return this.mcpStartupPromise;
}

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) return;
  // 先置位：等待只发生一次。未就绪的 server 在本函数返回后由其 settle 补注册，
  // 后续 turn 不会再次进入这里等连接。
  this.mcpToolsRegistered = true;

  const startup = this.startMcpStartup(traceContext);
  const mcpPort = this.mcpPort;
  if (!startup || !mcpPort) {
    return;
  }
  const serverCount = Object.keys(this.config.mcp?.servers ?? {}).length;
  const registerFromTools = (
    tools: readonly McpToolDescriptor[],
    source: "connected" | "deadline",
  ): void => {
    try {
      const registered = registerMcpTools(this.registry, mcpPort, tools, {
        allowedTools: this.config.toolAllowlist,
        disallowedTools: this.config.toolDisallowlist,
        officialCuaServerNames: computeOfficialCuaServerNames(
          this.config.mcp?.servers ?? {},
          new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
        ),
        // 插件 UI：display.ui 需要 server → pluginId 的归属；catalog 是 session 冻结的唯一权威。
        pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
      });
      // A7：记住注册集合与签名，回合边界 refreshMcpToolsIfChanged 据此判断是否重注册。
      this.registeredMcpToolNames = registered;
      this.mcpToolsSignature = mcpToolsSignature(tools);
      this.mcpToolListRevision = mcpPort.toolListRevision?.();
      if (registered.length > 0) {
        this.invalidateToolCache();
      }
      this.logger?.info("MCP tools registered", {
        ...traceContextToLogContext(traceContext),
        event: "mcp.tools.registered",
        module: "core.runtime",
        registeredToolCount: registered.length,
        serverCount,
        source,
        status: "completed",
      });
    } catch (error) {
      this.logger?.warn("MCP tool registration failed", {
        ...traceContextToLogContext(traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.tool_registration.failed",
        module: "core.runtime",
        source,
        status: "failed",
      });
    }
  };

  let timedOut = false;
  const settled = await settleWithin(
    startup.then(
      (snapshot) => snapshot,
      (error: unknown) => {
        this.logger?.warn("MCP initialization failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.initialization.failed",
          module: "core.runtime",
          status: "failed",
        });
        return undefined;
      },
    ),
    undefined,
    MCP_TOOL_REGISTRATION_WAIT_MS,
    () => {
      timedOut = true;
    },
  );

  if (!timedOut && settled) {
    registerFromTools(settled.tools, "connected");
    return;
  }
  if (timedOut) {
    // 部分注册：当前已连上的 server 的工具先进入工具表，其余等 startup settle 后补。
    try {
      // status()/listTools() 也是 RPC：上游卡住时它们同样会挂住，
      // 因此这里给部分注册一个短上限，拿不到就当没有可用工具。
      const tools = await settleWithin(
        mcpPort
          .listTools()
          .then((result) => result ?? ([] as readonly McpToolDescriptor[]))
          .catch(() => [] as readonly McpToolDescriptor[]),
        [] as readonly McpToolDescriptor[],
        MCP_TOOL_REGISTRATION_WAIT_MS,
      );
      registerFromTools(tools, "deadline");
    } catch (error) {
      this.logger?.warn("MCP partial tool registration failed", {
        ...traceContextToLogContext(traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.tool_registration.partial_failed",
        module: "core.runtime",
        status: "failed",
      });
    }
    void startup.then(
      (snapshot) => registerFromTools(snapshot.tools, "connected"),
      () => undefined,
    );
  }
}

/**
 * server 名 → 插件稳定 id。catalog 里 disabled 插件的 mcpServerNames 为空，天然不参与；
 * 同名冲突插件的 server 名互不相同（带插件名前缀），不需要额外去重。
 */
function buildPluginIdByServerName(
  catalog: PluginReferenceCatalog | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const plugin of catalog?.plugins ?? []) {
    for (const serverName of plugin.mcpServerNames) map.set(serverName, plugin.pluginId);
  }
  return map;
}

function mcpToolsSignature(descriptors: readonly McpToolDescriptor[]): string {
  return descriptors
    .map((tool) => `${tool.serverName}\u0001${tool.toolName}\u0001${tool.description ?? ""}`)
    .sort()
    .join("\n");
}

/**
 * 回合开始前刷新 MCP 工具表。只有端口报告 tools/list_changed 计数变化时才重新 listTools
 * （adapter 对收到通知的 server 重拉），再比较工具签名，变了就注销旧的、注册新的并失效工具缓存。
 * 不实现 toolListRevision 的端口（mock / 静态 server）永远不刷新；回合内也不刷新（已拍板）。
 */
export async function refreshMcpToolsIfChanged(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const mcpPort = this.mcpPort;
  if (!mcpPort || !this.mcpToolsRegistered) return;
  const revision = mcpPort.toolListRevision?.();
  if (revision === undefined || revision === this.mcpToolListRevision) return;
  let descriptors: McpToolDescriptor[];
  try {
    descriptors = await mcpPort.listTools();
  } catch {
    return;
  }
  this.mcpToolListRevision = revision;
  const signature = mcpToolsSignature(descriptors);
  if (this.mcpToolsSignature === signature) return;
  const previous = new Set(this.registeredMcpToolNames ?? []);
  for (const name of previous) this.registry.unregister(name);
  const registered = registerMcpTools(this.registry, mcpPort, descriptors, {
    allowedTools: this.config.toolAllowlist,
    disallowedTools: this.config.toolDisallowlist,
    officialCuaServerNames: computeOfficialCuaServerNames(
      this.config.mcp?.servers ?? {},
      new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
    ),
    pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
  });
  this.registeredMcpToolNames = registered;
  this.mcpToolsSignature = signature;
  this.invalidateToolCache();
  this.logger?.info("MCP tools re-registered after list_changed", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.tools.reregistered",
    module: "core.runtime",
    removedToolCount: previous.size,
    registeredToolCount: registered.length,
    status: "completed",
  });
}
