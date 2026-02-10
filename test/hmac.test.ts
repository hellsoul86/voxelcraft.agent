import test from "node:test";
import assert from "node:assert/strict";

import { canonicalString, signHmacHex } from "../src/mcp/hmac.js";

test("HMAC vector matches voxelcraft.ai", () => {
  const secret = "topsecret";
  const ts = "1700000000000";
  const method = "POST";
  const pathname = "/mcp";
  const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"list_tools\"}";

  const canon = canonicalString(ts, method, pathname, body);
  const got = signHmacHex(secret, canon);
  const want = "8d8937fdcea524a9301a74e8e2e4b3ee64ea5ae993f29219d57d0cd3d276613b";
  assert.equal(got, want);
});

