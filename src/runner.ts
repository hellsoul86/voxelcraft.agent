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
  obsTimeoutMS?: number;
  warmupTimeoutMS?: number;
  maxObsTimeouts?: number;
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

  const warmupTimeoutMS = Math.max(2000, opts.warmupTimeoutMS ?? 4500);
  await warmupSession(client, warmupTimeoutMS, (m) => log(`[${opts.sessionKey}] ${m}`));

  const scenario = createScenario(opts.scenario, opts, log);
  await scenario.init(ctx);

  const start = Date.now();
  const timeoutMS = (opts.timeoutSec ?? 120) * 1000;
  const obsTimeoutMS = Math.max(1500, opts.obsTimeoutMS ?? 3500);
  const maxObsTimeouts = Math.max(1, opts.maxObsTimeouts ?? 10);

  let lastTick = 0;
  let obsTimeoutStreak = 0;
  while (true) {
    if (scenario.done()) {
      return { ok: true, agentId: ctx.agentId, tick: lastTick };
    }
    if (Date.now() - start > timeoutMS) {
      return { ok: false, agentId: ctx.agentId, tick: lastTick, error: "timeout" };
    }

    const mode = scenario.obsMode();
    let res: { tick: number; agent_id: string; obs: any } | null = null;
    try {
      res = await client.getObs({ mode, wait_new_tick: true, timeout_ms: obsTimeoutMS });
      obsTimeoutStreak = 0;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (isTransientObsError(msg)) {
        obsTimeoutStreak++;
        if (obsTimeoutStreak >= maxObsTimeouts) {
          return { ok: false, agentId: ctx.agentId, tick: lastTick, error: `obs timeout streak exceeded (${obsTimeoutStreak}): ${msg}` };
        }
        if (obsTimeoutStreak % 3 === 0) {
          log(`[${opts.sessionKey}] transient obs errors=${obsTimeoutStreak}; refreshing sidecar session`);
          try {
            await client.disconnect();
          } catch {
            // ignore
          }
        }
        await sleep(Math.min(800, 100 * obsTimeoutStreak));
        continue;
      }
      return { ok: false, agentId: ctx.agentId, tick: lastTick, error: msg };
    }
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

async function warmupSession(client: VoxelCraftMcpClient, timeoutMS: number, log: (m: string) => void): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await client.getObs({ mode: "summary", wait_new_tick: true, timeout_ms: timeoutMS });
      if (res?.tick && res?.obs) {
        return;
      }
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? err);
      if (!isTransientObsError(msg) && !msg.toLowerCase().includes("catalog not available")) {
        throw err;
      }
      log(`warmup attempt=${attempt} transient error: ${msg}`);
    }
    await sleep(120 * attempt);
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("warmup failed: no obs")
}

function isTransientObsError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("timeout waiting for obs") ||
    m.includes("catalog not available") ||
    m.includes("http 503") ||
    m.includes("fetch failed") ||
    m.includes("connection reset") ||
    m.includes("econnreset") ||
    m.includes("timeout")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
