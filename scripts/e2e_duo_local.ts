import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { VoxelCraftMcpClient } from "../src/voxelcraft/client.js";

type DuoScenarioName = "trade_p2p" | "contract_gather" | "claim_law_tax";
let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter++;
  return `${prefix}_${Date.now()}_${uidCounter}`;
}

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

function asStr(v: unknown, def: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : def;
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

function invToMap(inv: any): Record<string, number> {
  const out: Record<string, number> = {};
  const arr = Array.isArray(inv) ? inv : [];
  for (const it of arr) {
    const item = it?.item;
    const count = it?.count;
    if (typeof item !== "string") continue;
    if (typeof count !== "number") continue;
    out[item] = count;
  }
  return out;
}

function findEvent(events: any, pred: (e: any) => boolean): any | undefined {
  const arr = Array.isArray(events) ? events : [];
  for (const e of arr) {
    if (e && typeof e === "object" && pred(e)) return e;
  }
  return undefined;
}

async function getObsSummary(client: VoxelCraftMcpClient): Promise<any> {
  const res = await client.getObs({ mode: "summary", wait_new_tick: true, timeout_ms: 2000 });
  if (!res?.obs) throw new Error("missing obs");
  return res;
}

async function waitForEventInObs(
  client: VoxelCraftMcpClient,
  pred: (e: any) => boolean,
  timeoutMS: number,
): Promise<{ obs: any; event: any }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMS) {
    const res = await getObsSummary(client);
    const obs = res.obs;
    const ev = findEvent(obs?.events, pred);
    if (ev) return { obs, event: ev };
  }
  throw new Error("timeout waiting for event");
}

async function sendInstantAndGetResult(client: VoxelCraftMcpClient, inst: any, timeoutMS: number): Promise<any> {
  const id = typeof inst?.id === "string" ? inst.id : "";
  if (!id) throw new Error("instant id required for e2e");
  await client.act({ instants: [inst] });
  const { event } = await waitForEventInObs(
    client,
    (e) => e.type === "ACTION_RESULT" && e.ref === id,
    timeoutMS,
  );
  return event;
}

async function sendInstantAndWaitResult(client: VoxelCraftMcpClient, inst: any, timeoutMS: number): Promise<any> {
  const event = await sendInstantAndGetResult(client, inst, timeoutMS);
  if (event?.ok !== true) {
    throw new Error(`ACTION_RESULT not ok: ref=${event?.ref ?? ""} code=${event?.code ?? ""} msg=${event?.message ?? ""}`);
  }
  return event;
}

async function startTaskAndWaitDone(
  client: VoxelCraftMcpClient,
  task: any,
  timeoutMS: number,
): Promise<{ taskId: string }> {
  const id = typeof task?.id === "string" ? task.id : "";
  if (!id) throw new Error("task id required for e2e");
  await client.act({ tasks: [task] });
  const { obs: arObs, event: ar } = await waitForEventInObs(
    client,
    (e) => e.type === "ACTION_RESULT" && e.ref === id,
    timeoutMS,
  );
  if (ar?.ok !== true) {
    throw new Error(`ACTION_RESULT not ok: ref=${id} code=${ar?.code ?? ""} msg=${ar?.message ?? ""}`);
  }
  const taskId = typeof ar?.task_id === "string" ? ar.task_id : "";
  if (!taskId) throw new Error(`missing task_id in ACTION_RESULT for ${id}`);

  // Many tasks can complete in the same tick they are started. If so, TASK_DONE/TASK_FAIL
  // may be present in the same OBS that contained ACTION_RESULT.
  let done = findEvent(
    arObs?.events,
    (e) => (e.type === "TASK_DONE" || e.type === "TASK_FAIL") && e.task_id === taskId,
  );
  if (!done) {
    const r = await waitForEventInObs(
      client,
      (e) => (e.type === "TASK_DONE" || e.type === "TASK_FAIL") && e.task_id === taskId,
      timeoutMS,
    );
    done = r.event;
  }
  if (done.type === "TASK_FAIL") {
    throw new Error(`TASK_FAIL: code=${done.code ?? ""} msg=${done.message ?? ""}`);
  }
  return { taskId };
}

async function waitForInventory(
  client: VoxelCraftMcpClient,
  pred: (inv: Record<string, number>, obs: any) => boolean,
  timeoutMS: number,
): Promise<{ inv: Record<string, number>; obs: any }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMS) {
    const res = await getObsSummary(client);
    const obs = res.obs;
    const inv = invToMap(obs?.inventory);
    if (pred(inv, obs)) return { inv, obs };
  }
  throw new Error("timeout waiting for inventory condition");
}

