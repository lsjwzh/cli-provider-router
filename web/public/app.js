'use strict';

let adminToken = '';
let routeProfileRows = [];
let ccProviderRows = [];
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function notify(message, error = false) {
  $('#notice').innerHTML = '';
  const node = document.createElement('div');
  node.className = `notice${error ? ' error' : ''}`;
  node.textContent = message;
  $('#notice').append(node);
  setTimeout(() => { if (node.isConnected) node.remove(); }, 5000);
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-cpr-admin-token': adminToken, ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data;
}

function item(title, detail, action) {
  const row = document.createElement('div'); row.className = 'item';
  const text = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = title;
  const small = document.createElement('small'); small.textContent = detail;
  text.append(strong, small); row.append(text);
  if (action) row.append(action);
  return row;
}

function showJson(target, value) { $(target).textContent = JSON.stringify(value, null, 2); }

async function loadDashboard() {
  const data = await api('/dashboard');
  const cards = $('#dashboard-cards'); cards.innerHTML = '';
  const values = [
    ['Claude providers', data.providers.claude], ['Codex providers', data.providers.codex],
    ['Route profiles', data.routeProfiles], ['CC-Switch', data.ccSwitch.takeover || 'unavailable'],
    ['Native CLI config', `Claude ${data.directCliConfig.claude.active ? 'managed' : 'native'} · Codex ${data.directCliConfig.codex.active ? 'managed' : 'native'}`],
  ];
  for (const [label, value] of values) {
    const card = document.createElement('div'); card.className = 'card';
    const span = document.createElement('span'); span.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = value;
    card.append(span, strong); cards.append(card);
  }
  showJson('#dashboard-detail', data.usage);
}

async function loadProviders() {
  const data = await api('/providers');
  const list = $('#providers-list'); list.innerHTML = '';
  for (const provider of data.providers) {
    const actions = document.createElement('div'); actions.className = 'toolbar';
    const edit = document.createElement('button'); edit.textContent = 'Edit';
    edit.addEventListener('click', async () => {
      const baseUrl = window.prompt('Base URL', provider.baseUrl || ''); if (baseUrl == null) return;
      const model = window.prompt('Model', provider.model || ''); if (model == null) return;
      const authToken = window.prompt('New auth token (leave blank to keep current)', ''); if (authToken == null) return;
      const body = { baseUrl, model, ...(authToken ? { authToken } : {}) };
      await api(`/providers/${encodeURIComponent(provider.appType)}/${encodeURIComponent(provider.id)}`, { method: 'PATCH', body });
      notify('Provider updated'); await loadProviders();
    });
    const remove = document.createElement('button'); remove.textContent = 'Delete'; remove.className = 'danger';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete provider ${provider.name}?`)) return;
      await api(`/providers/${encodeURIComponent(provider.appType)}/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
      notify('Provider deleted'); await loadProviders();
    });
    actions.append(edit, remove);
    list.append(item(`${provider.name} · ${provider.appType}`, `${provider.baseUrl || 'default login'} · ${provider.model || 'default model'} · ${provider.tokenMask || 'no returned token'}`, actions));
  }
}

async function loadCc() {
  const [detect, status] = await Promise.all([api('/ccswitch/detect'), api('/ccswitch/status')]);
  ccProviderRows = detect.providers || [];
  const selected = new Set($$('#cc-provider-list input:checked')
    .map(input => JSON.stringify([input.dataset.appType, input.dataset.providerId])));
  const list = $('#cc-provider-list'); list.innerHTML = '';
  for (const provider of ccProviderRows) {
    const label = document.createElement('label'); label.className = 'provider-choice';
    const input = document.createElement('input'); input.type = 'checkbox';
    input.dataset.appType = provider.appType;
    input.dataset.providerId = provider.providerId;
    input.checked = selected.has(JSON.stringify([provider.appType, provider.providerId]));
    const text = document.createElement('span'); text.textContent = `${provider.name} · ${provider.appType} (${provider.providerId})`;
    label.append(input, text); list.append(label);
  }
  showJson('#cc-status', { detect, status });
}

function ccSelectionBody() {
  const selectedProviders = $$('#cc-provider-list input:checked').map(input => {
    return { appType: input.dataset.appType, providerId: input.dataset.providerId };
  });
  if (!selectedProviders.length) throw new Error('Select at least one CC-Switch provider');
  const allProviders = selectedProviders.length === ccProviderRows.length && ccProviderRows.length > 0;
  return allProviders ? { allProviders: true } : { selectedProviders };
}

async function previewCc() {
  const data = await api('/ccswitch/preview', { method: 'POST', body: ccSelectionBody() });
  const list = $('#cc-preview-list'); list.innerHTML = '';
  for (const change of data.changes || []) {
    const state = document.createElement('span'); state.className = `condition-${change.condition}`; state.textContent = change.condition;
    list.append(item(`${change.appType}/${change.providerId} · ${change.field}`, `${change.original} → ${change.applied}`, state));
  }
  notify(data.canApply ? 'Preview is safe to apply' : 'Preview contains conflicts or warnings', !data.canApply);
  return data;
}

