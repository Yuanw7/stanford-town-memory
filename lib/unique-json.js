// JSON.parse accepts duplicate keys by overwriting earlier values. Reference
// maps must reject those outputs rather than silently losing selected facts.
function parseUniqueJson(text) {
  const result = JSON.parse(text), tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g);
  let index = 0;
  function value() {
    const token = tokens[index++];
    if (token === '{') {
      const keys = new Set();
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++]);
        if (keys.has(key)) throw new Error('duplicate_json_key');
        keys.add(key); index++; value();
        if (tokens[index] !== ',') break;
        index++;
      }
      index++;
    } else if (token === '[') {
      while (tokens[index] !== ']') {
        value(); if (tokens[index] !== ',') break;
        index++;
      }
      index++;
    }
  }
  value(); return result;
}
module.exports = { parseUniqueJson };
