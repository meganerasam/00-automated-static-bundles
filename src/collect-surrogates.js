// src/collect-surrogates.js — find the redirect/surrogate resources referenced by
// $redirect= / $redirect-rule= across the lists and copy their bodies from
// @adguard/scriptlets (dist/redirect-files/, mapped via getRedirectFilename).
//
// Returns { names, files: {filename: Buffer}, missing }.

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REDIRECT_RE = /\$(?:[^,\s]*,)*redirect(?:-rule)?=([a-z0-9_.-]+)/i;

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

export async function collectSurrogates(lists) {
  const names = new Set();
  for (const list of lists) {
    for (const line of list.lines) {
      if (!line.includes('redirect')) continue;
      const m = REDIRECT_RE.exec(line);
      if (m) names.add(m[1].toLowerCase());
    }
  }
  const wanted = [...names].sort();

  const red = await import('@adguard/scriptlets/redirects').catch(() => null);
  let filesDir = null;
  try {
    // ESM resolver (the package's exports map hides ./package.json from require.resolve).
    const url = import.meta.resolve('@adguard/scriptlets/redirects');
    filesDir = path.join(path.dirname(fileURLToPath(url)), '..', 'redirect-files');
  } catch { /* leave null */ }

  const files = {};
  const missing = [];
  for (const name of wanted) {
    if (!filesDir) { missing.push(name); continue; }
    // getRedirectFilename maps most names; fall back to <name> / <name>.js on disk.
    let filename = null;
    try { filename = red?.getRedirectFilename?.(name) ?? null; } catch { /* ignore */ }
    const candidates = [filename, name, `${name}.js`].filter(Boolean);
    let done = false;
    for (const cand of candidates) {
      const p = path.join(filesDir, cand);
      if (await exists(p)) { files[cand] = await readFile(p); done = true; break; } // Buffer (some binary)
    }
    if (!done) missing.push(name);
  }

  return { names: wanted, files, missing };
}
