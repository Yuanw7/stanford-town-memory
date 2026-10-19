const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function gitInfo(directory) {
  try {
    const options = { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
      dirtyStatus: execFileSync('git', ['status', '--porcelain'], options).trim(),
    };
  } catch { return { commit: null, dirtyStatus: 'uncommitted_repository' }; }
}
function createRun(kind, config) {
  if (!/^[a-z0-9_-]+$/.test(kind)) throw new Error('非法运行类型');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const directory = path.join(root, 'artifacts/local', kind, runId);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = {
    runId, kind, status: 'running', startedAt: new Date().toISOString(),
    code: gitInfo(root), upstream: gitInfo(path.join(root, 'ai-town')),
    hardware: { architecture: os.arch(), totalMemoryBytes: os.totalmem(), cpu: os.cpus()[0]?.model },
    node: process.version,
  };
  // 根仓库目前可能没有 commit；保存白名单源码快照，避免只有 dirty 标记无法复现。
  manifest.sourceSha256 = {};
  const snapshotDirectory = path.join(directory, 'source');
  const copy = relative => {
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) return;
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error('源码快照不跟随符号链接');
    if (fs.statSync(source).isDirectory()) {
      for (const child of fs.readdirSync(source)) copy(path.join(relative, child));
    } else {
      const buffer = fs.readFileSync(source);
      manifest.sourceSha256[relative] = hash(buffer);
      const target = path.join(snapshotDirectory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, buffer);
    }
  };
  ['index.js', 'package.json', 'package-lock.json', 'lib', 'scripts', 'tests',
    'integrations', 'models/Modelfile', 'configs/ai-town-research.patch', 'configs/upstream-lock.json'].forEach(copy);
  const write = (name, value) => {
    const target = path.join(directory, name);
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(`${target}.tmp`, target);
  };
  const append = (name, value) => fs.appendFileSync(path.join(directory, name), `${JSON.stringify(value)}\n`);
  write('config.json', config);
  write('manifest.json', manifest);
  return {
    directory, runId, manifest, write, append,
    finish(status, details = {}) {
      Object.assign(manifest, details, { status, endedAt: new Date().toISOString() });
      write('manifest.json', manifest);
    },
  };
}
module.exports = { root, hash, createRun };
