// A work's story, in three forms: the small wall label (canvas), the HTML side panel on a
// screen, and a floating canvas panel inside the headset. All three read the same exhibit
// fields — title / year / medium / story.text / story.process / links / provenance — so what
// the YAML says is what every visitor gets, whatever they're looking through.
import * as THREE from "three";
import { qrEncode, qrToSVG } from "../src/qr.mjs";

// A QR code for a link, or null if it's too long for the encoder (181 bytes).
const qr = (url) => { try { return url ? qrEncode(url) : null; } catch { return null; } };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const show = (v) => (v !== null && typeof v === "object" ? (Array.isArray(v) ? `[${v.map(show).join(", ")}]` : JSON.stringify(v)) : String(v));
const meta = (ex) => [ex.year, ex.medium].filter((v) => v !== null && v !== undefined).join(" · ");
const paras = (t) => (t ? String(t).split(/\n{2,}/) : []);
const isURL = (v) => typeof v === "string" && /^https?:\/\//.test(v);

// Process entries in a stable order: the recipe first, then whatever else the artist wrote down.
function processRows(p = {}) {
  const first = ["tool", "source", "seed"].filter((k) => k in p);
  const rest = Object.keys(p).filter((k) => !first.includes(k) && k !== "params");
  return [...first, ...rest].map((k) => [k, p[k]]);
}

// ── HTML panel ────────────────────────────────────────────────────────────────
export function storyHTML(ex) {
  const s = ex.story || {}, p = s.process || {};
  const link = (v) => (isURL(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v.replace(/^https?:\/\//, ""))}</a>` : esc(show(v)));
  let html = `<h2>${esc(ex.title)}</h2>`;
  if (ex.artist) html += `<p class="by">${esc(ex.artist)}</p>`;
  if (meta(ex)) html += `<p class="meta">${esc(meta(ex))}</p>`;
  html += paras(s.text).map((t) => `<p>${esc(t)}</p>`).join("");
  const rows = processRows(p);
  if (rows.length || p.params) {
    html += `<h3>Process</h3><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${link(v)}</dd>`).join("")}</dl>`;
    if (p.params) html += `<table class="params">${Object.entries(p.params).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(show(v))}</td></tr>`).join("")}</table>`;
  }
  const links = Object.entries(ex.links || {});
  if (links.length) html += `<p class="links">${links.map(([k, v]) => `<a class="${k === "buy" ? "buy" : ""}" href="${esc(v)}" target="_blank" rel="noopener">${esc(k)}</a>`).join("")}</p>`;
  if (ex.provenance) html += `<h3>Provenance</h3><dl>${Object.entries(ex.provenance).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${link(v)}</dd>`).join("")}</dl>`;
  return html;
}

// A live work's current iteration. Running: which hash, how far along. Caught: the moment —
// exactly the record a mint would store, and a link that replays it.
// mintable: the moment came from the chain's broadcast, so it can be minted.
// handoff: the moment's link, shown as a QR code so a phone (with a wallet) can finish the mint.
export function liveHTML(run, { mintable = false, handoff = null } = {}) {
  const m = run.moment();
  let html = `<h3>${run.frozen ? "Caught" : "This iteration"}</h3><dl>`
    + `<dt>hash</dt><dd class="hash">${esc(m.hash)}</dd>`
    + (m.onchain ? `<dt>epoch</dt><dd>${m.onchain.epoch}</dd>` : "")
    + `<dt>step</dt><dd><span class="step">${m.step}</span> of ${run.meta.steps}</dd></dl>`;
  if (run.frozen) {
    html += `<p class="note">This frame is hash + step. Replay the hash to this step and you get it back, anywhere. ${mintable ? "Minting records exactly this:" : "This is what a mint would record:"}</p>`
      + `<pre class="moment">${esc(JSON.stringify(m, null, 2))}</pre>`;
  } else {
    html += m.onchain
      ? `<p class="note">This iteration's hash came from the chain, so everyone here is watching the same one. Click the work to catch the moment you're looking at.</p>`
      : `<p class="note">Every run is a new iteration from a fresh hash. Click the work to catch the moment you're looking at.</p>`;
  }
  html += `<p class="links">`
    + (run.frozen && mintable ? `<button data-live="mint">Mint this moment</button>` : "")
    + `<button data-live="${run.frozen ? "resume" : "catch"}">${run.frozen ? "Resume" : "Catch this moment"}</button>`
    + (run.frozen ? `<button data-live="copy">Copy link</button>` : "") + `</p>`
    + `<p class="note mint-status" aria-live="polite"></p>`;
  const code = mintable && qr(handoff);
  if (code) html += `<div class="handoff">${qrToSVG(code, { size: 132 })}<p class="note">No wallet here? Scan with your phone to open this moment there and mint it. It stays mintable for a few hours.</p></div>`;
  return html;
}

