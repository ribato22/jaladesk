/**
 * JalaDesk Web Companion — Zero-Dependency Interactive VT100/xterm Terminal TUI
 *
 * High-DPI 60fps HTML5 <canvas> renderer with full ANSI/VT100 CSI cursor movement,
 * erase (ED/EL), scroll regions (DECSTBM), alternate screen buffer (?1049h/?1049l
 * for vim, htop, nano, tmux), SGR 16-color + 256-color + 24-bit TrueColor +
 * bold/dim/italic/underline/inverse, direct keyboard focus, paste support, and
 * ResizeObserver dynamic cols x rows sizing.
 *
 * Pure ES Module — works identically in modern browsers and headless Node.js tests.
 */

export const ANSI_16_COLORS = Object.freeze([
  '#0B1220', // 0  Black
  '#F87171', // 1  Red
  '#34D399', // 2  Green
  '#FBBF24', // 3  Yellow
  '#60A5FA', // 4  Blue
  '#C084FC', // 5  Magenta
  '#38BDF8', // 6  Cyan
  '#D8E4F2', // 7  White
  '#64748B', // 8  Bright Black
  '#FCA5A5', // 9  Bright Red
  '#6EE7B7', // 10 Bright Green
  '#FDE68A', // 11 Bright Yellow
  '#93C5FD', // 12 Bright Blue
  '#D8B4FE', // 13 Bright Magenta
  '#7DD3FC', // 14 Bright Cyan
  '#F8FAFC', // 15 Bright White
]);

const DEFAULT_THEME = Object.freeze({
  bg: '#04070D',
  fg: '#DCE9F9',
  cursorBg: '#38BDF8',
  cursorFg: '#04070D',
  cursorBorder: '#7DD3FC',
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSizePx: 14,
  lineHeightPx: 20,
  padX: 12,
  padY: 10,
});

const CUBE_LEVELS = Object.freeze([0, 95, 135, 175, 215, 255]);

function byteToHex(n) {
  const clamped = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  return clamped.toString(16).padStart(2, '0').toUpperCase();
}

export function rgbToHex(r, g, b) {
  return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
}

/**
 * Resolve an xterm 256-color palette index (0..255) to a #RRGGBB hex string.
 */
export function ansi256ToHex(index) {
  const n = Math.max(0, Math.min(255, Math.trunc(Number(index) || 0)));
  if (n < 16) {
    return ANSI_16_COLORS[n];
  }
  if (n < 232) {
    const offset = n - 16;
    const r = CUBE_LEVELS[Math.floor(offset / 36) % 6];
    const g = CUBE_LEVELS[Math.floor(offset / 6) % 6];
    const b = CUBE_LEVELS[offset % 6];
    return rgbToHex(r, g, b);
  }
  const gray = 8 + (n - 232) * 10;
  return rgbToHex(gray, gray, gray);
}

/**
 * Translate a DOM KeyboardEvent (or plain test object) into a VT100/xterm byte sequence.
 *
 * Returns { data: string | null, consumeCtrlLatch: boolean, preventDefault: boolean }.
 */
