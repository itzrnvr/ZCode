export {
  createSqliteSessionStore,
  getDefaultSessionDbPath,
  openStartupSqliteSessionStore,
  SqliteSessionStore,
} from "./session-store/sqlite-session-store.js";
export type { ConversationProjectionSink } from "./session-store/sqlite-session-store.js";
// conversation projection（0024）的存取词汇同样住在 adapters：行内容对存储层不透明
// （payload 是 bootstrap 序列化出来的 ConversationRow），但 schema 版本号必须与写入方共用
// 同一个常量，否则「升位即让旧行失效」这条规则会在两边各写一份然后漂移。
export { CONV_PROJECTION_SCHEMA_VERSION } from "./session-store/migrations/0024-conversation-projection.js";
export type {
  ProjectionMeta,
  ProjectionPage,
  ProjectionView,
  StoredProjectionRow,
} from "./session-store/repositories/conversation-projection.js";
export { createDwfJournalStore } from "./session-store/repositories/dwf-journal.js";
// run 内省查询的类型住在 adapters 而不是 contracts：它们说的是 **journal 行**的词汇
// （dwf_run 的列 + 时间戳），不是跨边界的工具载荷；而 bootstrap 已经依赖 @zcode/adapters，
// 能力探测的窄接口因此可以直接复用这份签名，不必在宿主侧再抄一遍（抄一遍就会漂移）。
export type {
  DwfArtifactItem,
  DwfArtifactItemsQuery,
  DwfListRunsQuery,
  DwfNodeStatusCounts,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
} from "./session-store/repositories/dwf-journal.js";
export type {
  DwfRunDetailRow,
  DwfRunListItem,
  DwfRunSessionListItem,
  DwfRunSessionRow,
  DwfRunTimestamps,
  DwfWorldNodeRow,
} from "./session-store/repositories/dwf-journal-codecs.js";
export { SqliteSessionMigrationError } from "./session-store/errors.js";
export type {
  SqliteSessionMigrationErrorKind,
  SqliteSessionMigrationErrorOptions,
} from "./session-store/errors.js";
export type {
  SessionStoreDebugCounts,
  SqliteSessionStoreOptions,
} from "./session-store/options.js";

export type {
  AsyncSqliteMigrationOptions,
  SqliteMigrationProgress,
} from "./session-store/migration-runner.js";

// 会话库的世代备份住在 adapters（而不是 bootstrap）：它操作的是**存储层的文件**，
// 用的是 sqlite 自己的 VACUUM INTO，和 Electron / 协议层都没有关系，因此可以在纯 node
// 下用真库做 round-trip 回归。bootstrap 只负责决定 "什么时候跑" 与 "库在哪"。
export {
  createSnapshot,
  DEFAULT_GENERATIONS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_STARTUP_DELAY_MS,
  listSnapshots,
  readSourceSignature,
  restoreSnapshot,
  RECOVERY_NOTE_FILE,
  runVacuumIntoWorker,
  scheduleSessionDatabaseBackups,
} from "./session-store/database-backups.js";
export type {
  CreateSnapshotOptions,
  FileMark,
  RestoreSnapshotOptions,
  RestoreSnapshotResult,
  ScheduleSessionDatabaseBackupsOptions,
  SessionDatabaseBackupHandle,
  SessionDatabaseBackupTimer,
  SnapshotInfo,
  SnapshotManifest,
  SnapshotManifestEntry,
  SnapshotResult,
  SnapshotSkipReason,
  SourceSignature,
  VacuumIntoRunner,
} from "./session-store/database-backups.js";
