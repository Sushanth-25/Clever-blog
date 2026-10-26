const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('shared manifest supplies both browser startup paths and complete packaged references', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background-worker.js');
  assert.deepEqual(manifest.background.scripts, ['models.js', 'background.js']);
  const files = [manifest.background.service_worker, ...manifest.background.scripts,
    manifest.action.default_popup, ...manifest.content_scripts.flatMap(entry => entry.js),
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), `Missing packaged file: ${file}`);
});
test('Firefox declares a stable ID and provider transmission with built-in consent support', () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.match(gecko.id, /^@[a-z0-9.-]+$/);
  assert.ok(Number.parseInt(gecko.strict_min_version, 10) >= 140);
  assert.deepEqual(gecko.data_collection_permissions.required, ['websiteContent', 'authenticationInfo']);
  assert.ok(!gecko.data_collection_permissions.required.includes('none'));
  assert.equal(manifest.browser_specific_settings.gecko_android, undefined);
});
