const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const pty     = require('node-pty');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const PORT  = process.env.NOA_PORT  || 2797;
const TOKEN = process.env.NOA_TOKEN || crypto.randomBytes(8).toString('hex');

// hook スクリプトが参照できるよう ~/.noa-token にトークンを書き出す
try {
  require('fs').writeFileSync(
    require('path').join(os.homedir(), '.noa-token'),
    `NOA_TOKEN=${TOKEN}\nNOA_PORT=${PORT}\n`,
    'utf8'
  );
} catch {}

// .zshrc に NOA_TERMINAL ガードがなければ自動追加（tmux 誤起動防止）
(function _ensureZshrcGuard() {
  const zshrc = require('path').join(os.homedir(), '.zshrc');
  try {
    const content = require('fs').readFileSync(zshrc, 'utf8');
    if (!content.includes('NOA_TERMINAL')) {
      const guard = '\n# Noa terminal guard (auto-added by noa server)\n' +
        '# tmux自動起動をNoaのPTY内ではスキップする\n';
      // [ -z "$TMUX" ] の条件に && [ -z "$NOA_TERMINAL" ] を追加
      const fixed = content.replace(
        /if \[ -z "\$TMUX" \]/g,
        'if [ -z "$TMUX" ] && [ -z "$NOA_TERMINAL" ]'
      );
      if (fixed !== content) {
        require('fs').writeFileSync(zshrc, fixed, 'utf8');
        console.log('[noa] .zshrc に NOA_TERMINAL ガードを自動追加しました');
      } else {
        // パターンが見つからない場合は末尾に追加
        require('fs').appendFileSync(zshrc,
          guard + 'if [ -z "$TMUX" ] && [ -z "$NOA_TERMINAL" ]; then\n  tmux attach 2>/dev/null || true\nfi\n'
        );
        console.log('[noa] .zshrc 末尾に NOA_TERMINAL ガードを追加しました');
      }
    }
  } catch {}
}());

// シェルパスを確実に取得（npm経由だとSHELLが未設定のことがある）
function findShell() {
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ];
  for (const s of candidates) {
    if (!s) continue;
    try { require('fs').accessSync(s, require('fs').constants.X_OK); return s; } catch {}
  }
  return '/bin/sh';
}
const SHELL = findShell();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const fs     = require('fs');

// ── セキュリティ設定 ─────────────────────────────────────────────
// NOA_ROOT: ファイルエディターで閲覧・編集できるルートディレクトリ
// マルチユーザー運用時はプロジェクトディレクトリに絞ること
const FILE_ROOT = path.resolve(process.env.NOA_ROOT || os.homedir());

// トークン認証ミドルウェア（全エディターAPIに適用）
function requireAuth(req, res, next) {
  const t = req.query.token || req.headers['x-noa-token'];
  if (t !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// パストラバーサル防止: FILE_ROOT 外へのアクセスを全拒否
function safeResolvePath(relPath) {
  const full = path.resolve(path.join(FILE_ROOT, relPath));
  if (full !== FILE_ROOT && !full.startsWith(FILE_ROOT + path.sep)) {
    throw new Error('Access denied: outside root');
  }
  return full;
}

// ── static ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── local file proxy（file:// URLをiframeで表示するため） ────────
app.get('/_file/*', (req, res) => {
  const filePath = '/' + req.params[0];
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found: ' + filePath);
  let target = filePath;
  try {
    if (fs.statSync(filePath).isDirectory()) {
      const idx = path.join(filePath, 'index.html');
      if (fs.existsSync(idx)) target = idx;
      else return res.status(404).send('No index.html in directory');
    }
  } catch { return res.status(500).send('Stat error'); }
  res.sendFile(target);
});

// ── Editor API: ディレクトリ一覧 ─────────────────────────────────
app.get('/_dir', requireAuth, (req, res) => {
  const relPath = req.query.path || '/';
  try {
    const absPath = safeResolvePath(relPath);
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    const list = entries
      .filter(e => !e.name.startsWith('.') || e.name === '.env')
      .map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
        path: path.posix.join(relPath.replace(/\\/g, '/'), e.name),
      }))
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    res.json({ root: FILE_ROOT, list });
  } catch(e) { res.status(403).json({ error: e.message }); }
});

