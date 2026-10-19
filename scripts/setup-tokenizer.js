const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../lib/artifacts');
const { directory } = require('../lib/tokenizer');

async function main() {
  const repository = 'Qwen/Qwen2.5-7B-Instruct';
  const revision = 'a09a35458c702b33eeacc393d103063234e8bc28';
  fs.mkdirSync(directory, { recursive: true });
  const metadata = { repository, revision, sha256: {} };
  for (const file of ['tokenizer.json', 'tokenizer_config.json']) {
    const url = `https://huggingface.co/${repository}/resolve/${revision}/${file}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Tokenizer HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    JSON.parse(buffer.toString());
    fs.writeFileSync(path.join(directory, file), buffer);
    metadata.sha256[file] = hash(buffer);
  }
  fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log('Tokenizer 已下载并记录版本、SHA256：models/cache/qwen2.5');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
