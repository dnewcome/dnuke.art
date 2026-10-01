// The gallery model: a parsed gallery.yaml in, a fully placed room out. Pure data — no three.js,
// no DOM — so the same hang runs in the viewer and in node tests.
//
// Frame: metres, floor at y = 0, room centred on the origin. The four walls are named by
// compass: north is -z (what you face from the default spawn), east +x, south +z, west -x.
// `at` on a wall is metres from that wall's centre, + to the RIGHT as you stand facing it.
//
//   room:     { size: [width, depth, height], wall, floor, ceiling, spawn: { at: [x, z], look } }
//   exhibits: - id, title, year, medium, artist
//               media: { image: path }             (relative to the gallery file)
//                   or { live: { module, seed, params, loop } }   a running piece — see viewer/live.mjs
//                      seed: chain + piece: <id> — iterations broadcast from the Moments contract
//   chain:    { rpc, contract, chainId, explorer }   (only needed for seed: chain)
//               wall, at, y, width                  (all optional — omit wall to auto-hang)
//               story: { text, process: { tool, source, seed, params, … } }
//               links: { buy, more, … }
//               provenance: { … }                   (reserved: token / contract / chain — shown, never acted on)

export const WALLS = {
  // normal: into the room. right: +along the wall as you face it. rotY: turns a +z-facing plane to face the room.
  north: { normal: [0, 0, 1], right: [1, 0, 0], rotY: 0 },
  east: { normal: [-1, 0, 0], right: [0, 0, 1], rotY: -Math.PI / 2 },
  south: { normal: [0, 0, -1], right: [-1, 0, 0], rotY: Math.PI },
  west: { normal: [1, 0, 0], right: [0, 0, -1], rotY: Math.PI / 2 },
};
const HANG_ORDER = ["north", "east", "south", "west"]; // a clockwise walk from the spawn
export const MEDIA_TYPES = ["image", "live"]; // next: video, model (glb), voxeled

const DEFAULTS = {
  room: { size: [9, 7, 3.4], wall: "#efece6", floor: "#57524d", ceiling: "#f7f6f3" },
  exhibit: { width: 1.0, y: 1.5 }, // 1.5 m: centre of the work at a standing eye line
  hang: { gap: 0.9, margin: 0.7 }, // between works, and from each corner
};

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// A live piece: its module, and how it's seeded. seed: "random" (the default) is a fresh hash
// every run — a new iteration each time; "chain" takes each iteration from the Moments contract
// (so every viewer sees the same one, and a caught moment can be minted); a number, string or
// 0x hash pins it to one.
function liveMedia(m, base, id, warnings, chain) {
  const spec = typeof m === "string" ? { module: m } : m || {};
  if (!spec.module) { warnings.push(`${id}: live media needs a module`); return null; }
  const seed = spec.seed ?? "random";
  if (seed === "chain" && (!chain || !Number.isInteger(spec.piece))) {
    warnings.push(`${id}: seed: chain needs a top-level chain: { rpc, contract } and a piece id — using random`);
    return liveMedia({ ...spec, seed: undefined }, base, id, warnings, chain);
  }
  return {
    type: "live",
    src: resolve(spec.module, base),
    seed,
    piece: seed === "chain" ? spec.piece : null,
    params: spec.params || {},
    loop: spec.loop ?? (spec.seed === undefined || seed === "chain"), // iterations roll on; a pinned seed holds its last frame
  };
}

function chainConfig(c, warnings) {
  if (!c) return null;
  if (typeof c.rpc !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.contract || "")) {
    warnings.push("chain: needs rpc (a URL) and contract (a 0x address) — ignored");
    return null;
  }
  return { rpc: c.rpc, contract: c.contract, chainId: c.chainId ?? null, explorer: c.explorer ?? null };
}
const resolve = (src, base) => (base ? new URL(src, base).href : src);

// Wall length along its own `right` axis.
export function wallLength(wall, [w, d]) {
  return wall === "north" || wall === "south" ? w : d;
}

// World position of a point `at` metres along `wall`, at height y, `off` metres out from the surface.
export function wallPoint(wall, at, y, [w, d], off = 0) {
  const W = WALLS[wall];
  const cx = W.normal[0] ? -W.normal[0] * (w / 2) : 0;
  const cz = W.normal[2] ? -W.normal[2] * (d / 2) : 0;
  return [cx + W.right[0] * at + W.normal[0] * off, y, cz + W.right[2] * at + W.normal[2] * off];
}

