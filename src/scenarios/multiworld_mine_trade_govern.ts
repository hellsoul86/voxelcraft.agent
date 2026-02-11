import type { Scenario, ScenarioAct, ScenarioContext } from "./types.js";
import { findActionResult, findTaskDone, findTaskFail, getBool, getString } from "./util.js";

type WorldID = "OVERWORLD" | "MINE_L1" | "CITY_HUB";

export class MultiworldMineTradeGovernScenario implements Scenario {
  name = "multiworld_mine_trade_govern";

  private phase = 0;
  private waitingRef: string | null = null;
  private waitingTaskID: string | null = null;
  private pending = "";
  private doneFlag = false;
  private actionSeq = 0;
  private obsTick = 0;
  private startTick = 0;
  private pendingSinceTick = 0;
  private cancelActiveRequested = false;

  private switchMineRetries = 0;
  private switchOverRetries = 0;
  private switchCityRetries = 0;
  private switchCooldownBackoff = 0;

  private governFallbackPending = false;

  private mineDone = false;
  private mineProbeDone = false;
  private mineBasePos: [number, number, number] | null = null;
  private mineAttempt = 0;
  private mineInventoryBefore = -1;
  private mineRelocateStep = 0;
  private mineRelocateTargets: Array<[number, number]> = [];
  private readonly mineOffsets: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  obsMode() {
    return "full" as const;
  }

  async init(ctx: ScenarioContext): Promise<void> {
    this.mineRelocateTargets = buildMineRelocateTargets(ctx.sessionKey);
    const worlds = await ctx.client.listWorlds();
    const ids = new Set((worlds.worlds ?? []).map((w) => String(w?.world_id ?? "")));
    if (ids.size === 0) {
      ctx.log(`[${this.name}] list_worlds not ready yet; continue and validate on first ticks`);
      return;
    }
    for (const want of ["OVERWORLD", "MINE_L1", "CITY_HUB"]) {
      if (!ids.has(want)) {
        throw new Error(`[${this.name}] phase=INIT missing world ${want} in voxelcraft.list_worlds`);
      }
    }
    ctx.log(`[${this.name}] worlds ok: ${[...ids].join(",")}`);
  }

