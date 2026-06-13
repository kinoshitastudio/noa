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

// ── session store ───────────────────────────────────────────────
// sessions: Map<id, { pty, clients: Set<ws>, scrollback: string[], name, created }>
const sessions = new Map();
let   sessionCounter = 1;

function newSessionId() {
  return `s${sessionCounter++}`;
}

function createSession(id, cols = 120, rows = 36, name = '') {
  console.log(`[pty] spawning ${SHELL} cols=${cols} rows=${rows} cwd=${os.homedir()}`);
  const ptyProc = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols, rows,
    cwd:  os.homedir(),
    env:  {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'ja_JP.UTF-8',
      SHELL,
      HOME: os.homedir(),
      USER: os.userInfo().username,
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
    sess.scrollback.push(data);
    if (sess.scrollback.length > 2000) sess.scrollback.shift();
    broadcast(sess, { type: 'output', data });
  });

  ptyProc.onExit(({ exitCode }) => {
    broadcast(sess, { type: 'exit', code: exitCode, id });
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
  }));
}

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
          // create with given id if it doesn't exist
          sess = createSession(msg.id, msg.cols || 120, msg.rows || 36, msg.name || '');
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
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║  N O A  —  web terminal              ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log(`  Local      →  http://localhost:${PORT}`);
  console.log(`  Tailscale  →  http://${tailscaleIP}:${PORT}`);
  console.log(`  Token      →  ${TOKEN}\n`);
});
