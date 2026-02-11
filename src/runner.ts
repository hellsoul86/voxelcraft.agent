import { VoxelCraftMcpClient } from "./voxelcraft/client.js";
import { VoxelCubeTracker } from "./voxelcraft/voxels.js";
import type { Scenario } from "./scenarios/types.js";
import { CatalogCache } from "./scenarios/types.js";
import { SmokeRoamScenario } from "./scenarios/smoke_roam.js";
import { WorkshopPadScenario } from "./scenarios/workshop_pad.js";
import { MineGatherScenario } from "./scenarios/mine_gather.js";
import { MemoryKVScenario } from "./scenarios/memory_kv.js";
import { BoardPostSearchScenario } from "./scenarios/board_post_search.js";
import { MultiworldMineTradeGovernScenario } from "./scenarios/multiworld_mine_trade_govern.js";

export type ScenarioName =
  | "smoke_roam"
  | "workshop_pad"
  | "mine_gather"
  | "memory_kv"
  | "board_post_search"
  | "multiworld_mine_trade_govern";

export interface RunScenarioOpts {
  mcpUrl: string;
  sessionKey: string; // maps to sidecar session via x-agent-id
  scenario: ScenarioName;
  durationSec?: number; // used by smoke_roam and swarm
  hmacSecret?: string;
  fresh?: boolean;
  timeoutSec?: number;
  log?: (msg: string) => void;
}

export interface RunResult {
  ok: boolean;
  agentId?: string;
  tick?: number;
  error?: string;
}

export async function runScenario(opts: RunScenarioOpts): Promise<RunResult> {
  const log = opts.log ?? ((m) => console.log(m));

  const client = new VoxelCraftMcpClient({
    mcpUrl: opts.mcpUrl,
    agentId: opts.sessionKey,
    hmacSecret: opts.hmacSecret,
  });

  // Basic MCP sanity.
  try {
    await client.initialize();
  } catch {
    // initialize is optional; ignore.
  }

  const tools = await client.listTools();
  const toolNames = new Set((tools.tools ?? []).map((t: any) => t?.name).filter(Boolean));
  for (const required of [
    "voxelcraft.get_status",
    "voxelcraft.get_obs",
    "voxelcraft.get_catalog",
    "voxelcraft.act",
    "voxelcraft.disconnect",
  ]) {
    if (!toolNames.has(required)) throw new Error(`missing MCP tool: ${required}`);
  }

  if (opts.fresh ?? true) {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }

  const voxels = new VoxelCubeTracker();
  const catalogs = new CatalogCache(client);
  const ctx = {
    client,
    sessionKey: opts.sessionKey,
    agentId: "",
    catalogs,
    voxels,
    log: (m: string) => log(`[${opts.sessionKey}] ${m}`),
  };

  const scenario = createScenario(opts.scenario, opts, log);
  await scenario.init(ctx);

  const start = Date.now();
  const timeoutMS = (opts.timeoutSec ?? 120) * 1000;

  let lastTick = 0;
  while (true) {
    if (scenario.done()) {
      return { ok: true, agentId: ctx.agentId, tick: lastTick };
    }
    if (Date.now() - start > timeoutMS) {
      return { ok: false, agentId: ctx.agentId, tick: lastTick, error: "timeout" };
    }

    const mode = scenario.obsMode();
    const res = await client.getObs({ mode, wait_new_tick: true, timeout_ms: 2000 });
    if (!res?.tick || !res?.obs) continue;

    lastTick = res.tick;
    ctx.agentId = res.agent_id;
    const obs = res.obs;

    if (mode === "full" && obs?.voxels?.encoding) {
      try {
        voxels.update(obs.voxels);
      } catch (e) {
        // If we started mid-session and only saw DELTA, force a reconnect to get RLE baseline.
        const msg = (e as Error).message || String(e);
        if (msg.includes("DELTA without baseline")) {
          log(`[${opts.sessionKey}] voxel baseline missing; reconnecting sidecar session`);
          voxels.reset();
          try {
            await client.disconnect();
          } catch {
            // ignore
          }
          continue;
        }
        throw e;
      }
    }

    const act = await scenario.step(obs, ctx);
    if (act) {
      await client.act(act);
    }
  }
}

function createScenario(name: ScenarioName, opts: RunScenarioOpts, log: (m: string) => void): Scenario {
  switch (name) {
    case "smoke_roam":
      return new SmokeRoamScenario({ durationSec: opts.durationSec ?? 30, seed: opts.sessionKey });
    case "workshop_pad":
      return new WorkshopPadScenario();
    case "mine_gather":
      return new MineGatherScenario();
    case "memory_kv":
      return new MemoryKVScenario();
    case "board_post_search":
      return new BoardPostSearchScenario();
    case "multiworld_mine_trade_govern":
      return new MultiworldMineTradeGovernScenario();
    default:
      log(`[${opts.sessionKey}] unknown scenario: ${name}`);
      throw new Error(`unknown scenario: ${name}`);
  }
}
