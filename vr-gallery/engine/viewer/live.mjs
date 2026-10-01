// Live pieces: a work on the wall that's running, not a picture of one.
//
// A piece is an ES module next to the gallery file:
//
//   export const meta = { name, version, steps, stepsPerFrame, hold };
//   export const params = { …defaults };            // gallery.yaml's params override these
//   export function create({ THREE, renderer, hash, rand, params }) {
//     return { texture, aspect, traits?, step(), render(), dispose() };
//   }
//
// step() advances the piece's own clock by one tick; render() draws its current state into
// `texture`. The runner owns time and counts ticks, so the piece never reads a wall clock, and
// never Math.random() — only rand(), seeded from `hash` (src/seed.mjs). That makes every
// frame addressable: a MOMENT is { hash, step }, and replaying a hash to a step reproduces it.
// `traits` is what the hash decided (palette, variant…): where a piece's rarity lives.
// Catching a moment is what a click (or a trigger pull) on a live work does; minting will
// record exactly that.
import * as THREE from "three";
import { prng, seedHash, randomHash } from "../src/seed.mjs";

const DEFAULT_META = { steps: 1000, stepsPerFrame: 4, hold: 6 };

// Offscreen passes must not be rendered through the XR camera, or they'd draw from the
// headset's eyes; switch XR off for the duration (three's own Reflector does the same).
function offscreen(renderer, fn) {
  const xr = renderer.xr.enabled, target = renderer.getRenderTarget();
  renderer.xr.enabled = false;
  try { fn(); } finally { renderer.xr.enabled = xr; renderer.setRenderTarget(target); }
}

// source: where iterations come from when they aren't local — the chain's broadcast
// (viewer/chain.mjs). next() resolves to { hash, epoch } for the iteration to show.
export async function liveRunner({ media, renderer, onChange, source }) {
  const mod = await import(media.src);
  const meta = { ...DEFAULT_META, ...(mod.meta || {}) };
  const params = { ...(mod.params || {}), ...media.params };
  const fixed = media.seed === "random" || media.seed === "chain" ? null : seedHash(media.seed);
  let piece = null, hash = null, epoch = null, step = 0, held = 0, frozen = false, waiting = false;

  const start = (h, e = null) => {
    piece?.dispose();
    hash = h;
    epoch = e;
    step = 0;
    held = 0;
    piece = mod.create({ THREE, renderer, hash, rand: prng(hash), params });
    offscreen(renderer, () => piece.render());
    onChange?.(run);
  };
  const advance = (n) => {
    if (n <= 0) return;
    offscreen(renderer, () => { for (let i = 0; i < n; i++) piece.step(); piece.render(); });
    step += n;
  };

  const run = {
    meta, params,
    get hash() { return hash; },
    get epoch() { return epoch; },
    get step() { return step; },
    get frozen() { return frozen; },
    get texture() { return piece.texture; },
    get aspect() { return piece.aspect ?? 1; },
    // visible: whether anyone could be looking. Off-screen works don't burn the GPU.
    update(dt, visible) {
      if (frozen || !visible) return;
      if (step < meta.steps) return advance(Math.min(meta.stepsPerFrame, meta.steps - step));
      if (!media.loop) return;
      held += dt;
      if (held <= meta.hold) return;
      if (!source) return start(fixed ?? randomHash()); // a new iteration
      if (waiting) return;
      waiting = true; // the broadcast's next iteration may be a few seconds off
      source.next().then(({ hash: h, epoch: e }) => { waiting = false; if (!frozen) start(h, e); });
    },
    // Jump to a moment: replay the hash up to the step, then hold there.
    seek(h, s, e = null) {
      start(h, e);
      advance(Math.min(Math.max(0, s | 0), meta.steps));
      frozen = true;
      onChange?.(run);
    },
    freeze() { frozen = true; onChange?.(run); },
    resume() { frozen = false; onChange?.(run); },
    // Everything needed to reproduce this frame — and what a mint will record.
    moment() {
      const m = { piece: meta.name ?? null, version: meta.version ?? null, module: media.src, hash, step, traits: piece.traits ?? null, params };
      if (media.seed === "chain") m.onchain = { piece: media.piece, epoch: epoch === null ? null : Number(epoch) };
      return m;
    },
    dispose() { piece?.dispose(); },
  };

  if (source) { const it = await source.next(); start(it.hash, it.epoch); }
  else start(fixed ?? randomHash());
  return run;
}
