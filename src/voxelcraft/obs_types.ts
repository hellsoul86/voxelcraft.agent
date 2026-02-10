export type Vec3 = [number, number, number];

export interface ItemStack {
  item: string;
  count: number;
}

export interface TaskObs {
  task_id: string;
  kind: string;
  progress: number;
  target?: Vec3;
  eta_ticks?: number;
}

export interface EntityObs {
  id: string;
  type: string;
  pos: Vec3;
  tags?: string[];
  reputation_hint?: number;
  item?: string;
  count?: number;
}

export interface VoxelDeltaOp {
  d: Vec3; // [dx,dy,dz] from center
  b: number; // uint16 palette id
}

export interface VoxelsObs {
  center: Vec3;
  radius: number;
  encoding: "RLE" | "DELTA";
  data?: string;
  ops?: VoxelDeltaOp[];
}

export interface SelfObs {
  pos: Vec3;
  yaw: number;
  hp: number;
  hunger: number;
  stamina: number;
  status: string[];
}

export interface WorldObs {
  time_of_day: number;
  weather: string;
  season_day: number;
  biome: string;
  active_event?: string;
  active_event_ends_tick?: number;
}

export type Event = Record<string, unknown>;

// "full" OBS from voxelcraft.ai protocol (may include more fields than declared here).
export interface ObsFull {
  type: string;
  protocol_version: string;
  tick: number;
  agent_id: string;
  world: WorldObs;
  self: SelfObs;
  inventory: ItemStack[];
  local_rules: Record<string, unknown>;
  voxels: VoxelsObs;
  entities: EntityObs[];
  events: Event[];
  tasks: TaskObs[];
  memory?: { key: string; value: string }[];
}

// "summary" OBS returned by the MCP sidecar (obsSummary).
export interface ObsSummary {
  type: string;
  protocol_version: string;
  tick: number;
  agent_id: string;
  world: WorldObs;
  self: SelfObs;
  inventory: ItemStack[];
  local_rules: Record<string, unknown>;
  entities: EntityObs[];
  events: Event[];
  tasks: TaskObs[];
  fun_score?: Record<string, unknown>;
  public_boards?: unknown[];
}

