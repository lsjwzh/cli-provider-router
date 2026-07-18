'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stripModelSuffix,
  modelValidForProvider,
  validateModel,
  resolveWireModel,
} = require('../lib/model-policy');
const { resolveSessionWireModel } = require('../lib/spawn-env');

test('stripModelSuffix removes only a terminal CLI display suffix', () => {
  assert.equal(stripModelSuffix(' ark-code-latest[1M] '), 'ark-code-latest');
  assert.equal(stripModelSuffix('model[preview]variant'), 'model[preview]variant');
  assert.equal(stripModelSuffix(null), '');
});

test('model validation accepts public summaries without store access', () => {
  const summary = Object.freeze({
    appType: 'claude',
    isOfficial: false,
    model: 'relay-primary',
    modelOptions: Object.freeze(['relay-primary', 'ark-code-latest[1M]']),
    aliasMap: Object.freeze({
      sonnet: Object.freeze({ model: 'ark-code-latest[1M]', name: 'Long context' }),
    }),
  });

  assert.equal(modelValidForProvider('claude', summary, 'relay-primary'), true);
  assert.equal(modelValidForProvider('claude', summary, 'ark-code-latest'), true);
  assert.equal(modelValidForProvider('claude', summary, 'ark-code-latest[1M]'), true);
  assert.equal(modelValidForProvider('claude', summary, 'sonnet'), true);
  assert.equal(modelValidForProvider('claude', summary, 'opus'), false);
  assert.equal(modelValidForProvider('claude', summary, 'default'), true);
  assert.equal(modelValidForProvider('claude', summary, 'unknown-model'), false);
  assert.equal(modelValidForProvider('ark-code-latest', summary), true);
});

test('model validation accepts raw provider settingsConfig shapes', () => {
  const rawClaude = Object.freeze({
    appType: 'claude',
    settingsConfig: Object.freeze({
      env: Object.freeze({
        ANTHROPIC_BASE_URL: 'https://relay.example/v1',
        ANTHROPIC_MODEL: 'relay-main[200K]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'relay-fast[1M]',
      }),
      modelCatalog: Object.freeze({ models: Object.freeze([{ model: 'relay-extra[1M]' }]) }),
    }),
  });
  const rawCodex = Object.freeze({
    appType: 'codex',
    settingsConfig: JSON.stringify({
      config: [
        'model_provider = "custom"',
        'model = "gpt-main[128K]"',
        '[model_providers.custom]',
        'base_url = "https://codex.example/v1"',
      ].join('\n'),
      modelCatalog: { models: [{ model: 'gpt-extra[1M]' }] },
    }),
  });

  assert.equal(validateModel, modelValidForProvider);
  assert.equal(validateModel('claude', rawClaude, 'relay-main'), true);
  assert.equal(validateModel('claude', rawClaude, 'haiku'), true);
  assert.equal(validateModel('claude', rawClaude, 'sonnet'), false);
  assert.equal(validateModel('claude', rawClaude, 'relay-extra'), true);
  assert.equal(validateModel('codex', rawCodex, 'gpt-main'), true);
  assert.equal(validateModel('codex', rawCodex, 'gpt-extra[1M]'), true);
  assert.equal(validateModel('codex', rawCodex, 'gpt-unknown'), false);
});

test('empty/default providers retain the existing Claude and Codex policy', () => {
  assert.equal(modelValidForProvider('claude', null, null), true);
  assert.equal(modelValidForProvider('claude', null, 'sonnet'), true);
  assert.equal(modelValidForProvider('claude', null, 'claude-opus-4-8[1M]'), true);
  assert.equal(modelValidForProvider('claude', null, 'relay-only-model'), false);
  assert.equal(modelValidForProvider('codex', null, 'unknown-model'), true);

  const official = { appType: 'claude', isOfficial: true, modelOptions: ['stale-relay-id'] };
  assert.equal(modelValidForProvider('claude', official, 'stale-relay-id'), false);
  assert.equal(modelValidForProvider('claude', official, 'claude-sonnet-4-5'), true);
});

test('resolveWireModel is resolveSessionWireModel-compatible and suffix aware', () => {
  const provider = {
    providerModel: 'relay-main[200K]',
    providerModels: ['relay-main[200K]', 'relay-extra[1M]'],
  };

  assert.equal(resolveWireModel('relay-extra', provider), 'relay-extra');
  assert.equal(resolveWireModel('relay-extra[1M]', provider), 'relay-extra');
  assert.equal(resolveWireModel('sonnet', provider), 'sonnet');
  assert.equal(resolveWireModel('unknown-model', provider), 'relay-main');
  assert.equal(resolveWireModel(null, provider), 'relay-main');

  assert.equal(resolveWireModel('claude-opus-4-8[1M]'), 'claude-opus-4-8');
  assert.equal(resolveWireModel(null, { defaultModel: 'claude-sonnet-4-5[1M]' }), 'claude-sonnet-4-5');
  assert.equal(resolveWireModel(null, { skipDefaultModel: true, defaultModel: 'ignored' }), null);
  assert.equal(resolveSessionWireModel('relay-extra[1M]', provider), 'relay-extra');
});
