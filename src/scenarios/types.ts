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
    const cat = await this.client.getCatalog(key);
    const entry: CatalogEntry = { name: cat.name, digest: cat.digest, data: cat.data };
    this.cache.set(key, entry);
    return entry;
  }

  clear(): void {
    this.cache.clear();
  }
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

