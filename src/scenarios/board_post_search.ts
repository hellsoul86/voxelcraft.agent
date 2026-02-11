import type { Scenario, ScenarioAct, ScenarioContext } from "./types.js";
import { findActionResult, findTaskDone, findTaskFail, getBool, getString } from "./util.js";

type RecipeDef = {
  recipe_id: string;
};

export class BoardPostSearchScenario implements Scenario {
  name = "board_post_search";

  private phase = 0;
  private waitingRef: string | null = null;
  private waitingTaskID: string | null = null;

  private basePos: [number, number, number] | null = null;
  private benchPos: [number, number, number] | null = null;
  private boardPos: [number, number, number] | null = null;

  private paletteByName = new Map<string, number>();

  private waitingBoardSearch = false;

  private doneFlag = false;

  obsMode() {
    return "full" as const;
  }

  async init(ctx: ScenarioContext): Promise<void> {
    const blocksCat = await ctx.catalogs.get("block_palette");
    const palette = blocksCat.data as string[];
    palette.forEach((name, idx) => this.paletteByName.set(name, idx));

    const recCat = await ctx.catalogs.get("recipes");
    const recipes = recCat.data as RecipeDef[];
    const need = ["stick_from_plank", "crafting_bench", "bulletin_board"];
    for (const id of need) {
      if (!recipes.find((r) => r.recipe_id === id)) {
        throw new Error(`[${this.name}] missing recipe ${id}`);
      }
    }

    ctx.log(`[${this.name}] catalogs ok (palette=${palette.length} recipes=${recipes.length})`);
  }

