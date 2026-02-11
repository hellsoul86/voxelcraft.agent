import { runScenario, type ScenarioName } from "./runner.js";

function usage(): never {
  console.error(`Usage:
  pnpm run run -- --scenario <name> [--mcp <url>] [--agent_id <id>] [--duration_sec <n>] [--no_fresh]
  pnpm run swarm -- --count <n> --duration_sec <n> [--scenario smoke_roam] [--mcp <url>] [--prefix <pfx>]
  pnpm run e2e -- --scenario <name>

Scenarios: smoke_roam | workshop_pad | mine_gather | memory_kv | board_post_search
`);
  process.exit(2);
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const cmd = argv[0] ?? "";
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.startsWith("no_")) {
      flags[key.slice(3)] = false;
      continue;
    }
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      flags[key] = v;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { cmd, flags };
}

function asInt(v: unknown, def: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : def;
}

function asStr(v: unknown, def: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : def;
}

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" ? true : v === "false" ? false : def;
  return def;
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (!cmd) usage();

  const mcpUrl = asStr(flags.mcp, "http://127.0.0.1:8090/mcp");

  if (cmd === "run") {
    const scenario = asStr(flags.scenario, "") as ScenarioName;
    if (!scenario) usage();

    const sessionKey = asStr(flags.agent_id, "agent_001");
    const durationSec = asInt(flags.duration_sec, 30);
    const fresh = asBool(flags.fresh, true);

    const res = await runScenario({
      mcpUrl,
      sessionKey,
      scenario,
      durationSec,
      fresh,
    });
    if (!res.ok) {
      console.error(`[run] failed: agent=${res.agentId ?? "?"} tick=${res.tick ?? 0} err=${res.error ?? "unknown"}`);
      process.exit(1);
    }
    console.log(`[run] ok: agent=${res.agentId} tick=${res.tick}`);
    process.exit(0);
  }

  if (cmd === "swarm") {
    const count = asInt(flags.count, 10);
    const durationSec = asInt(flags.duration_sec, 60);
    const scenario = asStr(flags.scenario, "smoke_roam") as ScenarioName;
    const prefix = asStr(flags.prefix, "agent_");

    const tasks = Array.from({ length: count }, (_, i) => {
      const id = `${prefix}${String(i + 1).padStart(3, "0")}`;
      return runScenario({
        mcpUrl,
        sessionKey: id,
        scenario,
        durationSec,
        fresh: true,
        timeoutSec: Math.max(30, durationSec + 30),
        log: () => {},
      }).then(
        (r) => ({ id, r }),
        (e) => ({ id, r: { ok: false, error: (e as Error).message } as any }),
      );
    });

    const results = await Promise.all(tasks);
    let ok = 0;
    const errors = new Map<string, number>();
    for (const it of results) {
      if (it.r.ok) {
        ok++;
      } else {
        const k = it.r.error ?? "unknown";
        errors.set(k, (errors.get(k) ?? 0) + 1);
      }
    }
    console.log(`[swarm] scenario=${scenario} count=${count} ok=${ok} fail=${count - ok}`);
    if (errors.size > 0) {
      for (const [k, n] of [...errors.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`[swarm] fail_reason n=${n} reason=${k}`);
      }
    }
    process.exit(ok === count ? 0 : 1);
  }

  usage();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