// ── canvas text ───────────────────────────────────────────────────────────────
function wrap(g, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const t = line ? line + " " + word : word;
      if (g.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

function canvasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// The wall label: 0.24 × 0.14 m, at 2000 px/m. Title and meta each wrap to two lines.
export function labelCanvas(ex) {
  const c = document.createElement("canvas");
  c.width = 480; c.height = 280;
  const g = c.getContext("2d");
  g.fillStyle = "#fbfaf7"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#161616";
  g.font = "600 38px system-ui, sans-serif";
  let y = 62;
  for (const l of wrap(g, ex.title, 420).slice(0, 2)) { g.fillText(l, 30, y); y += 44; }
  g.fillStyle = "#555";
  g.font = "26px system-ui, sans-serif";
  for (const l of wrap(g, meta(ex), 420).slice(0, 2)) { g.fillText(l, 30, y + 4); y += 32; }
  g.fillStyle = "#8a6d3b";
  g.font = "24px system-ui, sans-serif";
  g.fillText("select for the story →", 30, 256);
  return canvasTexture(c);
}

// The headset panel: 0.8 m wide, height to fit. Selecting it closes it.
// run: a live work's runner — the panel then says which moment you caught.
// handoff: a mintable moment's link — drawn as a QR code to scan with a phone.
export function storyPanel(ex, run, { handoff = null } = {}) {
  const W = 1024, pad = 64, maxW = W - 2 * pad;
  const c = document.createElement("canvas");
  c.width = W; c.height = 2400;
  const g = c.getContext("2d");
  const draw = (font, color, lines, lh, gap = 0) => { g.font = font; g.fillStyle = color; for (const l of lines) { g.fillText(l, pad, y); y += lh; } y += gap; };
  let y = pad + 40;
  g.fillStyle = "rgba(18,18,20,0.94)"; g.fillRect(0, 0, W, c.height);
  g.font = "600 54px system-ui, sans-serif";
  draw(g.font, "#fff", wrap(g, ex.title, maxW), 64, 6);
  if (meta(ex)) draw("32px system-ui, sans-serif", "#b9b2a6", [meta(ex)], 40, 24);
  g.font = "32px system-ui, sans-serif";
  for (const t of paras(ex.story?.text)) draw(g.font, "#e8e4dc", wrap(g, t, maxW), 44, 20);
  const p = ex.story?.process || {};
  const rows = [...processRows(p).map(([k, v]) => `${k}: ${show(v)}`), ...Object.entries(p.params || {}).map(([k, v]) => `  ${k} = ${show(v)}`)];
  if (rows.length) {
    y += 10;
    draw("600 30px system-ui, sans-serif", "#f2c14e", ["PROCESS"], 46);
    g.font = "28px ui-monospace, monospace";
    for (const r of rows) draw(g.font, "#d6d1c7", wrap(g, r, maxW), 38);
  }
  if (run) {
    const m = run.moment();
    y += 10;
    draw("600 30px system-ui, sans-serif", "#f2c14e", [run.frozen ? "CAUGHT" : "THIS ITERATION"], 46);
    g.font = "28px ui-monospace, monospace";
    draw(g.font, "#d6d1c7", [`step ${m.step} of ${run.meta.steps}`, m.hash.slice(0, 34), "  " + m.hash.slice(34)], 38);
  }
  const code = qr(handoff);
  if (code) {
    // a white tile with a quiet zone, big enough to scan from a phone held up to the headset view
    const cell = Math.floor(360 / (code.length + 8)), side = cell * (code.length + 8);
    y += 24;
    g.fillStyle = "#fff";
    g.fillRect(pad, y, side, side);
    g.fillStyle = "#000";
    code.forEach((row, r) => row.forEach((v, c) => v && g.fillRect(pad + (c + 4) * cell, y + (r + 4) * cell, cell, cell)));
    g.font = "600 30px system-ui, sans-serif"; g.fillStyle = "#f2c14e";
    g.fillText("MINT IT LATER", pad + side + 32, y + 50);
    g.font = "26px system-ui, sans-serif"; g.fillStyle = "#d6d1c7";
    // a phone can't scan a headset's screen, but it can scan a screenshot of it
    const lines = wrap(g, "Take a screenshot of this panel (Meta button + trigger). On your phone, the QR in it opens this moment so you can mint it there. It stays mintable for a few hours.", W - pad * 2 - side - 32);
    lines.forEach((l, i) => g.fillText(l, pad + side + 32, y + 96 + i * 36));
    y += side;
  }
  y += 30;
  draw("24px system-ui, sans-serif", "#77736b", [run?.frozen ? "select to close and let it run on" : "select to close"], 30);
  const H = Math.min(c.height, Math.ceil(y + pad / 2));
  const cropped = document.createElement("canvas");
  cropped.width = W; cropped.height = H;
  cropped.getContext("2d").drawImage(c, 0, 0);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, (0.8 * H) / W),
    new THREE.MeshBasicMaterial({ map: canvasTexture(cropped), transparent: true, toneMapped: false, depthTest: false }),
  );
  mesh.renderOrder = 10;
  return mesh;
}
