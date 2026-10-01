// Seeds, hashes and the one PRNG every live piece gets.
//
// The convention is the generative-NFT one (Art Blocks' tokenData.hash, fxhash's fxhash):
// a work's identity is a 32-byte HASH, and every random decision the piece makes comes from a
// single PRNG seeded by it. Same hash + same code = same artwork, on any machine, forever.
// A piece must never call Math.random() — only ctx.rand().
//
// Today the hash comes from a pinned seed in gallery.yaml or a fresh random one per run. When
// minting lands, it comes from the contract, and nothing about the piece changes.

export const isHash = (s) => typeof s === "string" && /^0x[0-9a-f]{64}$/i.test(s);

// sfc32 — small, fast, 128-bit state, and what most on-chain generative art uses.
export function sfc32(a, b, c, d) {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// The hash as eight 32-bit words.
const words = (hash) => Array.from({ length: 8 }, (_, i) => parseInt(hash.slice(2 + i * 8, 10 + i * 8), 16) >>> 0);

// rand() for a hash: sfc32 over all 256 bits (the two 128-bit halves XORed), warmed past the
// first outputs, which are weakly mixed for low-entropy states.
export function prng(hash) {
  if (!isHash(hash)) throw new Error(`not a 32-byte hash: ${hash}`);
  const w = words(hash);
  const rand = sfc32(w[0] ^ w[4], w[1] ^ w[5], w[2] ^ w[6], w[3] ^ w[7]);
  for (let i = 0; i < 16; i++) rand();
  return rand;
}

// A human seed (42, "spring-show") → a hash, deterministically. cyrb128-style string mixing,
// run twice with different salts for 256 bits. A 0x hash passes through unchanged.
export function seedHash(seed) {
  if (isHash(seed)) return seed.toLowerCase();
  const str = String(seed);
  const mix = (salt) => {
    let h1 = 1779033703 ^ salt, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1];
  };
  return "0x" + [...mix(0), ...mix(0x9e3779b9)].map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

// A fresh hash from the platform's CSPRNG — a new iteration nobody has seen before.
export function randomHash() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export const shortHash = (h) => (isHash(h) ? `${h.slice(0, 6)}…${h.slice(-4)}` : String(h));
