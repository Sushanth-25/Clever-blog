const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
function popup(response) {
  const store = { apiKey: 'saved-openai-key', provider: 'openai', model: 'gpt-4o-mini', sessionRequests: 7 };
  const elements = new Map();
  const messages = [];
  const timers = [];
  let ready;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', innerHTML: '', checked: true, listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; }, appendChild() {}, focus() {}
    });
    return elements.get(id);
  }
  const context = vm.createContext({ document: {
    addEventListener(event, fn) { ready = fn; }, getElementById: element, createElement() { return {}; }
  }, setTimeout(fn) { timers.push(fn); }, chrome: { runtime: { sendMessage(message, callback) {
    messages.push(message);
    callback(response || { success: true, activeModel: 'gemini-3.6-flash', message: 'Connected' });
  } }, storage: { local: {
    get(keys, callback) { callback(store); },
    set(values, callback) { Object.assign(store, values); callback?.(); }
  } } } });
  for (const file of ['models.js', 'popup.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  ready();
  return { store, element, messages };
}

test('testing unsaved Gemini settings leaves the saved OpenAI configuration untouched', () => {
  const app = popup();
  const before = structuredClone(app.store);
  app.element('providerSelect').value = 'gemini';
  app.element('modelSelect').value = 'gemini-3.5-flash-lite';
  app.element('apiKeyInput').value = 'unsaved-gemini-key';
  app.element('testBtn').listeners.click();
  assert.deepEqual(app.store, before);
  assert.equal(app.messages[0].data.provider, 'gemini');
  assert.equal(app.messages[0].data.model, 'gemini-3.5-flash-lite');
  assert.equal(app.element('testBtn').disabled, false);
});
test('failed connection test restores button and reports provider failure', () => {
  const app = popup({ success: false, error: 'Model busy' });
  app.element('modelSelect').value = 'gpt-4o-mini';
  app.element('testBtn').listeners.click();
  assert.equal(app.element('alertBanner').textContent, 'Model busy');
  assert.equal(app.element('testBtn').disabled, false);
});
test('only Save Key persists edited provider, model, and key together', () => {
  const app = popup();
  app.element('providerSelect').value = 'gemini';
  app.element('modelSelect').value = 'gemini-3.5-flash-lite';
  app.element('apiKeyInput').value = 'new-key';
  app.element('autoRolloverCheck').checked = false;
  app.element('saveBtn').listeners.click();
  assert.deepEqual(app.store, { apiKey: 'new-key', provider: 'gemini', model: 'gemini-3.5-flash-lite', sessionRequests: 7, autoRollover: false });
});
test('failed reset does not display a fictional success or clear the count', () => {
  const app = popup({ success: false, error: 'Storage failure' });
  app.element('resetSessionBtn').listeners.click();
  assert.equal(app.element('reqCounter').textContent, '7');
  assert.equal(app.element('alertBanner').textContent, 'Storage failure');
});
