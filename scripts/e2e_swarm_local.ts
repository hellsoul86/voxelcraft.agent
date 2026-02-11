import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { runScenario, type ScenarioName } from "../src/runner.js";

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      out[k] = v;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function asInt(v: unknown, def: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : def;
}

function asStr(v: unknown, def: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : def;
}

function normalizeFailReason(reason: string): string {
  const msg = String(reason ?? "").trim();
  const code = msg.match(/\bcode=([A-Z0-9_]+)/)?.[1];
  const phase = msg.match(/\bphase=([A-Z0-9_]+)/)?.[1];
  if (code && phase) return `phase=${phase} code=${code}`;
  if (code) return `code=${code}`;
  if (phase) return `phase=${phase}`;
  const firstLine = msg.split("\n")[0] ?? "unknown";
  return firstLine.slice(0, 240);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to get port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitHTTP(url: string, timeoutMS: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMS) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function spawnProc(cmd: string, args: string[], cwd: string, name: string): ChildProcessWithoutNullStreams {
  const p = spawn(cmd, args, { cwd, stdio: "pipe" });
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return p;
}

async function goBuild(cwd: string, pkg: string, outPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const p = spawnProc("go", ["build", "-o", outPath, pkg], cwd, "build");
  const code = await new Promise<number>((resolve) => p.once("exit", (c) => resolve(c ?? 1)));
  if (code !== 0) throw new Error(`go build failed: pkg=${pkg} code=${code}`);
  return outPath;
}

async function shutdown(p: ChildProcessWithoutNullStreams, name: string): Promise<void> {
  if (p.exitCode !== null) return;
  p.kill("SIGINT");
  const ok = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5_000);
    p.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!ok && p.exitCode === null) {
    process.stderr.write(`[${name}] SIGINT timeout; sending SIGKILL\n`);
    p.kill("SIGKILL");
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const count = asInt(flags.count, 50);
  const durationSec = asInt(flags.duration_sec, 60);
  const minSuccessRatioRaw = typeof flags.min_success_ratio === "string" ? Number.parseFloat(flags.min_success_ratio) : 0.95;
  const minSuccessRatio = Number.isFinite(minSuccessRatioRaw)
    ? Math.max(0, Math.min(1, minSuccessRatioRaw))
    : 0.95;
  const scenario = asStr(flags.scenario, "smoke_roam") as ScenarioName;
  const prefix = asStr(flags.prefix, "agent_");

  const serverPort = await getFreePort();
  const mcpPort = await getFreePort();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "voxelcraft-e2e-swarm-"));

  const voxelcraftAI = path.resolve(process.cwd(), "..", "voxelcraft.ai");
  const binDir = path.join(tmp, "bin");

  console.log(`[e2e_swarm] tmp=${tmp}`);
  console.log(`[e2e_swarm] server=http://127.0.0.1:${serverPort}`);
  console.log(`[e2e_swarm] mcp=http://127.0.0.1:${mcpPort}/mcp`);
  console.log(`[e2e_swarm] scenario=${scenario} count=${count} duration_sec=${durationSec}`);

  const serverBin = await goBuild(voxelcraftAI, "./cmd/server", path.join(binDir, "server"));
  const mcpBin = await goBuild(voxelcraftAI, "./cmd/mcp", path.join(binDir, "mcp"));

  const server = spawnProc(serverBin, [
    "-addr",
    `:${serverPort}`,
    "-world",
    "e2e_swarm_world",
    "-seed",
    "1337",
    "-data",
    tmp,
    "-load_latest_snapshot=false",
    "-disable_db=true",
  ], voxelcraftAI, "server");

  try {
    await waitHTTP(`http://127.0.0.1:${serverPort}/healthz`, 30_000);
  } catch (e) {
    await shutdown(server, "server");
    throw e;
  }

  const sidecar = spawnProc(mcpBin, [
    "-listen",
    `127.0.0.1:${mcpPort}`,
    "-world-ws-url",
    `ws://127.0.0.1:${serverPort}/v1/ws`,
    "-state-file",
    path.join(tmp, "mcp", "sessions.json"),
    "-max-sessions",
    String(Math.max(256, count+16)),
  ], voxelcraftAI, "mcp");

  try {
    await waitHTTP(`http://127.0.0.1:${mcpPort}/healthz`, 30_000);
  } catch (e) {
    await shutdown(sidecar, "mcp");
    await shutdown(server, "server");
    throw e;
  }

  let ok = false;
  try {
    const tasks = Array.from({ length: count }, (_, i) => {
      const sessionKey = `${prefix}${String(i + 1).padStart(3, "0")}`;
      return runScenario({
        mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
        sessionKey,
        scenario,
        durationSec,
        fresh: true,
        timeoutSec: Math.max(180, durationSec + 180),
        log: () => {},
      }).then(
        (r) => ({ sessionKey, r }),
        (e) => ({ sessionKey, r: { ok: false, error: (e as Error).message } as any }),
      );
    });

    const results = await Promise.all(tasks);
    let oks = 0;
    const errors = new Map<string, number>();
    for (const it of results) {
      if (it.r.ok) {
        oks++;
      } else {
        const k = normalizeFailReason(it.r.error ?? "unknown");
        errors.set(k, (errors.get(k) ?? 0) + 1);
      }
    }

    const ratio = count > 0 ? oks / count : 0;
    console.log(
      `[e2e_swarm] ok=${oks} fail=${count - oks} success_ratio=${ratio.toFixed(3)} min_success_ratio=${minSuccessRatio.toFixed(3)}`,
    );
    for (const [k, n] of [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`[e2e_swarm] fail_reason n=${n} reason=${k}`);
    }

    ok = ratio >= minSuccessRatio;
  } finally {
    await shutdown(sidecar, "mcp");
    await shutdown(server, "server");
  }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
