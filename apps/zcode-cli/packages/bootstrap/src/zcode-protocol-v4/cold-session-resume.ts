// 冷恢复协调器：订阅落在「不在内存注册表、但可能已持久化」的会话时
// （CLI 重启后打开历史会话），经宿主钩子把 record 拉起来，再回到既有
// gateway READY hydration 路径。从 v4-gateway 拆出（单一职责 + max-lines）。
//
// 语义要点：
// - 这里保留既有 runtime activation 单飞；完整 READY 水位由 gateway 负责；
// - 视图路径（readViewMaterial）刻意**不**单飞：gateway 的 viewFlights 已经包住
//   整段「裸读 + hydrate」，这里再叠一层 flight 表只会让"谁在等谁"不可读，而裸读
//   本身是 16ms 量级（messagesTail limit=500，见 server-operations.ts 的实测记录）。
// - 错误分型（项目规范：不靠错误文本分流）：
//   fault.subscribe.sessionNotFound（store 里也没有 / 宿主不支持恢复）
//   vs fault.subscribe.resumeFailed（恢复中途失败，保留原始 cause）。
//   message 附带 reasonCode——renderer 订阅错误块直显 lastError，无需 UI 改动即透出。

import type { MessageWithParts } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";

export type ColdSessionResumeOutcome =
  | { status: "resumed"; persistedMessages?: MessageWithParts[] }
  | { status: "notFound" };

/**
 * 视图冷物化（view-only）取到数的两种形态。
 *
 * 与 {@link ColdSessionResumeOutcome} 分成两个类型是有意的：resume 的产物是「runtime
 * 已激活」，视图路径要的只是「投影建得起来」，两者对宿主的索取面不同——后者一旦借道
 * resume 就把 4663ms 的 app.resume() 运行时构造重新拉回点击路径（实测：冷开 22515 part
 * 会话 11216ms 到首行，其中 activation 占 4663ms，磁盘读只占 16ms）。
 *
 * `unsupported` = 宿主没有裸读面（旧 host / 测试桩）。调用方必须退回 activation 路径，
 * 绝不能把「读不到」当成「会话不存在」——那会把一个还活着的历史会话报成 notFound。
 */
export type ColdViewMaterialReady =
  | { status: "available"; persistedMessages: MessageWithParts[] }
  | { status: "unsupported" };

/**
 * 宿主裸读面的完整结果。`notFound` 不会到达调用方：协调器把它翻成
 * {@link V4SubscribeSessionUnavailableError}，与 resume 路径同一个错误类与 reasonCode。
 */
export type ColdViewMaterialOutcome = ColdViewMaterialReady | { status: "notFound" };

/**
 * 无 backing record 的视图 hydration 里**缺席**的事实来源（ruling 5 的分歧集）。
 *
 * 逐项都是「record 才有」的读取面，视图路径拿不到，因此 view→READY 升级后必须重建一次
 * 投影才能收敛到今天（activation-first）的状态。核查结论：这七项在 record-less 分支下
 * 全部无条件缺席，分歧集**不为空**，所以 gateway 的强制重建不是死机器：
 * - `memoryEvents`：record.eventStore 快照。app.resume() 追加的 SessionResumed /
 *   SessionTitleUpdated / checkpoint_created / followup_mode_changed / model_selected
 *   都只活在这里（沙箱日志实测冷开 sourceEventSeq=2 就是前两条）。
 * - `workflowRunReplay`：record.app.replayDynamicWorkflowRuns（dwf journal 回放）。
 * - `fileChangeArtifacts`：record.app.readToolResultArtifact（turn 文件摘要的
 *   workspace checkpoint 正文）。
 * - `modelContextWindow`：record 路径按**本会话 runtime 的当前选型**解析档位，视图路径
 *   只能按持久 transcript 的最后一次选型 + 别的活跃 app 的 registry 解析；用户改过模型
 *   而 ModelSelected 未持久化时两者会不同。
 * - `configSeed`：getSessionConfigSeed 没有 runtime 真值（见 v4-bridge 的持久派生分支）。
 * - `usageSeed`：readSessionContextUsage 没有 record 直接返回 undefined。
 * - `subagentProjection`：listSessionSubagents 没有 liveParent，revision 退化成
 *   parentSession.time.updated，且拿不到 parentEvents / parentProjection。
 */
