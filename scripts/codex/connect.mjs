import { AppServer } from './app-server.mjs';
import { resolveRuntime, sourceThread } from './runtime.mjs';
import { readSource } from './probes.mjs';
import { CheckError, throwIfCancelled } from './errors.mjs';

export function sameSettings(a, b) {
  return ['id', 'model', 'modelProvider', 'reasoningEffort', 'cwd', 'originator']
    .every(key => a[key] === b[key]);
}

export async function connectCurrent(options = {}, env = process.env) {
  const { signal } = options;
  throwIfCancelled(signal);
  const id = sourceThread(options.thread, env);
  let runtime = await resolveRuntime(options.codex, env);
  throwIfCancelled(signal);
  let originator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || null;
  let app = new AppServer(runtime, originator, { env });
  try {
    await app.initialize({ signal });
    let source = await readSource(app, id, { signal });
    if (typeof source.originator !== 'string' || !source.originator || /[\r\n]/.test(source.originator)) {
      throw new CheckError('NO_ORIGINATOR', '运行时未提供客户端来源，无法沿用当前客户端渠道。');
    }
    const nextRuntime = await resolveRuntime(options.codex, {
      ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: source.originator,
    });
    throwIfCancelled(signal);
    if (source.originator !== originator || nextRuntime.file !== runtime.file) {
      originator = source.originator;
      runtime = nextRuntime;
      await app.close();
      throwIfCancelled(signal);
      app = new AppServer(runtime, originator, { env });
      await app.initialize({ signal });
      const checked = await readSource(app, id, { signal });
      if (!sameSettings(source, checked)) {
        throw new CheckError('SOURCE_CHANGED', '读取期间任务配置发生变化，请重新检测。');
      }
      source = checked;
    }
    return { app, source, runtime };
  } catch (error) {
    await app.close();
    throw error;
  }
}
