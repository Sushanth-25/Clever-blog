const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const binary = process.env.FIREFOX_BINARY;
const webExt = process.env.WEB_EXT_BIN || 'web-ext';
const enabled = Boolean(binary) && spawnSync(webExt, ['--version'], { timeout: 5000 }).status === 0;

test('Gecko temporarily loads the actual extension and fills through native messaging and storage', { skip: !enabled, timeout: 60000 }, async () => {
  const root = path.join(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleverblog-gecko-'));
  let child;
  let logs = '';
  let timer;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const page = `<!doctype html><html><body>
    <div role="listitem"><div role="heading">Numeric</div><div role="radiogroup">
      <div role="radio" data-value="5" aria-checked="false">5</div>
      <div role="radio" data-value="1.5" aria-checked="false">1.5</div>
    </div></div>
    <div role="listitem"><div role="heading">Select primes</div>
      <div role="listitem"><div role="checkbox" data-answer-value="2" aria-checked="false"><span dir="auto">2</span></div></div>
      <div role="listitem"><div role="checkbox" data-answer-value="3" aria-checked="false"><span dir="auto">3</span></div></div>
      <div role="listitem"><div role="checkbox" data-answer-value="4" aria-checked="false"><span dir="auto">4</span></div></div>
    </div>
    <div role="listitem"><div role="heading">Water</div><input type="text" id="water"></div>
    <button id="submit">Submit</button><script>
    let submitted = false;
    document.getElementById('submit').onclick = () => submitted = true;
    document.querySelectorAll('[role="radio"], [role="checkbox"]').forEach(option => {
      option.onclick = () => option.setAttribute('aria-checked', option.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    });
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function run() {
      let shadow;
      for (let i = 0; i < 300; i++) {
        shadow = document.getElementById('gform-ai-overlay-host')?.shadowRoot;
        if (shadow?.getElementById('navCounter').textContent === 'Question 1 of 3') break;
        await pause(50);
      }
      if (!shadow || shadow.getElementById('navCounter').textContent !== 'Question 1 of 3') throw new Error('Content script did not detect three questions: host=' + Boolean(shadow) + ', counter=' + shadow?.getElementById('navCounter').textContent);
      shadow.getElementById('fillAllBtn').click();
      for (let i = 0; i < 300 && shadow.getElementById('fillAllBtn').disabled; i++) await pause(50);
      const status = shadow.getElementById('batchStatus').textContent;
      if (!status.includes('3/3 processed · 3 filled · 0 skipped')) throw new Error(status + '; ' + shadow.getElementById('batchIssues').textContent);
      if (document.querySelector('[data-value="1.5"]').getAttribute('aria-checked') !== 'true') throw new Error('Radio not filled');
      const checked = Array.from(document.querySelectorAll('[role="checkbox"]')).map(option => option.getAttribute('aria-checked'));
      if (JSON.stringify(checked) !== JSON.stringify(['true', 'true', 'false'])) throw new Error('Checkboxes not filled');
      if (document.getElementById('water').value !== 'H2O') throw new Error('Text not filled');
      if (submitted) throw new Error('Form submitted');
      return { success: true, status, userAgent: navigator.userAgent };
    }
    run().catch(error => ({ success: false, error: error.message })).then(result => fetch('/result', { method: 'POST', body: JSON.stringify(result) }));
    </script></body></html>`;
  const server = http.createServer((request, response) => {
    if (request.url === '/result' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => body += chunk);
      request.on('end', () => {
        response.end('ok');
        try { resolveResult(JSON.parse(body)); } catch (error) { rejectResult(error); }
      });
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(page);
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const file of ['manifest.json', 'models.js', 'background.js', 'background-worker.js', 'popup.html', 'popup.js', 'content.js', 'icons']) {
      fs.cpSync(path.join(root, file), path.join(temp, file), { recursive: true });
    }
    const manifestFile = path.join(temp, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    // Only this isolated test copy receives a loopback matcher and fake responses.
    manifest.content_scripts[0].matches = ['http://127.0.0.1/*'];
    manifest.host_permissions.push('http://127.0.0.1/*');
    manifest.background.scripts.push('smoke-background.js');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    fs.writeFileSync(path.join(temp, 'smoke-background.js'), `
      globalThis.fetch = async (url, options) => {
        const state = await browser.storage.local.get('callbackCheck');
        if (!state.callbackCheck) throw new Error('Popup-style storage callbacks did not complete');
        const prompt = JSON.parse(options.body).contents[0].parts[0].text;
        const text = prompt.includes('Select primes') ? '["2","3"]' : prompt.includes('Water') ? 'H2O' : '1.5';
        return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }) };
      };
      browser.storage.local.set({ apiKey: 'fake-test-key', provider: 'gemini', model: 'gemini-3.5-flash-lite', autoRollover: false }).then(() => {
        chrome.storage.local.get(['apiKey'], config => {
          if (config.apiKey === 'fake-test-key') chrome.storage.local.set({ callbackCheck: true }, () => {});
        });
      });
    `);
    child = spawn(webExt, ['run', '--no-config-discovery', '--source-dir', temp, '--firefox', binary,
      '--no-reload', '--no-input', '--arg=-headless', '--start-url', origin], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-6000); });
    child.on('error', rejectResult);
    child.on('exit', code => rejectResult(new Error(`Browser exited (${code}): ${logs}`)));
    timer = setTimeout(() => rejectResult(new Error(`Gecko smoke test timed out: ${logs}`)), 45000);
    const outcome = await result;
    assert.equal(outcome.success, true, `${outcome.error}\n${logs}`);
    console.log(JSON.stringify(outcome));
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGINT');
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
