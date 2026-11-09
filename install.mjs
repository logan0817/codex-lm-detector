#!/usr/bin/env node
import { cp, mkdir, mkdtemp, rename, rm, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROOT, verifyArtifacts } from './scripts/core.mjs';

const INSTALL_FILES = ['SKILL.md', 'agents', 'assets', 'scripts', 'vendor', 'references', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];

async function assertNoSymlinks(file) {
  const entry = await lstat(file);
  if (entry.isSymbolicLink()) throw new Error('安装包包含符号链接，已停止。');
  if (entry.isDirectory()) {
    for (const name of await readdir(file)) await assertNoSymlinks(path.join(file, name));
  }
}

export async function install(target) {
  const destination = path.resolve(target);
  const relative = path.relative(ROOT, destination);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('安装目标不能位于当前包内部。');
  }
  if (await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new Error('目标目录已经存在，未覆盖。请先检查现有版本或选择新的 --target。');
  }
  await verifyArtifacts();
  for (const name of INSTALL_FILES) await assertNoSymlinks(path.join(ROOT, name));
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), '.codex-lm-detector-install-'));
  const payload = path.join(staging, 'codex-lm-detector');
  try {
    await mkdir(payload);
    for (const name of INSTALL_FILES) {
      await cp(path.join(ROOT, name), path.join(payload, name), { recursive: true, force: false, errorOnExist: true });
    }
    await verifyArtifacts(payload);
    // rename 在部分系统会替换空目录，写入前再次拒绝已存在的目标。
    if (await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw new Error('安装期间目标已出现，未覆盖。');
    }
    await rename(payload, destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const { values } = parseArgs({ strict: true, options: { target: { type: 'string' } } });
    if (values.target && !path.isAbsolute(values.target)) throw new Error('--target 必须是绝对路径。');
    const destination = await install(values.target || path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'skills/codex-lm-detector'));
    console.log(`已安装到：${destination}\n在目标 Codex 聊天的下一轮消息中输入 $codex-lm-detector；若未显示，请重新打开 Codex。`);
  } catch (error) {
    console.error(error.code ? `安装失败（${error.code}），请检查目标目录权限和完整包。` : error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
