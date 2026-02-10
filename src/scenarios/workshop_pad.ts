import type { Scenario, ScenarioAct, ScenarioContext } from "./types.js";
import { findActionResult, findTaskDone, findTaskFail, getBool, getString } from "./util.js";

type BlueprintDef = {
  id: string;
  blocks: Array<{ pos: [number, number, number]; block: string }>;
  cost?: Array<{ item: string; count: number }>;
};

type RecipeDef = {
  recipe_id: string;
  station: string;
};

export class WorkshopPadScenario implements Scenario {
  name = "workshop_pad";

  private phase = 0;
  private waitingRef: string | null = null;
  private waitingTaskID: string | null = null;
  private doneFlag = false;

  private basePos: [number, number, number] | null = null;
  private benchPos: [number, number, number] | null = null;
  private anchor: [number, number, number] | null = null;

  private paletteByName = new Map<string, number>();
  private blueprint: BlueprintDef | null = null;

  obsMode() {
    return "full" as const;
  }

  async init(ctx: ScenarioContext): Promise<void> {
    const blocksCat = await ctx.catalogs.get("block_palette");
    const palette = blocksCat.data as string[];
    palette.forEach((name, idx) => this.paletteByName.set(name, idx));

    const bpCat = await ctx.catalogs.get("blueprints");
    const blueprints = bpCat.data as BlueprintDef[];
    this.blueprint = blueprints.find((b) => b.id === "workshop_pad") ?? null;
    if (!this.blueprint) throw new Error(`[${this.name}] missing blueprint workshop_pad`);

    const recCat = await ctx.catalogs.get("recipes");
    const recipes = recCat.data as RecipeDef[];
    const need = ["stick_from_plank", "crafting_bench", "furnace", "torch"];
    for (const id of need) {
      if (!recipes.find((r) => r.recipe_id === id)) {
        throw new Error(`[${this.name}] missing recipe ${id}`);
      }
    }

    ctx.log(`[${this.name}] catalogs ok (palette=${palette.length} blueprints=${blueprints.length} recipes=${recipes.length})`);
  }

  async step(obs: any, ctx: ScenarioContext): Promise<ScenarioAct | null> {
    const pos = obs?.self?.pos as [number, number, number] | undefined;
    if (!pos) return null;
    const nowTick = Number(obs?.tick ?? 0);

    if (!this.basePos) {
      this.basePos = pos;
      this.benchPos = this.pickBenchPos(ctx, pos);
      this.anchor = this.pickAnchor(ctx, pos);
      ctx.log(`[${this.name}] basePos=${this.basePos.join(",")} benchPos=${this.benchPos.join(",")} anchor=${this.anchor.join(",")}`);
    }

    // Wait for ACTION_RESULT to get server task_id.
    if (this.waitingRef) {
      const ar = findActionResult(obs.events, this.waitingRef);
      if (!ar) return null;
      const ok = getBool(ar, "ok");
      if (!ok) {
        const code = getString(ar, "code") ?? "E_UNKNOWN";
        const msg = getString(ar, "message") ?? "";
        throw new Error(`[${this.name}] action rejected ref=${this.waitingRef} code=${code} msg=${msg}`);
      }
      const tid = getString(ar, "task_id");
      if (!tid) throw new Error(`[${this.name}] missing task_id for ref=${this.waitingRef}`);
      ctx.log(`[${this.name}] tick=${nowTick} ACTION_RESULT ok ref=${this.waitingRef} task_id=${tid}`);
      this.waitingRef = null;

      // Some tasks can complete in the same tick they are started (e.g. PLACE).
      const fail = findTaskFail(obs.events, tid);
      if (fail) {
        const code = getString(fail, "code") ?? "E_UNKNOWN";
        const msg = getString(fail, "message") ?? "";
        throw new Error(`[${this.name}] TASK_FAIL task_id=${tid} code=${code} msg=${msg}`);
      }
      const done = findTaskDone(obs.events, tid);
      if (done) {
        ctx.log(`[${this.name}] tick=${nowTick} TASK_DONE task_id=${tid} (same tick)`);
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
        const msg = getString(fail, "message") ?? "";
        throw new Error(`[${this.name}] TASK_FAIL task_id=${this.waitingTaskID} code=${code} msg=${msg}`);
      }
      const done = findTaskDone(obs.events, this.waitingTaskID);
      if (!done) return null;
      ctx.log(`[${this.name}] tick=${nowTick} TASK_DONE task_id=${this.waitingTaskID}`);
      this.waitingTaskID = null;
      this.phase++;
      return null;
    }

    if (!this.benchPos || !this.anchor || !this.blueprint) return null;

    switch (this.phase) {
      case 0:
        ctx.log(`[${this.name}] tick=${nowTick} start craft stick_from_plank`);
        return this.startTask("K_CRAFT_STICK", { type: "CRAFT", recipe_id: "stick_from_plank", count: 1 });
      case 1:
        ctx.log(`[${this.name}] tick=${nowTick} start craft crafting_bench #1`);
        return this.startTask("K_CRAFT_BENCH_1", { type: "CRAFT", recipe_id: "crafting_bench", count: 1 });
      case 2:
        ctx.log(`[${this.name}] tick=${nowTick} start place crafting_bench`);
        return this.startTask("K_PLACE_BENCH", {
          type: "PLACE",
          item_id: "CRAFTING_BENCH",
          block_pos: this.benchPos,
        });
      case 3:
        ctx.log(`[${this.name}] tick=${nowTick} start craft crafting_bench #2`);
        return this.startTask("K_CRAFT_BENCH_2", { type: "CRAFT", recipe_id: "crafting_bench", count: 1 });
      case 4:
        ctx.log(`[${this.name}] tick=${nowTick} start craft furnace`);
        return this.startTask("K_CRAFT_FURNACE", { type: "CRAFT", recipe_id: "furnace", count: 1 });
      case 5:
        ctx.log(`[${this.name}] tick=${nowTick} start craft torch`);
        return this.startTask("K_CRAFT_TORCH", { type: "CRAFT", recipe_id: "torch", count: 1 });
      case 6:
        ctx.log(`[${this.name}] tick=${nowTick} start build blueprint workshop_pad`);
        return this.startTask("K_BUILD_WORKSHOP_PAD", {
          type: "BUILD_BLUEPRINT",
          blueprint_id: "workshop_pad",
          anchor: this.anchor,
          rotation: 0,
        });
      case 7:
        ctx.log(`[${this.name}] tick=${nowTick} verifying blueprint blocks`);
        this.verifyBlueprint(ctx);
        this.doneFlag = true;
        return null;
      default:
        this.doneFlag = true;
        return null;
    }
  }

