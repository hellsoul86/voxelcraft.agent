import type { ObsFull, ObsSummary } from "../voxelcraft/obs_types.js";
import type { ObsMode, VoxelCraftMcpClient } from "../voxelcraft/client.js";
import type { VoxelCubeTracker } from "../voxelcraft/voxels.js";

export type AnyObs = ObsFull | ObsSummary | any;

export interface ScenarioContext {
  client: VoxelCraftMcpClient;
  sessionKey: string;
  agentId: string;
  catalogs: CatalogCache;
  voxels: VoxelCubeTracker;
  log: (msg: string) => void;
}

export interface CatalogEntry {
  name: string;
  digest: string;
  data: any;
}

export class CatalogCache {
  private readonly client: VoxelCraftMcpClient;
  private readonly cache = new Map<string, CatalogEntry>();

  constructor(client: VoxelCraftMcpClient) {
    this.client = client;
  }

  async get(name: string): Promise<CatalogEntry> {
    const key = name.trim().toLowerCase();
    const existing = this.cache.get(key);
    if (existing) return existing;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const cat = await this.client.getCatalog(key);
        const entry: CatalogEntry = { name: cat.name, digest: cat.digest, data: cat.data };
        this.cache.set(key, entry);
        return entry;
      } catch (err) {
        lastErr = err;
        const msg = String((err as Error)?.message ?? err);
        if (!isTransientCatalogError(msg) || attempt === 6) {
          break;
        }
        await sleep(120 * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("catalog fetch failed");
  }

  clear(): void {
    this.cache.clear();
  }
}

function isTransientCatalogError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("catalog not available") ||
    m.includes("timeout waiting for obs") ||
    m.includes("http 503") ||
    m.includes("fetch failed") ||
    m.includes("timeout")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export interface ScenarioAct {
  instants?: any[];
  tasks?: any[];
  cancel?: string[];
}

export interface Scenario {
  name: string;
  obsMode(): ObsMode;
  init(ctx: ScenarioContext): Promise<void>;
  step(obs: AnyObs, ctx: ScenarioContext): Promise<ScenarioAct | null>;
  done(): boolean;
}

