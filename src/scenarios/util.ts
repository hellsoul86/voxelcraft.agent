import type { Event } from "../voxelcraft/obs_types.js";

export function findActionResult(events: Event[] | undefined, ref: string): Event | undefined {
  if (!events) return undefined;
  return events.find((e) => e?.type === "ACTION_RESULT" && e?.ref === ref);
}

export function findTaskDone(events: Event[] | undefined, taskId: string): Event | undefined {
  if (!events) return undefined;
  return events.find((e) => e?.type === "TASK_DONE" && e?.task_id === taskId);
}

export function findTaskFail(events: Event[] | undefined, taskId: string): Event | undefined {
  if (!events) return undefined;
  return events.find((e) => e?.type === "TASK_FAIL" && e?.task_id === taskId);
}

export function getBool(e: any, key: string): boolean | undefined {
  const v = e?.[key];
  return typeof v === "boolean" ? v : undefined;
}

export function getString(e: any, key: string): string | undefined {
  const v = e?.[key];
  return typeof v === "string" ? v : undefined;
}

export function getNumber(e: any, key: string): number | undefined {
  const v = e?.[key];
  return typeof v === "number" ? v : undefined;
}

