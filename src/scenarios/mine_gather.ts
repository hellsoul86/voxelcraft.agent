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
  private blockedTargets = new Set<string>();
  private postMineChecks = 0;
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
        const message = getString(ar, "message") ?? "";
        if (this.retryableMineFailure(code) && this.phase <= 2) {
          this.resetForRetry(code, message);
          return null;
        }
        throw new Error(`[${this.name}] action rejected ref=${this.waitingRef} code=${code} msg=${message}`);
      }
      const tid = getString(ar, "task_id");
      if (!tid) throw new Error(`[${this.name}] missing task_id for ref=${this.waitingRef}`);
      this.waitingRef = null;

      // Some tasks can complete immediately (e.g. GATHER).
      const fail = findTaskFail(obs.events, tid);
      if (fail) {
        const code = getString(fail, "code") ?? "E_UNKNOWN";
        const message = getString(fail, "message") ?? "";
        if (this.retryableMineFailure(code) && this.phase <= 2) {
          this.resetForRetry(code, message);
          return null;
        }
        throw new Error(`[${this.name}] TASK_FAIL task_id=${tid} code=${code} msg=${message}`);
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
        const message = getString(fail, "message") ?? "";
        if (this.retryableMineFailure(code) && this.phase <= 2) {
          this.resetForRetry(code, message);
          return null;
        }
        throw new Error(`[${this.name}] TASK_FAIL task_id=${this.waitingTaskID} code=${code} msg=${message}`);
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

        if (!this.targetPos || !this.approachPos || this.targetNeedsReplan(ctx)) {
          const plan = this.pickMinePlan(ctx, selfPos);
          this.targetPos = plan.target;
          this.approachPos = plan.approach;
          this.postMineChecks = 0;
          ctx.log(`[${this.name}] target=${this.targetPos.join(",")} approach=${this.approachPos.join(",")}`);
        }

        const manToTarget = manhattan3(selfPos, this.targetPos);
        if (manToTarget <= 2) {
          this.phase = 1;
          return null;
        }

        const manToApproach = manhattan3(selfPos, this.approachPos);
        if (manToApproach <= 1) {
          this.phase = 1;
          return null;
        }

        const ref = "K_MOVE_0";
        this.waitingRef = ref;
        return { tasks: [{ id: ref, type: "MOVE_TO", target: this.approachPos, tolerance: 0.8 }] };
      }
      case 1: {
        if (!this.targetPos) throw new Error(`[${this.name}] missing targetPos`);
        const selfPos = obs?.self?.pos as [number, number, number] | undefined;
        if (!selfPos) return null;

        const air = this.idByName.get("AIR");
        const targetBlock = ctx.voxels.getBlockAtWorld(this.targetPos);
        if (targetBlock === null || (air !== undefined && targetBlock === air)) {
          this.resetForRetry("E_INVALID_TARGET", "target block missing before mine");
          return null;
        }

        if (manhattan3(selfPos, this.targetPos) > 2) {
          this.phase = 0;
          return null;
        }

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
          this.postMineChecks++;
          // Allow a few extra OBS ticks for drop/entity propagation on staging.
          if (this.postMineChecks < 6) {
            return null;
          }
          this.resetForRetry("E_INVALID_TARGET", "post-mine gather observation timeout");
          return null;
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
    if (this.retries >= 16) return false;
    return code === "E_INVALID_TARGET" || code === "E_BLOCKED";
  }

  private resetForRetry(code?: string, message?: string): void {
    if (this.targetPos && this.shouldBlacklistTarget(code, message)) {
      this.blockedTargets.add(posKey(this.targetPos));
    }

    this.retries++;
    this.waitingRef = null;
    this.waitingTaskID = null;
    this.targetPos = null;
    this.approachPos = null;
    this.postMineChecks = 0;
    this.phase = 0;
  }

  private shouldBlacklistTarget(code?: string, message?: string): boolean {
    const c = (code ?? "").toUpperCase();
    const m = (message ?? "").toLowerCase();
    if (c === "E_BLOCKED") return true;
    if (c !== "E_INVALID_TARGET") return false;
    return m.includes("no block") || m.includes("too far") || m.includes("target") || m.includes("2d world");
  }

  private targetNeedsReplan(ctx: ScenarioContext): boolean {
    if (!this.targetPos || !this.approachPos) return true;
    if (this.blockedTargets.has(posKey(this.targetPos))) return true;

    const air = this.idByName.get("AIR");
    if (air === undefined) return false;

    const t = ctx.voxels.getBlockAtWorld(this.targetPos);
    if (t === null || t === air) return true;

    const a = ctx.voxels.getBlockAtWorld(this.approachPos);
    if (a === null || a !== air) return true;

    return false;
  }

  private pickMinePlan(ctx: ScenarioContext, selfPos: [number, number, number]): { target: [number, number, number]; approach: [number, number, number] } {
    const center = ctx.voxels.getCenter();
    const air = this.idByName.get("AIR") ?? 0;
    const water = this.idByName.get("WATER");
    const lava = this.idByName.get("LAVA");
    const preferred = new Set(["DIRT", "GRASS", "STONE", "SAND", "GRAVEL", "ICE", "LOG", "CLAY"]);
    const avoid = new Set(["CHEST", "FURNACE", "CONTRACT_TERMINAL", "BULLETIN_BOARD", "SIGN", "CONVEYOR", "SWITCH", "CLAIM_TOTEM"]);

    const neigh: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    type Candidate = {
      target: [number, number, number];
      approach: [number, number, number];
      score: number;
      preferred: boolean;
    };

    const picks: Candidate[] = [];

    for (let dz = -7; dz <= 7; dz++) {
      for (let dx = -7; dx <= 7; dx++) {
        const bid = ctx.voxels.getBlockAtOffset(dx, 0, dz);
        if (bid === null || bid === air) continue;
        if (water !== undefined && bid === water) continue;
        if (lava !== undefined && bid === lava) continue;

        const name = this.palette[bid] ?? "";
        if (avoid.has(name)) continue;

        const y = selfPos[1] ?? 0;
        const target: [number, number, number] = [center[0] + dx, y, center[2] + dz];
        if (this.blockedTargets.has(posKey(target))) continue;

        let bestApproach: [number, number, number] | null = null;
        let bestApproachDist = Number.POSITIVE_INFINITY;

        for (const [nx, nz] of neigh) {
          const approach: [number, number, number] = [target[0] + nx, y, target[2] + nz];
          const around = ctx.voxels.getBlockAtWorld(approach);
          if (around === null || around !== air) continue;
          const d = manhattan3(selfPos, approach);
          if (d < bestApproachDist) {
            bestApproachDist = d;
            bestApproach = approach;
          }
        }

        if (!bestApproach) continue;

        const isPreferred = preferred.has(name) || name.endsWith("_ORE");
        const mineDist = Math.abs(target[0] - selfPos[0]) + Math.abs(target[2] - selfPos[2]);
        const score = bestApproachDist + mineDist * 0.25;

        picks.push({ target, approach: bestApproach, score, preferred: isPreferred });
      }
    }

    picks.sort((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      return a.score - b.score;
    });

    const pick = picks[0];
    if (!pick) {
      throw new Error(`[${this.name}] no mine target with reachable adjacent AIR`);
    }

    return { target: pick.target, approach: pick.approach };
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

function posKey(pos: [number, number, number]): string {
  return `${pos[0]},${pos[1]},${pos[2]}`;
}

function manhattan3(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
