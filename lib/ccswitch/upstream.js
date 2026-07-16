'use strict';

const fs = require('fs');
const { readSnapshot } = require('./snapshot');

// Intentionally reads only CPR's immutable snapshot map. It never consults the
// rewritten CC-Switch database, which prevents a local-proxy URL from becoming
// its own upstream and creating a request loop.
function readUpstreamMap(options = {}) {
  if (!options.snapshotId) throw new Error('snapshotId is required');
  const snap = readSnapshot(options.home, options.snapshotId);
  return JSON.parse(fs.readFileSync(snap.endpointsPath, 'utf8'));
}

function resolveSnapshotUpstream(options = {}) {
  const map = readUpstreamMap(options);
  const match = map.endpoints.find(item =>
    item.appType === options.appType && item.providerId === options.providerId &&
    (options.endpointId == null ? item.kind === 'provider-setting' : item.kind === 'provider-endpoint' && String(item.rowId) === String(options.endpointId))
  );
  return match ? match.upstream : null;
}

module.exports = { readUpstreamMap, resolveSnapshotUpstream };