async function confirmedCc(path, phrase, extra = {}) {
  if (window.prompt(`Type ${phrase} to continue`) !== phrase) return;
  const data = await api(path, { method: 'POST', body: { confirmation: phrase, ...extra } });
  notify(`${phrase} completed`); await loadCc(); return data;
}

function selectedCliConfig() {
  return { cli: $('#cli-config-cli').value, profileId: $('#cli-config-profile').value };
}

function renderCliConfigProfiles() {
  const cli = $('#cli-config-cli').value;
  const select = $('#cli-config-profile');
  const previous = select.value;
  select.textContent = '';
  for (const profile of routeProfileRows.filter(row => row.cli === cli && row.enabled)) {
    const option = document.createElement('option');
    option.value = profile.id; option.textContent = `${profile.name} (${profile.id})`;
    select.append(option);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}

async function loadCliConfig() {
  const cli = $('#cli-config-cli').value;
  const [detect, status] = await Promise.all([
    api(`/cli-config/detect?cli=${encodeURIComponent(cli)}`),
    api(`/cli-config/status?cli=${encodeURIComponent(cli)}`),
  ]);
  showJson('#cli-config-status', { detect, status });
}

async function previewCliConfig() {
  const selected = selectedCliConfig();
  if (!selected.profileId) throw new Error(`Create an enabled ${selected.cli} route profile first`);
  const data = await api('/cli-config/preview', { method: 'POST', body: selected });
  const list = $('#cli-config-files'); list.textContent = '';
  for (const file of data.files || []) {
    const state = document.createElement('span'); state.textContent = file.changed ? 'change' : 'same';
    list.append(item(file.path, `before ${file.beforeSha256 || 'absent'} · after ${file.afterSha256}`, state));
  }
  notify('Native CLI config preview ready');
  return data;
}

async function confirmedCliConfig(path, phrase, extra = {}) {
  const selected = selectedCliConfig();
  if (!selected.profileId && path !== '/cli-config/restore') throw new Error(`Create an enabled ${selected.cli} route profile first`);
  if (window.prompt(`Type ${phrase} to continue`) !== phrase) return;
  const data = await api(path, { method: 'POST', body: { ...selected, confirmation: phrase, ...extra } });
  notify(`${phrase} completed`); await loadCliConfig(); return data;
}

function routeRoles() { return $('#route-cli').value === 'claude' ? ['main', 'sub'] : ['main', 'default', 'worker', 'explorer']; }
function renderRouteInputs() {
  const target = $('#route-endpoints'); target.innerHTML = '';
  for (const role of routeRoles()) {
    const box = document.createElement('div'); box.className = 'route-box';
    const title = document.createElement('strong'); title.textContent = role;
    const provider = document.createElement('input'); provider.name = `${role}-provider`; provider.placeholder = 'provider id';
    const model = document.createElement('input'); model.name = `${role}-model`; model.placeholder = 'optional model';
    box.append(title, provider, model); target.append(box);
  }
}

async function loadRoutes() {
  const data = await api('/routes'); routeProfileRows = data.profiles; renderCliConfigProfiles();
  const list = $('#routes-list'); list.innerHTML = '';
  for (const profile of data.profiles) {
    const actions = document.createElement('div'); actions.className = 'toolbar';
    const toggle = document.createElement('button'); toggle.textContent = profile.enabled ? 'Disable' : 'Enable';
    toggle.addEventListener('click', async () => { await api(`/routes/${encodeURIComponent(profile.id)}`, { method: 'PATCH', body: { enabled: !profile.enabled } }); await loadRoutes(); });
    const remove = document.createElement('button'); remove.textContent = 'Delete'; remove.className = 'danger';
    remove.addEventListener('click', async () => { await api(`/routes/${encodeURIComponent(profile.id)}`, { method: 'DELETE' }); await loadRoutes(); });
    const routes = Object.entries(profile.routes).filter(([, endpoint]) => endpoint).map(([role, endpoint]) => `${role}: ${endpoint.providerId}${endpoint.model ? ` / ${endpoint.model}` : ''}`).join(' · ');
    actions.append(toggle, remove);
    list.append(item(`${profile.name} · ${profile.cli}${profile.enabled ? '' : ' · disabled'}`, routes || 'No routes configured', actions));
  }
}

async function loadUsage() {
  const params = new URLSearchParams(new FormData($('#usage-form'))); for (const [key, value] of [...params]) if (!value) params.delete(key);
  showJson('#usage-output', await api(`/usage?${params}`));
}

async function loadSettings() { const data = await api('/settings'); $('#settings-json').value = JSON.stringify(data.settings, null, 2); }

function bind() {
  $$('nav button').forEach(button => button.addEventListener('click', () => {
    $$('nav button,.page').forEach(node => node.classList.remove('active'));
    button.classList.add('active'); $(`#page-${button.dataset.page}`).classList.add('active');
  }));
  $('#dashboard-refresh').addEventListener('click', () => loadDashboard().catch(error => notify(error.message, true)));
  $('#providers-refresh').addEventListener('click', () => loadProviders().catch(error => notify(error.message, true)));
  $('#provider-form').addEventListener('submit', async event => {
    event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/providers', { method: 'POST', body }); event.currentTarget.reset(); notify('Provider added'); await loadProviders(); }
    catch (error) { notify(error.message, true); }
  });
  $('#cc-refresh').addEventListener('click', () => loadCc().catch(error => notify(error.message, true)));
  $('#cc-select-all').addEventListener('click', () => $$('#cc-provider-list input').forEach(input => { input.checked = true; }));
  $('#cc-clear-selection').addEventListener('click', () => $$('#cc-provider-list input').forEach(input => { input.checked = false; }));
  $('#cc-preview').addEventListener('click', () => previewCc().catch(error => notify(error.message, true)));
  $('#cc-snapshot').addEventListener('click', () => confirmedCc('/ccswitch/snapshot', 'CREATE SNAPSHOT').catch(error => notify(error.message, true)));
  $('#cc-apply').addEventListener('click', async () => {
    try {
      const selection = ccSelectionBody();
      const p = await previewCc();
      if (!p.canApply) return;
      if (selection.allProviders) {
        const phrase = 'TAKE OVER ALL PROVIDERS';
        if (window.prompt(`This selects every provider. Type ${phrase} to continue`) !== phrase) return;
        selection.allProvidersConfirmation = phrase;
      }
      await confirmedCc('/ccswitch/apply', 'APPLY TAKEOVER', selection);
    } catch (error) { notify(error.message, true); }
  });
  $('#cc-restore').addEventListener('click', () => confirmedCc('/ccswitch/restore', 'RESTORE').catch(error => notify(error.message, true)));
  $('#cc-force').addEventListener('click', () => confirmedCc('/ccswitch/restore', 'FORCE RESTORE', { force: true }).catch(error => notify(error.message, true)));
  $('#cli-config-cli').addEventListener('change', () => { renderCliConfigProfiles(); loadCliConfig().catch(error => notify(error.message, true)); });
  $('#cli-config-refresh').addEventListener('click', () => loadCliConfig().catch(error => notify(error.message, true)));
  $('#cli-config-preview').addEventListener('click', () => previewCliConfig().catch(error => notify(error.message, true)));
  $('#cli-config-snapshot').addEventListener('click', () => confirmedCliConfig('/cli-config/snapshot', 'CREATE CLI SNAPSHOT').catch(error => notify(error.message, true)));
  $('#cli-config-apply').addEventListener('click', async () => { try { await previewCliConfig(); await confirmedCliConfig('/cli-config/apply', 'APPLY CLI TAKEOVER'); } catch (error) { notify(error.message, true); } });
  $('#cli-config-restore').addEventListener('click', () => confirmedCliConfig('/cli-config/restore', 'RESTORE CLI CONFIG').catch(error => notify(error.message, true)));
  $('#cli-config-force').addEventListener('click', () => confirmedCliConfig('/cli-config/restore', 'FORCE RESTORE CLI CONFIG', { force: true }).catch(error => notify(error.message, true)));
  $('#route-cli').addEventListener('change', renderRouteInputs);
  $('#routes-refresh').addEventListener('click', () => loadRoutes().catch(error => notify(error.message, true)));
  $('#route-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const routes = {};
    for (const role of routeRoles()) { const providerId = String(form.get(`${role}-provider`) || '').trim(); const model = String(form.get(`${role}-model`) || '').trim(); if (providerId) routes[role] = { providerId, ...(model ? { model } : {}) }; }
    try { await api('/routes', { method: 'POST', body: { name: form.get('name'), cli: form.get('cli'), enabled: true, routes } }); event.currentTarget.reset(); renderRouteInputs(); await loadRoutes(); notify('Route profile created'); }
    catch (error) { notify(error.message, true); }
  });
  $('#usage-refresh').addEventListener('click', () => loadUsage().catch(error => notify(error.message, true)));
  $('#settings-refresh').addEventListener('click', () => loadSettings().catch(error => notify(error.message, true)));
  $('#settings-form').addEventListener('submit', async event => { event.preventDefault(); try { const patch = JSON.parse($('#settings-json').value); const data = await api('/settings', { method: 'PATCH', body: patch }); $('#settings-json').value = JSON.stringify(data.settings, null, 2); notify('Settings updated'); } catch (error) { notify(error.message, true); } });
}

async function start() {
  bind(); renderRouteInputs();
  try {
    const response = await fetch('/api/bootstrap'); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'bootstrap failed');
    adminToken = data.adminToken; $('#connection').textContent = 'Local admin connected';
    await loadRoutes();
    await Promise.all([loadDashboard(), loadProviders(), loadCc(), loadCliConfig(), loadUsage(), loadSettings()]);
  } catch (error) { $('#connection').textContent = 'Disconnected'; notify(error.message, true); }
}

start();