async function waitForObs(
  client: VoxelCraftMcpClient,
  pred: (obs: any) => boolean,
  timeoutMS: number,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMS) {
    const res = await getObsSummary(client);
    const obs = res.obs;
    if (pred(obs)) return obs;
  }
  throw new Error("timeout waiting for obs condition");
}

async function waitTicks(client: VoxelCraftMcpClient, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await getObsSummary(client);
  }
}

async function ensurePlacedAtAir(client: VoxelCraftMcpClient, itemId: string, basePos: [number, number, number]): Promise<[number, number, number]> {
  // Try a small deterministic set of offsets.
  const [x, y, z] = basePos;
  const candidates: [number, number, number][] = [
    [x + 1, y, z],
    [x + 2, y, z],
    [x, y, z + 1],
    [x, y, z + 2],
    [x - 1, y, z],
    [x, y, z - 1],
  ];
  for (let i = 0; i < candidates.length; i++) {
    const pos = candidates[i]!;
    try {
      await startTaskAndWaitDone(client, { id: `K_place_${i}`, type: "PLACE", item_id: itemId, block_pos: pos }, 10_000);
      return pos;
    } catch {
      // keep trying
    }
  }
  throw new Error(`failed to PLACE ${itemId} near ${basePos.join(",")}`);
}

async function scenarioTradeP2P(mcpUrl: string): Promise<void> {
  const a = new VoxelCraftMcpClient({ mcpUrl, agentId: "agent_a" });
  const b = new VoxelCraftMcpClient({ mcpUrl, agentId: "agent_b" });

  try {
    await a.disconnect();
  } catch {}
  try {
    await b.disconnect();
  } catch {}

  const a0 = await getObsSummary(a);
  const b0 = await getObsSummary(b);
  const aID = a0.agent_id as string;
  const bID = b0.agent_id as string;
  if (!aID || !bID || aID === bID) throw new Error(`bad agent ids: a=${aID} b=${bID}`);

  const invA0 = invToMap(a0.obs?.inventory);
  const invB0 = invToMap(b0.obs?.inventory);
  if ((invA0.PLANK ?? 0) < 5) throw new Error("agent_a missing PLANK for trade");
  if ((invB0.COAL ?? 0) < 1) throw new Error("agent_b missing COAL for trade");

  const offer = await sendInstantAndWaitResult(a, {
    id: "I_offer",
    type: "OFFER_TRADE",
    to: bID,
    offer: [["PLANK", 5]],
    request: [["COAL", 1]],
  }, 10_000);
  const tradeID = offer?.trade_id as string;
  if (!tradeID) throw new Error("missing trade_id");

  await sendInstantAndWaitResult(b, { id: "I_accept", type: "ACCEPT_TRADE", trade_id: tradeID }, 10_000);

  const aAfter = await waitForInventory(
    a,
    (inv) => (inv.PLANK ?? 0) === (invA0.PLANK ?? 0) - 5 && (inv.COAL ?? 0) === (invA0.COAL ?? 0) + 1,
    10_000,
  );
  const bAfter = await waitForInventory(
    b,
    (inv) => (inv.PLANK ?? 0) === (invB0.PLANK ?? 0) + 5 && (inv.COAL ?? 0) === (invB0.COAL ?? 0) - 1,
    10_000,
  );
  const invA1 = aAfter.inv;
  const invB1 = bAfter.inv;

  if ((invA1.PLANK ?? 0) !== (invA0.PLANK ?? 0) - 5) throw new Error("agent_a PLANK delta mismatch");
  if ((invA1.COAL ?? 0) !== (invA0.COAL ?? 0) + 1) throw new Error("agent_a COAL delta mismatch");
  if ((invB1.PLANK ?? 0) !== (invB0.PLANK ?? 0) + 5) throw new Error("agent_b PLANK delta mismatch");
  if ((invB1.COAL ?? 0) !== (invB0.COAL ?? 0) - 1) throw new Error("agent_b COAL delta mismatch");
}

