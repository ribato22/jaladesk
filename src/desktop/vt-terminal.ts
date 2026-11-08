export class VtTerminal {
  cols: number;
  rows: number;
  cursorRow = 0;
  cursorCol = 0;
  savedRow = 0;
  savedCol = 0;
  scrollTop = 0;
  scrollBottom: number;
  appCursorKeys = false;
  inAltScreen = false;
  title = '';

  private grid: string[][];
  private normalGrid: string[][];
  private normalCursorRow = 0;
  private normalCursorCol = 0;
  private scrollback: string[] = [];
  private carry = '';

  constructor(cols = 100, rows = 28) {
    this.cols = Math.max(20, cols);
    this.rows = Math.max(8, rows);
    this.scrollBottom = this.rows - 1;
    this.grid = this.makeGrid(this.rows, this.cols);
    this.normalGrid = this.grid;
  }

  private makeRow(cols = this.cols): string[] {
    return new Array<string>(cols).fill(' ');
  }

  private makeGrid(rows: number, cols: number): string[][] {
    const g: string[][] = [];
    for (let r = 0; r < rows; r++) {
      g.push(this.makeRow(cols));
    }
    return g;
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(20, Math.min(300, cols));
    const nextRows = Math.max(8, Math.min(120, rows));
    if (nextCols === this.cols && nextRows === this.rows) return;
    const newGrid = this.makeGrid(nextRows, nextCols);
    const copyRows = Math.min(this.rows, nextRows);
    const copyCols = Math.min(this.cols, nextCols);
    for (let r = 0; r < copyRows; r++) {
      for (let c = 0; c < copyCols; c++) {
        newGrid[r]![c] = this.grid[r]?.[c] ?? ' ';
      }
    }
    this.cols = nextCols;
    this.rows = nextRows;
    this.grid = newGrid;
    if (!this.inAltScreen) this.normalGrid = newGrid;
    this.scrollTop = 0;
    this.scrollBottom = nextRows - 1;
    this.cursorRow = Math.min(this.cursorRow, nextRows - 1);
    this.cursorCol = Math.min(this.cursorCol, nextCols - 1);
  }

  clearScrollbackAndScreen(): void {
    this.scrollback = [];
    this.grid = this.makeGrid(this.rows, this.cols);
    if (!this.inAltScreen) this.normalGrid = this.grid;
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  private scrollUp(lines = 1): void {
    for (let n = 0; n < lines; n++) {
      const topRow = this.grid[this.scrollTop];
      if (!this.inAltScreen && this.scrollTop === 0 && topRow) {
        this.scrollback.push(topRow.join('').replace(/\s+$/, ''));
        if (this.scrollback.length > 800) {
          this.scrollback.shift();
        }
      }
      for (let r = this.scrollTop; r < this.scrollBottom; r++) {
        this.grid[r] = this.grid[r + 1] ?? this.makeRow();
      }
      this.grid[this.scrollBottom] = this.makeRow();
    }
  }

  private scrollDown(lines = 1): void {
    for (let n = 0; n < lines; n++) {
      for (let r = this.scrollBottom; r > this.scrollTop; r--) {
        this.grid[r] = this.grid[r - 1] ?? this.makeRow();
      }
      this.grid[this.scrollTop] = this.makeRow();
    }
  }

  private lineFeed(): void {
    if (this.cursorRow === this.scrollBottom) {
      this.scrollUp(1);
    } else if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    }
  }

  private putChar(ch: string): void {
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.lineFeed();
    }
    const row = this.grid[this.cursorRow];
    if (row) {
      row[this.cursorCol] = ch;
    }
    this.cursorCol++;
  }

  write(chunk: string): void {
    const data = this.carry + chunk;
    this.carry = '';
    let i = 0;
    const len = data.length;

    while (i < len) {
      const ch = data[i]!;
      const code = ch.charCodeAt(0);

      if (ch === '\x1b') {
        if (i + 1 >= len) {
          this.carry = data.slice(i);
          break;
        }
        const next = data[i + 1]!;
        if (next === '[') {
          // CSI sequence: \x1b[ ... finalByte (0x40..0x7E)
          let j = i + 2;
          while (j < len) {
            const c = data.charCodeAt(j);
            if (c >= 0x40 && c <= 0x7e) break;
            j++;
          }
          if (j >= len) {
            this.carry = data.slice(i);
            break;
          }
          const paramsRaw = data.slice(i + 2, j);
          const finalCmd = data[j]!;
          this.handleCsi(paramsRaw, finalCmd);
          i = j + 1;
          continue;
        } else if (next === ']') {
          // OSC sequence: \x1b] ... (\x07 or \x1b\\)
          let j = i + 2;
          let foundEnd = -1;
          let skip = 1;
          while (j < len) {
            if (data[j] === '\x07') {
              foundEnd = j;
              skip = 1;
              break;
            }
            if (data[j] === '\x1b' && data[j + 1] === '\\') {
              foundEnd = j;
              skip = 2;
              break;
            }
            j++;
          }
          if (foundEnd === -1) {
            if (len - i > 512) {
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
            }
          }
          i = foundEnd + skip;
          continue;
        } else if (next === '(' || next === ')' || next === '*' || next === '+') {
          if (i + 2 >= len) {
            this.carry = data.slice(i);
            break;
          }
          i += 3;
          continue;
        } else if (next === 'M') {
          if (this.cursorRow === this.scrollTop) {
            this.scrollDown(1);
          } else if (this.cursorRow > 0) {
            this.cursorRow--;
          }
          i += 2;
          continue;
        } else if (next === 'D') {
          this.lineFeed();
          i += 2;
          continue;
        } else if (next === 'E') {
          this.cursorCol = 0;
          this.lineFeed();
          i += 2;
          continue;
        } else if (next === '7') {
          this.savedRow = this.cursorRow;
          this.savedCol = this.cursorCol;
          i += 2;
          continue;
        } else if (next === '8') {
          this.cursorRow = Math.min(this.rows - 1, this.savedRow);
          this.cursorCol = Math.min(this.cols - 1, this.savedCol);
          i += 2;
          continue;
        } else if (next === 'c') {
          this.clearScrollbackAndScreen();
          i += 2;
          continue;
        } else {
          i += 2;
          continue;
        }
      }

      if (ch === '\r') {
        this.cursorCol = 0;
        i++;
        continue;
      }
      if (ch === '\n' || ch === '\x0b' || ch === '\x0c') {
        this.lineFeed();
        i++;
        continue;
      }
      if (ch === '\b' || code === 0x08) {
        if (this.cursorCol > 0) this.cursorCol--;
        i++;
        continue;
      }
      if (ch === '\t') {
        const nextTab = (Math.floor(this.cursorCol / 8) + 1) * 8;
        this.cursorCol = Math.min(this.cols - 1, nextTab);
        i++;
        continue;
      }
      if (code < 32 || code === 0x7f) {
        i++;
        continue;
      }

      this.putChar(ch);
      i++;
    }
  }

  private handleCsi(raw: string, cmd: string): void {
    const isPrivate = raw.startsWith('?');
    const clean = isPrivate ? raw.slice(1) : raw;
    const parts = clean.length ? clean.split(';').map((s) => Number.parseInt(s, 10) || 0) : [];
    const p0 = parts[0] || 0;
    const p1 = parts[1] || 0;

    if (isPrivate) {
      if (cmd === 'h') {
        if (parts.includes(1)) this.appCursorKeys = true;
        if (parts.includes(1049) || parts.includes(47) || parts.includes(1047)) {
          if (!this.inAltScreen) {
            this.normalGrid = this.grid;
            this.normalCursorRow = this.cursorRow;
            this.normalCursorCol = this.cursorCol;
            this.grid = this.makeGrid(this.rows, this.cols);
            this.cursorRow = 0;
            this.cursorCol = 0;
            this.inAltScreen = true;
          }
        }
      } else if (cmd === 'l') {
        if (parts.includes(1)) this.appCursorKeys = false;
        if (parts.includes(1049) || parts.includes(47) || parts.includes(1047)) {
          if (this.inAltScreen) {
            this.grid = this.normalGrid;
            this.cursorRow = Math.min(this.rows - 1, this.normalCursorRow);
            this.cursorCol = Math.min(this.cols - 1, this.normalCursorCol);
            this.inAltScreen = false;
          }
        }
      }
      return;
    }

    switch (cmd) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, p0));
        break;
      case 'B':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + Math.max(1, p0));
        break;
      case 'C':
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + Math.max(1, p0));
        break;
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - Math.max(1, p0));
        break;
      case 'E':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + Math.max(1, p0));
        this.cursorCol = 0;
        break;
      case 'F':
        this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, p0));
        this.cursorCol = 0;
        break;
      case 'G':
      case '`':
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, (p0 || 1) - 1));
        break;
      case 'd':
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, (p0 || 1) - 1));
        break;
      case 'H':
      case 'f':
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, (p0 || 1) - 1));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, (p1 || 1) - 1));
        break;
      case 'J': {
        const mode = p0;
        if (mode === 2 || mode === 3) {
          if (mode === 3) this.scrollback = [];
          for (let r = 0; r < this.rows; r++) {
            this.grid[r] = this.makeRow();
          }
        } else if (mode === 0) {
          const cur = this.grid[this.cursorRow];
          if (cur) {
            for (let c = this.cursorCol; c < this.cols; c++) cur[c] = ' ';
          }
          for (let r = this.cursorRow + 1; r < this.rows; r++) {
            this.grid[r] = this.makeRow();
          }
        } else if (mode === 1) {
          for (let r = 0; r < this.cursorRow; r++) {
            this.grid[r] = this.makeRow();
          }
          const cur = this.grid[this.cursorRow];
          if (cur) {
            for (let c = 0; c <= this.cursorCol; c++) cur[c] = ' ';
          }
        }
        break;
      }
      case 'K': {
        const mode = p0;
        const cur = this.grid[this.cursorRow];
        if (!cur) break;
        if (mode === 0) {
          for (let c = this.cursorCol; c < this.cols; c++) cur[c] = ' ';
        } else if (mode === 1) {
          for (let c = 0; c <= this.cursorCol; c++) cur[c] = ' ';
        } else if (mode === 2) {
          for (let c = 0; c < this.cols; c++) cur[c] = ' ';
        }
        break;
      }
      case 'L': {
        const count = Math.max(1, p0);
        for (let n = 0; n < count; n++) {
          for (let r = this.scrollBottom; r > this.cursorRow; r--) {
            this.grid[r] = this.grid[r - 1] ?? this.makeRow();
          }
          this.grid[this.cursorRow] = this.makeRow();
        }
        break;
      }
      case 'M': {
        const count = Math.max(1, p0);
        for (let n = 0; n < count; n++) {
          for (let r = this.cursorRow; r < this.scrollBottom; r++) {
            this.grid[r] = this.grid[r + 1] ?? this.makeRow();
          }
          this.grid[this.scrollBottom] = this.makeRow();
        }
        break;
      }
      case 'P': {
        const count = Math.max(1, p0);
        const cur = this.grid[this.cursorRow];
        if (cur) {
          cur.splice(this.cursorCol, count);
          while (cur.length < this.cols) cur.push(' ');
        }
        break;
      }
      case '@': {
        const count = Math.max(1, p0);
        const cur = this.grid[this.cursorRow];
        if (cur) {
          const blanks = new Array<string>(count).fill(' ');
          cur.splice(this.cursorCol, 0, ...blanks);
          cur.length = this.cols;
        }
        break;
      }
      case 'X': {
        const count = Math.max(1, p0);
        const cur = this.grid[this.cursorRow];
        if (cur) {
          for (let c = this.cursorCol; c < Math.min(this.cols, this.cursorCol + count); c++) {
            cur[c] = ' ';
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
          this.cursorRow = 0;
          this.cursorCol = 0;
        }
        break;
      }
      case 's':
        this.savedRow = this.cursorRow;
        this.savedCol = this.cursorCol;
        break;
      case 'u':
        this.cursorRow = Math.min(this.rows - 1, this.savedRow);
        this.cursorCol = Math.min(this.cols - 1, this.savedCol);
        break;
      default:
        break;
    }
  }

  renderText(showCursor = true): string {
    const activeLines: string[] = [];
    let lastNonEmptyRow = this.cursorRow;
    for (let r = this.rows - 1; r > this.cursorRow; r--) {
      const line = this.grid[r]?.join('').replace(/\s+$/, '') ?? '';
      if (line.length > 0) {
        lastNonEmptyRow = r;
        break;
      }
    }

    for (let r = 0; r <= lastNonEmptyRow; r++) {
      const rowCells = [...(this.grid[r] ?? this.makeRow())];
      if (showCursor && r === this.cursorRow) {
        const c = Math.min(this.cols - 1, Math.max(0, this.cursorCol));
        const existing = rowCells[c] ?? ' ';
        rowCells[c] = existing === ' ' ? '█' : `${existing}\u0332`;
      }
      activeLines.push(rowCells.join('').replace(/\s+$/, ''));
    }

    if (this.inAltScreen || this.scrollback.length === 0) {
      return activeLines.join('\n');
    }
    return [...this.scrollback, ...activeLines].join('\n');
  }
}
