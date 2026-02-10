function readUVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  // Compatible with Go's binary.Uvarint for the small values we use (uint16 + run lengths).
  let x = 0n;
  let s = 0n;
  let i = offset;
  for (; i < buf.length; i++) {
    const b = BigInt(buf[i]!);
    if (b < 0x80n) {
      x |= b << s;
      const v = Number(x);
      if (!Number.isSafeInteger(v)) throw new Error("uvarint overflow");
      return { value: v, next: i + 1 };
    }
    x |= (b & 0x7fn) << s;
    s += 7n;
    if (s > 63n) throw new Error("uvarint overflow");
  }
  throw new Error("truncated uvarint");
}

export function decodeRLE(b64: string, expectedLen: number): Uint16Array {
  const raw = Buffer.from(b64, "base64");
  const out = new Uint16Array(expectedLen);
  let i = 0;
  let o = 0;
  while (i < raw.length) {
    const b = readUVarint(raw, i);
    i = b.next;
    const run = readUVarint(raw, i);
    i = run.next;
    const blockID = b.value;
    const runLen = run.value;
    if (blockID < 0 || blockID > 0xffff) throw new Error(`block id too large: ${blockID}`);
    if (runLen <= 0) throw new Error(`bad run len: ${runLen}`);
    if (o + runLen > expectedLen) throw new Error(`rle overrun: need ${o + runLen} > ${expectedLen}`);
    out.fill(blockID, o, o + runLen);
    o += runLen;
  }
  if (o !== expectedLen) throw new Error(`rle underrun: got ${o} want ${expectedLen}`);
  return out;
}

