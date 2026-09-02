/**
 * 📐 EMBEDDING UTILITIES
 * Embeddings travel through SQLite as Float32 BLOBs; similarity in JS.
 */

export function packEmbedding(v: number[]): Buffer {
  const f32 = new Float32Array(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function unpackEmbedding(buf: Buffer): number[] {
  if (buf.byteLength % 4 !== 0) return [];
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