// Auto-hang: fill walls in walking order, as many works per wall as fit, each wall's run centred.
function autoHang(items, size, hang) {
  const runs = Object.fromEntries(HANG_ORDER.map((k) => [k, []]));
  let wi = 0, used = 0;
  for (const ex of items) {
    for (;;) {
      if (wi >= HANG_ORDER.length) return { overflow: items.slice(items.indexOf(ex)) };
      const usable = wallLength(HANG_ORDER[wi], size) - 2 * hang.margin;
      const need = (used ? hang.gap : 0) + ex.width;
      if (used + need <= usable || used === 0) { runs[HANG_ORDER[wi]].push(ex); used += need; break; }
      wi++; used = 0;
    }
  }
  for (const [wall, run] of Object.entries(runs)) {
    const total = run.reduce((s, e) => s + e.width, 0) + hang.gap * Math.max(0, run.length - 1);
    let x = -total / 2;
    for (const ex of run) { ex.wall = wall; ex.at = x + ex.width / 2; x += ex.width + hang.gap; }
  }
  return { overflow: [] };
}

// spec: the parsed YAML. base: URL of the gallery file (media paths resolve against it).
// Returns { title, artist, room, exhibits, warnings } — warnings are for the author, never thrown.
export function normalize(spec, base) {
  spec = spec || {};
  const warnings = [];
  const r = spec.room || {};
  const size = Array.isArray(r.size) && r.size.length === 3 && r.size.every((v) => v > 0) ? r.size : DEFAULTS.room.size;
  if (r.size && size !== r.size) warnings.push("room.size must be [width, depth, height] in metres — using the default");
  const [w, d, h] = size;
  const sp = r.spawn || {};
  const room = {
    size,
    wall: r.wall || DEFAULTS.room.wall,
    floor: r.floor || DEFAULTS.room.floor,
    ceiling: r.ceiling || DEFAULTS.room.ceiling,
    spawn: {
      at: Array.isArray(sp.at) ? sp.at : [0, d / 2 - Math.min(1.2, d / 3)],
      look: sp.look ?? "north",
    },
  };
  const hang = { ...DEFAULTS.hang, ...(spec.hang || {}) };

  const chain = chainConfig(spec.chain, warnings);
  const seen = new Set();
  const exhibits = [];
  for (const [i, e] of (spec.exhibits || []).entries()) {
    const id = String(e.id ?? `exhibit-${i + 1}`);
    if (seen.has(id)) warnings.push(`duplicate exhibit id "${id}"`);
    seen.add(id);
    const media = e.media || {};
    const type = MEDIA_TYPES.find((t) => media[t]);
    if (!type) { warnings.push(`${id}: no supported media (${MEDIA_TYPES.join(", ")}) — skipped`); continue; }
    const m = type === "live" ? liveMedia(media.live, base, id, warnings, chain) : { type, src: resolve(media[type], base) };
    if (!m) continue;
    if (e.wall && !WALLS[e.wall]) warnings.push(`${id}: unknown wall "${e.wall}" — auto-hanging instead`);
    exhibits.push({
      id,
      title: e.title ?? id,
      year: e.year ?? null,
      medium: e.medium ?? null,
      artist: e.artist ?? spec.artist ?? null,
      media: m,
      wall: WALLS[e.wall] ? e.wall : null,
      at: num(e.at, null),
      y: num(e.y, DEFAULTS.exhibit.y),
      width: num(e.width, DEFAULTS.exhibit.width),
      story: e.story || {},
      links: e.links || {},
      provenance: e.provenance || null,
    });
  }

  // Placed on a wall but no `at`: spread along that wall. No wall at all: auto-hang.
  for (const wall of Object.keys(WALLS)) {
    const run = exhibits.filter((e) => e.wall === wall && e.at === null);
    run.forEach((e, k) => { e.at = (k - (run.length - 1) / 2) * (wallLength(wall, size) / Math.max(run.length, 1)); });
  }
  const { overflow } = autoHang(exhibits.filter((e) => !e.wall), size, hang);
  for (const e of overflow) warnings.push(`${e.id}: no wall space left — make the room bigger or hang it explicitly`);

  for (const e of exhibits) {
    if (!e.wall) continue;
    const half = wallLength(e.wall, size) / 2;
    if (Math.abs(e.at) + e.width / 2 > half) warnings.push(`${e.id}: runs past the end of the ${e.wall} wall`);
    if (e.y > h) warnings.push(`${e.id}: hung above the ceiling`);
    e.position = wallPoint(e.wall, e.at, e.y, size);
    e.rotY = WALLS[e.wall].rotY;
    e.normal = WALLS[e.wall].normal;
  }
  return {
    name: spec.name ?? null,
    title: spec.title ?? spec.name ?? "Untitled gallery",
    artist: spec.artist ?? null,
    about: spec.about ?? null,
    chain,
    room,
    exhibits: exhibits.filter((e) => e.wall),
    warnings,
  };
}

// Where to stand to look at a work: out along the wall normal, far enough to take it in,
// never past the middle of the room. Returns [x, z].
export function viewpoint(ex, size, height = ex.width) {
  const across = ex.wall === "north" || ex.wall === "south" ? size[1] : size[0];
  const dist = Math.min(Math.max(1.6 * Math.max(ex.width, height), 1.3), across / 2);
  const p = wallPoint(ex.wall, ex.at, 0, size, dist);
  return [p[0], p[2]];
}
