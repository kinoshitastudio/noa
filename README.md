# Noa

A browser-based terminal for your Mac — built for running [Claude Code](https://claude.com/claude-code) from iPhone or any remote device.

Three-column layout: terminal, editor, and file tree in one view.

```
TERM  │  EDITOR  │  FILES + PREVIEW
```

---

## Requirements

Noa runs on **macOS** (Linux mostly works; Windows is not supported).

- **Node.js 18+** — [nodejs.org](https://nodejs.org/)
- **Xcode Command Line Tools** — required to build `node-pty` (otherwise `npm install` fails). Run once:
  ```bash
  xcode-select --install
  ```
- **Claude Code** — *only if you want to use Claude inside Noa.* Noa auto-launches the `claude` command when you open a project, so install and log in first (otherwise you'll see `command not found: claude`):
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude   # then run once to log in — opens a browser (needs a Claude Pro/Max plan or API key)
  ```
  Details: [claude.com/claude-code](https://claude.com/claude-code)

---

## Quick start

```bash
npx @kinoshitastudio/noa
```

The browser opens automatically. A token is generated on first run and saved to `.noa-env` in the current directory.

Or clone and run locally:

```bash
git clone https://github.com/kinoshitastudio/noa.git
cd noa
npm install
npm start
```

---

## Access from iPhone / iPad

Open Safari on the same Wi-Fi network:

```
http://<your-mac-ip>:2797/?token=<your-token>
```

Find your Mac's IP: **System Settings → Wi-Fi → Details → IP Address**

Your token is in `.noa-env` in the directory where you ran Noa.

For access outside your home network, Noa automatically starts a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — the URL appears in the startup output.

---

## Claude Code integration

Noa shows Claude Code task lists in real time via a PostToolUse hook.

**1. Create the hook file:**

```bash
mkdir -p ~/.claude/noa-hooks
```

Save this as `~/.claude/noa-hooks/todo-notify.js`:

```js
#!/usr/bin/env node
'use strict';
const http = require('http');
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(Buffer.concat(chunks));
    const todos = d.tool_input?.todos || [];
    if (!Array.isArray(todos)) return;
    const cwd = process.cwd();
    const project = cwd.split('/').filter(Boolean).pop() || 'default';
    const body = JSON.stringify({ todos, project, path: cwd });
    const token = process.env.NOA_TOKEN || '';
    const port  = process.env.NOA_PORT  || '2797';
    const req = http.request({
      hostname: 'localhost', port,
      path: `/noa-todos?token=${encodeURIComponent(token)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => res.resume());
    req.on('error', () => {});
    req.write(body); req.end();
  } catch {}
});
```

**2. Add to `~/.claude/settings.json`:**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "TodoWrite",
        "hooks": [
          {
            "type": "command",
            "command": "NOA_TOKEN=<your-token> node ~/.claude/noa-hooks/todo-notify.js"
          }
        ]
      }
    ]
  }
}
```

Replace `<your-token>` with the token from `.noa-env`.

Once set up, Claude Code's task list appears in the **⬡ panel** in Noa, updated in real time as Claude works.

---

## Project management

Noa supports multiple isolated Claude sessions — one per project.

**Register a project:** Right-click any folder in the file tree → **⬡ Register as project**

This creates a dedicated tab in the ⬡ panel. Clicking the tab:
- Switches the terminal to that project's isolated Claude session
- Auto-launches `claude` in the project directory on first open
- Resumes the existing conversation on subsequent switches

To remove a project tab, click the **×** next to it.

---

## Mobile keyboard

On mobile (iPhone / iPad), Noa shows a floating D-pad in **Game Boy** theme:

- **Cross key** — arrow keys with long-press repeat
- **A** — Enter
- **B** — Escape
- **Sub-keys** — ESC / ^C / TAB / ^L / | / ~
- **📷** — pick a photo or file from your library, auto-inserts `@path` into the terminal

Switch to Game Boy theme via **Settings (⚙) → GAME BOY**.

---

## Features

| Feature | Description |
|---|---|
| **Terminal** | xterm.js, full color, resize-aware, scrollback |
| **Editor** | Monaco with language detection and syntax highlighting |
| **File tree** | Live edit highlights, right-click rename / delete / restore |
| **Preview** | In-panel browser for local servers (iframe) |
| **⬡ Task panel** | Claude Code task list per project, real-time updates |
| **Project sessions** | Isolated Claude conversations per project tab |
| **Git status** | Branch name + dirty file count in status bar |
| **Voice input** | Microphone with waveform, auto-stops after 3.5s silence |
| **File drop** | Drop files → saved to `~/.noa_uploads/` → `@path` auto-inserted |
| **Themes** | dark · light · Game Boy · OP-1 |
| **Cloudflare Tunnel** | Auto-started for remote access outside local network |

---

## Themes

| Theme | Style |
|---|---|
| **dark** | Default dark |
| **light** | Clean white |
| **Game Boy** | DMG green LCD, VT323 pixel font, D-pad on mobile |
| **OP-1** | Teenage Engineering cream + Liquid Glass settings panel |

Toggle with the **◑** button in the header, or via **Settings → theme**.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘S` (in editor) | Save file |
| `⌘M` | Toggle microphone |
| `⌘B` | Toggle settings panel |
| `⌘⇧F` | Editor full screen |
| `⌘Z` | Undo last file rename / delete |
| `≡` button | Toggle task history panel |

---

## Security

- Token-based auth on all endpoints and WebSocket connections
- File tree is scoped to the directory Noa was launched from (`NOA_ROOT`)
- Path traversal is blocked server-side
- Never expose port 2797 to the public internet without additional measures

Custom token:

```bash
NOA_TOKEN=yourtoken npm start
```

Restrict file access to a specific directory:

```bash
NOA_ROOT=/path/to/project npm start
```

---

## License

MIT — [kinoshita studio](https://kinoshita.studio)
