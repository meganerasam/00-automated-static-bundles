// src/budget.js — the MV3 declarativeNetRequest limits and the helpers that keep
// the generated static bundle inside them. See DATA_SOURCES.md §4.1.1.
//
// These are Chrome's current constants. They are also exposed at runtime as
// chrome.declarativeNetRequest.MAX_* — treat the numbers here as the design
// budget, and verify against the target Chrome version when they matter.

export const MV3 = Object.freeze({
  // Static rulesets (what this tool emits — shipped in the manifest).
  GUARANTEED_MINIMUM_STATIC_RULES: 30000, // across ENABLED static rulesets
  MAX_STATIC_RULESETS: 100,               // declarable
  MAX_ENABLED_STATIC_RULESETS: 50,        // enabled at once

  // Dynamic + session (the SERVER's compiled rules, not this bundle — here for
  // reference only). "safe" = block/allow/allowAllRequests/upgradeScheme.
  MAX_DYNAMIC_RULES: 30000,        // safe dynamic rules
  MAX_UNSAFE_DYNAMIC_RULES: 5000,  // redirect + modifyHeaders
  MAX_SESSION_RULES: 5000,

  // Regex + per-rule.
  MAX_REGEX_RULES: 1000, // per type, static and dynamic counted separately
  MAX_REGEX_RULE_BYTES: 2000,
});

const SAFE_ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme']);

export const isSafe = (rule) => SAFE_ACTIONS.has(rule?.action?.type);
export const isRegex = (rule) => typeof rule?.condition?.regexFilter === 'string';

/**
 * Split one logical ruleset's rules into <= maxRulesPerRuleset chunks, so no
 * single static ruleset file grows unwieldy. Returns an array of rule arrays.
 */
export function partition(rules, maxRulesPerRuleset) {
  if (rules.length <= maxRulesPerRuleset) return [rules];
  const parts = [];
  for (let i = 0; i < rules.length; i += maxRulesPerRuleset) {
    parts.push(rules.slice(i, i + maxRulesPerRuleset));
  }
  return parts;
}

/**
 * Audit the emitted rulesets against the budget. `rulesets` is
 * [{ id, enabled, rules }]. Returns a report object and an array of human-readable
 * warnings (empty === within budget).
 */
export function audit(rulesets) {
  const warnings = [];

  const enabledRules = rulesets.filter((r) => r.enabled)
    .reduce((n, r) => n + r.rules.length, 0);
  const totalRules = rulesets.reduce((n, r) => n + r.rules.length, 0);
  const enabledCount = rulesets.filter((r) => r.enabled).length;

  const regexEnabled = rulesets.filter((r) => r.enabled)
    .reduce((n, r) => n + r.rules.filter(isRegex).length, 0);
  const oversizedRegex = rulesets.flatMap((r) => r.rules)
    .filter((rule) => isRegex(rule)
      && Buffer.byteLength(rule.condition.regexFilter, 'utf8') >= MV3.MAX_REGEX_RULE_BYTES);

  if (enabledRules > MV3.GUARANTEED_MINIMUM_STATIC_RULES) {
    warnings.push(
      `Enabled static rules ${enabledRules} exceed the guaranteed ${MV3.GUARANTEED_MINIMUM_STATIC_RULES}. `
      + `Ship some rulesets enabled:false, or rely on getAvailableStaticRuleCount() at runtime.`);
  }
  if (enabledCount > MV3.MAX_ENABLED_STATIC_RULESETS) {
    warnings.push(`Enabled rulesets ${enabledCount} exceed ${MV3.MAX_ENABLED_STATIC_RULESETS}.`);
  }
  if (rulesets.length > MV3.MAX_STATIC_RULESETS) {
    warnings.push(`Declared rulesets ${rulesets.length} exceed ${MV3.MAX_STATIC_RULESETS}.`);
  }
  if (regexEnabled > MV3.MAX_REGEX_RULES) {
    warnings.push(`Enabled regex rules ${regexEnabled} exceed ${MV3.MAX_REGEX_RULES} — minimise regexFilter.`);
  }
  for (const rule of oversizedRegex) {
    warnings.push(`Regex rule id ${rule.id} is >= ${MV3.MAX_REGEX_RULE_BYTES} bytes once compiled.`);
  }

  return {
    report: {
      totalRules,
      enabledRules,
      declaredRulesets: rulesets.length,
      enabledRulesets: enabledCount,
      enabledRegexRules: regexEnabled,
      guaranteedStaticBudget: MV3.GUARANTEED_MINIMUM_STATIC_RULES,
      perRuleset: rulesets.map((r) => ({ id: r.id, enabled: r.enabled, rules: r.rules.length })),
    },
    warnings,
  };
}
