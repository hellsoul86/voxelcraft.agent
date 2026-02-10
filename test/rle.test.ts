import test from "node:test";
import assert from "node:assert/strict";

import { decodeRLE } from "../src/voxelcraft/rle.js";

test("RLE decode matches expected sequence (Go encoding compatible)", () => {
  // Pairs: (1,3),(2,2),(3,1),(7,50),(9,1),(10,3)
  const b64 = "AQMCAgMBBzIJAQoD";
  const out = decodeRLE(b64, 60);
  const got = Array.from(out);

  const expected: number[] = [];
  expected.push(1, 1, 1);
  expected.push(2, 2);
  expected.push(3);
  for (let i = 0; i < 50; i++) expected.push(7);
  expected.push(9);
  expected.push(10, 10, 10);

  assert.equal(got.length, expected.length);
  assert.deepEqual(got, expected);
});

