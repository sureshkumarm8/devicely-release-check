const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { once } = require('events');
const { MANIFEST, REQUIRED_SCRIPTS, sha256 } = require('./release-integrity');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 180000, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-100000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} failed (${signal || code}): ${output}`));
      else resolve(output);
    });
  });
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Packaged backend exited before shutdown');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [code, signal] = await exited;
    if (code !== 0 || signal) throw new Error(`Backend did not shut down cleanly (${signal || code})`);
  } finally {
    clearTimeout(timer);
  }
}

function verifyInstalled(installed) {
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, MANIFEST), 'utf8'));
  for (const [name, digest] of Object.entries(manifest.artifacts)) {
    assert.equal(sha256(fs.readFileSync(path.join(installed, name))), digest, `Installed file differs: ${name}`);
  }
  return manifest;
}

async function smokeTarball(tarball, { reportFile, timeout = 300000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devicely-release-'));
  const report = { schema: 1, tarballSha256: sha256(fs.readFileSync(tarball)), platform: process.platform,
    arch: process.arch, node: process.version, checks: [], success: false };
  let backend;
  let backendStopped = false;
  const check = async (name, action) => {
    await action();
    report.checks.push(name);
  };
  try {
    const data = path.join(root, 'data');
    const temp = path.join(root, 'temp');
    fs.mkdirSync(data);
    fs.mkdirSync(temp);
    const env = {
      PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: temp, TEMP: temp, TMP: temp,
      DEVICELY_DATA_DIR: data, DEVICELY_CONFIG_DIR: data, DEVICELY_TOKEN_DIR: data,
      DEVICELY_TEMP_DIR: temp, DEVICELY_SCREENSHOTS_DIR: path.join(data, 'screenshots'),
      DEVICELY_AUTO_RECONNECT: '0', DEVICELY_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
      DEVICELY_HOST: '127.0.0.1', CI: 'true', npm_config_cache: path.join(root, 'npm-cache'),
    };
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"devicely-release-smoke","private":true}\n');
    await check('production-install-and-postinstall', async () => {
      await run('npm', ['install', path.resolve(tarball), '--omit=dev', '--engine-strict',
        '--foreground-scripts', '--no-audit', '--no-fund'], { cwd: root, env, timeout });
      for (const name of ['devices.conf', 'apps_presets.conf', '.env']) {
        assert.ok(fs.existsSync(path.join(data, name)), `Postinstall did not create ${name}`);
      }
    });
    const installed = path.join(root, 'node_modules/devicely');
    const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.main, 'lib/server.js', 'Package main must point at the backend');
    assert.equal(pkg.bin?.devicely, './bin/devicely.js', 'Package bin must expose the Devicely CLI');
    const cli = path.join(root, 'node_modules/.bin/devicely');
    assert.ok(fs.realpathSync(cli) === fs.realpathSync(path.join(installed, 'bin/devicely.js')), 'npm CLI link points at the wrong file');
    const manifest = verifyInstalled(installed);
    report.version = pkg.version;
    report.commit = manifest.commit;
    report.sourceDigest = manifest.sourceDigest;
    await check('production-dependency-tree', () =>
      run('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: root, env }));
    await check('cli-version', async () => {
      const output = await run(cli, ['--version'], { cwd: root, env });
      assert.equal(output.trim(), pkg.version, 'CLI version must match the package exactly');
    });
    await check('cli-help', async () => {
      const output = await run(cli, ['--help'], { cwd: root, env });
      assert.match(output, /start/);
      assert.match(output, /mcp/);
    });
    await check('encrypted-script-roundtrip-and-syntax', () => run(process.execPath, ['-e', `
      const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
      const {spawnSync}=require('child_process');
      const installed=process.argv[1];
      const {decrypt}=require(path.join(installed,'lib/encryption.js'));
      const manifest=require(path.join(installed,'${MANIFEST}'));
      for(const name of ${JSON.stringify(REQUIRED_SCRIPTS)}) {
        const file='scripts/shell/'+name+'.enc';
        const plaintext=decrypt(fs.readFileSync(path.join(installed,file),'utf8'));
        assert.equal(crypto.createHash('sha256').update(plaintext).digest('hex'),manifest.scripts[file],file+' does not decrypt to its source');
        const result=spawnSync('bash',['-n'],{input:plaintext,encoding:'utf8'});
        assert.equal(result.status,0,file+' has invalid shell syntax');
      }
    `, installed], { cwd: root, env }));
    await check('native-sharp-png', () => run(process.execPath, ['-e', `
      const assert=require('assert/strict');
      const sharp=require(require.resolve('sharp',{paths:[process.argv[1]]}));
      sharp({create:{width:2,height:2,channels:4,background:'#ffffff'}}).png().toBuffer()
        .then(buffer=>assert.equal(buffer.subarray(1,4).toString(),'PNG'))
        .catch(err=>{console.error(err.message);process.exitCode=1;});
    `, installed], { cwd: root, env }));
    const port = await freePort();
    env.PORT = String(port);
    backend = spawn(process.execPath, ['-e', `
      require(process.argv[1]).startServer({port:${port},host:'127.0.0.1',browser:false,discover:false})
        .catch(err=>{console.error(err.message);process.exit(1);});
    `, installed], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let backendLog = '';
    backend.stdout.on('data', chunk => { backendLog = (backendLog + chunk).slice(-20000); });
    backend.stderr.on('data', chunk => { backendLog = (backendLog + chunk).slice(-20000); });
    let spawnError;
    backend.on('error', err => { spawnError = err; });
    const base = `http://127.0.0.1:${port}`;
    await check('backend-health-and-version', async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (backend.exitCode !== null || backend.signalCode !== null) throw new Error(`Backend startup failed: ${backendLog}`);
        let response;
        try { response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); }
        catch (err) {
          if (err.cause?.code !== 'ECONNREFUSED' && err.name !== 'TimeoutError') throw err;
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        assert.equal(response.status, 200);
        const health = await response.json();
        assert.equal(health.status, 'ok');
        assert.equal(health.version, pkg.version);
        return;
      }
      throw new Error(`Backend startup timed out: ${backendLog}`);
    });
    const token = fs.readFileSync(path.join(data, 'mcp-token'), 'utf8').trim();
    const request = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(10000) });
    await check('agent-api-auth-and-operation-routes', async () => {
      assert.equal((await request('/api/v1/operations/release-smoke')).status, 401);
      assert.equal((await request('/api/v1/operations/release-smoke', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
      const operation = await request('/api/v1/operations/release-smoke', { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(operation.status, 404);
      assert.deepEqual(await operation.json(), { success: false, error: { code: 'NOT_FOUND', message: 'Operation not found' } });
      assert.equal((await request('/api/v1/operations/release-smoke', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.invalid' } })).status, 403);
      const replay = await request('/api/recording/operations/release-smoke', { headers: { Origin: 'https://devicely-ai.vercel.app' } });
      assert.equal(replay.status, 404);
      assert.deepEqual(await replay.json(), { success: false, error: { code: 'NOT_FOUND', message: 'Replay operation not found' } });
    });
    await check('mcp-initialize-and-tool-list', async () => {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      assert.equal((await request('/mcp', { method: 'POST', headers: { ...headers, Authorization: '' }, body: '{}' })).status, 401);
      const rpc = async (body, notification = false) => {
        const response = await request('/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`MCP HTTP status ${response.status}: ${await response.text()}`);
        const session = response.headers.get('mcp-session-id');
        if (session) headers['mcp-session-id'] = session;
        if (notification) return;
        const text = await response.text();
        const data = response.headers.get('content-type')?.includes('text/event-stream')
          ? text.split('\n').find(line => line.startsWith('data: '))?.slice(6) : text;
        const result = JSON.parse(data);
        assert.equal(result.error, undefined, 'MCP returned an RPC error');
        return result.result;
      };
      const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'release-smoke', version: '1.0.0' } } });
      assert.equal(initialized.serverInfo.version, pkg.version);
      headers['MCP-Protocol-Version'] = initialized.protocolVersion;
      await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
      const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const names = listed.tools.map(tool => tool.name);
      for (const name of ['devicely_list_devices', 'devicely_snapshot', 'devicely_replay_recording']) assert.ok(names.includes(name), `MCP missing ${name}`);
    });
    await check('ui-websocket-connect', async () => {
      // The UI's first connection; a throw in the connection handler kills the backend.
      const WebSocket = require(require.resolve('ws', { paths: [installed] }));
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: 'https://devicely-ai.vercel.app' } });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`No devices_updated over WebSocket: ${backendLog}`)), 10000);
          ws.on('message', message => {
            if (JSON.parse(message).type === 'devices_updated') { clearTimeout(timer); resolve(); }
          });
          ws.on('error', err => { clearTimeout(timer); reject(err); });
        });
      } finally {
        ws.terminate();
      }
      assert.equal((await request('/api/health')).status, 200, `Backend died after WebSocket connect: ${backendLog}`);
    });
    await check('clean-backend-shutdown', async () => {
      await stopChild(backend);
      backendStopped = true;
    });
    report.success = true;
    return report;
  } finally {
    if (backend && !backendStopped && backend.exitCode === null && backend.signalCode === null) {
      const exited = once(backend, 'exit');
      backend.kill('SIGKILL');
      await exited;
    }
    if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const tarball = args[args.indexOf('--tarball') + 1];
  const reportFile = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;
  if (!args.includes('--tarball') || !tarball) {
    console.error('Usage: node scripts/release/tarball-smoke.js --tarball <file> [--report <file>]');
    process.exitCode = 1;
  } else {
    smokeTarball(tarball, { reportFile }).then(report => {
      console.log(`PASS: ${report.checks.length} tarball checks on ${report.platform}/${report.arch}, Node ${report.node}`);
    }).catch(err => { console.error(`FAIL: ${err.message}`); process.exitCode = 1; });
  }
}

module.exports = { run, verifyInstalled, smokeTarball };
