// A tiny dependency-free YAML *subset* parser — enough for gallery files, no more.
// Lifted from pixeldestrukt/voxeled (src/yaml.mjs), plus block scalars for story text.
//
// Supported: block mappings (`key: value`), block sequences (`- item`, incl. `- key: value`
// mapping items), inline flow collections (`[a, b]`, `{k: v}`), `#` comments, typed scalars
// (int, float, true/false, null/~, 'single'/"double" quoted, or bare strings), and block
// scalars — `key: |` keeps newlines, `key: >` folds them (blank line = paragraph break); a
// `-` chomping suffix is accepted and trailing newlines are always stripped. Indentation is
// spaces-only and sets nesting. This is intentionally NOT full YAML — if a gallery ever needs
// more, swap this module for `js-yaml`; the rest of the code only calls parseYAML().

function unquote(s) {
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) return line.slice(0, i);
  }
  return line;
}

// Split "key: value" at the first top-level ":" followed by space/EOL. { key:null } if none.
function splitKey(content) {
  let depth = 0, q = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === ":" && depth === 0 && (i === content.length - 1 || content[i + 1] === " "))
      return { key: unquote(content.slice(0, i).trim()), rest: content.slice(i + 1).trim() };
  }
  return { key: null, rest: content };
}

// Split a flow body on top-level commas (respecting nested brackets and quotes).
function splitFlow(inner) {
  const parts = [];
  let depth = 0, q = null, buf = "";
  for (const ch of inner) {
    if (q) { buf += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
    if (ch === "[" || ch === "{") { depth++; buf += ch; continue; }
    if (ch === "]" || ch === "}") { depth--; buf += ch; continue; }
    if (ch === "," && depth === 0) { parts.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim() !== "") parts.push(buf.trim());
  return parts;
}

// Block scalars are lifted out before line parsing (their text must keep blank lines and `#`)
// and stand in the line stream as a sentinel that parseScalar swaps back.
const BLOCK = "\u0000block:";
let blocks = [];

function parseScalar(s) {
  if (s.startsWith(BLOCK)) return blocks[+s.slice(BLOCK.length)];
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return unquote(s);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/[.eE]/.test(s) && /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
  return s;
}

function parseValue(s) {
  s = s.trim();
  if (s.startsWith("[")) return splitFlow(s.slice(1, -1)).map(parseValue);
  if (s.startsWith("{")) {
    const obj = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const { key, rest } = splitKey(part);
      if (key !== null) obj[key] = parseValue(rest);
    }
    return obj;
  }
  return parseScalar(s);
}

const isMapEntry = (s) => !s.startsWith("[") && !s.startsWith("{") && splitKey(s).key !== null;

function blockText(raw, fold) {
  while (raw.length && raw[raw.length - 1].trim() === "") raw.pop();
  const cut = Math.min(...raw.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
  const body = raw.map((l) => (l.trim() === "" ? "" : l.slice(cut).trimEnd()));
  if (!fold) return body.join("\n");
  return body.join("\n").split(/\n{2,}/).map((p) => p.replace(/\n/g, " ")).join("\n\n");
}

export function parseYAML(text) {
  const lines = [];
  blocks = [];
  const raws = String(text).split(/\r?\n/);
  for (let i = 0; i < raws.length; i++) {
    let nc = stripComment(raws[i]);
    if (nc.trim() === "") continue;
    const indent = nc.length - nc.trimStart().length;
    const m = nc.match(/:\s+([|>])-?\s*$/);
    if (m) {
      const body = [];
      while (i + 1 < raws.length && (raws[i + 1].trim() === "" || raws[i + 1].length - raws[i + 1].trimStart().length > indent)) body.push(raws[++i]);
      blocks.push(blockText(body, m[1] === ">"));
      nc = nc.slice(0, m.index + 1) + " " + BLOCK + (blocks.length - 1);
    }
    lines.push({ indent, content: nc.trim() });
  }
  let pos = 0;
  const peek = () => (pos < lines.length ? lines[pos] : null);
  const isSeqLine = (l) => l.content === "-" || l.content.startsWith("- ");

  function parseNode(parentIndent) {
    const first = peek();
    if (!first || first.indent <= parentIndent) return null;
    return isSeqLine(first) ? parseSeq(first.indent) : parseMap(first.indent);
  }

  function parseMap(indent) {
    const obj = {};
    for (let l = peek(); l && l.indent === indent && !isSeqLine(l); l = peek()) {
      const { key, rest } = splitKey(l.content);
      pos++;
      obj[key] = rest === "" ? parseNode(indent) : parseValue(rest);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    for (let l = peek(); l && l.indent === indent && isSeqLine(l); l = peek()) {
      const after = l.content === "-" ? "" : l.content.slice(2).trim();
      pos++;
      if (after === "") {
        arr.push(parseNode(indent));
      } else if (isMapEntry(after)) {
        const itemIndent = indent + 2; // key column after "- "
        const obj = {};
        const { key, rest } = splitKey(after);
        obj[key] = rest === "" ? parseNode(itemIndent) : parseValue(rest);
        for (let l2 = peek(); l2 && l2.indent === itemIndent && !isSeqLine(l2); l2 = peek()) {
          const { key: k2, rest: r2 } = splitKey(l2.content);
          pos++;
          obj[k2] = r2 === "" ? parseNode(itemIndent) : parseValue(r2);
        }
        arr.push(obj);
      } else {
        arr.push(parseValue(after));
      }
    }
    return arr;
  }

  return parseNode(-1) ?? {};
}
