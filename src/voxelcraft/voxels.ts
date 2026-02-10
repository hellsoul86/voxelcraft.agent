import type { Vec3, VoxelsObs, VoxelDeltaOp } from "./obs_types.js";
import { decodeRLE } from "./rle.js";

export class VoxelCubeTracker {
  private radius = 0;
  private size = 0;
  private blocks: Uint16Array | null = null;
  private center: Vec3 = [0, 0, 0];

  reset(): void {
    this.radius = 0;
    this.size = 0;
    this.blocks = null;
    this.center = [0, 0, 0];
  }

  update(vox: VoxelsObs): void {
    const r = vox.radius | 0;
    const s = 2 * r + 1;
    const expectedLen = s * s * s;

    if (vox.encoding === "RLE") {
      if (!vox.data) throw new Error("voxels: missing data for RLE");
      const cube = decodeRLE(vox.data, expectedLen);
      this.radius = r;
      this.size = s;
      this.blocks = cube;
      this.center = vox.center;
      return;
    }

    if (vox.encoding === "DELTA") {
      if (!this.blocks) throw new Error("voxels: DELTA without baseline cube");
      if (this.radius !== r || this.size !== s) throw new Error("voxels: DELTA radius mismatch");
      const ops: VoxelDeltaOp[] = vox.ops ?? [];
      for (const op of ops) {
        const [dx, dy, dz] = op.d;
        const idx = this.index(dx, dy, dz);
        this.blocks[idx] = op.b & 0xffff;
      }
      this.center = vox.center;
      return;
    }

    // Exhaustive guard if protocol changes.
    throw new Error(`voxels: unknown encoding ${(vox as any).encoding}`);
  }

  getCenter(): Vec3 {
    return this.center;
  }

  getRadius(): number {
    return this.radius;
  }

  hasCube(): boolean {
    return !!this.blocks;
  }

  getBlockAtOffset(dx: number, dy: number, dz: number): number | null {
    if (!this.blocks) return null;
    if (Math.abs(dx) > this.radius || Math.abs(dy) > this.radius || Math.abs(dz) > this.radius) return null;
    return this.blocks[this.index(dx, dy, dz)]!;
  }

  getBlockAtWorld(pos: Vec3): number | null {
    const [cx, cy, cz] = this.center;
    const dx = pos[0] - cx;
    const dy = pos[1] - cy;
    const dz = pos[2] - cz;
    return this.getBlockAtOffset(dx, dy, dz);
  }

  // Estimate the "surface y" at a given (dx,dz) within the current cube,
  // matching the server logic: an AIR cell with a non-AIR block directly below.
  estimateSurfaceY(dx: number, dz: number, airBlockID: number): number | null {
    if (!this.blocks) return null;
    const r = this.radius;
    const [cx, cy, cz] = this.center;
    if (Math.abs(dx) > r || Math.abs(dz) > r) return null;

    for (let dy = r; dy >= -r + 1; dy--) {
      const here = this.getBlockAtOffset(dx, dy, dz);
      const below = this.getBlockAtOffset(dx, dy - 1, dz);
      if (here === null || below === null) continue;
      if (here === airBlockID && below !== airBlockID) {
        return cy + dy;
      }
    }
    return null;
  }

  private index(dx: number, dy: number, dz: number): number {
    const r = this.radius;
    const s = this.size;
    // Scan order is dy outer, dz middle, dx inner (x fastest),
    // so the flattened index matches the server's curr[] layout.
    return (dy + r) * s * s + (dz + r) * s + (dx + r);
  }
}