  async step(obs: any, ctx: ScenarioContext): Promise<ScenarioAct | null> {
    if (this.doneFlag) return null;
    const t = Number(obs?.world_clock ?? obs?.tick ?? 0);
    if (Number.isFinite(t) && t > 0) this.obsTick = t;
    if (this.startTick <= 0 && this.obsTick > 0) this.startTick = this.obsTick;
    const worldID = this.worldID(obs);
    const pos = (obs?.self?.pos ?? null) as [number, number, number] | null;
    if (!worldID || !pos) return null;
    if (this.startTick > 0 && this.obsTick-this.startTick > 700) {
      this.doneFlag = true;
      ctx.log(`[${this.name}] budget reached; finish scenario at phase=${this.phaseName()}`);
      return null;
    }
    if (this.cancelActiveRequested) {
      const ids = activeTaskIDs(obs);
      this.cancelActiveRequested = false;
      if (ids.length > 0) {
        return { cancel: ids };
      }
    }

    if (this.switchCooldownBackoff > 0 && (this.phase === 2 || this.phase === 5 || this.phase === 8)) {
      this.switchCooldownBackoff--;
      return null;
    }

    if (this.waitingRef) {
      if (this.obsTick - this.pendingSinceTick > 40) {
        this.handlePendingTimeout(ctx, "action_result_timeout");
        return null;
      }
      const ar = findActionResult(obs?.events, this.waitingRef);
      if (!ar) return null;
      const ok = getBool(ar, "ok");
      if (!ok) {
        const code = getString(ar, "code") ?? "E_UNKNOWN";
        const msg = getString(ar, "message") ?? "";
        if (code === "E_CONFLICT") {
          this.clearPending();
          this.cancelActiveRequested = true;
          return null;
        }
        if (this.pending === "govern_propose") {
          ctx.log(`[${this.name}] phase=${this.phaseName()} propose failed code=${code}, fallback to city announce`);
          this.clearPending();
          this.governFallbackPending = true;
          return null;
        }
        if (this.pending === "switch_mine" && code === "E_WORLD_DENIED" && this.switchMineRetries < 2) {
          this.switchMineRetries++;
          this.clearPending();
          this.phase = 1;
          return null;
        }
        if (this.pending === "switch_mine" && code === "E_WORLD_COOLDOWN") {
          this.clearPending();
          this.switchCooldownBackoff = 3;
          return null;
        }
        if (this.pending === "switch_over" && code === "E_WORLD_DENIED" && this.switchOverRetries < 2) {
          this.switchOverRetries++;
          this.clearPending();
          this.phase = 4;
          return null;
        }
        if (this.pending === "switch_over" && code === "E_WORLD_COOLDOWN") {
          this.clearPending();
          this.switchCooldownBackoff = 3;
          return null;
        }
        if (this.pending === "switch_city" && code === "E_WORLD_DENIED" && this.switchCityRetries < 2) {
          this.switchCityRetries++;
          this.clearPending();
          this.phase = 7;
          return null;
        }
        if (this.pending === "switch_city" && code === "E_WORLD_COOLDOWN") {
          this.clearPending();
          this.switchCooldownBackoff = 3;
          return null;
        }
        if (this.pending === "mine_probe" && (code === "E_INVALID_TARGET" || code === "E_BLOCKED")) {
          this.mineAttempt++;
          this.clearPending();
          return null;
        }
        if (this.pending === "mine_relocate" && (code === "E_INVALID_TARGET" || code === "E_BLOCKED")) {
          this.mineRelocateStep++;
          this.clearPending();
          return null;
        }
        if (this.pending === "mine_gather" && (code === "E_INVALID_TARGET" || code === "E_NO_RESOURCE")) {
          this.clearPending();
          return null;
        }
        throw new Error(`[${this.name}] phase=${this.phaseName()} code=${code} action=${this.pending} msg=${msg}`);
      }
      const tid = getString(ar, "task_id");
      if (!tid) {
        this.finishPending(ctx);
        return null;
      }
      this.waitingTaskID = tid;
      this.waitingRef = null;
      this.pendingSinceTick = this.obsTick;

      const fail = findTaskFail(obs?.events, tid);
      if (fail) {
        const code = getString(fail, "code") ?? "E_UNKNOWN";
        const msg = getString(fail, "message") ?? "";
        if (code === "E_CONFLICT") {
          this.clearPending();
          this.cancelActiveRequested = true;
          return null;
        }
        if (this.pending === "mine_probe" && (code === "E_INVALID_TARGET" || code === "E_BLOCKED")) {
          this.mineAttempt++;
          this.clearPending();
          return null;
        }
        if (this.pending === "mine_gather" && (code === "E_INVALID_TARGET" || code === "E_NO_RESOURCE")) {
          this.clearPending();
          return null;
        }
        this.clearPending();
        throw new Error(`[${this.name}] phase=${this.phaseName()} code=${code} task=${tid} msg=${msg}`);
      }
      const done = findTaskDone(obs?.events, tid);
      if (done) this.finishPending(ctx);
      return null;
    }

    if (this.waitingTaskID) {
      if (this.obsTick - this.pendingSinceTick > 100) {
        this.handlePendingTimeout(ctx, "task_timeout");
        return null;
      }
      const fail = findTaskFail(obs?.events, this.waitingTaskID);
      if (fail) {
        const code = getString(fail, "code") ?? "E_UNKNOWN";
        const msg = getString(fail, "message") ?? "";
        const taskID = this.waitingTaskID;
        if (code === "E_CONFLICT") {
          this.clearPending();
          this.cancelActiveRequested = true;
          return null;
        }
        if (this.pending === "mine_probe" && (code === "E_INVALID_TARGET" || code === "E_BLOCKED")) {
          this.mineAttempt++;
          this.clearPending();
          return null;
        }
        if (this.pending === "mine_relocate" && (code === "E_INVALID_TARGET" || code === "E_BLOCKED")) {
          this.mineRelocateStep++;
          this.clearPending();
          return null;
        }
        if (this.pending === "mine_gather" && (code === "E_INVALID_TARGET" || code === "E_NO_RESOURCE")) {
          this.clearPending();
          return null;
        }
        this.clearPending();
        throw new Error(`[${this.name}] phase=${this.phaseName()} code=${code} task=${taskID} msg=${msg}`);
      }
      const done = findTaskDone(obs?.events, this.waitingTaskID);
      if (!done) return null;
      this.finishPending(ctx);
      return null;
    }

    switch (this.phase) {
      case 0:
        if (worldID === "OVERWORLD") {
          this.phase = 1;
          return null;
        }
        return this.startInstant("I_SWITCH_OVER_START", "switch_over_start", {
          type: "SWITCH_WORLD",
          target_world_id: "OVERWORLD",
        });

      case 1:
        if (this.nearGate(pos)) {
          this.phase = 2;
          return null;
        }
        return this.startTask("K_MOVE_GATE_OVER_1", "move_gate_over_1", {
          type: "MOVE_TO",
          target: [0, 0, 0],
          tolerance: 1.2,
        });

      case 2:
        return this.startInstant("I_SWITCH_MINE", "switch_mine", {
          type: "SWITCH_WORLD",
          target_world_id: "MINE_L1",
        });

      case 3: {
        if (worldID !== "MINE_L1") return null;
        if (this.mineProbeDone) {
          this.mineDone = true;
          this.phase = 4;
          ctx.log(`[${this.name}] mine probe task completed; proceed to trade/govern`);
          return null;
        }
        if (this.mineInventoryBefore < 0) this.mineInventoryBefore = invTotal(obs?.inventory);
        if (!this.mineBasePos) this.mineBasePos = pos;
        if (invTotal(obs?.inventory) > this.mineInventoryBefore) {
          this.mineDone = true;
          this.phase = 4;
          ctx.log(`[${this.name}] mine phase complete`);
          return null;
        }

        const item = this.findNearbyItem(obs, pos);
        if (item?.id) {
          return this.startTask("K_GATHER_MINE_DROP", "mine_gather", {
            type: "GATHER",
            target_id: item.id,
          });
        }

        if (this.mineAttempt >= this.mineOffsets.length) {
          if (this.mineRelocateStep >= this.mineRelocateTargets.length) {
            ctx.log(`[${this.name}] mine scan exhausted; continue without ore cargo`);
            this.phase = 4;
            return null;
          }
          const [rx, rz] = this.mineRelocateTargets[this.mineRelocateStep]!;
          return this.startTask(`K_MOVE_MINE_SCAN_${this.mineRelocateStep}`, "mine_relocate", {
            type: "MOVE_TO",
            target: [rx, 0, rz],
            tolerance: 1.2,
          });
        }
        const [dx, dz] = this.mineOffsets[this.mineAttempt]!;
        const target: [number, number, number] = [this.mineBasePos[0] + dx, 0, this.mineBasePos[2] + dz];
        return this.startTask(`K_MINE_PROBE_${this.mineAttempt}`, "mine_probe", {
          type: "MINE",
          block_pos: target,
        });
      }

      case 4:
        if (this.nearGate(pos)) {
          this.phase = 5;
          return null;
        }
        return this.startTask("K_MOVE_GATE_MINE", "move_gate_mine", {
          type: "MOVE_TO",
          target: [0, 0, 0],
          tolerance: 1.2,
        });

      case 5:
        return this.startInstant("I_SWITCH_OVER", "switch_over", {
          type: "SWITCH_WORLD",
          target_world_id: "OVERWORLD",
        });

      case 6:
        return this.startInstant("I_TRADE_ANNOUNCE", "trade_say", {
          type: "SAY",
          channel: "LOCAL",
          text: "market: selling ore from MINE_L1, looking for builders.",
        });

      case 7:
        if (this.nearGate(pos)) {
          this.phase = 8;
          return null;
        }
        return this.startTask("K_MOVE_GATE_OVER_2", "move_gate_over_2", {
          type: "MOVE_TO",
          target: [0, 0, 0],
          tolerance: 1.2,
        });

      case 8:
        return this.startInstant("I_SWITCH_CITY", "switch_city", {
          type: "SWITCH_WORLD",
          target_world_id: "CITY_HUB",
        });

      case 9: {
        if (this.governFallbackPending) {
          this.governFallbackPending = false;
          return this.startInstant("I_GOVERN_FALLBACK", "govern_say", {
            type: "SAY",
            channel: "LOCAL",
            text: "governance: request opening a civic proposal window in city hub.",
          });
        }
        const landID = String(obs?.local_rules?.land_id ?? "");
        if (!landID) {
          return this.startInstant("I_GOVERN_FALLBACK_NO_LAND", "govern_say", {
            type: "SAY",
            channel: "LOCAL",
            text: "governance: no land context, requesting public vote schedule.",
          });
        }
        return this.startInstant("I_GOVERN_PROPOSE", "govern_propose", {
          type: "PROPOSE_LAW",
          land_id: landID,
          template_id: "MARKET_TAX",
          params: { market_tax: 0.03 },
          title: "Adjust market tax to 3%",
        });
      }

      default:
        this.doneFlag = true;
        return null;
    }
  }