async function scenarioContractGather(mcpUrl: string): Promise<void> {
  const a = new VoxelCraftMcpClient({ mcpUrl, agentId: "agent_a" });
  const b = new VoxelCraftMcpClient({ mcpUrl, agentId: "agent_b" });

  try {
    await a.disconnect();
  } catch {}
  try {
    await b.disconnect();
  } catch {}

  const a0 = await getObsSummary(a);
  const b0 = await getObsSummary(b);
  const aID = a0.agent_id as string;
  const bID = b0.agent_id as string;
  if (!aID || !bID || aID === bID) throw new Error(`bad agent ids: a=${aID} b=${bID}`);

  const posA = a0.obs?.self?.pos as [number, number, number];
  if (!Array.isArray(posA) || posA.length !== 3) throw new Error("missing self.pos");

  const termPos = await ensurePlacedAtAir(a, "CONTRACT_TERMINAL", [posA[0], 0, posA[2]]);
  const termID = `CONTRACT_TERMINAL@${termPos[0]},${termPos[1]},${termPos[2]}`;

  const invA0 = invToMap(a0.obs?.inventory);
  if ((invA0.PLANK ?? 0) < 2) throw new Error("agent_a missing PLANK for reward");

  const post = await sendInstantAndWaitResult(
    a,
    {
      id: uid("I_post"),
      type: "POST_CONTRACT",
      terminal_id: termID,
      contract_kind: "GATHER",
      requirements: [{ item: "COAL", count: 1 }],
      reward: [{ item: "PLANK", count: 2 }],
      deposit: [],
      duration_ticks: 200,
    },
    10_000,
  );
  const contractID = post?.contract_id as string;
  if (!contractID) throw new Error("missing contract_id");

  await sendInstantAndWaitResult(
    b,
    { id: uid("I_accept"), type: "ACCEPT_CONTRACT", contract_id: contractID, terminal_id: termID },
    10_000,
  );

  // Move requirements into the terminal.
  await startTaskAndWaitDone(
    b,
    { id: uid("K_xfer"), type: "TRANSFER", src_container: "SELF", dst_container: termID, item_id: "COAL", count: 1 },
    10_000,
  );

  const invB0 = invToMap(b0.obs?.inventory);
  const aAfter = await waitForInventory(
    a,
    (inv) => (inv.COAL ?? 0) === (invA0.COAL ?? 0) + 1,
    10_000,
  );
  const bAfter = await waitForInventory(
    b,
    (inv) => (inv.COAL ?? 0) === (invB0.COAL ?? 0) - 1 && (inv.PLANK ?? 0) === (invB0.PLANK ?? 0) + 2,
    10_000,
  );
  const invB1 = bAfter.inv;
  const invA1 = aAfter.inv;
  if ((invA1.COAL ?? 0) !== (invA0.COAL ?? 0) + 1) throw new Error("poster did not receive gathered coal");
  if ((invB1.COAL ?? 0) !== (invB0.COAL ?? 0) - 1) throw new Error("transferred coal not deducted from agent_b");
  if ((invB1.PLANK ?? 0) !== (invB0.PLANK ?? 0) + 2) throw new Error("agent_b reward not received");
}