export const COLD_VIEW_DEFERRED_SOURCES = [
  "memoryEvents",
  "workflowRunReplay",
  "fileChangeArtifacts",
  "modelContextWindow",
  "configSeed",
  "usageSeed",
  "subagentProjection",
] as const;

export type ColdDeferredSource = (typeof COLD_VIEW_DEFERRED_SOURCES)[number];

/** 协调器需要的宿主能力窄面（与 V4GatewayHost 同形，避免循环 import）。 */
interface ColdSessionResumeHost {
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionResumeOutcome>;
  /**
   * 视图冷物化的裸读面：只做持久层存在性判定 + 尾读，**绝不**激活 runtime。
   * 缺席（旧宿主）→ readViewMaterial 回 unsupported，调用方退回 activation。
   */
  readColdViewMaterial?(sessionId: string): Promise<ColdViewMaterialOutcome>;
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: Record<string, unknown>): void;
}

/** 订阅不可用会话的结构化错误（reasonCode 见文件头）。 */
export class V4SubscribeSessionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reasonCode: "fault.subscribe.sessionNotFound" | "fault.subscribe.resumeFailed",
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${detail} (${reasonCode})`, options);
    this.name = "V4SubscribeSessionUnavailableError";
  }
}

export class ColdSessionResumeCoordinator {
  /** sessionId → 进行中的 runtime activation；settle 后立即释放。 */
  private readonly flights = new Map<string, Promise<MessageWithParts[] | undefined>>();

  constructor(private readonly host: ColdSessionResumeHost) {}

  ensureResumed(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const inFlight = this.flights.get(sessionId);
    if (inFlight) {
      this.host.onDebug?.(`cold resume joined existing flight session=${sessionId}`);
      return inFlight;
    }
    this.host.onDebug?.(`cold resume flight created session=${sessionId}`);
    const flight = this.resume(sessionId, resumeThoughtLevel, workspace).finally(() => {
      this.flights.delete(sessionId);
      this.host.onDebug?.(`cold resume flight cleared session=${sessionId}`);
    });
    this.flights.set(sessionId, flight);
    return flight;
  }

  /**
   * 视图路径取数：与 ensureResumed 共用同一套 not-found 分型（同一个错误类、同一个
   * reasonCode、逐字相同的 message），因此 renderer 的错误块无需知道走的是哪条路径。
   * 失败分型仍按项目规范走 reasonCode 而不是错误文本。
   */
  async readViewMaterial(sessionId: string): Promise<ColdViewMaterialReady> {
    const read = this.host.readColdViewMaterial;
    if (!read) {
      this.host.onDebug?.(`cold view material unsupported by host session=${sessionId}`);
      return { status: "unsupported" };
    }
    let outcome: ColdViewMaterialOutcome;
    try {
      outcome = await read.call(this.host, sessionId);
    } catch (error) {
      this.host.onError?.("v4.subscribe.viewMaterial", error, {
        phase: "readColdViewMaterial",
        sessionId,
      });
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.resumeFailed",
        `Failed to read persisted session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (outcome.status === "notFound") {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active and not persisted: ${sessionId}`,
      );
    }
    return outcome;
  }

  clear(): void {
    this.flights.clear();
  }

  private async resume(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const resume = this.host.resumePersistedSession;
    if (!resume) {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active: ${sessionId}`,
      );
    }
    let outcome: ColdSessionResumeOutcome;
    try {
      outcome = workspace
        ? await resume.call(this.host, sessionId, resumeThoughtLevel, workspace)
        : await resume.call(this.host, sessionId, resumeThoughtLevel);
    } catch (error) {
      this.host.onError?.("v4.subscribe.resume", error, {
        phase: "resumePersistedSession",
        sessionId,
      });
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.resumeFailed",
        `Failed to resume persisted session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (outcome.status === "notFound") {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active and not persisted: ${sessionId}`,
      );
    }
    return outcome.persistedMessages;
  }
}