  done(): boolean {
    return this.doneFlag;
  }

  private findNearbyItem(obs: any, pos: [number, number, number]): any | null {
    const entities = Array.isArray(obs?.entities) ? obs.entities : [];
    for (const e of entities) {
      if (e?.type !== "ITEM") continue;
      if (!Array.isArray(e?.pos) || e.pos.length !== 3) continue;
      const man = Math.abs(e.pos[0] - pos[0]) + Math.abs(e.pos[1] - pos[1]) + Math.abs(e.pos[2] - pos[2]);
      if (man <= 2) return e;
    }
    return null;
  }

  private clearPending(): void {
    this.waitingRef = null;
    this.waitingTaskID = null;
    this.pending = "";
  }

  private finishPending(ctx: ScenarioContext): void {
    const pending = this.pending;
    this.clearPending();
    switch (pending) {
      case "switch_over_start":
        this.phase = 1;
        return;
      case "move_gate_over_1":
        this.phase = 2;
        return;
      case "switch_mine":
        this.phase = 3;
        this.mineDone = false;
        this.mineProbeDone = false;
        this.mineBasePos = null;
        this.mineAttempt = 0;
        this.mineInventoryBefore = -1;
        this.mineRelocateStep = 0;
        return;
      case "mine_probe":
        this.mineProbeDone = true;
        this.mineAttempt++;
        return;
      case "mine_gather":
        return;
      case "mine_relocate":
        this.mineRelocateStep++;
        this.mineBasePos = null;
        this.mineAttempt = 0;
        return;
      case "move_gate_mine":
        this.phase = 5;
        return;
      case "switch_over":
        this.phase = 6;
        return;
      case "trade_say":
        this.phase = 7;
        return;
      case "move_gate_over_2":
        this.phase = 8;
        return;
      case "switch_city":
        this.phase = 9;
        return;
      case "govern_propose":
      case "govern_say":
        this.phase = 10;
        this.doneFlag = true;
        return;
      default:
        return;
    }
  }

