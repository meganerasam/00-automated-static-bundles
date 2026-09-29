// src/parse-scriptlets.js — turn uBO `##+js(...)` filters into a scriptlet DB.
//
// Handles:
//   example.com,other.*##+js(set-constant, foo, false)   -> injection
//   example.com#@#+js(set-constant, foo, false)          -> exception (removal)
//   ~sub.example.com,example.com##+js(name, a\, b)        -> negated domain + escaped comma
//
// Output DB shape (neutral):
//   { "<domain>": [ ["<name>", "<arg1>", ...], ... ], ... }
// with a "*" bucket for generic (domainless) injections. You reshape this into
// your build's *-db.js files.

const INJECT = '##+js(';
const EXCEPT = '#@#+js(';

/** Split "a, b\, c , d" on UNescaped commas, then unescape and trim. */
function splitArgs(inner) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === ',') { buf += ','; i++; continue; }
    if (ch === ',') { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((s) => s.trim()); // keep positional args, including empty ones
}

/** Parse the domain list left of the separator into {include[], exclude[]}. */
function parseDomains(domainStr) {
  const include = [];
  const exclude = [];
  for (const raw of domainStr.split(',')) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (d.startsWith('~')) exclude.push(d.slice(1));
    else include.push(d);
  }
  return { include, exclude };
}

export function parseScriptlets(lists) {
  /** @type {Map<string, Array<string[]>>} */
  const db = new Map();
  /** @type {Map<string, Set<string>>} domain -> set of scriptlet names to remove */
  const exceptions = new Map();
  const usedNames = new Set();
  let injections = 0;
  let exceptionCount = 0;

  const addException = (domain, name) => {
    if (!exceptions.has(domain)) exceptions.set(domain, new Set());
    exceptions.get(domain).add(name);
  };

  for (const list of lists) {
    for (const line of list.lines) {
      const isExcept = line.includes(EXCEPT);
      const sep = isExcept ? EXCEPT : (line.includes(INJECT) ? INJECT : null);
      if (!sep) continue;

      const sepIdx = line.indexOf(sep);
      const domainStr = line.slice(0, sepIdx);
      const close = line.lastIndexOf(')');
      if (close <= sepIdx) continue;
      const inner = line.slice(sepIdx + sep.length, close);

      const args = splitArgs(inner);
      const name = args[0];
      if (!name) continue;
      const call = args; // [name, ...args]

      const { include } = parseDomains(domainStr);
      const domains = include.length ? include : ['*'];

      if (isExcept) {
        exceptionCount++;
        for (const d of domains) addException(d, name);
        continue;
      }

      injections++;
      usedNames.add(name);
      for (const d of domains) {
        if (!db.has(d)) db.set(d, []);
        db.get(d).push(call);
      }
    }
  }

  // Apply exceptions: drop injected calls whose name is excepted on that domain
  // (or globally via a "*" exception).
  const globalExcept = exceptions.get('*') ?? new Set();
  for (const [domain, calls] of db) {
    const ex = exceptions.get(domain);
    const filtered = calls.filter(([name]) => !globalExcept.has(name) && !(ex && ex.has(name)));
    if (filtered.length) db.set(domain, filtered);
    else db.delete(domain);
  }

  // Deterministic object output (sorted by domain).
  const obj = {};
  for (const domain of [...db.keys()].sort()) obj[domain] = db.get(domain);

  return {
    db: obj,
    usedNames: [...usedNames].sort(),
    stats: { injections, exceptions: exceptionCount, domains: Object.keys(obj).length },
  };
}
