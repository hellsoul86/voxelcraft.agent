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
  private approachPos: [number, number, number] | null = null;
  private invTotalBefore = 0;
  private retries = 0;
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
        if (this.retryableMineFailure(code) && this.phase <= 2) {
          this.resetForRetry();
          return null;
        }
        throw new Error(`[${this.name}] action rejected ref=${this.waitingRef} code=${code}`);
      }
      const tid = getString(ar, "task_id");
      if (!tid) throw new Error(`[${this.name}] missing task_id for ref=${this.waitingRef}`);
      this.waitingRef = null;

      // Some tasks can complete immediately (e.g. GATHER).
      const fail = findTaskFail(obs.events, tid);
      if (fail) {
        const code = getString(fail, "code") ?? "E_UNKNOWN";
        if (this.retryableMineFailure(code) && this.phase <= 2) {
          this.resetForRetry();
          return null;
        }
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
        if (this.retryableMineFailure(code) && this.phase <= 2) {
          this.resetForRetry();
          return null;
        }
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
        const selfPos = obs?.self?.pos as [number, number, number] | undefined;
        if (!selfPos) return null;

        if (!this.targetPos || !this.approachPos) {
          const plan = this.pickMinePlan(ctx);
          this.targetPos = plan.target;
          this.approachPos = plan.approach;
          ctx.log(`[${this.name}] target=${this.targetPos.join(",")} approach=${this.approachPos.join(",")}`);
        }

        const man = Math.abs(selfPos[0] - this.targetPos[0]) + Math.abs(selfPos[1] - this.targetPos[1]) + Math.abs(selfPos[2] - this.targetPos[2]);
        if (man <= 2) {
          this.phase = 1;
          return null;
        }

        const ref = "K_MOVE_0";
        this.waitingRef = ref;
        return { tasks: [{ id: ref, type: "MOVE_TO", target: this.approachPos, tolerance: 1.2 }] };
      }
      case 1: {
        if (!this.targetPos) throw new Error(`[${this.name}] missing targetPos`);
        this.invTotalBefore = invTotal(obs?.inventory);
        const ref = "K_MINE_0";
        this.waitingRef = ref;
        return { tasks: [{ id: ref, type: "MINE", block_pos: this.targetPos }] };
      }
      case 2: {
        // Verify block is now AIR and gather the drop if present.
        if (!this.targetPos) throw new Error(`[${this.name}] missing targetPos`);
        const air = this.idByName.get("AIR");
        if (air === undefined) throw new Error(`[${this.name}] AIR missing from palette`);
        const b = ctx.voxels.getBlockAtWorld(this.targetPos);
        if (b === null) throw new Error(`[${this.name}] mined block out of view`);
        if (b !== air) throw new Error(`[${this.name}] expected mined block to be AIR, got=${b} (${this.palette[b] ?? "?"})`);

        // If any ITEM entities are nearby, GATHER one (mining drops are expected to be item entities).
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
          return { tasks: [{ id: ref, type: "GATHER", target_id: item.id }] };
        }

        // Fallback: if server auto-picks up drops (or mining drops go straight to inventory),
        // allow completion as long as inventory didn't regress.
        const after = invTotal(obs?.inventory);
        if (after < this.invTotalBefore) {
          throw new Error(`[${this.name}] inventory decreased after mine`);
        }
        if (after === this.invTotalBefore) {
          throw new Error(`[${this.name}] expected either an ITEM drop to gather or inventory increase after mine`);
        }
        this.doneFlag = true;
        return null;
      }
      case 3: {
        // Gather completed; inventory should increase.
        const after = invTotal(obs?.inventory);
        if (after <= this.invTotalBefore) {
          throw new Error(
            `[${this.name}] expected inventory to increase after gather: before=${this.invTotalBefore} after=${after}`,
          );
        }
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

  private retryableMineFailure(code: string): boolean {
    if (this.retries >= 4) return false;
    return code === "E_INVALID_TARGET" || code === "E_BLOCKED";
  }

  private resetForRetry(): void {
    this.retries++;
    this.waitingRef = null;
    this.waitingTaskID = null;
    this.targetPos = null;
    this.approachPos = null;
    this.phase = 0;
  }

  private pickMinePlan(ctx: ScenarioContext): { target: [number, number, number]; approach: [number, number, number] } {
    const center = ctx.voxels.getCenter();
    const air = this.idByName.get("AIR") ?? 0;
    const water = this.idByName.get("WATER");
    const preferred = new Set(["DIRT", "GRASS", "STONE", "SAND", "GRAVEL", "ICE", "LOG"]);

    const tryPick = (onlyPreferred: boolean) => {
      let best: { dx: number; dz: number; man: number; targetId: number } | null = null;
      for (let dz = -7; dz <= 7; dz++) {
        for (let dx = -7; dx <= 7; dx++) {
          const bid = ctx.voxels.getBlockAtOffset(dx, 0, dz);
          if (bid === null) continue;
          if (bid === air) continue;
          if (water !== undefined && bid === water) continue;
          if (onlyPreferred) {
            const name = this.palette[bid] ?? "";
            if (!preferred.has(name)) continue;
          }
          const man = Math.abs(dx) + Math.abs(dz);
          if (!best || man < best.man) best = { dx, dz, man, targetId: bid };
        }
      }
      return best;
    };

    const pick = tryPick(true) ?? tryPick(false);
    if (!pick) throw new Error(`[${this.name}] no mine target in obs cube on y=0 plane`);

    const target: [number, number, number] = [center[0] + pick.dx, center[1], center[2] + pick.dz];

    // Pick an adjacent AIR cell as the approach target.
    const neigh: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [nx, nz] of neigh) {
      const bid = ctx.voxels.getBlockAtWorld([target[0] + nx, target[1], target[2] + nz]);
      if (bid !== null && bid === air) {
        const approach: [number, number, number] = [target[0] + nx, target[1], target[2] + nz];
        return { target, approach };
      }
    }

    // If all neighbors are blocked in the cube, fall back to current center; MINE may fail but that's informative.
    return { target, approach: center };
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
