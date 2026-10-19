const { createGateway } = require('../lib/gateway');
const { createRun } = require('../lib/artifacts');
const config = { port: 11435, maxActive: 1, maxCalls: 2000, durationSeconds: 3600 };
const run = createRun('gateway', config);
const records = [];
const server = createGateway({ ...config, deadline: Date.now() + config.durationSeconds * 1000,
  record: row => { records.push(row); run.append('calls.jsonl', row); },
  event: row => run.append('request-events.jsonl', row) });
server.listen(config.port, '127.0.0.1', () => console.log(`本地计量网关 :${config.port}，记录：${run.directory}`));
function close() {
  server.close(() => {
    run.write('summary.json', { attempts: records.length,
      measured: records.filter(r => r.usageStatus === 'measured').length,
      unknown: records.filter(r => r.usageStatus === 'unknown').length });
    run.finish('completed');
  });
}
process.once('SIGINT', close); process.once('SIGTERM', close);
server.on('error', error => { run.finish('failed', { error: error.message }); process.exitCode = 1; });
