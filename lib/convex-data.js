// The installed Convex CLI prints Bytes("base64"), bigint literals and special
// floats even for --format json. Decode data only; never evaluate CLI output.
function parseConvexData(text) {
  if (!text.trim()) return [];
  const normalized = text.replace(/Bytes\("([A-Za-z0-9+/=]*)"\)|"(?:\\.|[^"\\])*"|-?\d+n|-?Infinity|NaN/g, (token, bytes) => {
    if (token.startsWith('"')) return token;
    if (bytes !== undefined) return JSON.stringify({ $convexBytes: bytes });
    if (token.endsWith('n')) return JSON.stringify({ $convexInt64: token.slice(0, -1) });
    return JSON.stringify({ $convexFloat: token });
  });
  try { return JSON.parse(normalized); } catch { throw new Error('invalid_convex_cli_data'); }
}
module.exports = { parseConvexData };