  async step(obs: any, ctx: ScenarioContext): Promise<ScenarioAct | null> {
    const pos = obs?.self?.pos as [number, number, number] | undefined;
    if (!pos) return null;
    const nowTick = Number(obs?.tick ?? 0);

    if (!this.basePos) {
      this.basePos = pos;
      this.benchPos = this.pickNearbyAir(ctx, pos, 2) ?? [pos[0] + 1, pos[1], pos[2]];
      // Place the board near the agent so POST_BOARD proximity checks pass.
      this.boardPos =
        this.pickNearbyAir(ctx, pos, 3, new Set([this.key(this.benchPos)])) ??
        this.pickNearbyAir(ctx, this.benchPos, 2, new Set([this.key(this.benchPos)])) ??
        [pos[0] + 2, pos[1], pos[2]];
      ctx.log(`[${this.name}] basePos=${this.basePos.join(",")} benchPos=${this.benchPos.join(",")} boardPos=${this.boardPos.join(",")}`);
    }

    // Wait for ACTION_RESULT to get server task_id.
    if (this.waitingRef) {
      const ref = this.waitingRef;
      const ar = findActionResult(obs.events, this.waitingRef);
      if (!ar) return null;
      const ok = getBool(ar, "ok");
      if (!ok) {
        const code = getString(ar, "code") ?? "E_UNKNOWN";
        const msg = getString(ar, "message") ?? "";
        throw new Error(`[${this.name}] action rejected ref=${ref} code=${code} msg=${msg}`);
      }
      const tid = getString(ar, "task_id");
      this.waitingRef = null;

      // Instant actions don't return task_id; treat completion as phase+1.
      if (!tid) {
        if (this.waitingBoardSearch) {
          this.waitingBoardSearch = false;
          const ev = (obs?.events ?? []).find((e: any) => e?.type === "BOARD_SEARCH" && e?.query === "voxelcraft");
          if (!ev) throw new Error(`[${this.name}] missing BOARD_SEARCH event`);
          const results = ev?.results;
          if (!Array.isArray(results) || results.length === 0) {
            throw new Error(`[${this.name}] BOARD_SEARCH returned no results`);
          }
          const hit = results.some((r: any) => typeof r?.title === "string" && r.title.includes("voxelcraft"));
          if (!hit) throw new Error(`[${this.name}] BOARD_SEARCH results missing expected title`);
          ctx.log(`[${this.name}] board search ok (results=${results.length})`);
          this.doneFlag = true;
          return null;
        }
        this.phase++;
        return null;
      }

      ctx.log(`[${this.name}] tick=${nowTick} ACTION_RESULT ok ref=${ref} task_id=${tid}`);

      const fail = findTaskFail(obs.events, tid);
      if (fail) {
        const code = getString(fail, "code") ?? "E_UNKNOWN";
        const msg = getString(fail, "message") ?? "";
        throw new Error(`[${this.name}] TASK_FAIL task_id=${tid} code=${code} msg=${msg}`);
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

    if (!this.benchPos || !this.boardPos) return null;

    switch (this.phase) {
      case 0:
        ctx.log(`[${this.name}] tick=${nowTick} start craft stick_from_plank`);
        return this.startTask("K_CRAFT_STICK", { type: "CRAFT", recipe_id: "stick_from_plank", count: 1 });
      case 1:
        ctx.log(`[${this.name}] tick=${nowTick} start craft crafting_bench`);
        return this.startTask("K_CRAFT_BENCH", { type: "CRAFT", recipe_id: "crafting_bench", count: 1 });
      case 2:
        ctx.log(`[${this.name}] tick=${nowTick} start place crafting_bench`);
        return this.startTask("K_PLACE_BENCH", { type: "PLACE", item_id: "CRAFTING_BENCH", block_pos: this.benchPos });
      case 3:
        ctx.log(`[${this.name}] tick=${nowTick} start craft bulletin_board`);
        return this.startTask("K_CRAFT_BOARD", { type: "CRAFT", recipe_id: "bulletin_board", count: 1 });
      case 4:
        ctx.log(`[${this.name}] tick=${nowTick} start place bulletin_board`);
        return this.startTask("K_PLACE_BOARD", { type: "PLACE", item_id: "BULLETIN_BOARD", block_pos: this.boardPos });
      case 5: {
        const boardID = `BULLETIN_BOARD@${this.boardPos[0]},${this.boardPos[1]},${this.boardPos[2]}`;
        const ref = "I_POST_1";
        this.waitingRef = ref;
        ctx.log(`[${this.name}] tick=${nowTick} post_board -> ${boardID}`);
        return {
          instants: [
            {
              id: ref,
              type: "POST_BOARD",
              board_id: boardID,
              title: "hello voxelcraft",
              body: "e2e post from board_post_search",
            },
          ],
        };
      }
      case 6: {
        const boardID = `BULLETIN_BOARD@${this.boardPos[0]},${this.boardPos[1]},${this.boardPos[2]}`;
        const ref = "I_SEARCH_1";
        this.waitingRef = ref;
        this.waitingBoardSearch = true;
        ctx.log(`[${this.name}] tick=${nowTick} search_board -> ${boardID}`);
        return {
          instants: [
            {
              id: ref,
              type: "SEARCH_BOARD",
              board_id: boardID,
              text: "voxelcraft",
              limit: 10,
            },
          ],
        };
      }
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

  private key(p: [number, number, number]): string {
    return `${p[0]},${p[1]},${p[2]}`;
  }

  private pickNearbyAir(
    ctx: ScenarioContext,
    basePos: [number, number, number],
    r: number,
    forbidden?: Set<string>,
  ): [number, number, number] | null {
    const air = this.paletteByName.get("AIR");
    if (air === undefined || !ctx.voxels.hasCube()) return null;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dz === 0) continue;
        if (Math.abs(dx) + Math.abs(dz) > r) continue;
        const p: [number, number, number] = [basePos[0] + dx, basePos[1], basePos[2] + dz];
        if (forbidden?.has(this.key(p))) continue;
        const got = ctx.voxels.getBlockAtWorld(p);
        if (got !== null && got === air) return p;
      }
    }
    return null;
  }
}
