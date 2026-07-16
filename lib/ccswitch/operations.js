'use strict';

const { listTomlBaseUrls, parseSettings, replaceTomlBaseUrl } = require('./common');

function currentValue(db, change) {
  if (change.kind === 'provider-endpoint') {
    const row = db.prepare('SELECT provider_id, app_type, url FROM provider_endpoints WHERE id=?').get(change.rowId);
    if (!row || row.provider_id !== change.providerId || row.app_type !== change.appType) return { exists: false };
    return { exists: true, value: row.url };
  }
  const row = db.prepare('SELECT settings_config FROM providers WHERE id=? AND app_type=?').get(change.providerId, change.appType);
  if (!row) return { exists: false };
  const settings = parseSettings(row.settings_config);
  if (!settings) return { exists: true, invalid: true };
  if (change.field === 'env.ANTHROPIC_BASE_URL') {
    return { exists: true, value: settings.env && settings.env.ANTHROPIC_BASE_URL };
  }
  if (change.field === 'config.base_url') {
    const item = listTomlBaseUrls(settings.config).find(entry => entry.occurrence === (change.occurrence || 0));
    return item ? { exists: true, value: item.value } : { exists: true, missingField: true };
  }
  return { exists: true, missingField: true };
}

function inspectChanges(db, changes) {
  return changes.map(change => {
    const current = currentValue(db, change);
    let condition = 'drift';
    if (!current.exists) condition = 'missing';
    else if (current.invalid || current.missingField) condition = 'invalid';
    else if (current.value === change.applied) condition = 'applied';
    else if (current.value === change.original) condition = 'original';
    return { ...change, current: current.value, condition };
  });
}

function assertMutable(inspected, expectedCondition, force) {
  const conflicts = inspected.filter(item => item.condition !== expectedCondition && !(force && !['missing', 'invalid'].includes(item.condition)));
  if (conflicts.length) {
    const error = new Error(`CC-Switch configuration drift detected in ${conflicts.length} field(s)`);
    error.code = 'CONFIG_DRIFT';
    error.conflicts = conflicts;
    throw error;
  }
}

function mutate(db, changes, direction, options = {}) {
  const restoring = direction === 'restore';
  const expectedCondition = restoring ? 'applied' : 'original';
  const inspected = inspectChanges(db, changes);
  const actionable = inspected.filter(item => item.condition !== (restoring ? 'original' : 'applied'));
  assertMutable(actionable, expectedCondition, !!options.force);

  const byProvider = new Map();
  for (const change of actionable.filter(item => item.kind === 'provider-setting')) {
    const key = `${change.appType}\0${change.providerId}`;
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key).push(change);
  }

  const execute = db.transaction(() => {
    for (const group of byProvider.values()) {
      const first = group[0];
      const row = db.prepare('SELECT settings_config FROM providers WHERE id=? AND app_type=?').get(first.providerId, first.appType);
      const settings = parseSettings(row.settings_config);
      for (const change of group.sort((a, b) => (a.occurrence || 0) - (b.occurrence || 0))) {
        const expected = restoring ? change.applied : change.original;
        const replacement = restoring ? change.original : change.applied;
        if (change.field === 'env.ANTHROPIC_BASE_URL') {
          settings.env ||= {};
          if (!options.force && settings.env.ANTHROPIC_BASE_URL !== expected) throw Object.assign(new Error('Configuration changed during transaction'), { code: 'CONCURRENT_DRIFT' });
          settings.env.ANTHROPIC_BASE_URL = replacement;
        } else {
          const result = replaceTomlBaseUrl(settings.config, change.occurrence || 0, expected, replacement, !!options.force);
          if (!result.found || (!result.changed && result.actual !== replacement)) throw Object.assign(new Error('Configuration changed during transaction'), { code: 'CONCURRENT_DRIFT' });
          settings.config = result.value;
        }
      }
      db.prepare('UPDATE providers SET settings_config=? WHERE id=? AND app_type=?').run(JSON.stringify(settings), first.providerId, first.appType);
    }

    for (const change of actionable.filter(item => item.kind === 'provider-endpoint')) {
      const expected = restoring ? change.applied : change.original;
      const replacement = restoring ? change.original : change.applied;
      const result = options.force
        ? db.prepare('UPDATE provider_endpoints SET url=? WHERE id=? AND provider_id=? AND app_type=?').run(replacement, change.rowId, change.providerId, change.appType)
        : db.prepare('UPDATE provider_endpoints SET url=? WHERE id=? AND provider_id=? AND app_type=? AND url=?').run(replacement, change.rowId, change.providerId, change.appType, expected);
      if (result.changes !== 1) throw Object.assign(new Error('Endpoint changed during transaction'), { code: 'CONCURRENT_DRIFT' });
    }
  });
  execute();
  return { changed: actionable.length, unchanged: changes.length - actionable.length };
}

module.exports = { currentValue, inspectChanges, mutate };
