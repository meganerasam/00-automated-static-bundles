// src/parse-cosmetics.js — turn uBO cosmetic filters into generic + specific maps.
//
//   ##.ad-banner              -> generic hide
//   example.com##.ad          -> specific hide (example.com)
//   example.com#@#.ad         -> unhide exception
//   example.com###sponsored   -> specific hide, selector "#sponsored"
//
// SKIPPED (handled by the runtime cosmetic/scriptlet layer, not DNR/CSS) and
// counted in stats: procedural (#?#), style/snippet (#$#), AdGuard scriptlet
// (#%#), HTML filtering (##^), and the ##+js() scriptlets (parse-scriptlets.js).

// First "#<modifiers>#" group on the line is the separator; domains never contain #.
const SEP = /#([@?$%]*)#/;

function parseDomains(domainStr) {
  const include = [];
  for (const raw of domainStr.split(',')) {
    const d = raw.trim().toLowerCase();
    if (d && !d.startsWith('~')) include.push(d);
  }
  return include;
}

export function parseCosmetics(lists) {
  const generic = new Set();
  /** @type {Map<string, {hide:Set<string>, unhide:Set<string>}>} */
  const specific = new Map();
  const skipped = { procedural: 0, style: 0, adguardScriptlet: 0, html: 0 };
  let genericCount = 0;
  let specificCount = 0;
  let unhideCount = 0;

  const bucket = (domain) => {
    if (!specific.has(domain)) specific.set(domain, { hide: new Set(), unhide: new Set() });
    return specific.get(domain);
  };

  for (const list of lists) {
    for (const line of lines(list)) {
      const m = SEP.exec(line);
      if (!m) continue;
      const mod = m[1];
      const sepStart = m.index;
      const selector = line.slice(sepStart + m[0].length);
      const domainStr = line.slice(0, sepStart);

      // Scriptlets are handled elsewhere.
      if (selector.startsWith('+js(')) continue;

      // Classify by modifier.
      if (mod === '') {
        if (selector.startsWith('^')) { skipped.html++; continue; } // ##^ HTML filtering
        if (!selector) continue;
        const domains = parseDomains(domainStr);
        if (!domains.length) { generic.add(selector); genericCount++; }
        else { for (const d of domains) { bucket(d).hide.add(selector); } specificCount++; }
      } else if (mod === '@') {
        if (selector.startsWith('+js(')) continue; // #@#+js — scriptlet exception
        if (!selector) continue;
        const domains = parseDomains(domainStr);
        for (const d of domains) bucket(d).unhide.add(selector);
        unhideCount++;
      } else if (mod.includes('%')) {
        skipped.adguardScriptlet++;
      } else if (mod.includes('$')) {
        skipped.style++;
      } else if (mod.includes('?')) {
        skipped.procedural++;
      }
    }
  }

  // Unhide beats hide for the same selector on the same domain (uBO semantics).
  const specificObj = {};
  for (const domain of [...specific.keys()].sort()) {
    const { hide, unhide } = specific.get(domain);
    for (const sel of unhide) hide.delete(sel);
    specificObj[domain] = { hide: [...hide].sort(), unhide: [...unhide].sort() };
    if (!specificObj[domain].hide.length && !specificObj[domain].unhide.length) delete specificObj[domain];
  }

  return {
    generic: [...generic].sort(),
    specific: specificObj,
    stats: {
      generic: genericCount,
      specific: specificCount,
      unhide: unhideCount,
      domains: Object.keys(specificObj).length,
      skipped,
    },
  };
}

// A cosmetic line has a "#...#" but is NOT a pure network rule. Cheap pre-filter:
// only consider lines containing '#'. (Network-only lines never do.)
function* lines(list) {
  for (const line of list.lines) {
    if (line.includes('#')) yield line;
  }
}
