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
  const scenario = (typeof flags.scenario === "string" ? flags.scenario : "workshop_pad") as ScenarioName;
  const sessionKey = (typeof flags.agent_id === "string" ? flags.agent_id : "agent_e2e") as string;

  const serverPort = await getFreePort();
  const mcpPort = await getFreePort();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "voxelcraft-e2e-"));

  const voxelcraftAI = path.resolve(process.cwd(), "..", "voxelcraft.ai");
  const binDir = path.join(tmp, "bin");

  console.log(`[e2e] tmp=${tmp}`);
  console.log(`[e2e] server=http://127.0.0.1:${serverPort}`);
  console.log(`[e2e] mcp=http://127.0.0.1:${mcpPort}/mcp`);

  const serverBin = await goBuild(voxelcraftAI, "./cmd/server", path.join(binDir, "server"));
  const mcpBin = await goBuild(voxelcraftAI, "./cmd/mcp", path.join(binDir, "mcp"));

  const server = spawnProc(serverBin, [
    "-addr",
    `:${serverPort}`,
    "-world",
    "e2e_world",
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
    const res = await runScenario({
      mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
      sessionKey,
      scenario,
      durationSec: 30,
      fresh: true,
      timeoutSec: 120,
    });
    if (!res.ok) throw new Error(res.error ?? "scenario failed");
    ok = true;
    console.log(`[e2e] scenario ok: ${scenario} agent=${res.agentId} tick=${res.tick}`);
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