  private startInstant(ref: string, pending: string, instant: any): ScenarioAct {
    const reqID = this.nextReqID(ref);
    this.waitingRef = reqID;
    this.pending = pending;
    this.waitingTaskID = null;
    this.pendingSinceTick = this.obsTick;
    return { instants: [{ id: reqID, ...instant }] };
  }

  private startTask(ref: string, pending: string, task: any): ScenarioAct {
    const reqID = this.nextReqID(ref);
    this.waitingRef = reqID;
    this.pending = pending;
    this.waitingTaskID = null;
    this.pendingSinceTick = this.obsTick;
    return { tasks: [{ id: reqID, ...task }] };
  }

  private nextReqID(base: string): string {
    this.actionSeq++;
    return `${base}_${this.actionSeq}`;
  }

  private handlePendingTimeout(ctx: ScenarioContext, reason: string): void {
    switch (this.pending) {
      case "mine_probe":
        this.mineAttempt++;
        break;
      case "mine_relocate":
        this.mineRelocateStep++;
        this.mineBasePos = null;
        this.mineAttempt = 0;
        break;
      case "govern_propose":
        this.governFallbackPending = true;
        break;
      case "govern_say":
        this.doneFlag = true;
        break;
      default:
        break;
    }
    this.clearPending();
    ctx.log(`[${this.name}] pending timeout recovered: ${reason}`);
  }

  private worldID(obs: any): WorldID | "" {
    const id = String(obs?.world_id ?? "");
    if (id === "OVERWORLD" || id === "MINE_L1" || id === "CITY_HUB") return id;
    return "";
  }

  private nearGate(pos: [number, number, number]): boolean {
    return Math.abs(pos[0]) <= 1 && Math.abs(pos[2]) <= 1;
  }

  private phaseName(): string {
    switch (this.phase) {
      case 0:
        return "ENSURE_OVERWORLD";
      case 1:
        return "MOVE_GATE_OVERWORLD";
      case 2:
        return "SWITCH_MINE_L1";
      case 3:
        return "MINE_GATHER";
      case 4:
        return "MOVE_GATE_MINE_L1";
      case 5:
        return "SWITCH_OVERWORLD";
      case 6:
        return "TRADE_OR_ANNOUNCE";
      case 7:
        return "MOVE_GATE_OVERWORLD_2";
      case 8:
        return "SWITCH_CITY_HUB";
      case 9:
        return "GOVERNANCE";
      default:
        return "DONE";
    }
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

function activeTaskIDs(obs: any): string[] {
  if (!Array.isArray(obs?.tasks)) return [];
  const out: string[] = [];
  for (const t of obs.tasks) {
    const id = typeof t?.task_id === "string" ? t.task_id : "";
    if (id) out.push(id);
  }
  return out;
}

function buildMineRelocateTargets(seed: string): Array<[number, number]> {
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c + i;
    h2 = Math.imul(h2, 2166136261);
  }
  const ox = ((h1 >>> 0) % 13) - 6; // [-6..6]
  const oz = ((h2 >>> 0) % 13) - 6; // [-6..6]
  const bx = ox * 6;
  const bz = oz * 6;
  return [
    [bx, bz],
    [bx + 4, bz],
    [bx - 4, bz],
    [bx, bz + 4],
    [bx, bz - 4],
    [bx + 8, bz + 8],
    [bx - 8, bz - 8],
    [bx + 12, bz - 6],
    [bx - 12, bz + 6],
  ];
}