  done(): boolean {
    return this.doneFlag;
  }

  private startTask(ref: string, task: any): ScenarioAct {
    this.waitingRef = ref;
    return { tasks: [{ id: ref, ...task }] };
  }

  private verifyBlueprint(ctx: ScenarioContext): void {
    if (!this.blueprint || !this.anchor) return;
    if (!ctx.voxels.hasCube()) throw new Error(`[${this.name}] missing voxel cube (need full OBS)`);

    for (const b of this.blueprint.blocks) {
      const [ox, oy, oz] = b.pos;
      const worldPos: [number, number, number] = [this.anchor[0] + ox, this.anchor[1] + oy, this.anchor[2] + oz];
      const got = ctx.voxels.getBlockAtWorld(worldPos);
      const want = this.paletteByName.get(b.block);
      if (want === undefined) throw new Error(`[${this.name}] missing palette id for ${b.block}`);
      if (got === null) throw new Error(`[${this.name}] block out of voxel cube at ${worldPos.join(",")}`);
      if (got !== want) {
        throw new Error(`[${this.name}] block mismatch at ${worldPos.join(",")}: got=${got} want=${want} (${b.block})`);
      }
    }
    ctx.log(`[${this.name}] blueprint verified (${this.blueprint.blocks.length} blocks)`);
  }

  private pickBenchPos(ctx: ScenarioContext, basePos: [number, number, number]): [number, number, number] {
    const air = this.paletteByName.get("AIR");
    if (air === undefined || !ctx.voxels.hasCube()) return [basePos[0] + 1, basePos[1], basePos[2]];

    // Find an AIR cell near the agent so station checks pass.
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dz === 0) continue;
        const p: [number, number, number] = [basePos[0] + dx, basePos[1], basePos[2] + dz];
        const got = ctx.voxels.getBlockAtWorld(p);
        if (got !== null && got === air) return p;
      }
    }
    return [basePos[0] + 1, basePos[1], basePos[2]];
  }

  private pickAnchor(ctx: ScenarioContext, basePos: [number, number, number]): [number, number, number] {
    const air = this.paletteByName.get("AIR");
    if (air === undefined) return [basePos[0] + 4, basePos[1], basePos[2]];
    if (!this.blueprint || !ctx.voxels.hasCube()) return [basePos[0] + 4, basePos[1], basePos[2]];

    // Try a few candidate anchors within the obs cube to avoid terrain collisions.
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = 3; dx <= 6; dx++) {
        const anchor: [number, number, number] = [basePos[0] + dx, basePos[1], basePos[2] + dz];
        let ok = true;
        for (const b of this.blueprint.blocks) {
          const [ox, oy, oz] = b.pos;
          const p: [number, number, number] = [anchor[0] + ox, anchor[1] + oy, anchor[2] + oz];
          const got = ctx.voxels.getBlockAtWorld(p);
          if (got === null || got !== air) {
            ok = false;
            break;
          }
        }
        if (ok) return anchor;
      }
    }

    // Fallback: place above the agent.
    return [basePos[0] + 4, basePos[1], basePos[2]];
  }
}