// ── Editor API: ファイル読み込み ──────────────────────────────────
app.get('/_read', requireAuth, (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'No path specified' });
  try {
    const absPath = safeResolvePath(relPath);
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'File too large (>1MB)' });
    const content = fs.readFileSync(absPath, 'utf8');
    res.json({ content, size: stat.size, mtime: stat.mtimeMs });
  } catch(e) { res.status(403).json({ error: e.message }); }
});

// ── Editor API: ファイル保存 ──────────────────────────────────────
app.post('/_write', requireAuth, express.json({ limit: '2mb' }), (req, res) => {
  const { path: relPath, content } = req.body || {};
  if (!relPath || content === undefined) return res.status(400).json({ error: 'Missing path or content' });
  try {
    const absPath = safeResolvePath(relPath);
    fs.writeFileSync(absPath, content, 'utf8');
    res.json({ ok: true });
  } catch(e) { res.status(403).json({ error: e.message }); }
});

// ── Image API: ファイルツリーから画像を認証付きで配信 ─────────────────
app.get('/_img', requireAuth, (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).send('no path');
  try {
    const absPath = safeResolvePath(relPath);
    res.sendFile(absPath);
  } catch(e) { res.status(403).send(e.message); }
});

// ── Upload API: ファイルを ~/.noa_uploads/ に保存して絶対パスを返す ─
const UPLOAD_DIR = path.join(os.homedir(), '.noa_uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.post('/_upload', requireAuth, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  try {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty body — body not parsed. Content-Type: ' + req.headers['content-type'] });
    }
    const rawName = req.headers['x-filename'] || `upload_${Date.now()}`;
    const filename = decodeURIComponent(rawName).replace(/[\/\\:*?"<>|]/g, '_');
    const savePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(savePath, req.body);
    res.json({ path: savePath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Claude Code Todos API: hookから受け取り全WSクライアントへブロードキャスト ──
const TODOS_PATH    = path.join(os.homedir(), '.noa_todos.json');
const PROJECTS_PATH = path.join(os.homedir(), '.noa_projects.json');
let _lastTodos = {};
let _projectPaths = {}; // { [project]: '/absolute/path' }
try { _lastTodos    = JSON.parse(fs.readFileSync(TODOS_PATH, 'utf8')); } catch {}
try { _projectPaths = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8')); } catch {}

function _saveTodos() {
  try { fs.writeFileSync(TODOS_PATH, JSON.stringify(_lastTodos), 'utf8'); } catch {}
}
function _saveProjectPaths() {
  try { fs.writeFileSync(PROJECTS_PATH, JSON.stringify(_projectPaths), 'utf8'); } catch {}
}

app.post('/noa-project-delete', express.json({ limit: '4kb' }), (req, res) => {
  const token = req.query.token || req.headers['x-noa-token'] || '';
  if (token !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const project = req.body?.project || '';
  if (!project) return res.status(400).json({ error: 'missing project' });
  delete _lastTodos[project];
  delete _projectPaths[project];
  _saveTodos();
  _saveProjectPaths();
  // PTYセッションが残っていれば終了
  const sessId = `proj:${project}`;
  const sess = sessions.get(sessId);
  if (sess) { try { sess.pty.kill(); } catch {} sessions.delete(sessId); }
  const msg = JSON.stringify({ type: 'project-deleted', project });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ ok: true, project });
});

// Claude から決定を求める通知 (AskUserQuestion hook)
app.post('/noa-notify', express.json({ limit: '4kb' }), (req, res) => {
  const token = req.query.token || req.headers['x-noa-token'] || '';
  if (token !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const project = req.body?.project || 'default';
  const message = req.body?.message || '';
  const msg = JSON.stringify({ type: 'project-notify', project, message });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ ok: true, project });
});

app.post('/noa-todos', express.json({ limit: '64kb' }), (req, res) => {
  const token = req.query.token || req.headers['x-noa-token'] || '';
  if (token !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const incoming = Array.isArray(req.body?.todos) ? req.body.todos : [];
  const project  = req.body?.project || 'default';
  const projPath = req.body?.path || '';
  const isUser   = req.headers['x-noa-source'] === 'user';
  // Claude からの更新: manual:true タスクを保持してマージ
  const existing = _lastTodos[project] || [];
  const manuals  = isUser ? [] : existing.filter(t => t.manual);
  const todos    = [...incoming, ...manuals.filter(m => !incoming.some(t => t.content === m.content))];
  _lastTodos[project] = todos;
  _saveTodos();
  // パスが送られてきたら保存
  if (projPath) { _projectPaths[project] = projPath; _saveProjectPaths(); }
  const msg = JSON.stringify({ type: 'todos-update', project, todos });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ ok: true, count: todos.length, project });
});

// ── ファイル操作API: リネーム ────────────────────────────────────
app.post('/_rename', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  const { path: relPath, name: newName } = req.body || {};
  if (!relPath || !newName) return res.status(400).json({ error: 'Missing path or name' });
  if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..')
    return res.status(400).json({ error: 'Invalid name' });
  try {
    const absPath = safeResolvePath(relPath);
    const newAbs  = path.join(path.dirname(absPath), newName);
    if (!newAbs.startsWith(FILE_ROOT)) return res.status(403).json({ error: 'Access denied' });
    fs.renameSync(absPath, newAbs);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ファイル操作API: 削除（ゴミ箱移動） ─────────────────────────
const TRASH_DIR = path.join(os.homedir(), '.noa_trash');
fs.mkdirSync(TRASH_DIR, { recursive: true });

app.post('/_delete', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  const { path: relPath } = req.body || {};
  if (!relPath) return res.status(400).json({ error: 'Missing path' });
  try {
    const absPath  = safeResolvePath(relPath);
    const name     = path.basename(absPath);
    const trashPath = path.join(TRASH_DIR, `${Date.now()}_${name}`);
    fs.renameSync(absPath, trashPath);
    res.json({ ok: true, trashPath }); // trashPath をクライアントに返してUndoに使う
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ファイル操作API: 復元（Undo用） ─────────────────────────────
app.post('/_restore', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  const { trashPath, originalPath } = req.body || {};
  if (!trashPath || !originalPath) return res.status(400).json({ error: 'Missing params' });
  if (!trashPath.startsWith(TRASH_DIR)) return res.status(403).json({ error: 'Access denied' });
  try {
    const absOriginal = safeResolvePath(originalPath);
    fs.renameSync(trashPath, absOriginal);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── session store ───────────────────────────────────────────────
// sessions: Map<id, { pty, clients: Set<ws>, scrollback: string[], name, created }>
const sessions = new Map();

// claude 終了マーカー。起動コマンド末尾の printf が出力する OSC シーケンス（端末は無視する不可視文字）。
// サーバーが検知したら scrollback を破棄してクライアントに clear を送る。
const CC_EXIT_MARK = '\x1b]1337;NOACCEXIT\x07';
let   sessionCounter = 1;

function newSessionId() {
  return `s${sessionCounter++}`;
}

function createSession(id, cols = 120, rows = 36, name = '', cwd = '') {
  const workDir = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
  console.log(`[pty] spawning ${SHELL} cols=${cols} rows=${rows} cwd=${workDir}`);
  const ptyProc = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols, rows,
    cwd:  workDir,
    env:  {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'ja_JP.UTF-8',
      SHELL,
      HOME: os.homedir(),
      USER: os.userInfo().username,
      NOA_TERMINAL: '1', // .zshrc の tmux 自動起動をスキップ
    },
  });

  const sess = {
    id,
    name: name || `session ${sessions.size + 1}`,
    pty:  ptyProc,
    clients:   new Set(),
    scrollback: [],    // array of data chunks
    created:   Date.now(),
  };

  ptyProc.onData(data => {
    // claude をexitすると起動コマンド末尾の printf が CC_EXIT_MARK を出力する。
    // それを検知したらこのセッションのスクロールバックを破棄し、クライアントにも画面消去を指示する。
    // （exit しない限り会話履歴は scrollback に残り、再接続時に復元される）
    if (data.includes(CC_EXIT_MARK)) {
      data = data.split(CC_EXIT_MARK).join(''); // マーカー自体は画面に出さない
      sess.scrollback = [];
      broadcast(sess, { type: 'clear' });
      if (!data) return;
    }
    sess.scrollback.push(data);
    if (sess.scrollback.length > 2000) sess.scrollback.shift();
    broadcast(sess, { type: 'output', data });
  });

  ptyProc.onExit(({ exitCode }) => {
    // 意図的な再起動(_silentExit)では [session ended] を出さない
    if (!sess._silentExit) broadcast(sess, { type: 'exit', code: exitCode, id });
    sessions.delete(id);
    broadcastAll({ type: 'sessions', list: sessionList() });
  });

  sessions.set(id, sess);
  return sess;
}

function broadcast(sess, msg) {
  const str = JSON.stringify(msg);
  sess.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function broadcastAll(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function sessionList() {
  return [...sessions.values()].map(s => ({
    id:      s.id,
    name:    s.name,
    created: s.created,
    clients: s.clients.size,
    pid:     s.pty.pid,
  }));
}

// 稼働中の claude プロセスを cwd 別に数える（Noa外のエージェントも検知）
function _claudeCountByDir() {
  const map = {};
  let pids = [];
  try {
    pids = execSync(`pgrep -f "claude" 2>/dev/null`, { timeout: 2000, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).slice(0, 16); // execSyncはブロックするので上限
  } catch {}
  for (const pid of pids) {
    try {
      const out = execSync(`lsof -p ${pid} -a -d cwd -F n 2>/dev/null`, { timeout: 1500, encoding: 'utf8' }).trim();
      const nLine = out.split('\n').find(l => l.startsWith('n/'));
      if (nLine) { const c = nLine.slice(1); map[c] = (map[c] || 0) + 1; }
    } catch {}
  }
  return map;
}
// あるプロジェクトdir配下で動いている claude 数
function _agentsForPath(dirMap, projPath) {
  if (!projPath) return 0;
  let n = 0;
  for (const [dir, cnt] of Object.entries(dirMap)) {
    if (dir === projPath || dir.startsWith(projPath + '/')) n += cnt;
  }
  return n;
}

// ── セッション健全性ウォッチドッグ (30秒ごと) ──────────────────────
function runWatchdog() {
  const projSessions = [...sessions.entries()].filter(([id]) => id.startsWith('proj:'));
  if (projSessions.length === 0) return;

  const pidMap = new Map(); // pid → sessId (重複検知用)
  const dirMap = _claudeCountByDir(); // 同時編集警告用: cwd別 claude 数
  const health = [];

  for (const [sessId, sess] of projSessions) {
    const projName = sessId.replace(/^proj:/, '');
    let cwd = null, ok = true, error = null;

    // PTY の cwd を lsof で取得（macOS）
    try {
      const out = execSync(`lsof -p ${sess.pty.pid} -a -d cwd -F n 2>/dev/null`, { timeout: 2000, encoding: 'utf8' }).trim();
      const nLine = out.split('\n').find(l => l.startsWith('n/'));
      if (nLine) cwd = nLine.slice(1);
    } catch {}

    // PTY PID 重複 = tmux合流バグ再発
    if (pidMap.has(sess.pty.pid)) {
      ok = false;
      error = `⚠ PTY重複: "${pidMap.get(sess.pty.pid)}" と同じPTY (PID:${sess.pty.pid}) です`;
    } else {
      pidMap.set(sess.pty.pid, sessId);
    }

    // 同時編集の警告材料: このプロジェクトを開いているクライアント数と、dir内で動くclaude数
    const projPath = _projectPaths[projName] || cwd;
    const agents = _agentsForPath(dirMap, projPath);
    health.push({ sessId, projName, pid: sess.pty.pid, cwd, ok, error, clients: sess.clients.size, agents });
  }

  broadcastAll({ type: 'session-health', sessions: health });
}
setInterval(runWatchdog, 30000);
setTimeout(runWatchdog, 5000); // 起動5秒後に初回チェック

// ── websocket ───────────────────────────────────────────────────
wss.on('connection', ws => {
  let authed = false;
  let sess   = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // auth gate
    if (!authed) {
      if (msg.type !== 'auth') return;
      if (msg.token !== TOKEN) {
        ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'invalid token' }));
        ws.close();
        return;
      }
      authed = true;
      ws.send(JSON.stringify({ type: 'auth', ok: true, sessions: sessionList() }));
      if (Object.keys(_lastTodos).length > 0) {
        ws.send(JSON.stringify({ type: 'todos-projects', projects: _lastTodos, paths: _projectPaths }));
      }
      return;
    }

    switch (msg.type) {

      case 'new': {
        const id = newSessionId();
        try {
          sess = createSession(id, msg.cols || 120, msg.rows || 36, msg.name || '');
          sess.clients.add(ws);
          ws.send(JSON.stringify({ type: 'attached', id: sess.id, name: sess.name }));
          broadcastAll({ type: 'sessions', list: sessionList() });
        } catch (e) {
          console.error('[pty error]', e.message);
          ws.send(JSON.stringify({ type: 'error', message: 'PTY spawn failed: ' + e.message }));
        }
        break;
      }

      case 'attach': {
        // detach from current
        if (sess) sess.clients.delete(ws);

        if (!sessions.has(msg.id)) {
          // proj:NAME 形式なら project-session と同じ処理でパスを引き継ぐ
          const projMatch = (msg.id || '').match(/^proj:(.+)$/);
          if (projMatch) {
            const pName = projMatch[1];
            const pPath = _projectPaths[pName] || '';
            sess = createSession(msg.id, msg.cols || 120, msg.rows || 36, pName, pPath);
            setTimeout(() => {
              if (!sessions.has(msg.id)) return;
              const s = sessions.get(msg.id);
              if (pPath) {
                s.pty.write(`cd "${pPath}"\n`);
                setTimeout(() => { if (sessions.has(msg.id)) sessions.get(msg.id).pty.write(`clear; claude --continue 2>/dev/null || claude; printf '\\033]1337;NOACCEXIT\\007'; clear\n`); }, 400);
              } else {
                s.pty.write(`clear; claude --continue 2>/dev/null || claude; printf '\\033]1337;NOACCEXIT\\007'; clear\n`);
              }
            }, 400);
          } else {
            sess = createSession(msg.id, msg.cols || 120, msg.rows || 36, msg.name || '');
          }
        } else {
          sess = sessions.get(msg.id);
        }
        sess.clients.add(ws);
        ws.send(JSON.stringify({ type: 'attached', id: sess.id, name: sess.name }));
        // replay scrollback
        if (sess.scrollback.length) {
          ws.send(JSON.stringify({ type: 'output', data: sess.scrollback.join('') }));
        }
        break;
      }

      case 'project-session': {
        // プロジェクト固有セッション: proj:NAME で固定ID管理
        const projName = (msg.name || '').trim();
        if (!projName) break;
        const sessId = `proj:${projName}`;
        const projPath = _projectPaths[projName] || '';

        if (sess) sess.clients.delete(ws);

        if (!sessions.has(sessId)) {
          // 初回: プロジェクトディレクトリで PTY を作成して claude を自動起動
          sess = createSession(sessId, msg.cols || 120, msg.rows || 36, projName, projPath);
          if (!projPath) {
            // パス未登録の場合、ヒントを表示
            setTimeout(() => {
              if (sessions.has(sessId)) {
                sessions.get(sessId).pty.write(
                  `echo "\x1b[33m[Noa] \x1b[0m${projName} のパス未登録 — ファイルツリーでフォルダを右クリック→⬡プロジェクト登録 または cd で移動後に再度タブをクリック"\r\n`
                );
              }
            }, 300);
          }
          setTimeout(() => {
            if (!sessions.has(sessId)) return;
            const s = sessions.get(sessId);
            // 明示的に cd して正しいディレクトリに移動してから claude 起動
            // --no-session-persistence で前回セッション(noa等)の引き継ぎを防ぐ
            if (projPath) {
              s.pty.write(`cd "${projPath}"\n`);
              setTimeout(() => {
                if (!sessions.has(sessId)) return;
                sessions.get(sessId).pty.write(`clear; claude --continue 2>/dev/null || claude; printf '\\033]1337;NOACCEXIT\\007'; clear\n`);
              }, 400);
            } else {
              s.pty.write(`clear; claude --continue 2>/dev/null || claude; printf '\\033]1337;NOACCEXIT\\007'; clear\n`);
            }
          }, 400);
          console.log(`[proj] created project session for "${projName}" at ${projPath || 'home'}`);
        } else {
          // 再接続: 既存 PTY にアタッチ（会話を継続）
          sess = sessions.get(sessId);
          console.log(`[proj] reattached to project session "${projName}"`);
        }
        sess.clients.add(ws);
        ws.send(JSON.stringify({ type: 'attached', id: sess.id, name: sess.name }));
        if (sess.scrollback.length) {
          ws.send(JSON.stringify({ type: 'output', data: sess.scrollback.join('') }));
        }
        broadcastAll({ type: 'sessions', list: sessionList() });
        break;
      }

      case 'input': {
        if (sess) sess.pty.write(msg.data);
        break;
      }

      case 'resize': {
        if (sess && msg.cols > 0 && msg.rows > 0) {
          sess.pty.resize(msg.cols, msg.rows);
        }
        break;
      }

      case 'rename': {
        if (sess && msg.name) {
          sess.name = msg.name;
          broadcastAll({ type: 'sessions', list: sessionList() });
        }
        break;
      }

      case 'kill': {
        const target = sessions.get(msg.id);
        if (target) {
          target.pty.kill();
          sessions.delete(msg.id);
          broadcastAll({ type: 'sessions', list: sessionList() });
        }
        break;
      }

      case 'proj-restart': {
        if (!authed) break;
        const rName = (msg.name || '').trim();
        if (!rName) break;
        const rSessId = `proj:${rName}`;
        const rPath = _projectPaths[rName] || '';
        // 既存セッションを強制終了（意図的なので [session ended] は出さない）
        if (sessions.has(rSessId)) {
          const old = sessions.get(rSessId);
          old._silentExit = true;
          try { old.pty.kill(); } catch {}
          sessions.delete(rSessId);
        }
        // 新しいPTYで再起動
        const rSess = createSession(rSessId, msg.cols || 120, msg.rows || 36, rName, rPath);
        rSess.clients.add(ws);
        broadcastAll({ type: 'sessions', list: sessionList() });
        ws.send(JSON.stringify({ type: 'attached', id: rSess.id, name: rSess.name }));
        ws.send(JSON.stringify({ type: 'clear' })); // 古い表示を消してから新claudeを描画
        setTimeout(() => {
          if (!sessions.has(rSessId)) return;
          const s = sessions.get(rSessId);
          if (rPath) {
            s.pty.write(`cd "${rPath}"\n`);
            setTimeout(() => { if (sessions.has(rSessId)) sessions.get(rSessId).pty.write(`clear; claude --continue 2>/dev/null || claude; printf '\\033]1337;NOACCEXIT\\007'; clear\n`); }, 400);
          } else {
            s.pty.write(`clear; claude --continue 2>/dev/null || claude; printf '\\033]1337;NOACCEXIT\\007'; clear\n`);
          }
        }, 400);
        ws.send(JSON.stringify({ type: 'proj-restarted', name: rName, pid: rSess.pty.pid }));
        console.log(`[proj] restarted "${rName}" (new PID: ${rSess.pty.pid})`);
        break;
      }

      case 'list': {
        ws.send(JSON.stringify({ type: 'sessions', list: sessionList() }));
        break;
      }

      // ── ファイルwatch（リアルタイム更新） ──
      case 'watch': {
        if (!authed) break;
        const watchRel = msg.path;
        if (!watchRel) break;
        try {
          const watchAbs = safeResolvePath(watchRel);
          // 既存のwatcherを閉じる
          if (ws._watchers) ws._watchers.forEach(w => { try { w.close(); } catch {} });
          ws._watchers = [];
          let debounce = null;
          const watcher = fs.watch(watchAbs, { persistent: false }, () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              try {
                const stat = fs.statSync(watchAbs);
                if (stat.size > 1024 * 1024) return;
                const content = fs.readFileSync(watchAbs, 'utf8');
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'file-changed', path: watchRel, content }));
                }
              } catch {}
            }, 100);
          });
          ws._watchers.push(watcher);
        } catch(e) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
        break;
      }

      case 'unwatch': {
        if (ws._watchers) { ws._watchers.forEach(w => { try { w.close(); } catch {} }); ws._watchers = []; }
        break;
      }

      // ── ディレクトリ再帰 watch（Claude Code の編集追跡） ──
      case 'watch-dir': {
        if (!authed) break;
        try {
          const absDir = safeResolvePath(msg.path || '/');
          if (ws._dirWatcher) { try { ws._dirWatcher.close(); } catch {} ws._dirWatcher = null; }
          let debounce = null;
          ws._dirWatcher = fs.watch(absDir, { recursive: true, persistent: false }, (event, filename) => {
            if (!filename) return;
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              const absPath = path.join(absDir, filename);
              const relPath = '/' + path.relative(FILE_ROOT, absPath).replace(/\\/g, '/');
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'file-active', path: relPath }));
              }
            }, 150);
          });
        } catch(e) {
          ws.send(JSON.stringify({ type: 'error', message: 'watch-dir: ' + e.message }));
        }
        break;
      }

      case 'unwatch-dir': {
        if (ws._dirWatcher) { try { ws._dirWatcher.close(); } catch {} ws._dirWatcher = null; }
        break;
      }

      // ── git branch / status ──
      case 'git-info': {
        if (!authed) break;
        let cwd = msg.cwd || os.homedir();
        // PTYのcwdをlsofで取得（macOS）
        if (!msg.cwd && sess) {
          try {
            const lsofOut = execSync(
              `lsof -p ${sess.pty.pid} -a -d cwd -F n 2>/dev/null`,
              { timeout: 1000, encoding: 'utf8' }
            ).trim();
            const nLine = lsofOut.split('\n').find(l => l.startsWith('n/'));
            if (nLine) cwd = nLine.slice(1);
          } catch {}
        }
        try {
          const branch = execSync(
            'git rev-parse --abbrev-ref HEAD 2>/dev/null || true',
            { cwd, timeout: 2000, encoding: 'utf8' }
          ).trim();
          if (!branch || branch === 'HEAD') {
            ws.send(JSON.stringify({ type: 'git-info', branch: null }));
            break;
          }
          const statusOut = execSync(
            'git status --porcelain 2>/dev/null || true',
            { cwd, timeout: 2000, encoding: 'utf8' }
          ).trim();
          const dirty = statusOut ? statusOut.split('\n').filter(Boolean).length : 0;
          ws.send(JSON.stringify({ type: 'git-info', branch, dirty, cwd }));
        } catch {
          ws.send(JSON.stringify({ type: 'git-info', branch: null }));
        }
        break;
      }
      case 'tailscale-info': {
        if (!authed) break;
        try {
          const ip = execSync('tailscale ip -4 2>/dev/null', { timeout: 2000, encoding: 'utf8' }).trim().split('\n')[0];
          const token = process.env.NOA_TOKEN || '';
          ws.send(JSON.stringify({ type: 'tailscale-info', ip, token }));
        } catch {
          ws.send(JSON.stringify({ type: 'tailscale-info', ip: null }));
        }
        break;
      }

      case 'cc-history': {
        if (!authed) break;
        try {
          const histPath = os.homedir() + '/.claude/history.jsonl';
          const raw = fs.readFileSync(histPath, 'utf8');
          // アクティブプロジェクトが指定されていればそのパスでフィルタ
          const filterProj = msg.project ? (msg.project + '') : null;
          const filterPath = filterProj ? (_projectPaths[filterProj] || null) : null;
          const entries = raw.trim().split('\n')
            .filter(l => l.trim())
            .slice(-500)
            .reverse()
            .map(l => {
              try {
                const d = JSON.parse(l);
                return {
                  display: d.display || '',
                  timestamp: d.timestamp || 0,
                  projPath: d.project || '',
                  project: (d.project || '').split('/').pop()
                };
              } catch { return null; }
            })
            .filter(Boolean)
            .filter(d => d.display && !d.display.startsWith('['))
            .filter(d => {
              if (!filterPath) return true; // フィルタなし → 全件
              return d.projPath === filterPath || d.projPath.startsWith(filterPath + '/');
            })
            .map(({ projPath, ...rest }) => rest) // projPath は送らない
            .slice(0, 50);
          ws.send(JSON.stringify({ type: 'cc-history', entries }));
        } catch(e) {
          ws.send(JSON.stringify({ type: 'cc-history', entries: [], error: e.message }));
        }
        break;
      }

      case 'shell-history': {
        if (!authed) break;
        try {
          const histFile = process.env.HISTFILE ||
            (fs.existsSync(os.homedir() + '/.zsh_history') ? os.homedir() + '/.zsh_history' : os.homedir() + '/.bash_history');
          const raw = fs.readFileSync(histFile, 'latin1');
          const lines = raw.split('\n').filter(l => l.trim());
          // zsh extended_history形式 ": timestamp:duration;command" をパース
          const cmds = lines
            .map(l => l.replace(/^: \d+:\d+;/, '').trim())
            .filter(l => l.length > 0)
            .slice(-40)
            .reverse();
          ws.send(JSON.stringify({ type: 'shell-history', cmds }));
        } catch(e) {
          ws.send(JSON.stringify({ type: 'shell-history', cmds: [], error: e.message }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (sess) sess.clients.delete(ws);
    if (ws._watchers) { ws._watchers.forEach(w => { try { w.close(); } catch {} }); ws._watchers = []; }
    if (ws._dirWatcher) { try { ws._dirWatcher.close(); } catch {} ws._dirWatcher = null; }
  });
});

