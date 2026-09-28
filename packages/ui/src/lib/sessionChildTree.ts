import type { ZCodeTaskMeta } from "@zcode/shared";

/** Tree input is a task row; only taskId/workspace identity/fork linkage matter here. */
export type SessionChildTreeInput = Pick<
  ZCodeTaskMeta,
  "taskId" | "workspacePath" | "title" | "createdAt" | "updatedAt"
> &
  Partial<Pick<ZCodeTaskMeta, "workspaceIdentity" | "forkedFromTaskId">>;

export interface SessionChildTreeNode {
  task: SessionChildTreeInput;
  children: SessionChildTreeNode[];
}

/**
 * Nest fork children under their forkedFromTaskId parent for list rendering.
 * Unknown parents (deleted rows, other workspaces) stay top-level so nothing
 * silently disappears. Depth is unbounded along genuine parent chains; only
 * true link cycles are flattened so the render walk can never loop.
 */
export function buildSessionChildTree(
  tasks: readonly SessionChildTreeInput[],
): SessionChildTreeNode[] {
  const byId = new Map<string, SessionChildTreeNode>();
  for (const task of tasks) {
    if (!byId.has(task.taskId)) {
      byId.set(task.taskId, { task, children: [] });
    }
  }

  // First pass: link children to parents known in this batch.
  const childIds = new Set<string>();
  for (const task of tasks) {
    const parentId = task.forkedFromTaskId;
    if (parentId === undefined || parentId === task.taskId) continue;
    const parent = byId.get(parentId);
    const node = byId.get(task.taskId);
    if (parent !== undefined && node !== undefined && !childIds.has(task.taskId)) {
      parent.children.push(node);
      childIds.add(task.taskId);
    }
  }

  // Second pass: collect roots, then break link cycles without dropping rows.
  // A node caught inside a cycle renders top-level with no children, so the
  // walk always terminates and every batch row stays visible.
  const roots: SessionChildTreeNode[] = [];
  const onPath = new Set<string>();
  const emitted = new Set<string>();
  const detachCycle = (node: SessionChildTreeNode): SessionChildTreeNode => {
    onPath.add(node.task.taskId);
    const safeChildren: SessionChildTreeNode[] = [];
    for (const child of node.children) {
      if (onPath.has(child.task.taskId)) continue;
      safeChildren.push(detachCycle(child));
    }
    onPath.delete(node.task.taskId);
    emitted.add(node.task.taskId);
    return { task: node.task, children: safeChildren };
  };
  for (const task of tasks) {
    if (childIds.has(task.taskId) || emitted.has(task.taskId)) continue;
    const node = byId.get(task.taskId);
    if (node) roots.push(detachCycle(node));
  }
  for (const task of tasks) {
    if (!emitted.has(task.taskId)) {
      const node = byId.get(task.taskId);
      if (node) roots.push({ task: node.task, children: [] });
    }
  }
  return roots;
}
