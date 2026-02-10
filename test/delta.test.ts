import test from "node:test";
import assert from "node:assert/strict";

import { VoxelCubeTracker } from "../src/voxelcraft/voxels.js";

test("DELTA ops apply at expected flattened indices (dy,dz,dx scan order)", () => {
  const tracker = new VoxelCubeTracker();

  // radius=1 => 3^3=27 zeros encoded as (0,27) uvarints => bytes [0x00,0x1b] => base64 "ABs="
  tracker.update({ center: [0, 0, 0], radius: 1, encoding: "RLE", data: "ABs=" });

  tracker.update({
    center: [0, 0, 0],
    radius: 1,
    encoding: "DELTA",
    ops: [
      { d: [0, 0, 0], b: 5 },
      { d: [1, -1, 0], b: 9 },
    ],
  });

  assert.equal(tracker.getBlockAtOffset(0, 0, 0), 5);
  assert.equal(tracker.getBlockAtOffset(1, -1, 0), 9);
});

