// Sync the work catalog from Curiate into this static site.
//
//   node scripts/sync-curiate.mjs            (re-run whenever the catalog on Curiate changes)
//
// Curiate is the source of truth: curiate.com/v1/users/<USER>/artworks (public, no auth). For
// each artwork this mirrors its images into works/<slug>/, writes works/<slug>/index.html, and
// writes works/catalog.json (vr-gallery can hang the same data). The front page's work list is
// regenerated between the <!-- curiate:start --> / <!-- curiate:end --> markers in index.html;
// everything outside them is left alone. No dependencies; Node 18+.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USER = process.env.CURIATE_USER || "dnuke";
const API = "https://curiate.com/v1";
const ORIGIN = "https://curiate.com";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKS = path.join(ROOT, "works");

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const abs = (u) => (u && u.startsWith("/") ? ORIGIN + u : u);
const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-") || "work";
// Curiate's dimensions are free text and use the typographic inch mark (”); normalise to ″.
const dims = (d) => (d ? d.replace(/\s*[”"]\s*$/, "″").replace(/\s*x\s*/gi, " × ") : null);

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Width/height from a JPEG or PNG header — enough to choose a landscape or portrait frame.
function imageSize(buf) {
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// Curiate serves photos as uploaded, so a JPEG may still carry an EXIF rotation. Browsers honour
// it when displaying, so swap width/height for orientations 5–8 to match what's seen.
function exifRotated(buf) {
  const i = buf.indexOf(Buffer.from("Exif\0\0"));
  if (i < 0) return false;
  const t = i + 6, le = buf.toString("ascii", t, t + 2) === "II";
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = t + u32(t + 4), n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) return u16(e + 8) >= 5;
  }
  return false;
}

function shape(size) {
  if (!size) return "landscape";
  const r = size.h / size.w;
  return r > 1.15 ? "portrait" : r > 0.87 ? "square" : "landscape";
}

const PAGE_CSS = `
    .work-hero { background: var(--surface); padding: calc(var(--header-h, 4rem) + 1rem) clamp(1rem, 4vw, 2.5rem) 2rem; display: flex; justify-content: center; }
    .work-hero img, .work-hero video { width: auto; height: auto; max-width: 100%; max-height: 82vh; object-fit: contain; }
    .about-piece { padding: var(--gap) clamp(1rem, 4vw, 2.5rem); display: grid; grid-template-columns: minmax(0, 52ch) 1fr; gap: clamp(2rem, 8vw, 6rem); }
    .about-piece h1 { font-size: clamp(2.2rem, 6vw, 4.5rem); font-weight: 300; letter-spacing: -0.03em; line-height: 1.05; margin-bottom: 1.2rem; }
    .about-piece p { font-size: clamp(1rem, 2vw, 1.2rem); line-height: 1.6; font-weight: 300; margin-bottom: 1.2em; }
    .specs { list-style: none; font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-muted); line-height: 2; }
    .specs span { color: var(--fg); }
    .specs a { border-bottom: 1px solid var(--fg-muted); text-transform: none; letter-spacing: 0; color: var(--fg); }
    .specs a:hover { border-color: var(--fg); }
    .pager { display: flex; justify-content: space-between; gap: 1rem; padding: 0 clamp(1rem, 4vw, 2.5rem) var(--gap); font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-muted); }
    .pager a:hover { color: var(--fg); }
    @media (max-width: 700px) { .about-piece { grid-template-columns: 1fr; } }`;

function workPage(w, prev, next) {
  const meta = [w.medium, w.year].filter(Boolean).join(" · ");
  const media = w.media.map((m) => m.type === "video"
    ? `<video src="${esc(m.file)}" controls playsinline muted loop></video>`
    : `<img src="${esc(m.file)}" alt="${esc(w.title)}${w.medium ? ", " + esc(w.medium) : ""}" width="${m.w || ""}" height="${m.h || ""}">`).join("\n      ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${esc(w.title)}${meta ? " — " + esc(meta) : ""}. dnuke.">
  <meta property="og:title" content="${esc(w.title)} — dnuke">
  <meta property="og:image" content="https://dnuke.art/works/${esc(w.slug)}/${esc(w.media[0]?.file || "")}">
  <title>${esc(w.title.toLowerCase())} — dnuke.art</title>
  <link rel="icon" type="image/svg+xml" href="../../favicon.svg">
  <link rel="stylesheet" href="../../css/style.css">
  <style>${PAGE_CSS}
  </style>
</head>
<body>

  <header>
    <a href="/" class="wordmark">dnuke</a>
    <nav>
      <a href="/#work">work</a>
      <a href="/about.html">about</a>
      <a href="mailto:hello@dnuke.art">contact</a>
    </nav>
  </header>

  <main>
    <section class="work-hero">
      ${media}
    </section>

    <section class="about-piece">
      <div>
        <h1>${esc(w.title)}</h1>
        ${w.statement ? w.statement.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("\n        ") : ""}
      </div>
      <ul class="specs">
        <li>${esc(w.catalog_number)}</li>
        ${w.year ? `<li><span>${esc(w.year)}</span></li>` : ""}
        ${w.medium ? `<li>${esc(w.medium)}</li>` : ""}
        ${w.dimensions ? `<li><span>${esc(w.dimensions)}</span></li>` : ""}
        ${w.series ? `<li>series <span>${esc(w.series)}</span></li>` : ""}
        ${w.sold ? `<li><span>sold</span></li>` : ""}
        <li>on <span><a href="${esc(w.curiate_url)}" target="_blank" rel="noopener">curiate</a></span></li>
      </ul>
    </section>

    <nav class="pager">
      ${prev ? `<a href="../${esc(prev.slug)}/">← ${esc(prev.title)}</a>` : "<span></span>"}
      ${next ? `<a href="../${esc(next.slug)}/">${esc(next.title)} →</a>` : "<span></span>"}
    </nav>
  </main>

  <footer>
    <span>&copy; 2026 dnuke</span>
  </footer>
</body>
</html>
`;
}

function frontPiece(w) {
  const m = w.media[0];
  const cls = ["piece", m?.shape === "portrait" ? "portrait" : m?.shape === "square" ? "square" : ""].filter(Boolean).join(" ");
  const media = m?.type === "video"
    ? `<video autoplay muted loop playsinline><source src="works/${esc(w.slug)}/${esc(m.file)}" type="video/mp4"></video>`
    : `<img src="works/${esc(w.slug)}/${esc(m?.file || "")}" alt="${esc(w.title)}" loading="lazy">`;
  return `      <article class="${cls}">
        <a href="works/${esc(w.slug)}/">
          <div class="media">
            ${media}
          </div>
          <div class="caption">
            <span class="title">${esc(w.title)}</span>
            <span class="meta">${esc([w.medium, w.year].filter(Boolean).join(" · ").toLowerCase())}${w.sold ? " · sold" : ""}</span>
          </div>
        </a>
      </article>`;
}

async function main() {
  const { artworks } = await json(`${API}/users/${USER}/artworks`);
  const { posts } = await json(`${API}/users/${USER}/posts?limit=50`);
  const byPost = new Map(posts.map((p) => [p.public_id, p]));
  const used = new Set();
  const works = [];

  for (const a of artworks) {
    const detail = (await json(`${API}/artworks/${a.public_id}`)).artwork || a;
    const ids = detail.post_public_ids?.length ? detail.post_public_ids : a.first_post_public_id ? [a.first_post_public_id] : [];
    let slug = slugify(a.title);
    while (used.has(slug)) slug += "-" + a.seq;
    used.add(slug);
    const dir = path.join(WORKS, slug);
    mkdirSync(dir, { recursive: true });

    const media = [];
    for (const id of ids) {
      const p = byPost.get(id) || (await json(`${API}/posts/${id}`).catch(() => null))?.post;
      if (!p?.media_url) continue;
      const type = (p.media_type || "").startsWith("video") ? "video" : "image";
      const src = abs(p.media_url);
      const file = path.basename(new URL(src).pathname);
      const res = await fetch(src);
      if (!res.ok) { console.warn(`  ! ${a.title}: ${res.status} ${src}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path.join(dir, file), buf);
      let size = type === "image" ? imageSize(buf) : null;
      if (size && exifRotated(buf)) size = { w: size.h, h: size.w };
      media.push({ type, file, w: size?.w ?? null, h: size?.h ?? null, shape: type === "video" ? "landscape" : shape(size), bytes: buf.length });
    }
    // drop files from earlier syncs that Curiate no longer lists
    for (const f of readdirSync(dir)) if (f !== "index.html" && !media.some((m) => m.file === f)) rmSync(path.join(dir, f));

    works.push({
      slug,
      public_id: a.public_id,
      catalog_number: a.catalog_number,
      title: a.title,
      year: a.year ?? null,
      medium: a.medium ?? null,
      dimensions: dims(a.dimensions),
      statement: a.statement?.trim() || null,
      series: a.series_name ?? null,
      sold: !!a.is_sold,
      curiate_url: ids[0] ? `${ORIGIN}/app/post/${ids[0]}` : `${ORIGIN}/app/profile/${USER}/catalogue`,
      media,
    });
    console.log(`  ✓ ${a.catalog_number.padEnd(8)} ${a.title}  (${media.map((m) => `${m.type} ${m.w}×${m.h} ${m.shape} ${(m.bytes / 1024) | 0} KB`).join(", ") || "no media"})`);
  }

  works.forEach((w, i) => writeFileSync(path.join(WORKS, w.slug, "index.html"), workPage(w, works[i - 1], works[i + 1])));
  // remove pages for works that left the catalog
  for (const d of readdirSync(WORKS, { withFileTypes: true })) if (d.isDirectory() && !works.some((w) => w.slug === d.name)) rmSync(path.join(WORKS, d.name), { recursive: true });
  writeFileSync(path.join(WORKS, "catalog.json"), JSON.stringify({ source: `${ORIGIN}/app/profile/${USER}/catalogue`, synced: new Date().toISOString(), works }, null, 2) + "\n");

  const indexPath = path.join(ROOT, "index.html");
  const html = readFileSync(indexPath, "utf8");
  const start = "<!-- curiate:start -->", end = "<!-- curiate:end -->";
  if (!html.includes(start) || !html.includes(end)) throw new Error(`index.html needs ${start} … ${end} markers around the work list`);
  const block = `${start}\n      <!-- generated by scripts/sync-curiate.mjs from curiate.com/${USER}; edits here are overwritten -->\n${works.map(frontPiece).join("\n\n")}\n      ${end}`;
  writeFileSync(indexPath, html.slice(0, html.indexOf(start)) + block + html.slice(html.indexOf(end) + end.length));
  console.log(`✓ ${works.length} works → works/, works/catalog.json, index.html`);
}

if (!existsSync(path.join(ROOT, "index.html"))) throw new Error("run from the dnuke.art repo");
main().catch((e) => { console.error(e); process.exit(1); });
