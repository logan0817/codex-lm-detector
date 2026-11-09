import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { CheckError, rpcError, throwIfCancelled } from './errors.mjs';

// 仅在检测子进程中禁用通知和 hook，不修改配置文件。
export class AppServer extends EventEmitter {
  constructor(runtime, originator, { env = process.env, spawnImpl = spawn } = {}) {
    super();
    this.pending = new Map(); this.nextId = 0; this.closed = false; this.serverRequests = 0;
    const childEnv = { ...env, CODEX_LM_DETECTOR_PROBE_PROCESS: '1' };
    if (originator) childEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = originator;
    this.child = spawnImpl(runtime.command, [...runtime.prefix, 'app-server', '--stdio',
      '-c', 'notify=[]', '-c', 'features.hooks=false'],
      { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
    this.child.once('error', () => this.fail(new CheckError('SPAWN_FAILED', 'Codex 运行时无法启动。')));
    this.child.once('exit', () => this.fail(new CheckError('SERVER_EXITED', 'Codex 检测进程提前退出，未得到检测结果。')));
    this.child.stdin.on('error', () => this.fail(new CheckError('PIPE_CLOSED', 'Codex 检测连接已关闭。')));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      if (line.length > 4_000_000) return this.fail(new CheckError('PROTOCOL_LIMIT', 'Codex 返回了过大的协议消息。'));
      let m; try { m = JSON.parse(line); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.method && Object.hasOwn(m, 'id')) {
        this.serverRequests++;
        this.write({ id: m.id, error: { code: -32601, message: 'Fingerprint probes do not grant permissions or execute tools.' } });
        this.emit('notification', { method: '_server_request', params: { ...m.params, requestMethod: m.method } });
      } else if (Object.hasOwn(m, 'id')) {
        const p = this.pending.get(m.id); if (!p) return;
        if (m.error) p.reject(rpcError(p.method, m.error)); else p.resolve(m.result);
      } else if (m.method) this.emit('notification', m);
    });
  }
  write(message) {
    if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 30_000, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new CheckError('CANCELLED', '检测已取消。'));
    if (this.closed) return Promise.reject(new CheckError('SERVER_CLOSED', 'Codex 检测连接已关闭。'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); this.pending.delete(id); signal?.removeEventListener('abort', abort);
      };
      const finish = (callback, value) => { cleanup(); callback(value); };
      const abort = () => finish(reject, new CheckError('CANCELLED', '检测已取消。'));
      const timer = setTimeout(() => finish(reject, new CheckError('RPC_TIMEOUT', `${method} 超时，本次不能判定模型。`)), timeout);
      this.pending.set(id, { method, resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      signal?.addEventListener('abort', abort, { once: true });
      this.write({ id, method, params });
    });
  }
  async initialize({ signal } = {}) {
    const info = await this.request('initialize', {
      clientInfo: { name: 'codex_lm_detector_skill', version: '0.1.0' }, capabilities: { experimentalApi: true },
    }, 30_000, { signal });
    throwIfCancelled(signal);
    this.write({ method: 'initialized', params: {} }); return info;
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear(); this.emit('closed', error);
  }
  async close() {
    this.fail(new CheckError('CLOSED', '检测连接已关闭。'));
    this.lines.close(); this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child.exitCode === null && !this.child.signalCode) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}
