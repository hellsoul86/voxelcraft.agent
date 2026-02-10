import type { Scenario, ScenarioAct, ScenarioContext } from "./types.js";
import { findActionResult, getBool, getString } from "./util.js";

export class MemoryKVScenario implements Scenario {
  name = "memory_kv";
  private phase = 0;
  private waitingRef: string | null = null;
  private doneFlag = false;

  obsMode() {
    return "no_voxels" as const;
  }

  async init(ctx: ScenarioContext): Promise<void> {
    ctx.log(`[${this.name}] init`);
  }

  async step(obs: any, _ctx: ScenarioContext): Promise<ScenarioAct | null> {
    if (this.waitingRef) {
      const ar = findActionResult(obs.events, this.waitingRef);
      if (!ar) return null;
      const ok = getBool(ar, "ok");
      if (!ok) {
        const code = getString(ar, "code") ?? "E_UNKNOWN";
        throw new Error(`[${this.name}] action rejected ref=${this.waitingRef} code=${code}`);
      }
      this.waitingRef = null;
      this.phase++;
      // LOAD_MEMORY returns memory in the same tick it is processed.
      if (this.phase === 2) {
        const mem = Array.isArray(obs?.memory) ? obs.memory : [];
        const found = mem.find((m: any) => m?.key === "e2e/foo" && m?.value === "bar");
        if (found) this.doneFlag = true;
      }
      return null;
    }

    switch (this.phase) {
      case 0: {
        this.waitingRef = "I_SAVE_0";
        return {
          instants: [{ id: "I_SAVE_0", type: "SAVE_MEMORY", key: "e2e/foo", value: "bar", ttl_ticks: 6000 }],
        };
      }
      case 1: {
        this.waitingRef = "I_LOAD_0";
        return {
          instants: [{ id: "I_LOAD_0", type: "LOAD_MEMORY", prefix: "e2e/", limit: 10 }],
        };
      }
      case 2: {
        const mem = Array.isArray(obs?.memory) ? obs.memory : [];
        const found = mem.find((m: any) => m?.key === "e2e/foo" && m?.value === "bar");
        if (!found) return null;
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
}