async function scenarioClaimLawTax(mcpUrl: string): Promise<void> {
  const a = new VoxelCraftMcpClient({ mcpUrl, agentId: "agent_a" });
  const b = new VoxelCraftMcpClient({ mcpUrl, agentId: "agent_b" });

  try {
    await a.disconnect();
  } catch {}
  try {
    await b.disconnect();
  } catch {}

  const a0 = await getObsSummary(a);
  const b0 = await getObsSummary(b);
  const aID = a0.agent_id as string;
  const bID = b0.agent_id as string;
  if (!aID || !bID || aID === bID) throw new Error(`bad agent ids: a=${aID} b=${bID}`);

  const posA = a0.obs?.self?.pos as [number, number, number];
  if (!Array.isArray(posA) || posA.length !== 3) throw new Error("missing self.pos");

  const invA0 = invToMap(a0.obs?.inventory);
  if ((invA0.BATTERY ?? 0) < 1 || (invA0.CRYSTAL_SHARD ?? 0) < 1) {
    throw new Error("agent_a missing BATTERY/CRYSTAL_SHARD for claim");
  }

  // CLAIM_LAND is implemented as a task-like request (in ACT.tasks).
  await a.act({ tasks: [{ id: "K_claim", type: "CLAIM_LAND", anchor: [posA[0], 0, posA[2]], radius: 32 }] });
  const claimAR = await waitForEventInObs(a, (e) => e.type === "ACTION_RESULT" && e.ref === "K_claim", 10_000);
  if (claimAR.event?.ok !== true) throw new Error(`claim failed: ${claimAR.event?.code ?? ""} ${claimAR.event?.message ?? ""}`);
  const landID = claimAR.event?.land_id as string;
  if (!landID) throw new Error("missing land_id");

  await sendInstantAndWaitResult(a, { id: "I_perms", type: "SET_PERMISSIONS", land_id: landID, policy: { allow_trade: true } }, 10_000);

  // Ensure B is within the claimed land so MARKET_TAX applies to this trade.
  await startTaskAndWaitDone(
    b,
    { id: "K_move_land", type: "MOVE_TO", target: [posA[0], 0, posA[2]], tolerance: 3 },
    15_000,
  );

  const propose = await sendInstantAndWaitResult(
    a,
    {
      id: "I_law",
      type: "PROPOSE_LAW",
      land_id: landID,
      template_id: "MARKET_TAX",
      params: { market_tax: 0.1 },
      title: "tax=10%",
    },
    10_000,
  );
  const lawID = propose?.law_id as string;
  if (!lawID) throw new Error("missing law_id");

  // Wait through NOTICE window (tuning in this e2e sets notice/vote to 10 ticks).
  await waitTicks(a, 12);
  let voted = false;
  for (let i = 0; i < 8; i++) {
    const voteRes = await sendInstantAndGetResult(a, { id: `I_vote_${i}`, type: "VOTE", law_id: lawID, choice: "YES" }, 10_000);
    if (voteRes?.ok === true) {
      voted = true;
      break;
    }
    // Not yet in voting window; keep polling.
    if (voteRes?.code !== "E_BLOCKED") {
      throw new Error(`vote failed: ${voteRes?.code ?? ""} ${voteRes?.message ?? ""}`);
    }
    await waitTicks(a, 2);
  }
  if (!voted) throw new Error("vote window not reached in time");
  await waitTicks(a, 12);

  const bTaxObs = await waitForObs(
    b,
    (obs) => Number(obs?.local_rules?.tax?.market ?? 0) > 0,
    15_000,
  );
  const taxRate = Number(bTaxObs?.local_rules?.tax?.market ?? 0);
  const invB0 = invToMap(bTaxObs?.inventory);
  if ((invB0.COAL ?? 0) < 10) throw new Error("agent_b missing COAL for taxed trade");

  const offer = await sendInstantAndWaitResult(a, {
    id: "I_offer",
    type: "OFFER_TRADE",
    to: bID,
    offer: [["PLANK", 20]],
    request: [["COAL", 10]],
  }, 10_000);
  const tradeID = offer?.trade_id as string;
  if (!tradeID) throw new Error("missing trade_id");

  await sendInstantAndWaitResult(b, { id: "I_accept", type: "ACCEPT_TRADE", trade_id: tradeID }, 10_000);
  const bAfter = await waitForInventory(
    b,
    (inv) => (inv.COAL ?? 0) === (invB0.COAL ?? 0) - 10 && (inv.PLANK ?? 0) > (invB0.PLANK ?? 0),
    10_000,
  );
  const invB1 = bAfter.inv;
  const plankGain = (invB1.PLANK ?? 0) - (invB0.PLANK ?? 0);
  if (plankGain > 19) throw new Error(`market tax not applied (taxRate=${taxRate}, plank_gain=${plankGain})`);
  if ((invB1.COAL ?? 0) !== (invB0.COAL ?? 0) - 10) throw new Error("coal delta mismatch");
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const scenario = asStr(flags.scenario, "trade_p2p") as DuoScenarioName;

  const serverPort = await getFreePort();
  const mcpPort = await getFreePort();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "voxelcraft-e2e-duo-"));

  const voxelcraftAI = path.resolve(process.cwd(), "..", "voxelcraft.ai");
  const binDir = path.join(tmp, "bin");
  const tuningPath = path.join(tmp, "tuning.yaml");

  const tuning = `protocol_version: "0.9"\n\nstarter_items:\n  PLANK: 200\n  COAL: 200\n  STONE: 50\n  BERRIES: 20\n  BATTERY: 10\n  CRYSTAL_SHARD: 10\n  CONTRACT_TERMINAL: 4\n\nlaw_notice_ticks: 10\nlaw_vote_ticks: 10\n`;
  await fs.writeFile(tuningPath, tuning, "utf8");

  console.log(`[e2e_duo] tmp=${tmp}`);
  console.log(`[e2e_duo] server=http://127.0.0.1:${serverPort}`);
  console.log(`[e2e_duo] mcp=http://127.0.0.1:${mcpPort}/mcp`);
  console.log(`[e2e_duo] scenario=${scenario}`);

  const serverBin = await goBuild(voxelcraftAI, "./cmd/server", path.join(binDir, "server"));
  const mcpBin = await goBuild(voxelcraftAI, "./cmd/mcp", path.join(binDir, "mcp"));

  const server = spawnProc(serverBin, [
    "-addr",
    `:${serverPort}`,
    "-world",
    "e2e_duo_world",
    "-seed",
    "1337",
    "-data",
    tmp,
    "-load_latest_snapshot=false",
    "-disable_db=true",
    "-tuning",
    tuningPath,
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
    "16",
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
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
    switch (scenario) {
      case "trade_p2p":
        await scenarioTradeP2P(mcpUrl);
        break;
      case "contract_gather":
        await scenarioContractGather(mcpUrl);
        break;
      case "claim_law_tax":
        await scenarioClaimLawTax(mcpUrl);
        break;
      default:
        throw new Error(`unknown scenario: ${scenario}`);
    }
    ok = true;
    console.log(`[e2e_duo] ok scenario=${scenario}`);
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
