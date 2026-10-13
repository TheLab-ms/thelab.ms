// Run with: node --test scripts/bootstrap-worker.test.js
// Exercise the shell helper and npm lifecycle with a fake CLI; no Cloudflare calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { edgeJWKS, edgeToken } from '../src/services.js';

const root = path.resolve(import.meta.dirname, '..');
const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : process.cwd();
const statePath = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath));
const config = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc')));
const command = args.slice(0, 3).join(' ');
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
save();
const fail = message => { console.error(message); process.exit(1); };
if (state.fail && command.startsWith(state.fail)) fail('CLI failure');
if (command === 'd1 migrations apply') {
  if (args[3] !== 'DB') fail('Expected binding DB');
  if (args.includes('--remote') && config.d1_databases[0].database_id !== state.databaseId) {
    fail('Database not found');
  }
  state.migrated = true;
} else if (args[0] === 'deploy') {
  if (!state.migrated) fail('Schema must be ready before deploy');
  const secrets = args.includes('--secrets-file') ?
    JSON.parse(fs.readFileSync(path.join(root, args[args.indexOf('--secrets-file') + 1]))) : {};
  const combined = { ...state.secrets, ...secrets };
  if (config.secrets.required.some(name => !(name in combined))) fail('Missing required secrets');
  state.uploads.push(secrets);
  state.secrets = combined;
  state.deployed = true;
} else fail('Unexpected command: ' + command);
save();
`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker bootstrap test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'node_modules/wrangler/bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules/.bin'));
  for (const file of ['scripts/bootstrap-worker.sh', 'package.json', 'wrangler.jsonc', '.dev.vars.example']) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, 'node_modules/wrangler/bin/wrangler.js'), mock, { mode: 0o755 });
  fs.symlinkSync('../wrangler/bin/wrangler.js', path.join(dir, 'node_modules/.bin/wrangler'));
  const read = file => fs.readFileSync(path.join(dir, file), 'utf8');
  const json = file => JSON.parse(read(file));
  const write = (file, value) => fs.writeFileSync(path.join(dir, file), value);
  const state = () => json('state.json');
  const setState = value => write('state.json', JSON.stringify(value));
  setState({ databaseId: json('wrangler.jsonc').d1_databases[0].database_id,
    secrets: {}, calls: [], uploads: [], deployed: false });
  const run = (...args) => spawnSync('bash', [path.join(dir, 'scripts/bootstrap-worker.sh'), ...args], {
    cwd: os.tmpdir(), encoding: 'utf8',
  });
  const deploy = (...args) => spawnSync('npm', ['run', 'deploy', '--', ...args], {
    cwd: dir, encoding: 'utf8',
  });
  return { dir, read, json, write, state, setState, run, deploy };
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function privateFile(f, file) {
  assert.equal(fs.statSync(path.join(f.dir, file)).mode & 0o777, 0o600);
}

test('local setup preserves values and generates a key accepted by the Worker', async t => {
  const f = fixture(t);
  const config = f.read('wrangler.jsonc');
  f.write('.dev.vars', 'SITE_URL=http://localhost:8787\nSTRIPE_SECRET_KEY="literal $(exit 1)"\n AUTH_SECRET=\nEDGE_JWT_PRIVATE_KEY=\n');
  const result = f.run('--local');
  success(result);
  const first = f.read('.dev.vars');
  const values = parseEnv(first);
  assert.equal(values.STRIPE_SECRET_KEY, 'literal $(exit 1)');
  assert.ok(Buffer.from(values.AUTH_SECRET, 'base64').length >= 32);
  const key = createPrivateKey({ key: Buffer.from(values.EDGE_JWT_PRIVATE_KEY, 'base64'), format: 'der', type: 'pkcs8' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
  privateFile(f, '.dev.vars');
  for (const value of [values.AUTH_SECRET, values.EDGE_JWT_PRIVATE_KEY]) {
    assert.ok(!(result.stdout + result.stderr).includes(value));
  }
  const env = { ...values, EDGE_URL: 'https://edge.example' };
  const jwks = await (await edgeJWKS(null, env)).json();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].x, key.export({ format: 'jwk' }).x);
  assert.equal((await edgeToken(env)).split('.').length, 3);
  success(f.run('--local'));
  assert.equal(f.read('.dev.vars'), first);
  assert.equal(f.read('wrangler.jsonc'), config);
  assert.ok(f.state().calls.every(args => args.slice(0, 5).join(' ') === 'd1 migrations apply DB --local'));
});

test('local migration failure preserves generated keys for retry', t => {
  const f = fixture(t);
  f.setState({ ...f.state(), fail: 'd1 migrations' });
  assert.notEqual(f.run('--local').status, 0);
  const keys = f.read('.dev.vars');
  privateFile(f, '.dev.vars');
  f.setState({ ...f.state(), fail: null });
  success(f.run('--local'));
  assert.equal(f.read('.dev.vars'), keys);
});

test('first-deploy key preparation is local, private, independent and repeatable', t => {
  const f = fixture(t);
  success(f.run('--local'));
  const local = f.read('.dev.vars');
  const config = f.read('wrangler.jsonc');
  f.setState({ ...f.state(), calls: [] });
  const result = f.run('--secrets');
  success(result);
  const keys = f.json('.env.bootstrap.json');
  assert.notEqual(keys.AUTH_SECRET, parseEnv(local).AUTH_SECRET);
  assert.notEqual(keys.EDGE_JWT_PRIVATE_KEY, parseEnv(local).EDGE_JWT_PRIVATE_KEY);
  for (const value of Object.values(keys)) assert.ok(!(result.stdout + result.stderr).includes(value));
  f.write('.env.bootstrap.json', JSON.stringify({ ...keys, STRIPE_SECRET_KEY: 'keep-provider-value' }));
  fs.chmodSync(path.join(f.dir, '.env.bootstrap.json'), 0o644);
  success(f.run('--secrets'));
  assert.deepEqual(f.json('.env.bootstrap.json'), { ...keys, STRIPE_SECRET_KEY: 'keep-provider-value' });
  privateFile(f, '.env.bootstrap.json');
  assert.equal(f.read('.dev.vars'), local);
  assert.equal(f.read('wrangler.jsonc'), config);
  assert.deepEqual(f.state().calls, []);
});

test('invalid existing keys or JSON fail without replacement, disclosure or CLI calls', t => {
  for (const contents of [
    '{"AUTH_SECRET":"short-private-value"}',
    '{"EDGE_JWT_PRIVATE_KEY":"invalid-private-value"}',
    '{"AUTH_SECRET":null}',
    '{"AUTH_SECRET":"malformed-private-value"',
    '[]',
  ]) {
    const f = fixture(t);
    f.write('.env.bootstrap.json', contents);
    const result = f.run('--secrets');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /short-private-value|invalid-private-value|malformed-private-value/);
    assert.equal(f.read('.env.bootstrap.json'), contents);
    assert.deepEqual(f.state().calls, []);
  }
});

test('existing deploy migrates the configured DB first and does not upload local secrets', t => {
  const f = fixture(t);
  const config = f.read('wrangler.jsonc');
  assert.equal(f.state().databaseId, '3e4bca68-f6db-4ef5-8e92-c80a38f02aa1');
  const secrets = Object.fromEntries(f.json('wrangler.jsonc').secrets.required.map(name => [name, `existing-${name}`]));
  f.setState({ ...f.state(), secrets, deployed: true });
  success(f.run('--secrets'));
  success(f.deploy());
  assert.deepEqual(f.state().calls, [['d1', 'migrations', 'apply', 'DB', '--remote'], ['deploy']]);
  assert.deepEqual(f.state().uploads, [{}]);
  assert.deepEqual(f.state().secrets, secrets);
  assert.equal(f.read('wrangler.jsonc'), config);
});

test('fresh deploy uses an explicitly configured DB and forwards secrets only to deploy', t => {
  const f = fixture(t);
  const config = f.json('wrangler.jsonc');
  config.d1_databases[0].database_id = '11111111-2222-4333-8444-555555555555';
  f.write('wrangler.jsonc', JSON.stringify(config));
  f.setState({ ...f.state(), databaseId: config.d1_databases[0].database_id });
  success(f.run('--secrets'));
  const keys = f.json('.env.bootstrap.json');
  const secrets = { ...Object.fromEntries(config.secrets.required.map(name => [name, `provider-${name}`])), ...keys };
  f.write('.env.bootstrap.json', JSON.stringify(secrets));
  success(f.deploy('--secrets-file', '.env.bootstrap.json'));
  assert.deepEqual(f.state().calls, [
    ['d1', 'migrations', 'apply', 'DB', '--remote'], ['deploy', '--secrets-file', '.env.bootstrap.json'],
  ]);
  assert.deepEqual(f.state().secrets, secrets);
});

test('migration failures or missing databases stop before deployment or provisioning', t => {
  for (const change of [{ fail: 'd1 migrations' }, { databaseId: null }]) {
    const f = fixture(t);
    f.setState({ ...f.state(), ...change });
    assert.notEqual(f.deploy().status, 0);
    assert.deepEqual(f.state().calls, [['d1', 'migrations', 'apply', 'DB', '--remote']]);
    assert.equal(f.state().deployed, false);
  }
});

test('missing secrets or a failed deploy never trigger secret generation or a fallback', t => {
  for (const change of [{}, { fail: 'deploy' }]) {
    const f = fixture(t);
    f.setState({ ...f.state(), ...change });
    const result = f.deploy();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required secrets|CLI failure/);
    assert.equal(f.state().migrated, true);
    assert.equal(f.state().deployed, false);
    assert.equal(fs.existsSync(path.join(f.dir, '.env.bootstrap.json')), false);
    assert.deepEqual(f.state().calls, [['d1', 'migrations', 'apply', 'DB', '--remote'], ['deploy']]);
  }
});

test('unsupported remote mode and extra arguments fail without side effects', t => {
  const f = fixture(t);
  for (const args of [[], ['--remote'], ['--local', '--remote']]) {
    assert.notEqual(f.run(...args).status, 0);
  }
  success(f.run('--help'));
  assert.deepEqual(f.state().calls, []);
  assert.equal(fs.existsSync(path.join(f.dir, '.dev.vars')), false);
});