// ── start ────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const tailscaleIP = '100.107.218.60';
  const localUrl    = `http://localhost:${PORT}/?token=${encodeURIComponent(TOKEN)}`;
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║  N O A  —  web terminal              ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log(`  Local      →  http://localhost:${PORT}`);
  console.log(`  Tailscale  →  http://${tailscaleIP}:${PORT}`);
  console.log(`  Token      →  ${TOKEN}\n`);

  // NOA_NO_OPEN=1 で自動オープンを無効化できる
  if (!process.env.NOA_NO_OPEN) {
    const { exec } = require('child_process');
    const opener = process.platform === 'darwin' ? 'open'
                 : process.platform === 'win32'  ? 'start'
                 : 'xdg-open';
    exec(`${opener} "${localUrl}"`);
  }

  // Cloudflare Quick Tunnel（NOA_NO_TUNNEL=1 で無効化）
  if (!process.env.NOA_NO_TUNNEL) {
    const { spawn } = require('child_process');
    const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const _extractUrl = data => {
      const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
      if (m) {
        const tunnelUrl = `${m[0]}/?token=${encodeURIComponent(TOKEN)}`;
        console.log(`  Tunnel     →  ${tunnelUrl}\n`);
        broadcastAll({ type: 'tunnel-url', url: tunnelUrl });
      }
    };
    cf.stdout.on('data', _extractUrl);
    cf.stderr.on('data', _extractUrl);
    cf.on('error', () => {}); // cloudflared 未インストール時は無視
    process.on('exit', () => { try { cf.kill(); } catch {} });
  }
});
