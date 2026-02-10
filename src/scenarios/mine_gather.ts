import type { Scenario, ScenarioAct, ScenarioContext } from "./types.js";
import { findActionResult, findTaskDone, findTaskFail, getBool, getString } from "./util.js";

export class MineGatherScenario implements Scenario {
  name = "mine_gather";

  private palette: string[] = [];
  private idByName = new Map<string, number>();

  private phase = 0;
  private waitingRef: string | null = null;
  private waitingTaskID: string | null = null;

  private targetPos: [number, number, number] | null = null;
  private invTotalBefore = 0;
  private doneFlag = false;

  obsMode() {
    return "full" as const;
  }

  async init(ctx: ScenarioContext): Promise<void> {
    const blocksCat = await ctx.catalogs.get("block_palette");
    this.palette = blocksCat.data as string[];
    this.palette.forEach((name, idx) => this.idByName.set(name, idx));
    ctx.log(`[${this.name}] palette loaded (${this.palette.length})`);
  }

  async step(obs: any, ctx: ScenarioContext): Promise<ScenarioAct | null> {
    if (!ctx.voxels.hasCube()) return null;

    // Wait for ACTION_RESULT to get server task_id.
    if (this.waitingRef) {
      const ar = findActionResult(obs.events, this.waitingRef);
      if (!ar) return null;
      const ok = getBool(ar, "ok");
      if (!ok) {
        const code = getString(ar, "code") ?? "E_UNKNOWN";
        throw new Error(`[${this.name}] action rejected ref=${this.waitingRef} code=${code}`);
      }
      const tid = getString(ar, "task_id");
      if (!tid) throw new Error(`[${this.name}] missing task_id for ref=${this.waitingRef}`);
      this.waitingRef = null;

      // Some tasks can complete immediately (e.g. GATHER).
      const fail = findTaskFail(obs.events, tid);
      if (fail) {
        const code = getString(fail, "code") ?? "E_UNKNOWN";
        throw new Error(`[${this.name}] TASK_FAIL task_id=${tid} code=${code}`);
      }
      const done = findTaskDone(obs.events, tid);
      if (done) {
        this.phase++;
        return null;
      }

      this.waitingTaskID = tid;
      return null;
    }

    // Wait for TASK_DONE / TASK_FAIL.
    if (this.waitingTaskID) {
      const fail = findTaskFail(obs.events, this.waitingTaskID);
      if (fail) {
        const code = getString(fail, "code") ?? "E_UNKNOWN";
        throw new Error(`[${this.name}] TASK_FAIL task_id=${this.waitingTaskID} code=${code}`);
      }
      const done = findTaskDone(obs.events, this.waitingTaskID);
      if (!done) return null;
      this.waitingTaskID = null;
      this.phase++;
      return null;
    }

    switch (this.phase) {
      case 0: {
        this.targetPos = this.pickMineTarget(ctx);
        this.invTotalBefore = invTotal(obs?.inventory);
        const ref = "K_MINE_0";
        this.waitingRef = ref;
        return { tasks: [{ id: ref, type: "MINE", block_pos: this.targetPos }] };
      }
      case 1: {
        // Verify inventory increased and block is now AIR.
        if (!this.targetPos) throw new Error(`[${this.name}] missing targetPos`);
        const after = invTotal(obs?.inventory);
        if (after <= this.invTotalBefore) {
          throw new Error(`[${this.name}] expected inventory to increase: before=${this.invTotalBefore} after=${after}`);
        }
        const air = this.idByName.get("AIR");
        if (air === undefined) throw new Error(`[${this.name}] AIR missing from palette`);
        const b = ctx.voxels.getBlockAtWorld(this.targetPos);
        if (b === null) throw new Error(`[${this.name}] mined block out of view`);
        if (b !== air) throw new Error(`[${this.name}] expected mined block to be AIR, got=${b} (${this.palette[b] ?? "?"})`);

        // Optional: if any ITEM entities are nearby, try GATHER one.
        const selfPos = obs?.self?.pos as [number, number, number] | undefined;
        const item = (obs?.entities ?? []).find((e: any) => {
          if (e?.type !== "ITEM") return false;
          if (!selfPos || !Array.isArray(e?.pos) || e.pos.length !== 3) return false;
          const man = Math.abs(e.pos[0] - selfPos[0]) + Math.abs(e.pos[1] - selfPos[1]) + Math.abs(e.pos[2] - selfPos[2]);
          return man <= 2;
        });
        if (item?.id) {
          const ref = "K_GATHER_0";
          this.waitingRef = ref;
          this.phase = 2; // jump to gather verify
          return { tasks: [{ id: ref, type: "GATHER", target_id: item.id }] };
        }

        this.doneFlag = true;
        return null;
      }
      case 2: {
        // Gather completed; just ensure inventory didn't decrease.
        const after = invTotal(obs?.inventory);
        if (after < this.invTotalBefore) throw new Error(`[${this.name}] inventory decreased after gather`);
        this.doneFlag = true;
        return null;
      }
      default:
        this.doneFlag = true;
        return null;
    }
  }

  done(): boolean {
    return this.doneFlag;
  }

  private pickMineTarget(ctx: ScenarioContext): [number, number, number] {
    const center = ctx.voxels.getCenter();
    const air = this.idByName.get("AIR") ?? 0;
    const water = this.idByName.get("WATER");
    const preferred = new Set(["DIRT", "GRASS", "STONE", "SAND", "GRAVEL", "ICE", "LOG"]);

    // Search within Manhattan<=2 (server constraint), prefer common breakable blocks, avoid water.
    for (let dy = -1; dy >= -2; dy--) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const man = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (man > 2) continue;
          const bid = ctx.voxels.getBlockAtOffset(dx, dy, dz);
          if (bid === null) continue;
          if (bid === air) continue;
          if (water !== undefined && bid === water) continue;
          const name = this.palette[bid] ?? "";
          if (!name) continue;
          if (!preferred.has(name)) continue;
          return [center[0] + dx, center[1] + dy, center[2] + dz];
        }
      }
    }

    // Fallback: mine the block directly below.
    return [center[0], center[1] - 1, center[2]];
  }
}

function invTotal(inv: any): number {
  if (!Array.isArray(inv)) return 0;
  let n = 0;
  for (const it of inv) {
    const c = Number(it?.count ?? 0);
    if (Number.isFinite(c) && c > 0) n += c;
  }
  return n;
}
