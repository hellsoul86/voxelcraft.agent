import { buildHmacHeaders } from "./hmac.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

export class JsonRpcClient {
  private readonly url: URL;
  private nextID = 1;
  private readonly agentId: string;
  private readonly hmacSecret?: string;
  private readonly timeoutMS: number;

  constructor(opts: { mcpUrl: string; agentId: string; hmacSecret?: string; timeoutMS?: number }) {
    this.url = new URL(opts.mcpUrl);
    this.agentId = opts.agentId;
    this.hmacSecret = opts.hmacSecret;
    this.timeoutMS = opts.timeoutMS ?? 15_000;
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextID++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) req.params = params;
    const rawBody = JSON.stringify(req);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-agent-id": this.agentId,
    };

    if (this.hmacSecret) {
      const ts = Date.now().toString();
      Object.assign(
        headers,
        buildHmacHeaders({
          secret: this.hmacSecret,
          agentId: this.agentId,
          ts,
          method: "POST",
          pathname: this.url.pathname,
          rawBody,
        }),
      );
    }

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMS);
    try {
      const resp = await fetch(this.url, {
        method: "POST",
        headers,
        body: rawBody,
        signal: ac.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`http ${resp.status}: ${text}`);
      }
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(text) as JsonRpcResponse;
      } catch (e) {
        throw new Error(`bad jsonrpc response: ${(e as Error).message}; body=${text.slice(0, 512)}`);
      }
      if (parsed.error) {
        throw new Error(`jsonrpc error ${parsed.error.code}: ${parsed.error.message}`);
      }
      return parsed.result as T;
    } finally {
      clearTimeout(t);
    }
  }
}

