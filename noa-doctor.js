#!/usr/bin/env node
// noa-doctor: Noaの動作に必要な設定を検証・自動修復する
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const ZSHRC       = path.join(os.homedir(), '.zshrc');
const NOA_PROJECTS = path.join(os.homedir(), '.noa_projects.json');
const NOA_TOKEN   = path.join(os.homedir(), '.noa-token');

let ok = 0, warn = 0, fixed = 0;

function pass(msg)  { console.log(`  ✅ ${msg}`); ok++; }
function fail(msg)  { console.log(`  ❌ ${msg}`); warn++; }
function fix(msg)   { console.log(`  🔧 ${msg}`); fixed++; }
function info(msg)  { console.log(`  ℹ️  ${msg}`); }

console.log('\n🩺 Noa Doctor\n');

// 1. .zshrc NOA_TERMINAL ガード
console.log('【.zshrc】');
try {
  const content = fs.readFileSync(ZSHRC, 'utf8');
  if (content.includes('NOA_TERMINAL')) {
    pass('NOA_TERMINALガードあり（tmux誤起動防止）');
  } else {
    fail('NOA_TERMINALガードなし → 全PTYが同じtmuxに入るバグが再発する');
    // 自動修復
    const fixed_content = content.replace(
      /if \[ -z "\$TMUX" \]/g,
      'if [ -z "$TMUX" ] && [ -z "$NOA_TERMINAL" ]'
    );
    if (fixed_content !== content) {
      fs.writeFileSync(ZSHRC, fixed_content, 'utf8');
      fix('.zshrc を自動修復しました');
    } else {
      fail('自動修復できませんでした。手動で確認してください');
    }
  }
} catch (e) {
  fail(`.zshrc 読み込み失敗: ${e.message}`);
}

// 2. サーバー起動確認
console.log('\n【サーバー】');
let port = 2797;
try {
  const tokenFile = fs.readFileSync(NOA_TOKEN, 'utf8');
  const portLine = tokenFile.split('\n').find(l => l.startsWith('NOA_PORT='));
  if (portLine) port = parseInt(portLine.split('=')[1]) || 2797;
} catch {}

function checkServer() {
  return new Promise(resolve => {
    const req = http.request({ hostname: 'localhost', port, path: '/', timeout: 2000 }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

checkServer().then(running => {
  if (running) {
    pass(`サーバー起動中 (port ${port})`);
  } else {
    fail(`サーバーが応答しない (port ${port}) → npm start で起動してください`);
  }

  // 3. プロジェクトパス確認
  console.log('\n【プロジェクトパス (.noa_projects.json)】');
  try {
    const projects = JSON.parse(fs.readFileSync(NOA_PROJECTS, 'utf8'));
    const entries = Object.entries(projects);
    if (entries.length === 0) {
      info('プロジェクト未登録（Noaのタブから登録してください）');
    } else {
      entries.forEach(([name, projPath]) => {
        if (fs.existsSync(projPath)) {
          pass(`${name} → ${projPath}`);
        } else {
          fail(`${name} → ${projPath} （フォルダが存在しない）`);
        }
      });
    }
  } catch {
    info('プロジェクト未登録');
  }

  // 4. git 状態確認（変更が未コミットなら警告）
  console.log('\n【git（変更の安全性）】');
  try {
    const status = execSync('git status --porcelain', {
      cwd: path.dirname(__filename), encoding: 'utf8'
    }).trim();
    if (status) {
      warn++;
      console.log(`  ⚠️  未コミットの変更あり（変更前に git commit しておくと素早く戻せます）:`);
      status.split('\n').forEach(l => console.log(`     ${l}`));
    } else {
      pass('git クリーン（問題発生時は git checkout HEAD -- public/index.html server.js で即戻し可能）');
    }
  } catch {
    info('gitリポジトリ外');
  }

  // サマリー
  console.log('\n' + '─'.repeat(40));
  console.log(`結果: ✅${ok}件OK  🔧${fixed}件自動修復  ❌${warn - fixed}件要確認`);
  if (warn - fixed === 0) {
    console.log('✨ Noa は正常な状態です\n');
  } else {
    console.log('⚠️  上記の問題を確認してください\n');
  }
});
