// src/convert-network.js — network filters -> DNR static rulesets.
//
// PRIMARY path: @adguard/tsurlfilter (the converter you chose). Its DNR-converter
// API has moved across majors (v2 inline; v3 -> @adguard/dnr-converter), so it is
// isolated in `tsurlfilterConvert` below with the expected shape documented. If
// your installed version differs, adjust ONLY that function.
//
// FALLBACK path: a built-in `basicConvert` covering the common uBO/ABP network
// forms (||domain^, options, exceptions) so the tool produces output out of the
// box. Redirect/$csp/$removeparam/regex rules are skipped there and reported —
// tsurlfilter handles those. Choose the path with config.network.converter
// ("tsurlfilter" | "basic"); "tsurlfilter" auto-falls-back to basic on failure.

import { partition } from './budget.js';

const COSMETIC = /#([@?$%]*)#/; // lines with a cosmetic separator are not network rules

const RESOURCE_TYPES = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
  xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest', subdocument: 'sub_frame',
  frame: 'sub_frame', document: 'main_frame', doc: 'main_frame', media: 'media',
  font: 'font', websocket: 'websocket', ping: 'ping', object: 'object',
  object_subrequest: 'object', other: 'other',
};

function isNetworkLine(line) {
  if (!line) return false;
  if (COSMETIC.test(line)) return false;      // cosmetic / scriptlet
  if (line.startsWith('!')) return false;      // comment
  return true;
}

/** Parse one ABP/uBO network rule into a DNR rule, or return {skip, reason}. */
function parseNetworkRule(raw) {
  let line = raw.trim();
  if (!line) return { skip: 'empty' };

  const isAllow = line.startsWith('@@');
  if (isAllow) line = line.slice(2);

  // Split off $options.
  let options = '';
  const dollar = line.lastIndexOf('$');
  if (dollar !== -1 && !line.slice(dollar).includes('/')) { // crude: avoid $ inside regex
    options = line.slice(dollar + 1);
    line = line.slice(0, dollar);
  }

  if (line.startsWith('/') && line.endsWith('/')) return { skip: 'regex' };
  if (!line) return { skip: 'empty-pattern' };

  const condition = { urlFilter: line, isUrlFilterCaseSensitive: false };
  const resourceTypes = new Set();
  const excludedResourceTypes = new Set();
  let unsupported = null;

  if (options) {
    for (const opt of options.split(',')) {
      const o = opt.trim();
      if (!o) continue;
      const neg = o.startsWith('~');
      const key = (neg ? o.slice(1) : o).split('=')[0];
      const val = o.includes('=') ? o.slice(o.indexOf('=') + 1) : null;

      if (RESOURCE_TYPES[key]) { (neg ? excludedResourceTypes : resourceTypes).add(RESOURCE_TYPES[key]); }
      else if (key === 'third-party' || key === '3p') condition.domainType = neg ? 'firstParty' : 'thirdParty';
      else if (key === 'first-party' || key === '1p') condition.domainType = neg ? 'thirdParty' : 'firstParty';
      else if (key === 'domain' && val) {
        const inc = [], exc = [];
        for (const d of val.split('|')) { if (d.startsWith('~')) exc.push(d.slice(1)); else if (d) inc.push(d); }
        if (inc.length) condition.initiatorDomains = inc;
        if (exc.length) condition.excludedInitiatorDomains = exc;
      }
      else if (key === 'important') { /* raise priority below */ condition.__important = true; }
      else if (key === 'redirect' || key === 'redirect-rule') { unsupported = 'redirect'; }
      else if (key === 'csp') { unsupported = 'csp'; }
      else if (key === 'removeparam') { unsupported = 'removeparam'; }
      else if (key === 'header') { unsupported = 'header'; }
      else if (key === 'badfilter') { unsupported = 'badfilter'; }
      else { unsupported = key; }
    }
  }
  if (unsupported) return { skip: unsupported };

  if (resourceTypes.size) condition.resourceTypes = [...resourceTypes];
  if (excludedResourceTypes.size) condition.excludedResourceTypes = [...excludedResourceTypes];
  const important = condition.__important; delete condition.__important;

  return {
    rule: {
      priority: isAllow ? 2 : (important ? 2 : 1),
      action: { type: isAllow ? 'allow' : 'block' },
      condition,
    },
  };
}

