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
  runFixture(fixture);
});

test('one-shot fills supported controls, reuses cache, skips unmatched answers, and stops on cancellation or changed forms', { skip: !available }, () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  runFixture(`<!doctype html><html><body>
  <main id="questions"></main><button id="next-section">Next</button><button id="submit">Submit</button>
  <pre id="test-results">RUNNING</pre><script>
  const fixture = document.getElementById('questions');
  let navigationClicks = 0;
  document.getElementById('next-section').onclick = document.getElementById('submit').onclick = () => navigationClicks++;
  function question(title, type, options = []) {
    const node = document.createElement('div'); node.setAttribute('role', 'listitem');
    const heading = document.createElement('div'); heading.setAttribute('role', 'heading'); heading.textContent = title; node.appendChild(heading);
    const controls = [];
    if (type === 'text' || type === 'paragraph' || type === 'editable') {
      const field = document.createElement(type === 'paragraph' ? 'textarea' : type === 'editable' ? 'div' : 'input');
      if (type === 'text') field.type = 'text';
      if (type === 'editable') { field.setAttribute('role', 'textbox'); field.contentEditable = 'true'; }
      field.dataset.events = '';
      for (const event of ['input', 'change']) field.addEventListener(event, () => field.dataset.events += event + ',');
      controls.push(field); node.appendChild(field);
    } else {
      const group = document.createElement('div');
      if (type === 'dropdown') group.setAttribute('role', 'listbox');
      node.appendChild(group);
      for (const text of options) {
        const option = document.createElement('div');
        option.setAttribute('role', type === 'dropdown' ? 'option' : type);
        option.setAttribute('data-value', text); option.setAttribute('data-answer-value', text); option.setAttribute('aria-checked', 'false');
        option.textContent = text; option.dataset.clicks = '0';
        if (type === 'dropdown') option.hidden = true;
        option.onclick = event => {
          event.stopPropagation(); option.dataset.clicks = String(Number(option.dataset.clicks) + 1);
          if (type === 'radio') controls.forEach(control => control.setAttribute('aria-checked', 'false'));
          option.setAttribute('aria-checked', option.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          if (type === 'dropdown') controls.forEach(control => control.hidden = true);
        };
        group.appendChild(option); controls.push(option);
      }
      if (type === 'dropdown') group.onclick = () => controls.forEach(control => control.hidden = false);
    }
    fixture.appendChild(node); return { node, controls };
  }
  const numeric = question('Numeric', 'radio', ['5', '1.5']);
  const primes = question('Primes', 'checkbox', ['2', '3', '4']);
  const planet = question('Planet', 'dropdown', ['Earth', 'Mars']);
  const short = question('Water', 'text');
  const paragraph = question('Paragraph', 'paragraph');
  const editable = question('Editable', 'editable');
  const unmatched = question('Unmatched', 'radio', ['A', 'B']);
  const readonly = question('Read only', 'text'); readonly.controls[0].readOnly = true;
  const last = question('Last', 'radio', ['No', 'Yes']);
  const answers = {
    Numeric: ['1.5', [1]], Primes: ['2\\n3', [0, 1]], Planet: ['Mars', [1]], Water: ['H2O', []],
    Paragraph: ['A short paragraph.', []], Editable: ['Editable answer', []], Unmatched: ['Unknown', []],
    'Read only': ['Leave alone', []], Last: ['Yes', [1]]
  };
  const requests = [];
  let automatic = true, pending;
  function success(answer, indices) { return { success: true, answer, matchedIndices: indices, modelUsed: 'test-model', sessionRequests: requests.length }; }
  const chrome = { runtime: { sendMessage(message, callback) {
    requests.push(message);
    if (!automatic) { pending = callback; return; }
    const [answer, indices] = answers[message.data.questionText];
    setTimeout(() => callback(success(answer, indices)), 1);
  } } };
  </script><script>${source.replaceAll('</script', '<\\/script')}</script><script>
  const checks = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function check(condition, label) { if (!condition) throw new Error(label); checks.push(label); }
  async function until(condition) {
    for (let i = 0; i < 300; i++) { if (condition()) return; await pause(5); }
    throw new Error('Timed out after: ' + checks.at(-1) + '; ' + document.getElementById('gform-ai-overlay-host').shadowRoot.getElementById('batchStatus').textContent);
  }
  async function run() {
    await pause(750);
    const shadow = document.getElementById('gform-ai-overlay-host').shadowRoot;
    const el = id => shadow.getElementById(id);
    check(el('stopFillBtn').hidden, 'Stop initially hidden');
    el('getAnswerBtn').click(); await until(() => !el('getAnswerBtn').disabled);
    check(numeric.controls[1].getAttribute('aria-checked') === 'false', 'single request still requires manual selection');
    primes.controls[2].click(); // Incorrect pre-existing checkbox must be cleared.
    el('autoSolveCheck').checked = true; el('autoSolveCheck').dispatchEvent(new Event('change'));
    el('fillAllBtn').click();
    check(el('getAnswerBtn').disabled && el('nextBtn').disabled && el('autoSolveCheck').disabled, 'conflicting controls disabled during batch');
    await until(() => !el('fillAllBtn').disabled);
    check(numeric.controls[1].getAttribute('aria-checked') === 'true', 'numeric radio filled');
    check(JSON.stringify(primes.controls.map(control => control.getAttribute('aria-checked'))) === JSON.stringify(['true', 'true', 'false']), 'checkbox set replaced with all correct matches');
    check(planet.controls[1].getAttribute('aria-checked') === 'true', 'dropdown opened and selected');
    check(short.controls[0].value === 'H2O' && short.controls[0].dataset.events === 'input,change,', 'short answer filled with native events');
    check(paragraph.controls[0].value === 'A short paragraph.', 'paragraph filled');
    check(editable.controls[0].textContent === 'Editable answer', 'contenteditable field filled');
    check(unmatched.controls.every(control => control.getAttribute('aria-checked') === 'false'), 'unmatched options left untouched');
    check(readonly.controls[0].value === '', 'read-only field left untouched');
    check(last.controls[1].getAttribute('aria-checked') === 'true', 'continues after skipped questions');
    check(el('batchStatus').textContent.includes('9/9 processed · 7 filled · 2 skipped'), 'progress totals reflect skipped questions');
    check(el('batchIssues').textContent.includes('Unmatched') && el('batchIssues').textContent.includes('Read only'), 'skip reasons identify questions');
    check(requests.length === 9, 'cached answer reused and requests stay sequential');
    const before = requests.length;
    el('fillAllBtn').click(); await until(() => !el('fillAllBtn').disabled);
    check(requests.length === before && numeric.controls[1].dataset.clicks === '1', 'cached second run is idempotent');
    check(navigationClicks === 0, 'never navigates or submits automatically');
    // Stop while a provider request is pending: late answers must not fill fields.
    automatic = false; fixture.replaceChildren();
    const slow = question('Slow', 'text'); question('Never requested', 'text');
    el('rescanBtn').click(); el('fillAllBtn').click();
    const countBeforeStop = requests.length;
    el('stopFillBtn').click();
    check(el('batchStatus').textContent.includes('Stopping'), 'pending stop visible');
    pending(success('Late answer', [])); await until(() => !el('fillAllBtn').disabled);
    check(slow.controls[0].value === '' && requests.length === countBeforeStop, 'Stop suppresses late fill and additional requests');
    check(el('batchStatus').textContent.startsWith('Stopped.'), 'stopped state reported');
    // Reused question node changes options during inference.
    fixture.replaceChildren(); const changed = question('Changing', 'radio', ['Old', 'Other']);
    el('rescanBtn').click(); el('fillAllBtn').click();
    changed.controls[0].setAttribute('data-value', 'New'); changed.controls[0].textContent = 'New';
    pending(success('Old', [0])); await until(() => !el('fillAllBtn').disabled);
    check(changed.controls[0].getAttribute('aria-checked') === 'false' && el('batchStatus').textContent.includes('Form changed'), 'changed form stops without stale selection');
    // A provider failure should stop rather than retry every remaining question.
    fixture.replaceChildren(); question('Provider failure', 'text'); question('Not sent', 'text');
    el('rescanBtn').click(); el('fillAllBtn').click(); const countAtFailure = requests.length;
    pending({ success: false, error: 'Quota unavailable' }); await until(() => !el('fillAllBtn').disabled);
    check(requests.length === countAtFailure && el('batchStatus').textContent.includes('Request failed'), 'provider failure stops queue');
    check(el('batchIssues').textContent.includes('Quota unavailable'), 'provider error remains visible');
    document.getElementById('test-results').textContent = 'PASS: ' + checks.join('; ');
  }
  run().catch(error => { document.getElementById('test-results').textContent = 'FAIL: ' + error.message; });
  </script></body></html>`);
});

function runFixture(fixture) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleverblog-browser-'));
  const file = path.join(temp, 'fixture.html');
  fs.writeFileSync(file, fixture);
  try {
    const result = spawnSync(chrome, [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(temp, 'profile')}`, '--dump-dom', '--virtual-time-budget=12000', pathToFileURL(file).href
    ], { encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024 });
    const match = result.stdout?.match(/<pre id="test-results">([^<]*)<\/pre>/);
    assert.equal(result.status, 0, result.error?.message || result.stderr.slice(-2000));
    assert.ok(match, 'Missing browser test result');
    assert.match(match[1], /^PASS:/, match[1]);
    console.log(match[1]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
