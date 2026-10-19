const fs = require('node:fs');
const path = require('node:path');
const { Tokenizer } = require('@huggingface/tokenizers');
const { root, hash } = require('./artifacts');

const directory = path.join(root, 'models/cache/qwen2.5');
function loadTokenizer() {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
  const files = ['tokenizer.json', 'tokenizer_config.json'].map(name => {
    const buffer = fs.readFileSync(path.join(directory, name));
    if (hash(buffer) !== metadata.sha256[name]) throw new Error(`Tokenizer 校验和不匹配：${name}`);
    return JSON.parse(buffer);
  });
  const tokenizer = new Tokenizer(...files);
  return { metadata, count: text => tokenizer.encode(text).ids.length };
}

// 固定 ChatML 模板并以 raw prompt 调用服务，避免客户端和服务端重复套模板。
// 该路径只适用于已验证的 Qwen2.5；AI Town 的聊天接口另行验收。
function renderPrompt(messages) {
  for (const message of messages) {
    if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new Error('非法消息');
    }
    if (/<\|(?:im_start|im_end|endoftext)\|>/.test(message.content)) {
      throw new Error('消息包含保留的模型角色分隔符');
    }
  }
  return messages.map(m => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('') + '<|im_start|>assistant\n';
}
module.exports = { loadTokenizer, renderPrompt, directory };
