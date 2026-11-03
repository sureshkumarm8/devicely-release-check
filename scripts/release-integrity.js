const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MANIFEST = 'release-manifest.json';
const REQUIRED_SCRIPTS = [
  'android_device_control', 'connect_android_usb_multi_final',
  'connect_android_wireless', 'connect_android_wireless_multi_final',
  'connect_ios_usb_multi_final', 'connect_ios_wireless_multi_final', 'ios_device_control',
];
const REQUIRED_FILES = [
  'package.json', 'README.md', 'LICENSE', 'NOTICE', 'bin/devicely.js',
  'lib/server.js', 'lib/encryption.js', 'lib/dataPaths.js',
  'lib/api/v1/index.js', 'lib/api/v1/auth.js', 'lib/mcp/index.js',
  'lib/mcp/http.js', 'lib/mcp/stdio.js', 'lib/virtualDevices/index.js',
  'scripts/postinstall.js', 'config/devices.conf', 'config/apps_presets.conf',
  'apks/appium-uiautomator2-server.apk', 'apks/appium-uiautomator2-server-test.apk',
  ...REQUIRED_SCRIPTS.map(name => `scripts/shell/${name}.enc`),
];
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');
const portable = name => name.split(path.sep).join('/');
const excluded = name => ['node_modules', '.git', 'tests', '__tests__', 'frontend', 'public', 'screenshots',
  'coverage', 'dist', 'package-lock.json', 'tsconfig.json', 'eslint.config.js', 'jest.config.js',
  'logger-integration-examples.js', 'logger-demo.js', '.DS_Store', '.gitignore'].includes(name)
  || /\.(test|spec)\.js$|\.log$|\.map$|\.bak$|\.backup|\.strategic-backup|^\.env/.test(name);

function filesIn(dir, skip = () => false) {
  if (!fs.existsSync(dir)) throw new Error(`Required directory missing: ${path.basename(dir)}`);
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (skip(entry.name)) return [];
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${entry.name}`);
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(full, skip) : [full];
  });
}

function hashes(root, files) {
  return Object.fromEntries(files.sort().map(file => [portable(path.relative(root, file)), sha256(fs.readFileSync(file))]));
}

function sourceHashes(repo) {
  const files = ['webapp/backend', 'bin', 'scripts/device', 'scripts/release'].flatMap(dir =>
    filesIn(path.join(repo, dir), excluded));
  for (const name of ['package.json', 'npm-package/package.json', 'sync-to-npm-package.sh',
    'server.json', 'devices.conf', 'apps_presets.conf', 'README.md', 'LICENSE', 'NOTICE']) {
    files.push(path.join(repo, name));
  }
  files.push(...filesIn(path.join(repo, 'npm-package/apks')));
  for (const name of ['CHANGELOG.md', 'deviceDetection.js', 'androidDeviceDetection.js']) {
    if (fs.existsSync(path.join(repo, name))) files.push(path.join(repo, name));
  }
  return hashes(repo, files);
}

function artifactHashes(dist) {
  return hashes(dist, filesIn(dist, name => name === MANIFEST || name === 'node_modules' || name.endsWith('.tgz')));
}

function expectedFiles(repo) {
  const backend = filesIn(path.join(repo, 'webapp/backend'), excluded)
    .map(file => `lib/${portable(path.relative(path.join(repo, 'webapp/backend'), file))}`);
  const bin = filesIn(path.join(repo, 'bin'), excluded).filter(file => file.endsWith('.js'))
    .map(file => `bin/${portable(path.relative(path.join(repo, 'bin'), file))}`);
  return [...new Set([...REQUIRED_FILES, ...backend, ...bin])].sort();
}

function checkInventory(names, required) {
  const found = new Set(names);
  const missing = required.filter(name => !found.has(name));
  if (missing.length) throw new Error(`Missing required package files: ${missing.join(', ')}`);
}

function checkSync(repo) {
  for (const file of filesIn(path.join(repo, 'webapp/backend'), excluded)) {
    const name = portable(path.relative(path.join(repo, 'webapp/backend'), file));
    const synced = path.join(repo, 'npm-package/lib', name);
    if (!fs.existsSync(synced) || sha256(fs.readFileSync(file)) !== sha256(fs.readFileSync(synced))) {
      throw new Error(`Stale package source: lib/${name}; sync before building`);
    }
    for (const name of ['appium-uiautomator2-server.apk', 'appium-uiautomator2-server-test.apk']) {
      const source = path.join(repo, '.android-apks', name);
      const synced = path.join(repo, 'npm-package/apks', name);
      if (fs.existsSync(source) && sha256(fs.readFileSync(source)) !== sha256(fs.readFileSync(synced))) {
        throw new Error(`Stale Android APK asset: ${name}; sync before building`);
      }
    }
  }
}

function writeManifest(repo, dist) {
  checkSync(repo);
  const artifacts = artifactHashes(dist);
  checkInventory(Object.keys(artifacts), expectedFiles(repo));
  const source = sourceHashes(repo);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const manifest = {
    schema: 1, commit, builtAt: new Date().toISOString(),
    node: process.version, platform: process.platform, arch: process.arch,
    sourceDigest: sha256(JSON.stringify(source)), source, artifacts,
    scripts: Object.fromEntries(REQUIRED_SCRIPTS.map(name =>
      [`scripts/shell/${name}.enc`, sha256(fs.readFileSync(path.join(repo, 'scripts/device', `${name}.sh`)))])),
  };
  fs.writeFileSync(path.join(dist, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✅ Release manifest records commit ${commit.slice(0, 8)} and ${Object.keys(artifacts).length} artifact hashes`);
}

function verifyManifest(repo, dist) {
  checkSync(repo);
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, MANIFEST), 'utf8'));
  if (manifest.schema !== 1) throw new Error('Unsupported release manifest schema');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  if (manifest.commit !== commit) throw new Error('Build commit differs from HEAD; rebuild');
  const source = sourceHashes(repo);
  if (sha256(JSON.stringify(source)) !== manifest.sourceDigest) throw new Error('Source changed since build; rebuild');
  const artifacts = artifactHashes(dist);
  if (JSON.stringify(artifacts) !== JSON.stringify(manifest.artifacts)) throw new Error('Distribution changed since build; rebuild');
  checkInventory(Object.keys(artifacts), expectedFiles(repo));
  return manifest;
}

function verifyPackedFiles(pack, manifest) {
  const names = pack.files.map(file => file.path);
  checkInventory(names, [...Object.keys(manifest.artifacts), MANIFEST]);
  const expected = new Set([...Object.keys(manifest.artifacts), MANIFEST]);
  const extras = names.filter(name => !expected.has(name));
  if (extras.length) throw new Error(`Unexpected packed files: ${extras.join(', ')}`);
}

function checkSizes(pack, baseline, { maxUnpackedBytes = 25 * 1024 * 1024, maxPackedBytes = 20 * 1024 * 1024, maxGrowth = 0.15 } = {}) {
  if (![pack.size, pack.unpackedSize].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid package size metadata');
  if (pack.unpackedSize > maxUnpackedBytes || pack.size > maxPackedBytes) throw new Error('Package exceeds 25 MiB unpacked or 20 MiB packed limit');
  if (baseline && pack.unpackedSize > baseline + Math.floor(baseline * maxGrowth)) throw new Error('Unpacked size grew more than 15% over the published version');
}

module.exports = { MANIFEST, REQUIRED_FILES, REQUIRED_SCRIPTS, sha256, filesIn, sourceHashes,
  artifactHashes, expectedFiles, checkInventory, checkSync, writeManifest, verifyManifest, verifyPackedFiles, checkSizes };
