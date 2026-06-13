# Noa

A browser-based terminal for your Mac.  
Access your files, run commands, and edit code — from any device on your local network.

---

## What it is

Noa runs on your Mac as a local Node.js server and opens in any browser.  
Inspired by [Conductor](https://github.com/cbh123) by Charlie Holtz.

Three-column layout:

```
TERM  │  EDITOR  │  FILES + PREVIEW
```

| Pane | Description |
|---|---|
| **TERM** | Full xterm.js terminal with task history panel |
| **EDITOR** | Monaco-based code editor with syntax highlighting |
| **FILES** | Finder-style file tree with live edit highlights |
| **PREVIEW** | In-panel browser for local servers |

---

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 18+

---

## Getting started

```bash
git clone https://github.com/kinoshitastudio/noa.git
cd noa
npm install
npm start
```

The browser opens automatically at `http://localhost:2797`.  
A token is generated on first run and saved to `.noa-env` in the current directory.

To access from another device (iPhone, iPad, etc.) on the same Wi-Fi:

```
http://<your-mac-local-ip>:2797/?token=<your-token>
```

Find your Mac's local IP: **System Settings → Wi-Fi → Details**.

---

## Token & security

Noa uses a random token to prevent unauthorized access.

```
.noa-env        ← generated automatically, keep this private
NOA_TOKEN=abc…
```

To set a custom token:

```bash
NOA_TOKEN=yourtoken npm start
```

Never expose port 2797 to the public internet without additional security measures.

---

## Features

- **Terminal** — xterm.js, full color support, resize-aware
- **Editor** — Monaco with language detection, path display, save shortcut
- **File tree** — Finder-style, lazy-loads folders, highlights active file in real time
- **Task history** — command bubbles with running · done · error status dots (toggle with `≡`)
- **Git status** — branch name and dirty-file count in the status bar
- **cd highlight** — file tree auto-expands and scrolls when you `cd` into a directory
- **Voice input** — microphone waveform visualization
- **Themes** — dark · light · gameboy · op-1 (toggle with `A` in the header)
- **Sessions** — multiple browser tabs connect simultaneously, each with its own PTY

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘S` (in editor) | Save file |
| `≡` button | Toggle task history panel |
| `A` button | Cycle themes |
| `◀` button | Collapse / expand terminal pane |

---

## Roadmap

- `npx @kinoshitastudio/noa` one-line launcher
- SSH tunnel support for remote access
- File upload / download via drag and drop

---

## License

MIT — [kinoshita studio](https://kinoshita.studio)
