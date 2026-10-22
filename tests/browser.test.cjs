const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const chrome = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome');
const available = spawnSync(chrome, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0;

test('content overlay handles cache isolation, sections, checkbox selection, metadata, and pending navigation', { skip: !available }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleverblog-browser-'));
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <main id="questions"></main><pre id="test-results">RUNNING</pre>
  <script>
  const fixture = document.getElementById('questions');
  function question(title, options, type = 'radio') {
    const node = document.createElement('div');
    node.setAttribute('role', 'listitem');
    node.innerHTML = '<div role="heading"></div>';
    node.firstChild.textContent = title;
    for (const text of options) {
      const option = document.createElement('div');
      option.setAttribute('role', type);
      option.setAttribute('data-value', text);
      option.setAttribute('data-answer-value', text);
      option.setAttribute('aria-checked', 'false');
      option.textContent = text;
      option.onclick = () => option.setAttribute('aria-checked', option.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      if (type === 'checkbox') {
        const wrapper = document.createElement('div');
        wrapper.setAttribute('role', 'listitem');
        const label = document.createElement('span');
        label.setAttribute('dir', 'auto');
        label.textContent = text;
        option.textContent = '';
        option.appendChild(label);
        wrapper.appendChild(option);
        node.appendChild(wrapper);
      } else {
        node.appendChild(option);
      }
    }
    fixture.appendChild(node);
    return node;
  }
  const a = question('Same title', ['Red', 'Green']);
  const b = question('Same title', ['Blue', 'Yellow']);
  let pending = null;
  let requests = 0;
  const chrome = { runtime: { sendMessage(message, callback) { requests++; pending = callback; } } };
  function reply(answer, indices, model = 'gpt-4o-mini', count = 12) {
    const callback = pending; pending = null;
    callback({ success: true, answer, matchedIndices: indices, modelUsed: model, sessionRequests: count, tierSwitched: true });
  }
  </script><script>${source.replaceAll('</script', '<\\/script')}</script><script>
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [];
  function check(condition, label) { if (!condition) throw new Error(label); checks.push(label); }
  async function run() {
    await pause(750);
    const shadow = document.getElementById('gform-ai-overlay-host').shadowRoot;
    const el = id => shadow.getElementById(id);
    check(el('questionTitle').textContent.includes('Same title'), 'initial scrape');
    el('getAnswerBtn').click(); reply('Red', [0]); await pause(0);
    check(el('resultContainer').textContent.includes('gpt-4o-mini'), 'actual model retained');
    check(el('resultContainer').textContent.includes('12'), 'actual counter retained');
    check(!el('resultContainer').textContent.includes('/ 40'), 'fictional quota removed');
    el('nextBtn').click();
    check(!el('resultContainer').textContent.includes('Red'), 'duplicate title cache isolated');
    el('prevBtn').click();
    check(el('resultContainer').textContent.includes('Red'), 'same question cache retained');
    a.querySelector('[role="radio"]').setAttribute('data-value', 'Purple');
    a.querySelector('[role="radio"]').textContent = 'Purple';
    await pause(450);
    check(!el('resultContainer').textContent.includes('Red'), 'changed options invalidate cached answer');
    // Keep one question so subsequent replacement has the same count.
    fixture.replaceChildren();
    question('Old section', ['Old choice']); await pause(450);
    check(el('questionTitle').textContent.includes('Old section'), 'section count change');
    fixture.replaceChildren();
    const checkbox = question('All primes', ['2', '3', '4'], 'checkbox'); await pause(450);
    check(el('questionTitle').textContent.includes('All primes'), 'same-sized section refresh');
    check(el('navCounter').textContent === 'Question 1 of 1', 'nested checkbox items are not counted as questions');
    el('getAnswerBtn').click(); reply('2\\n3', [0, 1]); await pause(0);
    checkbox.querySelectorAll('[role="checkbox"]')[2].click(); // Pre-existing incorrect checkbox must be cleared.
    el('selectOptionBtn').click();
    const checked = () => Array.from(checkbox.querySelectorAll('[role="checkbox"]')).map(option => option.getAttribute('aria-checked'));
    check(JSON.stringify(checked()) === JSON.stringify(['true', 'true', 'false']), 'all correct checkboxes selected');
    el('selectOptionBtn').click();
    check(JSON.stringify(checked()) === JSON.stringify(['true', 'true', 'false']), 'checkbox selection idempotent');
    fixture.replaceChildren();
    question('Slow first question', ['First']); question('Next question', ['Next']); await pause(450);
    el('getAnswerBtn').click(); el('nextBtn').click(); reply('First', [0]); await pause(0);
    check(!el('resultContainer').textContent.includes('First'), 'late answer does not replace active question');
    el('prevBtn').click();
    check(el('resultContainer').textContent.includes('First'), 'late answer cached for original question');
    const toggle = el('autoSolveCheck'); toggle.checked = true; toggle.dispatchEvent(new Event('change'));
    el('getAnswerBtn').click(); const before = requests; el('nextBtn').click(); reply('First', [0]); await pause(0);
    check(requests === before + 1 && pending, 'auto-solve follows navigation after pending request');
    reply('Next', [0]); await pause(0);
    check(el('resultContainer').textContent.includes('Next'), 'new active question gets its own answer');
    const host = document.getElementById('gform-ai-overlay-host');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fixture });
    document.dispatchEvent(new Event('fullscreenchange'));
    check(host.parentElement === fixture, 'overlay moves inside fullscreen element');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    document.dispatchEvent(new Event('fullscreenchange'));
    check(host.parentElement === document.documentElement, 'overlay restored after fullscreen');
    document.getElementById('test-results').textContent = 'PASS: ' + checks.join('; ');
  }
  run().catch(error => { document.getElementById('test-results').textContent = 'FAIL: ' + error.message; });
  </script></body></html>`;
  const file = path.join(temp, 'fixture.html');
  fs.writeFileSync(file, fixture);
  try {
    const result = spawnSync(chrome, [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(temp, 'profile')}`, '--dump-dom', '--virtual-time-budget=8000', pathToFileURL(file).href
    ], { encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024 });
    const match = result.stdout?.match(/<pre id="test-results">([^<]*)<\/pre>/);
    assert.equal(result.status, 0, result.error?.message || result.stderr.slice(-2000));
    assert.ok(match, 'Missing browser test result');
    assert.match(match[1], /^PASS:/, match[1]);
    console.log(match[1]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