export function keyEventToAnsi(ev, options = {}) {
  if (!ev || typeof ev.key !== 'string') {
    return { data: null, consumeCtrlLatch: false, preventDefault: false };
  }

  const key = ev.key;
  const appCursorKeys = Boolean(options.appCursorKeys);
  const ctrlLatch = Boolean(options.ctrlLatch);
  const metaKey = Boolean(ev.metaKey);
  const altKey = Boolean(ev.altKey);
  const shiftKey = Boolean(ev.shiftKey);
  const ctrlKey = Boolean(ev.ctrlKey) || ctrlLatch;

  // Ignore standalone modifier key presses
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'CapsLock') {
    return { data: null, consumeCtrlLatch: false, preventDefault: false };
  }

  // Allow macOS browser Cmd shortcuts (Cmd+C, Cmd+V, Cmd+R, Cmd+L, Cmd+Tab, etc.)
  if (metaKey && !ev.ctrlKey && !ctrlLatch) {
    return { data: null, consumeCtrlLatch: false, preventDefault: false };
  }

  // Allow Ctrl+Shift+C / Ctrl+Shift+V for browser copy/paste on Linux/Windows
  if (ev.ctrlKey && shiftKey && !altKey && (key === 'C' || key === 'c' || key === 'V' || key === 'v')) {
    return { data: null, consumeCtrlLatch: false, preventDefault: false };
  }

  // Named navigation, editing, and function keys
  const ss3 = appCursorKeys ? '\x1bO' : '\x1b[';
  const modCode = 1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0);

  switch (key) {
    case 'Enter':
      return { data: altKey ? '\x1b\r' : '\r', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'Backspace':
      return { data: altKey ? '\x1b\x7f' : ctrlKey ? '\x08' : '\x7f', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'Tab':
      return { data: shiftKey ? '\x1b[Z' : '\t', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'Escape':
      return { data: '\x1b', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'ArrowUp':
      return {
        data: modCode > 1 ? `\x1b[1;${modCode}A` : `${ss3}A`,
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'ArrowDown':
      return {
        data: modCode > 1 ? `\x1b[1;${modCode}B` : `${ss3}B`,
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'ArrowRight':
      return {
        data: modCode > 1 ? `\x1b[1;${modCode}C` : `${ss3}C`,
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'ArrowLeft':
      return {
        data: modCode > 1 ? `\x1b[1;${modCode}D` : `${ss3}D`,
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'Home':
      return {
        data: modCode > 1 ? `\x1b[1;${modCode}H` : `${ss3}H`,
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'End':
      return {
        data: modCode > 1 ? `\x1b[1;${modCode}F` : `${ss3}F`,
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'Insert':
      return {
        data: modCode > 1 ? `\x1b[2;${modCode}~` : '\x1b[2~',
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'Delete':
      return {
        data: modCode > 1 ? `\x1b[3;${modCode}~` : '\x1b[3~',
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'PageUp':
      return {
        data: modCode > 1 ? `\x1b[5;${modCode}~` : '\x1b[5~',
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'PageDown':
      return {
        data: modCode > 1 ? `\x1b[6;${modCode}~` : '\x1b[6~',
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    case 'F1':
      return { data: '\x1bOP', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F2':
      return { data: '\x1bOQ', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F3':
      return { data: '\x1bOR', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F4':
      return { data: '\x1bOS', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F5':
      return { data: '\x1b[15~', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F6':
      return { data: '\x1b[17~', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F7':
      return { data: '\x1b[18~', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F8':
      return { data: '\x1b[19~', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F9':
      return { data: '\x1b[20~', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F10':
      return { data: '\x1b[21~', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F11':
      return { data: '\x1b[23~', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    case 'F12':
      return { data: '\x1b[24~', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    default:
      break;
  }

  // Ctrl+A..Z and standard ASCII control chords
  if (ctrlKey && key.length === 1) {
    const upper = key.toUpperCase();
    const code = upper.charCodeAt(0);
    if (code >= 0x41 && code <= 0x5a) {
      const ctrlChar = String.fromCharCode(code - 0x40);
      return {
        data: altKey ? `\x1b${ctrlChar}` : ctrlChar,
        consumeCtrlLatch: ctrlLatch,
        preventDefault: true,
      };
    }
    if (key === ' ' || key === '@' || key === '2') {
      return { data: '\x00', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    }
    if (key === '[') return { data: '\x1b', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    if (key === '\\') return { data: '\x1c', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    if (key === ']') return { data: '\x1d', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    if (key === '^' || key === '6') return { data: '\x1e', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    if (key === '_' || key === '-') return { data: '\x1f', consumeCtrlLatch: ctrlLatch, preventDefault: true };
    return { data: null, consumeCtrlLatch: false, preventDefault: false };
  }

  // Printable single character (including Unicode / Alt+char)
  if (key.length === 1) {
    return {
      data: altKey ? `\x1b${key}` : key,
      consumeCtrlLatch: false,
      preventDefault: true,
    };
  }

  return { data: null, consumeCtrlLatch: false, preventDefault: false };
}

function makeBlankCell(bg = null) {
  return {
    ch: ' ',
    fg: null,
    bg,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function cloneCell(cell) {
  return {
    ch: cell.ch,
    fg: cell.fg,
    bg: cell.bg,
    bold: cell.bold,
    dim: cell.dim,
    italic: cell.italic,
    underline: cell.underline,
    inverse: cell.inverse,
  };
}

export class WebVtTerminal {
  constructor(options = {}) {
    this.cols = Math.max(20, Math.min(300, Math.floor(Number(options.cols) || 100)));
    this.rows = Math.max(8, Math.min(120, Math.floor(Number(options.rows) || 30)));
    this.maxScrollback = Math.max(0, Math.min(5000, Math.floor(Number(options.maxScrollback) || 1000)));
    this.theme = { ...DEFAULT_THEME, ...(options.theme || {}) };

    this.callbacks = {
      onData: typeof options.onData === 'function' ? options.onData : () => {},
      onResize: typeof options.onResize === 'function' ? options.onResize : () => {},
      onTitle: typeof options.onTitle === 'function' ? options.onTitle : () => {},
      onCtrlLatchChange: typeof options.onCtrlLatchChange === 'function' ? options.onCtrlLatchChange : () => {},
      onRender: typeof options.onRender === 'function' ? options.onRender : () => {},
    };

    // Renderer & DOM bindings (optional — stays pure/headless when unattached)
    this._canvas = null;
    this._container = null;
    this._ctx = null;
    this._resizeObserver = null;
    this._rafId = 0;
    this._dirty = false;
    this._focused = false;
    this._cursorBlinkOn = true;
    this._blinkTimer = null;
    this._reducedMotion = false;
    this._listeners = [];
    this._cellWidth = 8.4;
    this._cellHeight = this.theme.lineHeightPx;
    this._cssWidth = 0;
    this._cssHeight = 0;
    this._dpr = 1;
    this._lastReportedCols = 0;
    this._lastReportedRows = 0;

    this._initState();
  }

  _initState() {
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.pendingWrap = false;
    this.savedRow = 0;
    this.savedCol = 0;
    this.savedSgr = null;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.autoWrap = true;
    this.appCursorKeys = false;
    this.cursorVisible = true;
    this.inAltScreen = false;
    this.bracketedPaste = false;
    this.title = '';
    this.ctrlLatch = false;
    this.scrollOffset = 0;

    this._resetSgr();
    this.grid = this._makeGrid(this.rows, this.cols);
    this.normalGrid = this.grid;
    this.normalCursorRow = 0;
    this.normalCursorCol = 0;
    this.normalPendingWrap = false;
    this.scrollback = [];
    this.carry = '';
  }

  _resetSgr() {
    this.curFg = null;
    this.curBg = null;
    this.curBold = false;
    this.curDim = false;
    this.curItalic = false;
    this.curUnderline = false;
    this.curInverse = false;
  }

  _snapshotSgr() {
    return {
      fg: this.curFg,
      bg: this.curBg,
      bold: this.curBold,
      dim: this.curDim,
      italic: this.curItalic,
      underline: this.curUnderline,
      inverse: this.curInverse,
    };
  }

  _restoreSgr(snap) {
    if (!snap) return;
    this.curFg = snap.fg;
    this.curBg = snap.bg;
    this.curBold = snap.bold;
    this.curDim = snap.dim;
    this.curItalic = snap.italic;
    this.curUnderline = snap.underline;
    this.curInverse = snap.inverse;
  }

  _makeRow(cols = this.cols, bg = null) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c += 1) {
      row[c] = makeBlankCell(bg);
    }
    return row;
  }

  _makeGrid(rows, cols) {
    const g = new Array(rows);
    for (let r = 0; r < rows; r += 1) {
      g[r] = this._makeRow(cols);
    }
    return g;
  }

  _resizeGrid(oldGrid, oldRows, oldCols, nextRows, nextCols) {
    const nextGrid = this._makeGrid(nextRows, nextCols);
    const copyRows = Math.min(oldRows, nextRows);
    const copyCols = Math.min(oldCols, nextCols);
    for (let r = 0; r < copyRows; r += 1) {
      const srcRow = oldGrid[r];
      if (!srcRow) continue;
      for (let c = 0; c < copyCols; c += 1) {
        if (srcRow[c]) {
          nextGrid[r][c] = cloneCell(srcRow[c]);
        }
      }
    }
    return nextGrid;
  }

  getDimensions() {
    return { cols: this.cols, rows: this.rows };
  }

  resize(cols, rows) {
    const nextCols = Math.max(20, Math.min(300, Math.floor(Number(cols) || this.cols)));
    const nextRows = Math.max(8, Math.min(120, Math.floor(Number(rows) || this.rows)));
    if (nextCols === this.cols && nextRows === this.rows) return false;

    const oldRows = this.rows;
    const oldCols = this.cols;
    this.grid = this._resizeGrid(this.grid, oldRows, oldCols, nextRows, nextCols);
    if (this.inAltScreen) {
      this.normalGrid = this._resizeGrid(
        this.normalGrid,
        this.normalGrid.length,
        this.normalGrid[0]?.length || oldCols,
        nextRows,
        nextCols,
      );
      this.normalCursorRow = Math.min(this.normalCursorRow, nextRows - 1);
      this.normalCursorCol = Math.min(this.normalCursorCol, nextCols - 1);
    } else {
      this.normalGrid = this.grid;
    }

    this.cols = nextCols;
    this.rows = nextRows;
    this.scrollTop = 0;
    this.scrollBottom = nextRows - 1;
    this.cursorRow = Math.min(this.cursorRow, nextRows - 1);
    this.cursorCol = Math.min(this.cursorCol, nextCols - 1);
    this.pendingWrap = false;
    this._syncDataset();
    this._scheduleRender();
    return true;
  }

  reset() {
    const prevCtrlLatch = this.ctrlLatch;
    this._initState();
    if (prevCtrlLatch) {
      this.callbacks.onCtrlLatchChange(false);
    }
    this._syncDataset();
    this._scheduleRender();
  }

  clearScrollbackAndScreen() {
    this.scrollback = [];
    this.scrollOffset = 0;
    this.grid = this._makeGrid(this.rows, this.cols);
    if (!this.inAltScreen) this.normalGrid = this.grid;
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.pendingWrap = false;
    this._scheduleRender();
  }

  setCtrlLatch(active) {
    const next = Boolean(active);
    if (this.ctrlLatch === next) return;
    this.ctrlLatch = next;
    this.callbacks.onCtrlLatchChange(next);
  }

  toggleCtrlLatch() {
    this.setCtrlLatch(!this.ctrlLatch);
    return this.ctrlLatch;
  }

  sendSequence(seq) {
    if (typeof seq !== 'string' || seq.length === 0) return;
    this.scrollOffset = 0;
    this.callbacks.onData(seq);
    this._scheduleRender();
  }

  pasteText(text) {
    const str = String(text || '');
    if (!str) return;
    const normalized = str.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
    const payload = this.bracketedPaste ? `\x1b[200~${normalized}\x1b[201~` : normalized;
    this.sendSequence(payload);
  }

  scrollViewport(deltaLines) {
    if (this.inAltScreen || this.scrollback.length === 0) {
      this.scrollOffset = 0;
      return;
    }
    const next = Math.max(0, Math.min(this.scrollback.length, this.scrollOffset + Math.trunc(deltaLines)));
    if (next !== this.scrollOffset) {
      this.scrollOffset = next;
      this._scheduleRender();
    }
  }

  _scrollUp(lines = 1) {
    const count = Math.max(1, Math.min(this.rows, lines));
    for (let n = 0; n < count; n += 1) {
      const topRow = this.grid[this.scrollTop];
      if (!this.inAltScreen && this.scrollTop === 0 && topRow && this.maxScrollback > 0) {
        this.scrollback.push(topRow);
        if (this.scrollback.length > this.maxScrollback) {
          this.scrollback.shift();
        }
        if (this.scrollOffset > 0) {
          this.scrollOffset = Math.min(this.scrollback.length, this.scrollOffset + 1);
        }
      }
      for (let r = this.scrollTop; r < this.scrollBottom; r += 1) {
        this.grid[r] = this.grid[r + 1] || this._makeRow(this.cols, this.curBg);
      }
      this.grid[this.scrollBottom] = this._makeRow(this.cols, this.curBg);
    }
  }

  _scrollDown(lines = 1) {
    const count = Math.max(1, Math.min(this.rows, lines));
    for (let n = 0; n < count; n += 1) {
      for (let r = this.scrollBottom; r > this.scrollTop; r -= 1) {
        this.grid[r] = this.grid[r - 1] || this._makeRow(this.cols, this.curBg);
      }
      this.grid[this.scrollTop] = this._makeRow(this.cols, this.curBg);
    }
  }

  _lineFeed() {
    this.pendingWrap = false;
    if (this.cursorRow === this.scrollBottom) {
      this._scrollUp(1);
    } else if (this.cursorRow < this.rows - 1) {
      this.cursorRow += 1;
    }
  }

  _putChar(ch) {
    if (this.pendingWrap) {
      if (this.autoWrap) {
        this.cursorCol = 0;
        this._lineFeed();
      } else {
        this.pendingWrap = false;
      }
    }

    const row = this.grid[this.cursorRow];
    if (row && this.cursorCol >= 0 && this.cursorCol < this.cols) {
      row[this.cursorCol] = {
        ch,
        fg: this.curFg,
        bg: this.curBg,
        bold: this.curBold,
        dim: this.curDim,
        italic: this.curItalic,
        underline: this.curUnderline,
        inverse: this.curInverse,
      };
    }

    if (this.cursorCol >= this.cols - 1) {
      this.pendingWrap = true;
    } else {
      this.cursorCol += 1;
    }
  }

  write(chunk) {
    if (!chunk) return;
    const data = this.carry + String(chunk);
    this.carry = '';
    let i = 0;
    const len = data.length;

    while (i < len) {
      const ch = data[i];
      const code = ch.charCodeAt(0);

      if (ch === '\x1b') {
        if (i + 1 >= len) {
          this.carry = data.slice(i);
          break;
        }
        const next = data[i + 1];

        if (next === '[') {
          // CSI sequence: ESC [ <params/intermediates> <final 0x40..0x7E>
          let j = i + 2;
          while (j < len) {
            const c = data.charCodeAt(j);
            if (c >= 0x40 && c <= 0x7e) break;
            j += 1;
          }
          if (j >= len) {
            if (len - i > 256) {
              i += 2;
              continue;
            }
            this.carry = data.slice(i);
            break;
          }
          const paramsRaw = data.slice(i + 2, j);
          const finalCmd = data[j];
          this._handleCsi(paramsRaw, finalCmd);
          i = j + 1;
          continue;
        }

        if (next === ']') {
          // OSC sequence: ESC ] ... (BEL or ESC \)
          let j = i + 2;
          let foundEnd = -1;
          let skip = 1;
          while (j < len) {
            if (data[j] === '\x07') {
              foundEnd = j;
              skip = 1;
              break;
            }
            if (data[j] === '\x1b' && j + 1 < len && data[j + 1] === '\\') {
              foundEnd = j;
              skip = 2;
              break;
            }
            j += 1;
          }
          if (foundEnd === -1) {
            if (len - i > 1024) {
              i += 2;
              continue;
            }
            this.carry = data.slice(i);
            break;
          }
          const oscBody = data.slice(i + 2, foundEnd);
          const semi = oscBody.indexOf(';');
          if (semi !== -1) {
            const oscCode = oscBody.slice(0, semi);
            if (oscCode === '0' || oscCode === '2') {
              this.title = oscBody.slice(semi + 1).trim();
              this.callbacks.onTitle(this.title);
            }
          }
          i = foundEnd + skip;
          continue;
        }

        if (next === 'P' || next === '_' || next === '^' || next === 'X') {
          // DCS / APC / PM / SOS terminated by ST (ESC \)
          let j = i + 2;
          let foundEnd = -1;
          while (j < len) {
            if (data[j] === '\x1b' && j + 1 < len && data[j + 1] === '\\') {
              foundEnd = j;
              break;
            }
            j += 1;
          }
          if (foundEnd === -1) {
            if (len - i > 1024) {
              i += 2;
              continue;
            }
            this.carry = data.slice(i);
            break;
          }
          i = foundEnd + 2;
          continue;
        }

        if (next === '(' || next === ')' || next === '*' || next === '+') {
          if (i + 2 >= len) {
            this.carry = data.slice(i);
            break;
          }
          i += 3;
          continue;
        }

        if (next === 'M') {
          this.pendingWrap = false;
          if (this.cursorRow === this.scrollTop) {
            this._scrollDown(1);
          } else if (this.cursorRow > 0) {
            this.cursorRow -= 1;
          }
          i += 2;
          continue;
        }

        if (next === 'D') {
          this._lineFeed();
          i += 2;
          continue;
        }

        if (next === 'E') {
          this.cursorCol = 0;
          this._lineFeed();
          i += 2;
          continue;
        }

        if (next === '7') {
          this.savedRow = this.cursorRow;
          this.savedCol = this.cursorCol;
          this.savedSgr = this._snapshotSgr();
          i += 2;
          continue;
        }

        if (next === '8') {
          this.cursorRow = Math.min(this.rows - 1, this.savedRow);
          this.cursorCol = Math.min(this.cols - 1, this.savedCol);
          this.pendingWrap = false;
          this._restoreSgr(this.savedSgr);
          i += 2;
          continue;
        }

        if (next === 'c') {
          this._resetSgr();
          this.clearScrollbackAndScreen();
          i += 2;
          continue;
        }

        i += 2;
        continue;
      }

      if (ch === '\r') {
        this.cursorCol = 0;
        this.pendingWrap = false;
        i += 1;
        continue;
      }

      if (ch === '\n' || ch === '\x0b' || ch === '\x0c') {
        this._lineFeed();
        i += 1;
        continue;
      }

      if (ch === '\b' || code === 0x08) {
        if (this.pendingWrap) {
          this.pendingWrap = false;
        } else if (this.cursorCol > 0) {
          this.cursorCol -= 1;
        }
        i += 1;
        continue;
      }

      if (ch === '\t') {
        this.pendingWrap = false;
        const nextTab = (Math.floor(this.cursorCol / 8) + 1) * 8;
        this.cursorCol = Math.min(this.cols - 1, nextTab);
        i += 1;
        continue;
      }

      if (code < 32 || code === 0x7f) {
        i += 1;
        continue;
      }

      // Handle UTF-16 surrogate pairs cleanly (emojis / symbols)
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
        const low = data.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          this._putChar(data.slice(i, i + 2));
          i += 2;
          continue;
        }
      }

      this._putChar(ch);
      i += 1;
    }

    this._syncDataset();
    this._scheduleRender();
  }

  _handleCsi(raw, cmd) {
    const isPrivate = raw.startsWith('?');
    const isGt = raw.startsWith('>');
    const clean = isPrivate || isGt ? raw.slice(1) : raw;

    if (cmd === 'm' && !isPrivate && !isGt) {
      this._handleSgr(clean);
      return;
    }

    const parts = clean.length ? clean.split(';').map((s) => Number.parseInt(s, 10) || 0) : [];
    const p0 = parts[0] || 0;
    const p1 = parts[1] || 0;

    if (isPrivate) {
      if (cmd === 'h') {
        for (const mode of parts) {
          if (mode === 1) this.appCursorKeys = true;
          else if (mode === 7) this.autoWrap = true;
          else if (mode === 25) this.cursorVisible = true;
          else if (mode === 2004) this.bracketedPaste = true;
          else if (mode === 1049 || mode === 1047 || mode === 47) {
            this._enterAltScreen();
          }
        }
      } else if (cmd === 'l') {
        for (const mode of parts) {
          if (mode === 1) this.appCursorKeys = false;
          else if (mode === 7) this.autoWrap = false;
          else if (mode === 25) this.cursorVisible = false;
          else if (mode === 2004) this.bracketedPaste = false;
          else if (mode === 1049 || mode === 1047 || mode === 47) {
            this._leaveAltScreen();
          }
        }
      }
      return;
    }

    if (isGt) {
      if (cmd === 'c') {
        this.callbacks.onData('\x1b[>0;276;0c');
      }
      return;
    }

    switch (cmd) {
      case 'A':
        this.pendingWrap = false;
        this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, p0));
        break;
      case 'B':
        this.pendingWrap = false;
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + Math.max(1, p0));
        break;
      case 'C':
        this.pendingWrap = false;
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + Math.max(1, p0));
        break;
      case 'D':
        this.pendingWrap = false;
        this.cursorCol = Math.max(0, this.cursorCol - Math.max(1, p0));
        break;
      case 'E':
        this.pendingWrap = false;
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + Math.max(1, p0));
        this.cursorCol = 0;
        break;
      case 'F':
        this.pendingWrap = false;
        this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, p0));
        this.cursorCol = 0;
        break;
      case 'G':
      case '`':
        this.pendingWrap = false;
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, (p0 || 1) - 1));
        break;
      case 'd':
        this.pendingWrap = false;
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, (p0 || 1) - 1));
        break;
      case 'H':
      case 'f':
        this.pendingWrap = false;
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, (p0 || 1) - 1));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, (p1 || 1) - 1));
        break;
      case 'J': {
        const mode = p0;
        if (mode === 2 || mode === 3) {
          if (mode === 3) {
            this.scrollback = [];
            this.scrollOffset = 0;
          }
          for (let r = 0; r < this.rows; r += 1) {
            this.grid[r] = this._makeRow(this.cols, this.curBg);
          }
        } else if (mode === 0) {
          const cur = this.grid[this.cursorRow];
          if (cur) {
            for (let c = this.cursorCol; c < this.cols; c += 1) {
              cur[c] = makeBlankCell(this.curBg);
            }
          }
          for (let r = this.cursorRow + 1; r < this.rows; r += 1) {
            this.grid[r] = this._makeRow(this.cols, this.curBg);
          }
        } else if (mode === 1) {
          for (let r = 0; r < this.cursorRow; r += 1) {
            this.grid[r] = this._makeRow(this.cols, this.curBg);
          }
          const cur = this.grid[this.cursorRow];
          if (cur) {
            for (let c = 0; c <= this.cursorCol; c += 1) {
              cur[c] = makeBlankCell(this.curBg);
            }
          }
        }
        break;
      }
      case 'K': {
        const mode = p0;
        const cur = this.grid[this.cursorRow];
        if (!cur) break;
        if (mode === 0) {
          for (let c = this.cursorCol; c < this.cols; c += 1) {
            cur[c] = makeBlankCell(this.curBg);
          }
        } else if (mode === 1) {
          for (let c = 0; c <= this.cursorCol; c += 1) {
            cur[c] = makeBlankCell(this.curBg);
          }
        } else if (mode === 2) {
          for (let c = 0; c < this.cols; c += 1) {
            cur[c] = makeBlankCell(this.curBg);
          }
        }
        break;
      }
      case 'L': {
        const count = Math.max(1, Math.min(this.rows, p0));
        if (this.cursorRow >= this.scrollTop && this.cursorRow <= this.scrollBottom) {
          for (let n = 0; n < count; n += 1) {
            for (let r = this.scrollBottom; r > this.cursorRow; r -= 1) {
              this.grid[r] = this.grid[r - 1] || this._makeRow(this.cols, this.curBg);
            }
            this.grid[this.cursorRow] = this._makeRow(this.cols, this.curBg);
          }
        }
        break;
      }
      case 'M': {
        const count = Math.max(1, Math.min(this.rows, p0));
        if (this.cursorRow >= this.scrollTop && this.cursorRow <= this.scrollBottom) {
          for (let n = 0; n < count; n += 1) {
            for (let r = this.cursorRow; r < this.scrollBottom; r += 1) {
              this.grid[r] = this.grid[r + 1] || this._makeRow(this.cols, this.curBg);
            }
            this.grid[this.scrollBottom] = this._makeRow(this.cols, this.curBg);
          }
        }
        break;
      }
      case 'S':
        this._scrollUp(Math.max(1, p0));
        break;
      case 'T':
        this._scrollDown(Math.max(1, p0));
        break;
      case 'P': {
        const count = Math.max(1, Math.min(this.cols, p0));
        const cur = this.grid[this.cursorRow];
        if (cur) {
          cur.splice(this.cursorCol, count);
          while (cur.length < this.cols) {
            cur.push(makeBlankCell(this.curBg));
          }
        }
        break;
      }
      case '@': {
        const count = Math.max(1, Math.min(this.cols, p0));
        const cur = this.grid[this.cursorRow];
        if (cur) {
          const blanks = new Array(count);
          for (let b = 0; b < count; b += 1) blanks[b] = makeBlankCell(this.curBg);
          cur.splice(this.cursorCol, 0, ...blanks);
          cur.length = this.cols;
        }
        break;
      }
      case 'X': {
        const count = Math.max(1, Math.min(this.cols, p0));
        const cur = this.grid[this.cursorRow];
        if (cur) {
          const limit = Math.min(this.cols, this.cursorCol + count);
          for (let c = this.cursorCol; c < limit; c += 1) {
            cur[c] = makeBlankCell(this.curBg);
          }
        }
        break;
      }
      case 'r': {
        const top = Math.max(1, p0 || 1) - 1;
        const bot = Math.min(this.rows, p1 || this.rows) - 1;
        if (bot > top) {
          this.scrollTop = top;
          this.scrollBottom = bot;
        } else {
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        }
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.pendingWrap = false;
        break;
      }
      case 's':
        this.savedRow = this.cursorRow;
        this.savedCol = this.cursorCol;
        this.savedSgr = this._snapshotSgr();
        break;
      case 'u':
        this.cursorRow = Math.min(this.rows - 1, this.savedRow);
        this.cursorCol = Math.min(this.cols - 1, this.savedCol);
        this.pendingWrap = false;
        this._restoreSgr(this.savedSgr);
        break;
      case 'n':
        if (p0 === 6) {
          this.callbacks.onData(`\x1b[${this.cursorRow + 1};${this.cursorCol + 1}R`);
        } else if (p0 === 5) {
          this.callbacks.onData('\x1b[0n');
        }
        break;
      case 'c':
        if (p0 === 0) {
          this.callbacks.onData('\x1b[?1;2c');
        }
        break;
      default:
        break;
    }
  }

  _enterAltScreen() {
    if (this.inAltScreen) return;
    this.normalGrid = this.grid;
    this.normalCursorRow = this.cursorRow;
    this.normalCursorCol = this.cursorCol;
    this.normalPendingWrap = this.pendingWrap;
    this.grid = this._makeGrid(this.rows, this.cols);
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.pendingWrap = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.scrollOffset = 0;
    this.inAltScreen = true;
  }

  _leaveAltScreen() {
    if (!this.inAltScreen) return;
    this.grid = this.normalGrid;
    this.cursorRow = Math.min(this.rows - 1, this.normalCursorRow);
    this.cursorCol = Math.min(this.cols - 1, this.normalCursorCol);
    this.pendingWrap = this.normalPendingWrap;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.scrollOffset = 0;
    this.inAltScreen = false;
  }

  _handleSgr(raw) {
    if (!raw) {
      this._resetSgr();
      return;
    }

    // Flatten colon sub-params (e.g., 38:5:196 -> 38,5,196)
    const tokens = raw.split(';');
    const codes = [];
    for (const tok of tokens) {
      if (tok.includes(':')) {
        const subs = tok.split(':');
        for (const sub of subs) {
          codes.push(Number.parseInt(sub, 10) || 0);
        }
      } else {
        codes.push(tok === '' ? 0 : Number.parseInt(tok, 10) || 0);
      }
    }

    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) {
        this._resetSgr();
      } else if (code === 1) {
        this.curBold = true;
      } else if (code === 2) {
        this.curDim = true;
      } else if (code === 3) {
        this.curItalic = true;
      } else if (code === 4) {
        this.curUnderline = true;
      } else if (code === 7) {
        this.curInverse = true;
      } else if (code === 22) {
        this.curBold = false;
        this.curDim = false;
      } else if (code === 23) {
        this.curItalic = false;
      } else if (code === 24) {
        this.curUnderline = false;
      } else if (code === 27) {
        this.curInverse = false;
      } else if (code >= 30 && code <= 37) {
        this.curFg = ANSI_16_COLORS[code - 30];
      } else if (code === 39) {
        this.curFg = null;
      } else if (code >= 40 && code <= 47) {
        this.curBg = ANSI_16_COLORS[code - 40];
      } else if (code === 49) {
        this.curBg = null;
      } else if (code >= 90 && code <= 97) {
        this.curFg = ANSI_16_COLORS[code - 90 + 8];
      } else if (code >= 100 && code <= 107) {
        this.curBg = ANSI_16_COLORS[code - 100 + 8];
      } else if (code === 38 || code === 48) {
        const isFg = code === 38;
        const mode = codes[i + 1];
        if (mode === 5 && i + 2 < codes.length) {
          const hex = ansi256ToHex(codes[i + 2]);
          if (isFg) this.curFg = hex;
          else this.curBg = hex;
          i += 2;
        } else if (mode === 2 && i + 4 < codes.length) {
          const hex = rgbToHex(codes[i + 2], codes[i + 3], codes[i + 4]);
          if (isFg) this.curFg = hex;
          else this.curBg = hex;
          i += 4;
        }
      }
    }
  }

  getCell(row, col) {
    const r = Math.trunc(row);
    const c = Math.trunc(col);
    if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) {
      return makeBlankCell();
    }
    return cloneCell(this.grid[r][c]);
  }

  getLineText(row) {
    const r = Math.trunc(row);
    if (r < 0 || r >= this.rows || !this.grid[r]) return '';
    return this.grid[r]
      .map((cell) => cell.ch)
      .join('')
      .replace(/\s+$/, '');
  }

  renderText(showCursor = false) {
    const lines = [];
    if (!this.inAltScreen && this.scrollback.length > 0) {
      const start = Math.max(0, this.scrollback.length - 200);
      for (let s = start; s < this.scrollback.length; s += 1) {
        const sRow = this.scrollback[s];
        lines.push(
          sRow
            .map((cell) => cell.ch)
            .join('')
            .replace(/\s+$/, ''),
        );
      }
    }

    let lastNonEmpty = this.cursorRow;
    for (let r = this.rows - 1; r > this.cursorRow; r -= 1) {
      if (this.getLineText(r).length > 0) {
        lastNonEmpty = r;
        break;
      }
    }

    for (let r = 0; r <= lastNonEmpty; r += 1) {
      const row = this.grid[r];
      if (!row) {
        lines.push('');
        continue;
      }
      const chars = row.map((cell) => cell.ch);
      if (showCursor && this.cursorVisible && r === this.cursorRow) {
        const col = Math.max(0, Math.min(this.cols - 1, this.cursorCol));
        chars[col] = chars[col] === ' ' ? '█' : `${chars[col]}\u0332`;
      }
      lines.push(chars.join('').replace(/\s+$/, ''));
    }

    return lines.join('\n');
  }

  /* ========================================================================
     Browser High-DPI 60fps <canvas> Attachment, ResizeObserver & Input
     ======================================================================== */

  attach(canvasEl, containerEl = null) {
    this.detach();
    if (!canvasEl) return () => {};

    this._canvas = canvasEl;
    this._container = containerEl || canvasEl.parentElement || canvasEl;
    this._ctx = canvasEl.getContext('2d', { alpha: false });
    this._reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const addListener = (target, event, handler, opts) => {
      target.addEventListener(event, handler, opts);
      this._listeners.push([target, event, handler, opts]);
    };

    const onPointerDown = () => {
      this.focus();
    };

    const onFocus = () => {
      this._focused = true;
      this._cursorBlinkOn = true;
      this._startBlink();
      this._scheduleRender();
    };

    const onBlur = () => {
      this._focused = false;
      this._stopBlink();
      this._cursorBlinkOn = true;
      this._scheduleRender();
    };

    const onKeyDown = (ev) => {
      const mapped = keyEventToAnsi(ev, {
        appCursorKeys: this.appCursorKeys,
        ctrlLatch: this.ctrlLatch,
      });
      if (mapped.consumeCtrlLatch) {
        this.setCtrlLatch(false);
      }
      if (mapped.preventDefault) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      if (mapped.data) {
        this._cursorBlinkOn = true;
        this.sendSequence(mapped.data);
      }
    };

    const onPaste = (ev) => {
      const pasted = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
      if (!pasted) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.pasteText(pasted);
    };

    const onWheel = (ev) => {
      if (this.inAltScreen || this.scrollback.length === 0) return;
      if (ev.deltaY === 0) return;
      ev.preventDefault();
      const step = ev.deltaY < 0 ? 3 : -3;
      this.scrollViewport(step);
    };

    addListener(canvasEl, 'pointerdown', onPointerDown);
    addListener(canvasEl, 'focus', onFocus);
    addListener(canvasEl, 'blur', onBlur);
    addListener(canvasEl, 'keydown', onKeyDown);
    addListener(canvasEl, 'paste', onPaste);
    addListener(canvasEl, 'wheel', onWheel, { passive: false });

    if (typeof ResizeObserver === 'function' && this._container) {
      this._resizeObserver = new ResizeObserver(() => {
        this.fit();
      });
      this._resizeObserver.observe(this._container);
    } else if (typeof window !== 'undefined') {
      addListener(window, 'resize', () => this.fit());
    }

    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (this._canvas === canvasEl) {
          this.fit();
        }
      });
    }

    this.fit();
    this._scheduleRender();

    return () => this.detach();
  }

  detach() {
    this._stopBlink();
    if (this._rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    if (this._resizeObserver) {
      try {
        this._resizeObserver.disconnect();
      } catch {
        // Ignore observer disconnect error
      }
      this._resizeObserver = null;
    }
    for (const [target, event, handler, opts] of this._listeners) {
      target.removeEventListener(event, handler, opts);
    }
    this._listeners = [];
    this._canvas = null;
    this._container = null;
    this._ctx = null;
    this._focused = false;
  }

  focus() {
    if (this._canvas && typeof this._canvas.focus === 'function') {
      this._canvas.focus({ preventScroll: true });
    }
  }

  _startBlink() {
    this._stopBlink();
    if (this._reducedMotion) return;
    this._blinkTimer = setInterval(() => {
      if (!this._focused) return;
      this._cursorBlinkOn = !this._cursorBlinkOn;
      this._scheduleRender();
    }, 530);
  }

  _stopBlink() {
    if (this._blinkTimer) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = null;
    }
  }

  _measureGlyphMetrics() {
    const ctx = this._ctx;
    if (!ctx) return;
    ctx.font = `500 ${this.theme.fontSizePx}px ${this.theme.fontFamily}`;
    const measured = ctx.measureText('MMMMMMMMMM').width / 10;
    if (Number.isFinite(measured) && measured > 4 && measured < 30) {
      this._cellWidth = measured;
    }
    this._cellHeight = this.theme.lineHeightPx;
  }

  fit() {
    if (!this._canvas || !this._container) return this.getDimensions();
    const rect = this._container.getBoundingClientRect();
    const cssW = Math.floor(rect.width);
    const cssH = Math.floor(rect.height);
    if (cssW < 80 || cssH < 60) {
      return this.getDimensions();
    }

    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? Math.min(3, window.devicePixelRatio) : 1;
    const backingW = Math.max(1, Math.round(cssW * dpr));
    const backingH = Math.max(1, Math.round(cssH * dpr));

    if (this._canvas.width !== backingW || this._canvas.height !== backingH) {
      this._canvas.width = backingW;
      this._canvas.height = backingH;
    }
    this._cssWidth = cssW;
    this._cssHeight = cssH;
    this._dpr = dpr;

    if (this._ctx) {
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this._measureGlyphMetrics();

    const usableW = Math.max(40, cssW - this.theme.padX * 2);
    const usableH = Math.max(40, cssH - this.theme.padY * 2);
    const nextCols = Math.max(20, Math.min(300, Math.floor(usableW / this._cellWidth)));
    const nextRows = Math.max(8, Math.min(120, Math.floor(usableH / this._cellHeight)));

    this.resize(nextCols, nextRows);
    if (nextCols !== this._lastReportedCols || nextRows !== this._lastReportedRows) {
      this._lastReportedCols = nextCols;
      this._lastReportedRows = nextRows;
      this.callbacks.onResize(nextCols, nextRows);
    }
    this._scheduleRender();
    return { cols: this.cols, rows: this.rows };
  }

  _syncDataset() {
    if (!this._canvas || !this._canvas.dataset) return;
    this._canvas.dataset.cols = String(this.cols);
    this._canvas.dataset.rows = String(this.rows);
    this._canvas.dataset.altScreen = this.inAltScreen ? 'true' : 'false';
  }

  _scheduleRender() {
    if (!this._canvas || !this._ctx) return;
    this._dirty = true;
    if (this._rafId) return;
    if (typeof requestAnimationFrame === 'function') {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = 0;
        if (this._dirty) {
          this._dirty = false;
          this.renderNow();
        }
      });
    } else {
      this._dirty = false;
      this.renderNow();
    }
  }

  _getVisibleRow(viewRow) {
    if (this.inAltScreen || this.scrollOffset === 0) {
      return this.grid[viewRow];
    }
    const total = this.scrollback.length + this.rows;
    const startIdx = Math.max(0, total - this.rows - this.scrollOffset);
    const idx = startIdx + viewRow;
    if (idx < this.scrollback.length) {
      return this.scrollback[idx];
    }
    return this.grid[idx - this.scrollback.length];
  }

  renderNow() {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;
    const w = this._cssWidth || this._canvas.width / this._dpr;
    const h = this._cssHeight || this._canvas.height / this._dpr;
    if (w <= 0 || h <= 0) return;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, w, h);

    const cellW = this._cellWidth;
    const cellH = this._cellHeight;
    const padX = this.theme.padX;
    const padY = this.theme.padY;
    const baselineOffset = Math.round(cellH * 0.76);
    const baseFont = `500 ${this.theme.fontSizePx}px ${this.theme.fontFamily}`;
    const boldFont = `700 ${this.theme.fontSizePx}px ${this.theme.fontFamily}`;
    const italicFont = `italic 500 ${this.theme.fontSizePx}px ${this.theme.fontFamily}`;
    const boldItalicFont = `italic 700 ${this.theme.fontSizePx}px ${this.theme.fontFamily}`;

    let activeFont = '';
    ctx.textBaseline = 'alphabetic';

    for (let r = 0; r < this.rows; r += 1) {
      const row = this._getVisibleRow(r);
      if (!row) continue;
      const y = padY + r * cellH;
      const textY = y + baselineOffset;

      for (let c = 0; c < this.cols; c += 1) {
        const cell = row[c];
        if (!cell) continue;

        let fg = cell.fg || this.theme.fg;
        let bg = cell.bg;
        if (cell.bold && !cell.fg) {
          fg = '#F4F8FD';
        }
        if (cell.inverse) {
          const tmp = fg;
          fg = bg || this.theme.bg;
          bg = tmp;
        }

        const x = padX + c * cellW;
        if (bg) {
          ctx.fillStyle = bg;
          ctx.fillRect(x, y, Math.ceil(cellW + 0.5), cellH);
        }

        const hasGlyph = cell.ch !== ' ' && cell.ch !== '';
        if (hasGlyph || cell.underline) {
          const wantFont =
            cell.bold && cell.italic
              ? boldItalicFont
              : cell.bold
                ? boldFont
                : cell.italic
                  ? italicFont
                  : baseFont;
          if (wantFont !== activeFont) {
            ctx.font = wantFont;
            activeFont = wantFont;
          }

          if (cell.dim) ctx.globalAlpha = 0.62;
          ctx.fillStyle = fg;
          if (hasGlyph) {
            ctx.fillText(cell.ch, x, textY);
          }
          if (cell.underline) {
            ctx.fillRect(x, y + cellH - 2, Math.ceil(cellW + 0.5), 1);
          }
          if (cell.dim) ctx.globalAlpha = 1;
        }
      }
    }

    // Cursor rendering (when visible and not scrolled up into history)
    if (this.cursorVisible && this.scrollOffset === 0) {
      const curCol = Math.max(0, Math.min(this.cols - 1, this.cursorCol));
      const curRow = Math.max(0, Math.min(this.rows - 1, this.cursorRow));
      const cx = padX + curCol * cellW;
      const cy = padY + curRow * cellH;

      if (this._focused) {
        if (this._cursorBlinkOn) {
          ctx.fillStyle = this.theme.cursorBg;
          ctx.fillRect(cx, cy + 1, Math.ceil(cellW), cellH - 2);
          const under = this.grid[curRow]?.[curCol];
          if (under && under.ch !== ' ' && under.ch !== '') {
            ctx.font = under.bold ? boldFont : baseFont;
            ctx.fillStyle = this.theme.cursorFg;
            ctx.fillText(under.ch, cx, cy + baselineOffset);
          }
        }
      } else {
        ctx.strokeStyle = this.theme.cursorBorder;
        ctx.lineWidth = 1.25;
        ctx.strokeRect(cx + 0.5, cy + 1.5, Math.ceil(cellW) - 1, cellH - 3);
      }
    }

    this.callbacks.onRender(this);
  }
}
