'use strict';

const { appendAudit, readAudit } = require('./audit');
const { apply } = require('./apply');
const { discover } = require('./discover');
const { preview } = require('./preview');
const { fullRestore, restore } = require('./restore');
const { snapshot, readSnapshot } = require('./snapshot');
const { status } = require('./status');
const { readUpstreamMap, resolveSnapshotUpstream } = require('./upstream');
const gateway = require('./gateway');

module.exports = {
  appendAudit,
  apply,
  discover,
  fullRestore,
  preview,
  readAudit,
  readSnapshot,
  readUpstreamMap,
  resolveSnapshotUpstream,
  restore,
  snapshot,
  status,
  ...gateway,
};
