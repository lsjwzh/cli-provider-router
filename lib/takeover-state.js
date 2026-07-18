'use strict';

const fs = require('fs');
const path = require('path');
const { createCprPaths, ensureCprPaths } = require('./paths');
const { writeJsonAtomic, removeFile } = require('./atomic-json');

const ACTIVE_PHASES = new Set(['applying', 'active', 'restoring', 'conflict', 'rollback-required']);
const INACTIVE_PHASES = new Set(['inactive', 'restored', 'full-restored']);

function pathsFor(homeOrPaths) {
  const paths = homeOrPaths && homeOrPaths.home && homeOrPaths.directCliConfigStateDir
    ? homeOrPaths
    : createCprPaths({ home: typeof homeOrPaths === 'string' ? homeOrPaths : homeOrPaths && homeOrPaths.home });
  ensureCprPaths(paths);
  return {
    paths,
    ccSwitchStateFile: paths.ccSwitchStateFile,
    directStateDir: paths.directCliConfigStateDir,
  };
}

function readStateStrict(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw Object.assign(new Error(`cannot read takeover state ${file}: ${error.message}`), {
      code: 'TAKEOVER_STATE_UNREADABLE', file, cause: error,
    });
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
    return value;
  } catch (error) {
    throw Object.assign(new Error(`cannot validate takeover state ${file}: ${error.message}`), {
      code: 'TAKEOVER_STATE_INVALID', file, cause: error,
    });
  }
}

function statePhase(state, kind) {
  if (!state) return 'inactive';
  const explicit = String(state.status || state.phase || '').toLowerCase();
  if (explicit) return explicit;
  if (kind === 'direct-cli' && (state.snapshotId || Array.isArray(state.appliedFiles))) return 'active';
  if (kind === 'ccswitch' && (state.snapshotId || Array.isArray(state.changes))) return 'active';
  return 'inactive';
}

function isActiveState(state, kind) {
  const phase = statePhase(state, kind);
  if (ACTIVE_PHASES.has(phase)) return true;
  if (INACTIVE_PHASES.has(phase)) return false;
  // Unknown persisted phases are treated as active. Lifecycle guards must fail
  // closed when a newer/partial writer leaves a state we do not understand.
  return !!state;
}

function createTakeoverStateStore(homeOrPaths) {
  const resolved = pathsFor(homeOrPaths);

  function ccSwitch() {
    const state = readStateStrict(resolved.ccSwitchStateFile);
    return {
      kind: 'ccswitch', file: resolved.ccSwitchStateFile, state,
      phase: statePhase(state, 'ccswitch'), active: isActiveState(state, 'ccswitch'),
    };
  }

  function direct(cli) {
    if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
    const file = path.join(resolved.directStateDir, `${cli}.json`);
    const state = readStateStrict(file);
    return { kind: 'direct-cli', cli, file, state, phase: statePhase(state, 'direct-cli'), active: isActiveState(state, 'direct-cli') };
  }

  function summary() {
    const entries = [ccSwitch(), direct('claude'), direct('codex')];
    return { active: entries.some(entry => entry.active), entries, activeEntries: entries.filter(entry => entry.active) };
  }

  function writeCcSwitch(state) {
    writeJsonAtomic(resolved.ccSwitchStateFile, state);
    return state;
  }

  function writeDirect(cli, state) {
    const entry = direct(cli);
    writeJsonAtomic(entry.file, state);
    return state;
  }

  function removeDirect(cli) {
    const entry = direct(cli);
    removeFile(entry.file);
  }

  function assertCanStop(action = 'stop') {
    const current = summary();
    if (!current.active) return current;
    const labels = current.activeEntries.map(entry => entry.kind === 'ccswitch'
      ? `CC-Switch (${entry.phase})`
      : `direct ${entry.cli} (${entry.phase})`);
    const error = new Error(`refusing to ${action}: active takeover would be stranded: ${labels.join(', ')}`);
    error.code = 'ACTIVE_TAKEOVER';
    error.takeovers = current.activeEntries.map(entry => ({ kind: entry.kind, cli: entry.cli, phase: entry.phase, file: entry.file }));
    throw error;
  }

  return {
    paths: resolved,
    ccSwitch,
    direct,
    summary,
    writeCcSwitch,
    writeDirect,
    removeDirect,
    assertCanStop,
  };
}

module.exports = {
  ACTIVE_PHASES,
  INACTIVE_PHASES,
  createTakeoverStateStore,
  isActiveState,
  readStateStrict,
  statePhase,
};
