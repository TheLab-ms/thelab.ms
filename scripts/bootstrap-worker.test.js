// Run with: node --test scripts/bootstrap-worker.test.js
// Exercise the shell entrypoint in isolated projects with a fake Cloudflare CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { edgeJWKS, edgeToken } from '../src/edge-auth.js';

const root = path.resolve(import.meta.dirname, '..');
const mock = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = args[args.indexOf('--cwd') + 1];
const statePath = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath));
const command = args.slice(0, 3).join(' ');
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
save();
const fail = message => { console.error(message); process.exit(1); };
if (state.fail && command.startsWith(state.fail)) fail('Authentication error');
if (command === 'd1 list --json') console.log(JSON.stringify(state.databases));
else if (command.startsWith('d1 create ')) state.databases.push({ name: args[2], uuid: '11111111-2222-4333-8444-555555555555' });
else if (command.startsWith('queues info ')) {
  if (!state.queues.includes(args[2])) fail('Queue "' + args[2] + '" does not exist. To create it, run: wrangler queues create ' + args[2]);
} else if (command.startsWith('queues create ')) state.queues.push(args[2]);
else if (command === 'secret list --format') {
  if (!state.deployed) fail('Worker "thelab-ms" not found.');
  console.log(JSON.stringify(Object.keys(state.secrets).map(name => ({ name }))));
} else if (args[0] === 'deploy') {
  const secrets = JSON.parse(fs.readFileSync(args[args.indexOf('--secrets-file') + 1]));
  state.uploads.push(secrets);
  Object.assign(state.secrets, secrets);
  state.deployed = true;
} else if (command !== 'd1 migrations apply') fail('Unexpected command: ' + command);
save();
`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker bootstrap test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'node_modules/wrangler/bin'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules/wrangler/wrangler-dist'), path.join(dir, 'node_modules/wrangler/wrangler-dist'));
  for (const file of ['scripts/bootstrap-worker.sh', 'wrangler.jsonc', '.dev.vars.example']) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, 'node_modules/wrangler/bin/wrangler.js'), mock);
  const read = file => fs.readFileSync(path.join(dir, file), 'utf8');
  const json = file => JSON.parse(read(file));
  const write = (file, value) => fs.writeFileSync(path.join(dir, file), value);
  const state = () => json('state.json');
  const setState = value => write('state.json', JSON.stringify(value));
  // Model a fresh install independently of the deployed database ID in the repo.
  const config = json('wrangler.jsonc');
  delete config.d1_databases[0].database_id;
  write('wrangler.jsonc', JSON.stringify(config));
  setState({ databases: [], queues: [], secrets: {}, deployed: false, calls: [], uploads: [] });
  const run = (mode, env = {}) => {
    const environment = { ...process.env, ...env };
    for (const name of ['AUTH_SECRET', 'EDGE_JWT_PRIVATE_KEY', 'TURNSTILE_SECRET_KEY',
      'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
      if (!(name in env)) delete environment[name];
    }
    return spawnSync('bash', [path.join(dir, 'scripts/bootstrap-worker.sh'), mode], {
      cwd: os.tmpdir(), env: environment, encoding: 'utf8',
    });
  };
  return { dir, read, json, write, state, setState, run };
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('local setup preserves values and generates a key accepted by the Worker', async t => {
  const f = fixture(t);
  f.write('.dev.vars', 'SITE_URL=http://localhost:8787\nSTRIPE_SECRET_KEY="literal $(exit 1)"\n AUTH_SECRET=\nEDGE_JWT_PRIVATE_KEY=\n');
  success(f.run('--local'));
  const first = f.read('.dev.vars');
  const values = parseEnv(first);
  assert.equal(values.STRIPE_SECRET_KEY, 'literal $(exit 1)');
  assert.ok(Buffer.from(values.AUTH_SECRET, 'base64').length >= 32);
  const key = createPrivateKey({ key: Buffer.from(values.EDGE_JWT_PRIVATE_KEY, 'base64'), format: 'der', type: 'pkcs8' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.equal((fs.statSync(path.join(f.dir, '.dev.vars')).mode & 0o777), 0o600);
  const env = { ...values, EDGE_URL: 'https://edge.example' };
  const jwks = await (await edgeJWKS(null, env)).json();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].x, key.export({ format: 'jwk' }).x);
  assert.equal((await edgeToken(env)).split('.').length, 3);
  success(f.run('--local'));
  assert.equal(f.read('.dev.vars'), first);
  assert.ok(f.state().calls.every(args => args.slice(0, 3).join(' ') === 'd1 migrations apply' && args.includes('--local')));
});

test('remote bootstrap creates resources, migrates before deployment, and preserves secrets on rerun', t => {
  const f = fixture(t);
  success(f.run('--remote', { STRIPE_SECRET_KEY: 'sk_test_fixture' }));
  const initial = f.state();
  assert.equal(initial.databases.length, 1);
  assert.deepEqual(initial.queues, ['thelab-membership-failed', 'thelab-membership']);
  assert.equal(f.json('wrangler.jsonc').d1_databases[0].database_id, initial.databases[0].uuid);
  assert.equal(initial.secrets.STRIPE_SECRET_KEY, 'sk_test_fixture');
  assert.ok(initial.secrets.AUTH_SECRET);
  assert.ok(initial.secrets.EDGE_JWT_PRIVATE_KEY);
  assert.ok(initial.calls.findIndex(args => args[1] === 'migrations') < initial.calls.findIndex(args => args[0] === 'deploy'));
  assert.equal(fs.statSync(path.join(f.dir, '.env.bootstrap.json')).mode & 0o777, 0o600);
  // Even without the local backup, existing remote keys must not be rotated.
  fs.unlinkSync(path.join(f.dir, '.env.bootstrap.json'));
  success(f.run('--remote', { STRIPE_SECRET_KEY: 'replacement-must-not-upload' }));
  const second = f.state();
  assert.deepEqual(second.secrets, initial.secrets);
  assert.deepEqual(second.uploads[1], {});
  assert.equal(second.databases.length, 1);
  assert.equal(second.queues.length, 2);
});

test('remote bootstrap reuses saved keys after a failed migration', t => {
  const f = fixture(t);
  f.setState({ ...f.state(), fail: 'd1 migrations' });
  assert.notEqual(f.run('--remote').status, 0);
  const keys = f.json('.env.bootstrap.json');
  assert.equal(f.state().deployed, false);
  f.setState({ ...f.state(), fail: null });
  success(f.run('--remote'));
  assert.equal(f.state().secrets.AUTH_SECRET, keys.AUTH_SECRET);
  assert.equal(f.state().secrets.EDGE_JWT_PRIVATE_KEY, keys.EDGE_JWT_PRIVATE_KEY);
});

test('authentication errors are not treated as missing resources or missing Worker', t => {
  for (const fail of ['d1 list', 'queues info', 'secret list']) {
    const f = fixture(t);
    f.setState({ ...f.state(), fail });
    const result = f.run('--remote');
    assert.notEqual(result.status, 0, fail);
    assert.match(result.stderr, /Authentication error/);
    assert.equal(f.state().deployed, false);
    assert.equal(f.state().calls.at(-1).slice(0, 3).join(' ').startsWith(fail), true);
  }
});

test('an unknown configured database ID stops bootstrap', t => {
  const f = fixture(t);
  const config = f.json('wrangler.jsonc');
  config.d1_databases[0].database_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  f.write('wrangler.jsonc', JSON.stringify(config));
  const result = f.run('--remote');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Configured D1 database ID was not found/);
  assert.equal(f.state().calls.length, 1);
});

test('local bootstrap applies real D1 migrations in an isolated project', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir, 'node_modules/wrangler/bin/wrangler.js'));
  fs.symlinkSync(path.join(root, 'node_modules/wrangler/bin/wrangler.js'), path.join(f.dir, 'node_modules/wrangler/bin/wrangler.js'));
  fs.cpSync(path.join(root, 'migrations'), path.join(f.dir, 'migrations'), { recursive: true });
  success(f.run('--local'));
  const result = spawnSync('node', [path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
    'd1', 'execute', 'thelab-membership', '--local', '--json', '--command',
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('members', 'fob_claims') ORDER BY name",
    '--cwd', f.dir, '--config', path.join(f.dir, 'wrangler.jsonc')], {
    encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  success(result);
  assert.deepEqual(JSON.parse(result.stdout)[0].results, [{ name: 'fob_claims' }, { name: 'members' }]);
});
