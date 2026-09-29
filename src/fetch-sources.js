// src/fetch-sources.js — download the pinned uAssets filter lists.
// Native fetch (Node 18+). Cached on disk under .cache/ so re-runs are cheap.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CACHE_DIR = '.cache';

async function cachedFetch(url, key) {
  const cacheFile = path.join(CACHE_DIR, key);
  if (existsSync(cacheFile)) {
    return readFile(cacheFile, 'utf8');
  }
  const res = await fetch(url, { headers: { 'user-agent': 'automated-static-bundle' } });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const text = await res.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, text, 'utf8');
  return text;
}

async function resolveIncludes(text, baseUrl, key, depth) {
  if (depth > 3 || !text.includes('!#include')) return text;
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^!#include\s+(\S+)/);
    if (!m) { out.push(line); continue; }
    const incUrl = new URL(m[1], baseUrl).href;
    try {
      const sub = await cachedFetch(incUrl, `${key}__inc__${m[1]}`.replace(/[^\w.-]/g, '_'));
      out.push(await resolveIncludes(sub, incUrl, key, depth + 1));
    } catch (e) {
      out.push(`! include failed: ${m[1]} (${e.message})`);
    }
  }
  return out.join('\n');
}

/**
 * Fetch every configured list. Returns
 *   [{ id, ruleset, enabledByDefault, path, lines: string[] }]
 * with comments (! …) and blank lines stripped.
 */
export async function fetchLists(cfg) {
  const { baseUrl, ref, lists } = cfg.uassets;
  const resolvedBase = baseUrl.replace('{ref}', ref);

  const out = [];
  const failed = [];
  for (const list of lists) {
    // A list may give an absolute `url` (regional lists live outside uAssets); else uAssets `path`
    const url = list.url || resolvedBase + list.path;
    const key = `${ref}__${list.id}.txt`.replace(/[^\w.-]/g, '_');
    process.stdout.write(`  fetch ${list.id} (${list.path || list.url}) … `);
    try {
      let text = await cachedFetch(url, key);
      // Opt-in (config uassets.resolveIncludes): inline `!#include <relative path>` sub-lists, as uBO
      // does — some regional lists (e.g. RU AdList) are nothing but includes. Off by default so the
      // shared default build is unchanged.
      if (cfg.uassets.resolveIncludes) text = await resolveIncludes(text, url, key, 0);
      const lines = text.split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.length && !l.startsWith('!') && !l.startsWith('[Adblock'));
      console.log(`${lines.length} lines`);
      out.push({ ...list, url, lines });
    } catch (e) {
      console.log(`SKIPPED (${e.message})`);
      failed.push({ id: list.id, path: list.path, error: e.message });
    }
  }
  out.failed = failed;
  return out;
}
