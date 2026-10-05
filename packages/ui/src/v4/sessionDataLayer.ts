// SessionDataLayer（纯数据层）。
// Map<topic, SessionStore>，不知道「显示」这回事；生命周期 = 引用计数：
// 有 pane 引用 → 订阅；归零 → 延迟退订（keep-warm，防拖拽/切 pane 抖动）。
// 一个实例对应一条 host 连接；跨 workspace 分屏在 shell 层做
// Map<workspaceKey, SessionDataLayer>，本层不感知 workspace。
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { SessionOpenKind } from "@/lib/sessionOpenArmsTelemetry.js";
import { conversationTopic, type ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";
import type { CommandsQueryParams, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";
import {
  conversationRowsPrefetchCache,
  createConversationRowsFastReader,
} from "@/v4/conversationRowsFastPath.js";
// 只从纯调度模块取这一个入口，不从 useTaskListPrefetch（React 胶水）取：
// 胶水要借 workspaceConnectionRegistry 的连接租约，而注册表自己 import 本文件，
// 直接 import 胶水会成环。注册点由胶水在惰性创建控制器时回填；注册前调用是 no-op，
// 语义正好——侧栏还没渲染过，也就没有预取可取消。
import { notifyTaskListPrefetchOpened } from "@/v4/conversationRowsPrefetch.js";

/** pane 持有的租约；release 幂等。 */
export interface SessionLease {
  readonly sessionId: string;
  readonly store: ConversationProjectionStore;
  /** 由数据层按 projection 生命周期判定，避免 pane 首次 render 时 snapshot 仍为空。 */
  readonly openKind: SessionOpenKind;
  /** pane acquire 的 Renderer 单调时钟起点。 */
  readonly startedAt: number;
  release(): void;
}

interface SessionDataLayerOptions {
  transport: ConversationTransport;
  /** 引用归零后延迟退订窗口（ms），默认 30s。 */
  keepWarmMs?: number;
}

const SESSION_DATA_LAYER_KEEP_WARM_MS = 30_000;
const E2E_SESSION_DATA_LAYER_KEEP_WARM_MS = 1_000;

function resolveSessionDataLayerKeepWarmMs(
  e2eStoreBridgeEnabled = shouldExposeE2EStoreBridge(),
): number {
  return e2eStoreBridgeEnabled
    ? E2E_SESSION_DATA_LAYER_KEEP_WARM_MS
    : SESSION_DATA_LAYER_KEEP_WARM_MS;
}

interface SessionEntry {
  store: ConversationProjectionStore;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class SessionDataLayer {
  private readonly transport: ConversationTransport;
  private readonly keepWarmMs: number;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly offFrame: () => void;
  private readonly offRuntimeRestart: () => void;
  private disposed = false;

  constructor(options: SessionDataLayerOptions) {
    this.transport = options.transport;
    this.keepWarmMs = options.keepWarmMs ?? resolveSessionDataLayerKeepWarmMs();
    // 连接级单监听：按 topic 扇入到各 store（pane 间共享的正是这一条连接）。
    this.offFrame = this.transport.onFrame((frame, context) => {
      this.entries.get(frame.topic)?.store.handleFrame(frame, context);
    });
    // runtime 换代后预取结果一律作废：换代期间可能有别的进程写过库，而换代前取到的行
    // 带着当时的 revision，新鲜度已无法由客户端判断。
    // 这里清的是**预取缓存**，不是已播种的临时行——durable store（SQLite）跨 CLI 重启
    // 仍然成立，把正在显示的临时行清掉只会让 pane 白屏一次。
    this.offRuntimeRestart = this.transport.onRuntimeRestart(() => {
      conversationRowsPrefetchCache.invalidate();
    });
  }

  /**
   * 取得 session 的投影 store。首个引用触发 subscribe（新开 pane 就是一次
   * subscribe，与刷新、新设备同一路径）；重复 acquire 共享同一 store（readonly，
   * 同 session 多 pane = 多视图）。
   */
  acquire(sessionId: string): SessionLease {
    if (this.disposed) {
      throw new Error("SessionDataLayer 已释放，不能再 acquire");
    }
    const topic = conversationTopic(sessionId);
    const startedAt = monotonicNow();
    let entry = this.entries.get(topic);
    let openKind: SessionOpenKind;
    if (entry) {
      openKind = entry.keepWarmTimer !== null ? "keep_warm" : "warm";
      entry.refCount++;
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
        entry.keepWarmTimer = null;
      }
    } else {
      const store = new ConversationProjectionStore(topic, this.transport);
      entry = { store, refCount: 1, keepWarmTimer: null };
      // 不变量：一个 topic 一个 store 实例，且**永不池化 / 跨会话复用**。
      // 快绘临时层的「权威 snapshot 落地后永久拒绝播种」标记是按 store 实例存的
      // （conversationFastRowsLayer.ts），复用实例会让标记泄漏到下一个会话，表现为
      // 「快绘再也不命中」——不报错，只是静默失效，极难查。两道防线：
      // releaseEntry 先 entries.delete 再 store.close()（见下方），所以不存在把已关闭
      // 实例塞回表里的路径；且已关闭的 store 拒绝播种。两条都由
      // test/sessionDataLayerStoreIdentity.test.ts 钉住。
      this.entries.set(topic, entry);
      openKind = "cold";
      // 快绘必须在 connect 之前发出，而且这是**载荷顺序**而不是风格问题：CLI 把同一条
      // 连接上的所有请求串在一个 FIFO 上（bootstrap/src/zcode-protocol/transport.ts:186-195，
      // shouldBypassProcessingQueue :224-233 只放行 sessionStop / workspaceCancelGenerateText），
      // 而 subscribe 的处理函数里就是视图冷物化（约 2 280 ms hydration）。subscribe 先进
      // 队列，快绘就要排在整段 hydration 后面，本功能等于没做。
      //
      // 「把请求排在 subscribe 前面」正是 6b9c6e1 刚修掉的那个 bug 的形状（journal 发现查询
      // 自激活、抢下串行首位、把冷视图物化挤下去，实测冷开 11.2 s），所以必须写清楚为什么
      // 本读取不是同一件事：conversationRows 是 server.ts 的直接派发，不激活、不在请求路径上
      // 折叠、不读 transcript、不取写锁（projection lane 的硬不变量，带测试；Main 已裁定）。
      // 它在串行车道上的占用是 miss 时 1-3 条单行 PK 查询，hit 时一次 begin deferred 的
      // 有界分页读——后者与 subscribe 快照本来就载的是同一量级载荷。占首位安全，恰恰因为
      // 它便宜且不自激活。一旦那条不变量被破坏，这个派发顺序就会变成刚修掉的那个 bug，
      // 所以依赖关系记在三处（projection §12、notes §14.4、这段注释），不记在一处。
      notifyTaskListPrefetchOpened(sessionId);
      const prefetched = conversationRowsPrefetchCache.consume(sessionId);
      if (prefetched) {
        // 预取命中是同步的，天然排在 connect 之前，一次 RPC 都不用发。
        store.seedFastRows({
          ok: true,
          revision: prefetched.revision,
          rows: prefetched.rows,
          hasMore: prefetched.hasMore,
        });
      } else {
        // 不 await：connect 才是权威路径，绝不等加速器。慢的、丢的、晚于 snapshot 才
        // resolve 的快绘结果都会被 seedFastRows 拒掉（永久标记），因此是 no-op 而不是隐患。
        void createConversationRowsFastReader(this.transport)
          .read({ sessionId })
          .then((outcome) => {
            store.seedFastRows(outcome);
          });
      }
      // 订阅失败落在 store.state（status=error + retry()），不在这里抛。
      void store.connect({ rendererPrepareStartedAt: startedAt });
    }
    logger.lifecycle.info("v4 session data lease acquired", {
      event: "v4.session_data.acquire",
      keepWarm: entry.keepWarmTimer !== null,
      module: "ui.v4.session_data_layer",
      openKind,
      refCount: entry.refCount,
      sessionId,
      status: "completed",
      topic,
    });

    let released = false;
    return {
      sessionId,
      store: entry.store,
      openKind,
      startedAt,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(topic);
      },
    };
  }

  /** 当前活跃（含 keep-warm 中）的 session 数，测试与调试观测点。 */
  get size(): number {
    return this.entries.size;
  }

  /** renderer pending-command registry 的只读对账入口；仍复用本 layer 的同一 host connection。 */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
    return this.transport.queryCommands(params);
  }

  private releaseEntry(topic: string): void {
    const entry = this.entries.get(topic);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0 || this.disposed) {
      logger.lifecycle.info("v4 session data lease released", {
        event: "v4.session_data.release",
        module: "ui.v4.session_data_layer",
        refCount: entry.refCount,
        status: "completed",
        topic,
      });
      return;
    }
    // 关 pane ≠ 停 session：这里只是退订视图，session 在 CLI 里照跑。
    entry.keepWarmTimer = setTimeout(() => {
      this.entries.delete(topic);
      logger.lifecycle.info("v4 session data keep-warm expired", {
        event: "v4.session_data.keep_warm_expired",
        module: "ui.v4.session_data_layer",
        refCount: 0,
        status: "completed",
        topic,
      });
      void entry.store.close();
    }, this.keepWarmMs);
    logger.lifecycle.info("v4 session data lease released", {
      event: "v4.session_data.release",
      keepWarmMs: this.keepWarmMs,
      module: "ui.v4.session_data_layer",
      refCount: 0,
      status: "keep_warm",
      topic,
    });
  }

  /** 连接销毁时清场（window/workspace 卸载）。 */
  dispose(): void {
    if (this.disposed) return;
    logger.lifecycle.info("v4 session data layer dispose started", {
      entryCount: this.entries.size,
      event: "v4.session_data.dispose.started",
      module: "ui.v4.session_data_layer",
      status: "started",
    });
    this.disposed = true;
    this.offFrame();
    this.offRuntimeRestart();
    for (const entry of this.entries.values()) {
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
      }
      void entry.store.close();
    }
    this.entries.clear();
    logger.lifecycle.info("v4 session data layer dispose completed", {
      event: "v4.session_data.dispose.completed",
      module: "ui.v4.session_data_layer",
      status: "completed",
    });
  }
}
