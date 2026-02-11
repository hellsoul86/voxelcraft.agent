# voxelcraft.agent

Local, non-LLM agent runner used to validate and load-test `voxelcraft.ai` through the MCP sidecar (`cmd/mcp`).

This intentionally mirrors an OpenClaw-style "cron calls tools over HTTP" integration:

- Agent talks to **MCP** only: `POST /mcp` (JSON-RPC 2.0)
- MCP sidecar holds the **WS** connection to `voxelcraft.ai` and caches the latest `OBS`

## Prereqs

- Node 24+
- `pnpm`
- Go 1.22+ (only for `pnpm run e2e`, which spawns `voxelcraft.ai`)

## Install

```bash
cd /home/vscode/projects/voxelcraft.agent
pnpm install
pnpm test
```

## Run (manual, assumes server+sidecar already running)

Default MCP endpoint: `http://127.0.0.1:8090/mcp`

```bash
pnpm run run -- --scenario smoke_roam --agent_id agent_001
pnpm run run -- --scenario workshop_pad --agent_id agent_002
pnpm run run -- --scenario mine_gather --agent_id agent_003
pnpm run run -- --scenario memory_kv --agent_id agent_004
pnpm run run -- --scenario board_post_search --agent_id agent_005
```

## Swarm (load)

```bash
pnpm run swarm -- --count 50 --duration_sec 60 --scenario smoke_roam
```

## E2E (auto-spawn voxelcraft.ai server + MCP sidecar)

```bash
pnpm run e2e -- --scenario workshop_pad
```

## E2E Swarm (auto-spawn + load)

```bash
pnpm run e2e:swarm -- --count 50 --duration_sec 60 --scenario smoke_roam
```
