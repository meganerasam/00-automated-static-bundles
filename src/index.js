// src/index.js — orchestrate the full static-bundle regeneration.
//   npm run build                 fetch + convert + write dist/
//   npm run build -- --report-only   compute + print, write nothing

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fetchLists } from './fetch-sources.js';
import { convertNetwork } from './convert-network.js';
import { parseScriptlets } from './parse-scriptlets.js';
import { buildScriptletLibrary } from './scriptlet-library.js';
import { parseCosmetics } from './parse-cosmetics.js';
import { collectSurrogates } from './collect-surrogates.js';
import { audit } from './budget.js';

const reportOnly = process.argv.includes('--report-only');
// Optional `--config <file>` (e.g. a per-build config such as Wonder's regional lists); defaults to
// ../config.json, so the plain `npm run build` is unchanged.
const cfgArg = process.argv.indexOf('--config');
const cfgPath = cfgArg !== -1 && process.argv[cfgArg + 1]
  ? path.resolve(process.argv[cfgArg + 1])
  : new URL('../config.json', import.meta.url);
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const outDir = cfg.output?.dir ?? 'dist';
const json = (v) => JSON.stringify(v, null, cfg.output?.prettyJson ? 2 : 0);

async function write(rel, data) {
  if (reportOnly) return;
  const file = path.join(outDir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  const body = Buffer.isBuffer(data) || typeof data === 'string' ? data : json(data);
  await writeFile(file, body);
}

async function main() {
  console.log(`uBO ref: ${cfg.uassets.ref}  |  converter: ${cfg.network?.converter ?? 'tsurlfilter'}\n`);

  console.log('1/6 fetch lists');
  const lists = await fetchLists(cfg);

  console.log('2/6 convert network -> DNR rulesets');
  const { rulesets, skipped: netSkipped } = await convertNetwork(lists, cfg);

  console.log('3/6 parse ##+js() -> scriptlet DB');
  const scriptlets = parseScriptlets(lists);

  console.log('4/6 assemble scriptlet library');
  const library = await buildScriptletLibrary(scriptlets.usedNames);

  console.log('5/6 parse cosmetics');
  const cosmetics = parseCosmetics(lists);

  console.log('6/6 collect surrogates');
  const surrogates = await collectSurrogates(lists);

  const { report: budgetReport, warnings } = audit(rulesets);

  // --- write bundle ---
  if (!reportOnly) await rm(outDir, { recursive: true, force: true });

  for (const rs of rulesets) await write(rs.path, rs.rules);
  await write('rulesets/manifest-snippet.json', {
    declarative_net_request: {
      rule_resources: rulesets.map((r) => ({ id: r.id, enabled: r.enabled, path: r.path })),
    },
  });

  await write('scriptlets/scriptlet-db.json', scriptlets.db);
  await write('scriptlets/used-scriptlets.json', scriptlets.usedNames);
  await write('scriptlets/scriptlets.js', library.code);

  await write('cosmetic/generic.json', cosmetics.generic);
  await write('cosmetic/specific.json', cosmetics.specific);

  await write('surrogates/redirect-resources.json', surrogates.names);
  for (const [name, content] of Object.entries(surrogates.files)) {
    await write(`surrogates/${name}`, content);
  }

  const report = {
    uboRef: cfg.uassets.ref,
    generatedFrom: cfg.uassets.lists.map((l) => l.id),
    network: { ...budgetReport, skippedByReason: netSkipped },
    scriptlets: { ...scriptlets.stats, used: scriptlets.usedNames.length,
      libraryResolved: library.resolved.length, libraryMissing: library.missing },
    cosmetics: cosmetics.stats,
    surrogates: { referenced: surrogates.names.length, emitted: Object.keys(surrogates.files).length,
      missing: surrogates.missing },
    warnings,
  };
  await write('report.json', report);

  // --- summary ---
  console.log('\n── summary ─────────────────────────────');
  console.log(`rulesets:   ${rulesets.length} (${budgetReport.enabledRulesets} enabled) — `
    + `${budgetReport.enabledRules}/${budgetReport.guaranteedStaticBudget} enabled static rules`);
  console.log(`scriptlets: ${scriptlets.stats.domains} domains, ${scriptlets.usedNames.length} distinct scriptlets`
    + (library.missing.length ? ` (⚠ ${library.missing.length} unresolved code)` : ''));
  console.log(`cosmetics:  ${cosmetics.stats.generic} generic, ${cosmetics.stats.domains} domains`
    + ` (skipped: ${JSON.stringify(cosmetics.stats.skipped)})`);
  console.log(`surrogates: ${surrogates.names.length} referenced, ${Object.keys(surrogates.files).length} emitted`);
  console.log(`network skipped: ${JSON.stringify(netSkipped)}`);
  if (warnings.length) { console.log('\n⚠ budget warnings:'); for (const w of warnings) console.log('  - ' + w); }
  console.log(reportOnly ? '\n(report-only: nothing written)' : `\n→ wrote ${outDir}/`);
}

main().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
