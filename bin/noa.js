#!/usr/bin/env node
'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const ENV_FILE = path.join(process.cwd(), '.noa-env');

// ── トークン管理 ──────────────────────────────────────────────────
function loadOrCreateToken() {
  // 1. 環境変数が既にセットされていればそれを使う
  if (process.env.NOA_TOKEN) return process.env.NOA_TOKEN;

  // 2. カレントディレクトリの .noa-env を読む
  if (fs.existsSync(ENV_FILE)) {
    const line = fs.readFileSync(ENV_FILE, 'utf8')
      .split('\n').find(l => l.startsWith('NOA_TOKEN='));
    if (line) return line.slice('NOA_TOKEN='.length).trim();
  }

  // 3. 初回: トークンを生成して保存
  const token = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(ENV_FILE, `NOA_TOKEN=${token}\n`, 'utf8');
  console.log('\n  ✦ Token generated and saved to .noa-env');
  console.log('  ✦ Keep this file safe — it controls access to your Mac\n');
  return token;
}

// ── ブラウザを開く ────────────────────────────────────────────────
function openBrowser(url) {
  try {
    const cmd = process.platform === 'darwin' ? 'open'
              : process.platform === 'win32'  ? 'start'
              : 'xdg-open';
    execSync(`${cmd} "${url}"`, { stdio: 'ignore' });
  } catch {}
}

// ── メイン ───────────────────────────────────────────────────────
const token = loadOrCreateToken();
const port  = process.env.NOA_PORT || 2797;

// hook スクリプトが参照できるよう ~/.noa-token に保存
try {
  fs.writeFileSync(
    path.join(require('os').homedir(), '.noa-token'),
    `NOA_TOKEN=${token}\nNOA_PORT=${port}\n`,
    'utf8'
  );
} catch {}
const url   = `http://localhost:${port}/?token=${token}`;

// サーバープロセスを起動（このプロセスの子として）
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, NOA_TOKEN: token, NOA_PORT: String(port) },
  stdio: 'inherit',
});

server.on('error', err => {
  console.error('  ✗ Failed to start server:', err.message);
  process.exit(1);
});

// 少し待ってからブラウザを開く
setTimeout(() => {
  console.log(`\n  ◆ Opening ${url}\n`);
  openBrowser(url);
}, 1200);

// Ctrl+C でサーバーも終了
process.on('SIGINT', () => { server.kill(); process.exit(0); });
process.on('SIGTERM', () => { server.kill(); process.exit(0); });