/** Built-in fallback converter. Returns { rules, skipped: {reason: count} }. */
function basicConvert(lines) {
  const rules = [];
  const skipped = {};
  for (const line of lines) {
    if (!isNetworkLine(line)) continue;
    const { rule, skip } = parseNetworkRule(line);
    if (skip) { skipped[skip] = (skipped[skip] ?? 0) + 1; continue; }
    rules.push(rule);
  }
  return { rules, skipped };
}

/**
 * tsurlfilter adapter — EXPECTED SHAPE (verify against your installed version):
 *   import { DeclarativeFilterConverter, Filter, RuleSetsLoaderApi } from
 *     '@adguard/tsurlfilter/es/declarative-converter';
 * Build a Filter from the raw text, call converter.convertStaticRuleSet(...),
 * then read the DNR rules out of the resulting rule set.
 * Returns { rules, skipped }.
 */
async function tsurlfilterConvert(lines) {
  // Wired for @adguard/tsurlfilter v3 (preprocess -> Filter -> convertStaticRuleSet).
  const [core, dc] = await Promise.all([
    import('@adguard/tsurlfilter'),
    import('@adguard/tsurlfilter/es/declarative-converter'),
  ]);
  // preprocess() logs every uBO rule it can't parse (e.g. ##^ HTML filtering) to
  // the console via @adguard/logger. Those are expected and non-fatal — silence
  // console for just this synchronous call.
  const saved = { error: console.error, warn: console.warn, info: console.info, log: console.log };
  console.error = console.warn = console.info = console.log = () => {};
  let pre;
  try { pre = core.FilterListPreprocessor.preprocess(lines.join('\n')); }
  finally { Object.assign(console, saved); }
  const filter = new dc.Filter(1, { getContent: async () => pre }, false);
  const converter = new dc.DeclarativeFilterConverter();
  const conv = await converter.convertStaticRuleSet(filter, {
    resourcesPath: '/web_accessible_resources', // where redirect targets resolve
    maxNumberOfRules: 1_000_000,                 // no truncation; we budget/partition ourselves
  });
  const declarative = await conv.ruleSet.getDeclarativeRules();
  // Keep DNR action/condition/priority; drop tsurlfilter's ids (convertNetwork assigns).
  const rules = declarative.map((r) => ({ priority: r.priority, action: r.action, condition: r.condition }));

  const skipped = {};
  const note = (k) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  for (const e of conv.errors || []) note(e?.name || e?.constructor?.name || 'error');
  for (const l of conv.limitations || []) note(l?.name || l?.constructor?.name || 'limitation');
  return { rules, skipped };
}

/**
 * Convert all lists into DNR rulesets grouped by config `ruleset`, with sequential
 * ids and per-ruleset partitioning. Returns { rulesets:[{id,enabled,rules,path}], skipped }.
 */
export async function convertNetwork(lists, cfg) {
  const mode = cfg.network?.converter ?? 'tsurlfilter';
  const maxPer = cfg.budget?.maxRulesPerRuleset ?? 30000;

  // Group source lines by ruleset name.
  const groups = new Map(); // ruleset -> { enabled, lines: [] }
  for (const list of lists) {
    const g = groups.get(list.ruleset) ?? { enabled: !!list.enabledByDefault, lines: [] };
    g.enabled = g.enabled || !!list.enabledByDefault;
    // Pass ALL lines: tsurlfilter extracts network rules and ignores cosmetics;
    // basicConvert filters non-network lines itself.
    for (const line of list.lines) g.lines.push(line);
    groups.set(list.ruleset, g);
  }

  const rulesets = [];
  const skippedTotal = {};
  let nextId = 1;

  for (const [name, g] of groups) {
    let out;
    if (mode === 'basic') out = basicConvert(g.lines);
    else out = await tsurlfilterConvert(g.lines).catch((e) => {
      console.warn(`  tsurlfilter failed for "${name}" (${e.message}); using basic converter`);
      return basicConvert(g.lines);
    });

    for (const [reason, n] of Object.entries(out.skipped)) skippedTotal[reason] = (skippedTotal[reason] ?? 0) + n;

    // Assign globally-unique ids, then partition into <= maxPer chunks.
    const withIds = out.rules.map((r) => ({ id: nextId++, ...r }));
    const parts = partition(withIds, maxPer);
    parts.forEach((rules, i) => {
      const id = parts.length > 1 ? `${name}-${i + 1}` : name;
      rulesets.push({ id, enabled: g.enabled, rules, path: `rulesets/ruleset-${id}.json` });
    });
  }

  return { rulesets, skipped: skippedTotal };
}
