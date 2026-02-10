import { createHmac } from "node:crypto";

export function canonicalString(ts: string, method: string, pathname: string, rawBody: string): string {
  return `${ts}\n${method}\n${pathname}\n${rawBody}`;
}

export function signHmacHex(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

export function buildHmacHeaders(args: {
  secret: string;
  agentId: string;
  ts: string;
  method: string;
  pathname: string;
  rawBody: string;
}): Record<string, string> {
  const canon = canonicalString(args.ts, args.method, args.pathname, args.rawBody);
  const sig = signHmacHex(args.secret, canon);
  return {
    "x-agent-id": args.agentId,
    "x-ts": args.ts,
    "x-signature": sig,
  };
}

