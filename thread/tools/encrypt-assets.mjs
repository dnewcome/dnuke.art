#!/usr/bin/env node
// Encrypt the visualizer's model files with a passphrase (AES-256-GCM, PBKDF2-SHA256).
// The page derives the same key in the browser and decrypts in memory.
//   node thread/tools/encrypt-assets.mjs "<passphrase>" [dir]
// Reads <dir>/leds.f32 and <dir>/thread-structure.glb, writes <name>.enc, deletes the plain files.
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [pass, dir = 'thread'] = process.argv.slice(2);
if (!pass) { console.error('usage: encrypt-assets.mjs "<passphrase>" [dir]'); process.exit(1); }
const ITER = 200000;
async function key(salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
}
for (const name of ['leds.f32', 'thread-structure.glb']) {
  const src = join(dir, name);
  if (!existsSync(src)) { console.log(`skip ${name} (not found)`); continue; }
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(salt), readFileSync(src)));
  const out = new Uint8Array(4 + 16 + 12 + ct.length);
  out.set(new TextEncoder().encode('THR1'), 0); out.set(salt, 4); out.set(iv, 20); out.set(ct, 32);
  writeFileSync(src + '.enc', out); unlinkSync(src);
  console.log(`${name} -> ${name}.enc (${out.length} bytes)`);
}
