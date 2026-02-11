import { JsonRpcClient } from "../mcp/jsonrpc.js";

export type ObsMode = "full" | "no_voxels" | "summary";

export interface GetObsArgs {
  mode?: ObsMode;
  wait_new_tick?: boolean;
  timeout_ms?: number;
}

export interface ActArgs {
  instants?: unknown[];
  tasks?: unknown[];
  cancel?: string[];
  expected_world_id?: string;
  act_id?: string;
  based_on_obs_id?: string;
  idempotency_key?: string;
  wait_ack_ms?: number;
}

export class VoxelCraftMcpClient {
  private readonly rpc: JsonRpcClient;

  constructor(opts: { mcpUrl: string; agentId: string; hmacSecret?: string; timeoutMS?: number }) {
    this.rpc = new JsonRpcClient({
      mcpUrl: opts.mcpUrl,
      agentId: opts.agentId,
      hmacSecret: opts.hmacSecret,
      timeoutMS: opts.timeoutMS,
    });
  }

  async initialize(): Promise<unknown> {
    return this.rpc.call("initialize", {});
  }

  async listTools(): Promise<{ tools: Array<{ name: string }> }> {
    return this.rpc.call("list_tools");
  }

  async getStatus(): Promise<any> {
    return this.callTool("voxelcraft.get_status", {});
  }

  async listWorlds(): Promise<{ worlds: Array<{ world_id: string }> }> {
    const res = await this.callTool("voxelcraft.list_worlds", {});
    return res as { worlds: Array<{ world_id: string }> };
  }

  async getObs(args: GetObsArgs): Promise<{ tick: number; agent_id: string; obs: any }> {
    const res = await this.callTool("voxelcraft.get_obs", args ?? {});
    return res as { tick: number; agent_id: string; obs: any };
  }

  async getEvents(args: { since_cursor?: number; limit?: number }): Promise<{ events: Array<{ cursor: number; event: any }>; next_cursor: number }> {
    const res = await this.callTool("voxelcraft.get_events", args ?? {});
    return res as { events: Array<{ cursor: number; event: any }>; next_cursor: number };
  }

  async getCatalog(name: string): Promise<{ name: string; digest: string; data: any }> {
    const res = await this.callTool("voxelcraft.get_catalog", { name });
    return res as { name: string; digest: string; data: any };
  }

  async act(args: ActArgs): Promise<{ sent: boolean; tick_used: number; agent_id: string; act_id?: string; ack?: any }> {
    const res = await this.callTool("voxelcraft.act", args ?? {});
    return res as { sent: boolean; tick_used: number; agent_id: string; act_id?: string; ack?: any };
  }

  async disconnect(): Promise<{ ok: boolean }> {
    const res = await this.callTool("voxelcraft.disconnect", {});
    return res as { ok: boolean };
  }

  private async callTool(name: string, args: unknown): Promise<any> {
    return this.rpc.call("call_tool", { name, arguments: args });
  }
}
