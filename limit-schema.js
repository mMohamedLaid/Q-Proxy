// limit-schema.js — loads/validates limit-schema.json and the optional per-hop `limits` records.
'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'limit-schema.json');

function loadLimitSchema() {
  try { return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')); }
  catch (e) { return { error: e.message, enums: {}, providers: {} }; }
}

// Returns a list of problems (empty = fine). `enums` comes from limit-schema.json.
function validateLimitRecord(r, enums) {
  const bad = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['record is not an object'];
  const e = enums || {};
  if (!r.id || typeof r.id !== 'string') bad.push('id missing');
  if (!(e.unit || []).includes(r.unit)) bad.push(`unit "${r.unit}" not one of ${(e.unit || []).join('/')}`);
  const lvl = r.scope && r.scope.level;
  if (!(e.scopeLevel || []).includes(lvl)) bad.push(`scope.level "${lvl}" not one of ${(e.scopeLevel || []).join('/')}`);
  const wk = r.window && r.window.kind;
  if (!(e.windowKind || []).includes(wk)) bad.push(`window.kind "${wk}" not one of ${(e.windowKind || []).join('/')}`);
  if (r.value !== null && r.value !== undefined && !(typeof r.value === 'number' && r.value >= 0)) bad.push('value must be a number >= 0 or null');
  if (r.source !== undefined && !(e.source || []).includes(r.source)) bad.push(`source "${r.source}" unknown`);
  if (r.onExceed && r.onExceed.kind !== undefined && !(e.onExceedKind || []).includes(r.onExceed.kind)) bad.push(`onExceed.kind "${r.onExceed.kind}" unknown`);
  if (wk === 'rolling' && !(r.window && r.window.size)) bad.push('rolling window needs window.size (e.g. "60s")');
  return bad;
}

function validateSchemaFile(schema) {
  const problems = [];
  for (const [prov, p] of Object.entries(schema.providers || {})) {
    for (const rec of p.records || []) for (const b of validateLimitRecord(rec, schema.enums)) problems.push(`${prov}/${rec && rec.id}: ${b}`);
  }
  return problems;
}

// True only when key rotation can actually help: some record is scoped to the key.
function keyRotationHelps(records) {
  return (records || []).some(r => r && r.scope && r.scope.level === 'key');
}

module.exports = { loadLimitSchema, validateLimitRecord, validateSchemaFile, keyRotationHelps };
