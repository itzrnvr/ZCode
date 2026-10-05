import type { SessionDatabaseBackupHandle } from "@zcode/adapters/storage";
import { scheduleSessionDatabaseBackups } from "@zcode/adapters/storage";
import type { Logger } from "@zcode/contracts";
import { dirname, join } from "node:path";

/**
 * 备份目录 = 库文件的兄弟目录 `backups/`（默认布局下就是 `~/.zcode/cli/db/backups`）。
 *
 * 两个理由，都不是审美：
 *  1. 从 dbPath 派生 ⇒ `storage.sessionDbPath` 覆盖、以及 `ZCODE_FORK_IDENTITY=blackbird`
 *     的数据根都自动跟着走。这里**不再解析一遍数据根**——解析两遍的地方迟早漂移。
 *  2. `packages/services/src/storage/domain/storageCatalog.ts` 的 `PREFIX_RULES.backups`
 *     已经列了 `"cli/db/backups"`（cleanability = `"confirm"`），所以快照落地就出现在
 *     资源管理界面里、用户可清理，目录表一行都不用改。
 */
export function getSessionDbBackupsDir(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

/**
 * 排定会话库的世代备份：启动后一次（`DEFAULT_STARTUP_DELAY_MS`），之后每 30 min 一次，
 * 保留 3 份。定时器是 unref 的，绝不会把本该退出的进程吊住。
 *
 * 必须在 session store 已经打开、迁移跑完之后调用：备份的是**迁移后**的库，
 * 而 `VACUUM INTO` 只读打开源库，因此与正在跑的 store 并存是安全的（实测：写事务持锁时
 * 也能拿到一致快照，源文件逐字节不变）。
 *
 * 多进程/多窗口同时排定也没问题：进程内单飞 + `.snapshot.lock` 跨进程互斥 + 源库签名比对，
 * 第二个调度器只会记一条 `skipped/unchanged`，不会白写 2 GB。
 */
export function scheduleStartupSessionDatabaseBackups(options: {
  dbPath: string;
  logger: Logger;
}): SessionDatabaseBackupHandle {
  return scheduleSessionDatabaseBackups({
    dbPath: options.dbPath,
    backupsDir: getSessionDbBackupsDir(options.dbPath),
    logger: options.logger.child({ module: "adapters.sessionStore" }),
  });
}
