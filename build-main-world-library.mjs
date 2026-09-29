// build-main-world-library.mjs — generate the MAIN-world scriptlet library for a
// build (Ad Block Pro / build 12) from @adguard/scriptlets corelibs, which ship
// SELF-CONTAINED scriptlet code (dependencies inlined). Each used ##+js() name is
// resolved to a corelibs entry (directly or via the uBO->AdG converter) and its
// code is emitted once, then every used name is mapped to a small (args)=>fn
// adapter under self.__proScriptlets. Names not in corelibs are reported and left
// unimplemented (the runtime no-ops on unknown names).
//
// Regenerate whenever the scriptlet DB is refreshed, from the SAME @adguard
// version the DB was built with (name<->code coupling). Output: dist/scriptlets/library.js
import fs from 'fs';

const CORE = 'node_modules/@adguard/scriptlets/dist/scriptlets.corelibs.json';
const USED = 'dist/scriptlets/used-scriptlets.json';
const OUT = 'dist/scriptlets/library.js';

const core = JSON.parse(fs.readFileSync(CORE, 'utf8'));
const used = JSON.parse(fs.readFileSync(USED, 'utf8'));
const conv = await import('@adguard/scriptlets/converters').catch(() => null);

const norm = (s) => s.replace(/^(ubo|abp)-/, '').replace(/\.js$/, '');
const byName = new Map();
for (const e of core.scriptlets) for (const n of e.names) byName.set(norm(n), e);

function resolve(name) {
   if (byName.has(norm(name))) return byName.get(norm(name));
   if (conv && conv.convertUboToAdg) {
      try {
         const outc = conv.convertUboToAdg(`##+js(${name})`);
         const rule = Array.isArray(outc) ? outc[0] : outc;
         const m = rule && /scriptlet\(\s*'([^']+)'/.exec(rule);
         if (m && byName.has(norm(m[1]))) return byName.get(norm(m[1]));
      } catch (e) { /* fall through */ }
   }
   return null;
}

const entryId = new Map(); // corelibs entry -> synthetic id
const nameToId = {};
const resolved = [];
const missing = [];
for (const name of used) {
   const e = resolve(name);
   if (!e) { missing.push(name); continue; }
   if (!entryId.has(e)) entryId.set(e, 'f' + entryId.size);
   nameToId[name] = entryId.get(e);
   resolved.push(name);
}

const L = [];
L.push('/* MAIN-world scriptlet library for build 12 (Ad Block Pro).');
L.push(` * Generated from @adguard/scriptlets ${core.version} corelibs (self-contained).`);
L.push(' * Regenerate with build-main-world-library.mjs when the scriptlet DB changes.');
L.push(` * Resolved ${resolved.length}/${used.length} scriptlets. */`);
L.push('(function () {');
L.push('   if (self.__proScriptlets) return;');
L.push('   var f = Object.create(null);');
for (const [e, id] of entryId) L.push(`   f[${JSON.stringify(id)}] = ${e.scriptlet};`);
L.push('   function mk(name, fn) {');
L.push('      return function (args) {');
L.push('         try { fn({ name: name, uniqueId: "pro_" + name, args: args }, args); } catch (e) {}');
L.push('      };');
L.push('   }');
L.push('   var R = Object.create(null);');
for (const name of resolved) L.push(`   R[${JSON.stringify(name)}] = mk(${JSON.stringify(name)}, f[${JSON.stringify(nameToId[name])}]);`);
L.push('   self.__proScriptlets = R;');
L.push('})();');
if (missing.length) L.push(`/* NOT bundled (absent from corelibs ${core.version}): ${missing.join(', ')} */`);

fs.writeFileSync(OUT, L.join('\n') + '\n');
console.log(`library.js: resolved ${resolved.length}/${used.length}, missing ${missing.length}: ${missing.join(', ')}`);
