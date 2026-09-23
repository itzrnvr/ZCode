# Fork Customization Guide

This is a fork of [itzrnvr/ZCode](https://github.com/itzrnvr/ZCode) with custom features.
The upstream `AGENTS.md` contains ZCode's original guidelines (in Chinese).
This file contains **fork-specific** instructions that take precedence.

## Conflict-Resistant Development Rules

**Goal:** Merge upstream changes without conflicts. Our patches survive `git merge upstream/main`.

### Rule 1: New logic goes in new files

Never add new functions, types, or constants to existing upstream files.
Create a new file instead. New files have **zero** merge-conflict risk.

### Rule 2: Existing file edits are minimal and at stable locations

When you must touch an existing file, make the smallest possible change and place it at:
- **Imports** (top of file) — a single `import` line
- **Return statements** — wrap or filter at the return point
- **End of functions** — append after existing logic

Never edit mid-function logic, SQL strings, or complex expressions in existing files.

### Rule 3: One integration point per feature

Each feature touches existing files in exactly 1-2 places. Document them here
so re-applying after an upstream merge is trivial.

## Build & Deploy

```bash
# Local-only: fix pnpm version (don't commit this)
node -e "const fs=require('fs'); ['package.json','apps/zcode-cli/package.json'].forEach(f=>{const p=JSON.parse(fs.readFileSync(f,'utf8'));p.packageManager='pnpm@10.33.0';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')})"

# Build (from repo root)
pnpm --filter @zcode/desktop build:no-runtime-assets

# Deploy: extract installed asar, swap out/ dir, repack, swap
# See D:/zcode-analysis/swap-src.bat
```

## Git Workflow

- `main` — tracks upstream ZCode, always buildable
- `feat/<name>` — one branch per feature, merge to main when done
- Multiple agents can work on different branches simultaneously
- **Never commit `package.json` or `apps/zcode-cli/package.json`** — the pnpm version fix is local-only

## Feature Registry

### 1. Side-Chat Persistence (`feat/sidechat-persistence`)

**What:** Side-pane tab state survives renderer reloads via localStorage.
Also hides "Selection side chat" entries from the main task list.

**New files (no conflict risk):**
- `packages/ui/src/lib/sidePanePersistence.ts` — localStorage read/write helpers
- `packages/services/src/session/sideChatFilter.ts` — generic `excludeSideChats<T>()` filter

**Integration points in existing files:**
- `packages/ui/src/lib/taskSidePaneMemory.ts`:
  - Line ~6: `import { readPersistedSidePaneState, persistSidePaneState } from "./sidePanePersistence.js"`
  - `readTaskSidePaneMemoryState()`: localStorage fallback when Map misses (3 lines)
  - `saveTaskSidePaneMemoryState()`: `persistSidePaneState(key, nextState)` at end (1 line)
- `packages/services/src/session/taskIndexRepo.ts`:
  - Line ~41: `import { excludeSideChats } from "#src/session/sideChatFilter.js"`
  - `listTaskMetas()`: `return excludeSideChats(rows.map(rowToMeta))`
  - `queryTaskList()`: `items: excludeSideChats(rows.map(...))`
  - `queryGroupedTaskView()`: `const activeTasks = excludeSideChats(...)`

### Future Features (not yet implemented)

- **zk-kit**: Study-kit panel/notion/promotion UI — add as source-level components in `packages/ui/src/`
- **Fork promotion**: Fix side-chat fork render blocker — source at `apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts`

## Upstream Sync Procedure

```bash
git checkout main
git pull origin main          # or add upstream remote and pull from there
git checkout feat/sidechat-persistence
git merge main                # conflicts will be tiny (1-2 lines at integration points)
# Resolve any conflicts at the documented integration points
# Rebuild and redeploy
pnpm --filter @zcode/desktop build:no-runtime-assets
```

If an integration point conflicts, the fix is mechanical:
re-add the `import` line or re-wrap the `return` statement with `excludeSideChats()`.
The new files (`sidePanePersistence.ts`, `sideChatFilter.ts`) will never conflict.
