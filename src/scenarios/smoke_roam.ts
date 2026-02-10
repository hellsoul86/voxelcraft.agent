import type { Scenario, ScenarioAct, ScenarioContext } from "./types.js";
import { findActionResult, findTaskDone, findTaskFail, getBool, getString } from "./util.js";

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

class LCG {
  private x: number;
  constructor(seed: number) {
    this.x = seed >>> 0;
  }
  nextU32(): number {
    // Numerical Recipes LCG.
    this.x = (Math.imul(this.x, 1664525) + 1013904223) >>> 0;
    return this.x;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.nextU32() % arr.length]!;
  }
}

export class SmokeRoamScenario implements Scenario {
  name = "smoke_roam";

  private readonly durationTicks: number;
  private startTick: number | null = null;

  private waitingRef: string | null = null;
  private moveTaskID: string | null = null;
  private moveRef: string | null = null;
  private moves = 0;
  private saidHello = false;
  private rng: LCG;
  private doneFlag = false;

  constructor(opts: { durationSec: number; seed: string }) {
    this.durationTicks = Math.max(1, Math.floor((opts.durationSec * 1000) / 200));
    this.rng = new LCG(hash32(opts.seed));
  }

  obsMode() {
    return "summary" as const;
  }

  async init(ctx: ScenarioContext): Promise<void> {
    ctx.log(`[${this.name}] duration=${this.durationTicks} ticks`);
  }

  async step(obs: any, ctx: ScenarioContext): Promise<ScenarioAct | null> {
    const now = Number(obs?.tick ?? 0);
    if (!now) return null;

    if (this.startTick === null) this.startTick = now;
    if (now - this.startTick >= this.durationTicks) {
      this.doneFlag = true;
      return null;
    }

    // Wait for SAY ack.
    if (this.waitingRef) {
      const ar = findActionResult(obs.events, this.waitingRef);
      if (!ar) return null;
      const ok = getBool(ar, "ok");
      if (!ok) {
        const code = getString(ar, "code") ?? "E_UNKNOWN";
        throw new Error(`[${this.name}] SAY failed: ${code}`);
      }
      this.waitingRef = null;
      return null;
    }

    // Handle MOVE_TO start ack.
    if (this.moveRef) {
      const ar = findActionResult(obs.events, this.moveRef);
      if (!ar) return null;
      const ok = getBool(ar, "ok");
      if (!ok) {
        const code = getString(ar, "code") ?? "E_UNKNOWN";
        throw new Error(`[${this.name}] MOVE_TO rejected: ${code}`);
      }
      const taskId = getString(ar, "task_id");
      if (!taskId) throw new Error(`[${this.name}] MOVE_TO missing task_id`);
      this.moveRef = null;

      // MOVE_TO can complete immediately if already within 1 block.
      const fail = findTaskFail(obs.events, taskId);
      if (fail) throw new Error(`[${this.name}] MOVE_TO TASK_FAIL`);
      const done = findTaskDone(obs.events, taskId);
      if (done) {
        this.moves++;
        return null;
      }

      this.moveTaskID = taskId;
      return null;
    }

    // Handle MOVE_TO completion/failure.
    if (this.moveTaskID) {
      const fail = findTaskFail(obs.events, this.moveTaskID);
      if (fail) throw new Error(`[${this.name}] MOVE_TO TASK_FAIL`);
      const done = findTaskDone(obs.events, this.moveTaskID);
      if (!done) return null;
      this.moveTaskID = null;
      this.moves++;
      return null;
    }

    // First action: SAY.
    if (!this.saidHello) {
      const ref = "I_SAY_0";
      this.waitingRef = ref;
      this.saidHello = true;
      return {
        instants: [{ id: ref, type: "SAY", channel: "LOCAL", text: "smoke_roam online" }],
      };
    }

    // Roam: move in tiny steps to avoid y-mismatch on uneven terrain.
    const stepOffsets = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const;
    const [dx, dz] = this.rng.pick(stepOffsets);
    const [x, y, z] = obs?.self?.pos ?? [0, 0, 0];
    const target: [number, number, number] = [x + dx, y, z + dz];

    const ref = `K_MOVE_${this.moves}`;
    this.moveRef = ref;
    return { tasks: [{ id: ref, type: "MOVE_TO", target, tolerance: 1.2 }] };
  }

  done(): boolean {
    return this.doneFlag;
  }
}
