const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

function worker(fetchResponse) {
  const store = { apiKey: 'fake-test-key', provider: 'gemini', model: 'gemini-3.5-flash-lite', sessionRequests: 0 };
  const calls = [];
  let listener;
  const context = vm.createContext({
    AbortSignal, console,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } }, storage: { local: {
      async get() { return structuredClone(store); },
      async set(values) { Object.assign(store, structuredClone(values)); }
    } } },
    fetch: async (url, args) => {
      calls.push({ url, headers: args.headers, body: JSON.parse(args.body) });
      return fetchResponse ? fetchResponse(calls.at(-1), calls.length) : gemini('1.5');
    },
    importScripts(file) { vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return { store, calls, run: code => vm.runInContext(code, context), message: data => new Promise(resolve => listener(data, {}, resolve)) };
}
function gemini(text, extraParts = []) {
  return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [...extraParts, { text }] } }] }) };
}
const question = { questionText: 'Choose a number', options: ['5', '1.5'], questionType: 'radio' };

test('exact numeric and punctuated option labels survive cleanup', () => {
  const app = worker();
  for (const answer of ['1.5', '1. Answer', 'C. elegans', '"quoted"', '**bold**']) {
    assert.equal(app.run(`cleanExtractedAnswer(${JSON.stringify(answer)}, [${JSON.stringify(answer)}, "other"])`), answer);
  }
  assert.equal(app.run('cleanExtractedAnswer("1.5", [])'), '1.5');
});
test('matching rejects partial and ambiguous option labels', () => {
  const app = worker();
  assert.equal(app.run('findBestOptionMatch("York", ["New York", "London"])'), -1);
  assert.equal(app.run('findBestOptionMatch("yes", ["Yes", "YES"])'), -1);
  assert.equal(app.run('findBestOptionMatch(" yes ", ["Yes", "No"])'), 0);
});
test('checkbox answers return every exact match and deduplicate indices', async () => {
  const app = worker(() => gemini('["3", "2", "3"]'));
  const response = await app.message({ action: 'GET_ANSWER', data: { questionText: 'All primes?', options: ['2', '3', '4'], questionType: 'checkbox' } });
  assert.equal(response.success, true);
  assert.deepEqual(Array.from(response.matchedIndices), [0, 1]);
  assert.equal(response.answer, '2\n3');
  assert.match(app.calls[0].body.contents[0].parts[0].text, /ALL correct options/);
});
test('malformed and unmatched checkbox answers fail without counting success', async () => {
  for (const text of ['2 and 3', '["2", "unknown"]', '[]', '[2]']) {
    const app = worker(() => gemini(text));
    const response = await app.message({ action: 'GET_ANSWER', data: { questionText: 'All primes?', options: ['2', '3'], questionType: 'checkbox' } });
    assert.equal(response.success, false);
    assert.equal(app.store.sessionRequests, 0);
  }
});
test('simultaneous successful answers retain every counter increment', async () => {
  const app = worker();
  const results = await Promise.all(Array.from({ length: 10 }, () => app.message({ action: 'GET_ANSWER', data: question })));
  assert.ok(results.every(result => result.success));
  assert.equal(app.store.sessionRequests, 10);
  assert.equal(app.store.modelRequests['gemini-3.5-flash-lite'], 10);
  assert.equal(new Set(results.map(result => result.sessionRequests)).size, 10);
});
test('fallback uses HTTP status and counts the model that actually answered', async () => {
  const app = worker((call, count) => count === 1
    ? { ok: false, status: 429, json: async () => ({ error: { message: 'Capacity unavailable' } }) }
    : gemini('1.5'));
  const response = await app.message({ action: 'GET_ANSWER', data: question });
  assert.equal(response.success, true);
  assert.equal(response.modelUsed, 'gemini-3-flash-preview');
  assert.equal(response.tierSwitched, true);
  assert.equal(app.store.model, 'gemini-3.5-flash-lite');
  assert.equal(app.store.modelRequests['gemini-3-flash-preview'], 1);
  assert.equal(app.store.modelRequests['gemini-3.5-flash-lite'], undefined);
});
test('disabled fallback and authentication failures never try another model', async () => {
  for (const status of [400, 401, 403, 429]) {
    const app = worker(() => ({ ok: false, status, json: async () => ({ error: { message: 'Rejected' } }) }));
    app.store.autoRollover = false;
    const result = await app.message({ action: 'GET_ANSWER', data: question });
    assert.equal(result.success, false);
    assert.equal(app.calls.length, 1);
  }
});
test('authentication errors do not trigger enabled fallback, but timeouts do', async () => {
  const rejected = worker(() => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Denied' } }) }));
  assert.equal((await rejected.message({ action: 'GET_ANSWER', data: question })).success, false);
  assert.equal(rejected.calls.length, 1);
  const timedOut = worker((call, count) => {
    if (count === 1) throw new DOMException('Timed out', 'TimeoutError');
    return gemini('1.5');
  });
  assert.equal((await timedOut.message({ action: 'GET_ANSWER', data: question })).modelUsed, 'gemini-3-flash-preview');
});
test('connection testing uses exactly the chosen model and never persists settings', async () => {
  const app = worker(() => ({ ok: false, status: 503, json: async () => ({ error: { message: 'Busy' } }) }));
  app.store.provider = 'openai';
  app.store.model = 'gpt-4o-mini';
  const before = structuredClone(app.store);
  const result = await app.message({ action: 'TEST_CONNECTION', data: { apiKey: 'unsaved-key', provider: 'gemini', model: 'gemini-3.6-flash' } });
  assert.equal(result.success, false);
  assert.equal(app.calls.length, 1);
  assert.match(app.calls[0].url, /gemini-3.6-flash:generateContent$/);
  assert.deepEqual(app.store, before);
});
test('successful connection tests also leave counters and settings untouched', async () => {
  const app = worker(() => gemini('Connected'));
  const before = structuredClone(app.store);
  assert.equal((await app.message({ action: 'TEST_CONNECTION', data: { apiKey: 'unsaved-key', provider: 'gemini', model: 'gemini-3.6-flash' } })).success, true);
  assert.deepEqual(app.store, before);
});
test('model allowlist rejects the invalid alias and unavailable models before calling API', async () => {
  const app = worker();
  for (const model of ['gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gpt-4o-mini']) {
    app.store.model = model;
    assert.equal((await app.message({ action: 'GET_ANSWER', data: question })).success, false);
  }
  assert.equal(app.calls.length, 0);
});
test('Gemini key is sent in headers, and thought parts do not become answers', async () => {
  const app = worker(() => gemini('1.5', [{ thought: true, text: 'private reasoning' }]));
  const response = await app.message({ action: 'GET_ANSWER', data: question });
  assert.equal(response.answer, '1.5');
  assert.ok(!app.calls[0].url.includes('fake-test-key'));
  assert.equal(app.calls[0].headers['x-goog-api-key'], 'fake-test-key');
});
test('truncated answers are rejected before matching and counting', async () => {
  const app = worker(() => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '5' }] } }] }) }));
  const response = await app.message({ action: 'GET_ANSWER', data: question });
  assert.equal(response.success, false);
  assert.equal(app.store.sessionRequests, 0);
});
test('OpenAI path returns matching metadata and does not use a Gemini model', async () => {
  const app = worker(() => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '1.5' } }] }) }));
  app.store.provider = 'openai';
  app.store.model = 'gpt-4o-mini';
  const result = await app.message({ action: 'GET_ANSWER', data: question });
  assert.equal(result.success, true);
  assert.equal(result.modelUsed, 'gpt-4o-mini');
  assert.equal(app.calls[0].body.model, 'gpt-4o-mini');
});
test('reset waits for earlier counter writes', async () => {
  const app = worker();
  await app.run('Promise.all([updateCounters("model"), updateCounters("model"), updateCounters()])');
  assert.equal(app.store.sessionRequests, 0);
  assert.deepEqual(app.store.modelRequests, {});
  assert.equal(await app.run('updateCounters("model")'), 1);
});
test('storage errors are returned to callers without blocking later counter updates', async () => {
  const app = worker();
  app.run(`const save = chrome.storage.local.set;
    let fail = true;
    chrome.storage.local.set = async values => {
      if (fail) { fail = false; throw new Error('Storage failure'); }
      return save(values);
    };`);
  await assert.rejects(app.run('updateCounters("model")'), /Storage failure/);
  assert.equal(await app.run('updateCounters("model")'), 1);
});
