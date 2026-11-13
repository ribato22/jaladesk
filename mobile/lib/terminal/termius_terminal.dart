import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Curated Termius-grade terminal color themes with full 16-color ANSI palettes.
class TerminalThemePreset {
  final String id;
  final String name;
  final Color background;
  final Color chromeSurface;
  final Color border;
  final Color foreground;
  final Color cursor;
  final Color selection;
  final bool isLight;
  final List<Color> ansi16;

  const TerminalThemePreset({
    required this.id,
    required this.name,
    required this.background,
    required this.chromeSurface,
    required this.border,
    required this.foreground,
    required this.cursor,
    required this.selection,
    this.isLight = false,
    required this.ansi16,
  });

  static const List<TerminalThemePreset> presets = [
    TerminalThemePreset(
      id: 'jala_sapphire',
      name: 'Jala Sapphire',
      background: Color(0xFF080D16),
      chromeSurface: Color(0xFF0F1724),
      border: Color(0xFF22324A),
      foreground: Color(0xFFE6EDF7),
      cursor: Color(0xFFE0B454),
      selection: Color(0x552E6DB4),
      ansi16: [
        Color(0xFF1A2233),
        Color(0xFFF06A6A),
        Color(0xFF42D392),
        Color(0xFFE0B454),
        Color(0xFF5CA8FF),
        Color(0xFFC792EA),
        Color(0xFF56D4DD),
        Color(0xFFD5DEEB),
        Color(0xFF5C6B82),
        Color(0xFFFF8585),
        Color(0xFF67E8AE),
        Color(0xFFF4CC74),
        Color(0xFF82BCFF),
        Color(0xFFDAB3F8),
        Color(0xFF7CE8F0),
        Color(0xFFFFFFFF),
      ],
    ),
    TerminalThemePreset(
      id: 'termius_dark',
      name: 'Termius Classic',
      background: Color(0xFF141720),
      chromeSurface: Color(0xFF1B1F2B),
      border: Color(0xFF2B3142),
      foreground: Color(0xFFE5E9F0),
      cursor: Color(0xFF2EC87E),
      selection: Color(0x552EC87E),
      ansi16: [
        Color(0xFF232836),
        Color(0xFFEF6165),
        Color(0xFF2EC87E),
        Color(0xFFF5B851),
        Color(0xFF4C9AFF),
        Color(0xFFB877DB),
        Color(0xFF38C7BD),
        Color(0xFFD8DEE9),
        Color(0xFF636D83),
        Color(0xFFFF7A7E),
        Color(0xFF54E09B),
        Color(0xFFFFCB6B),
        Color(0xFF73B2FF),
        Color(0xFFD097F0),
        Color(0xFF63E2D9),
        Color(0xFFFFFFFF),
      ],
    ),
    TerminalThemePreset(
      id: 'dracula',
      name: 'Dracula Pro',
      background: Color(0xFF1E1F29),
      chromeSurface: Color(0xFF282A36),
      border: Color(0xFF44475A),
      foreground: Color(0xFFF8F8F2),
      cursor: Color(0xFFFF79C6),
      selection: Color(0x6644475A),
      ansi16: [
        Color(0xFF21222C),
        Color(0xFFFF5555),
        Color(0xFF50FA7B),
        Color(0xFFF1FA8C),
        Color(0xFFBD93F9),
        Color(0xFFFF79C6),
        Color(0xFF8BE9FD),
        Color(0xFFF8F8F2),
        Color(0xFF6272A4),
        Color(0xFFFF6E6E),
        Color(0xFF69FF94),
        Color(0xFFFFFFA5),
        Color(0xFFD6ACFF),
        Color(0xFFFF92DF),
        Color(0xFFA4FFFF),
        Color(0xFFFFFFFF),
      ],
    ),
    TerminalThemePreset(
      id: 'tokyo_night',
      name: 'Tokyo Night',
      background: Color(0xFF16161E),
      chromeSurface: Color(0xFF1F2335),
      border: Color(0xFF333954),
      foreground: Color(0xFFC0CAF5),
      cursor: Color(0xFF7AA2F7),
      selection: Color(0x55364A82),
      ansi16: [
        Color(0xFF15161E),
        Color(0xFFF7768E),
        Color(0xFF9ECE6A),
        Color(0xFFE0AF68),
        Color(0xFF7AA2F7),
        Color(0xFFBB9AF7),
        Color(0xFF7DCFFF),
        Color(0xFFA9B1D6),
        Color(0xFF565F89),
        Color(0xFFFF899D),
        Color(0xFFAFDB7E),
        Color(0xFFF0C27B),
        Color(0xFF92B4FF),
        Color(0xFFCDB4FF),
        Color(0xFF9BE0FF),
        Color(0xFFE5EAFF),
      ],
    ),
    TerminalThemePreset(
      id: 'monokai_pro',
      name: 'Monokai Pro',
      background: Color(0xFF1B1A1E),
      chromeSurface: Color(0xFF26252A),
      border: Color(0xFF3E3C44),
      foreground: Color(0xFFFCFCFA),
      cursor: Color(0xFFFFD866),
      selection: Color(0x555B595C),
      ansi16: [
        Color(0xFF2D2A2E),
        Color(0xFFFF6188),
        Color(0xFFA9DC76),
        Color(0xFFFFD866),
        Color(0xFF78DCE8),
        Color(0xFFAB9DF2),
        Color(0xFF78DCE8),
        Color(0xFFFCFCFA),
        Color(0xFF727072),
        Color(0xFFFF7A9A),
        Color(0xFFBBE68E),
        Color(0xFFFFE285),
        Color(0xFF95E5EE),
        Color(0xFFC1B6F7),
        Color(0xFF95E5EE),
        Color(0xFFFFFFFF),
      ],
    ),
    TerminalThemePreset(
      id: 'nord',
      name: 'Nordic Frost',
      background: Color(0xFF242933),
      chromeSurface: Color(0xFF2E3440),
      border: Color(0xFF434C5E),
      foreground: Color(0xFFD8DEE9),
      cursor: Color(0xFF88C0D0),
      selection: Color(0x554C566A),
      ansi16: [
        Color(0xFF3B4252),
        Color(0xFFBF616A),
        Color(0xFFA3BE8C),
        Color(0xFFEBCB8B),
        Color(0xFF81A1C1),
        Color(0xFFB48EAD),
        Color(0xFF88C0D0),
        Color(0xFFE5E9F0),
        Color(0xFF616E88),
        Color(0xFFD08770),
        Color(0xFFB5CEA0),
        Color(0xFFF2D69E),
        Color(0xFF96B4D2),
        Color(0xFFC8A3C1),
        Color(0xFF8FBCBB),
        Color(0xFFECEFF4),
      ],
    ),
    TerminalThemePreset(
      id: 'matrix_ops',
      name: 'Phosphor Ops',
      background: Color(0xFF050C07),
      chromeSurface: Color(0xFF0A170E),
      border: Color(0xFF193823),
      foreground: Color(0xFF7AF4A6),
      cursor: Color(0xFF35F27C),
      selection: Color(0x551F7A42),
      ansi16: [
        Color(0xFF0D1F13),
        Color(0xFFFF6B6B),
        Color(0xFF35F27C),
        Color(0xFFD8F269),
        Color(0xFF5AD9A6),
        Color(0xFF8BE89E),
        Color(0xFF56F0C5),
        Color(0xFF9CF7BE),
        Color(0xFF346947),
        Color(0xFFFF8888),
        Color(0xFF66FFA0),
        Color(0xFFE8FF8A),
        Color(0xFF80F0C2),
        Color(0xFFB2F5C0),
        Color(0xFF89FFE0),
        Color(0xFFE3FFED),
      ],
    ),
    TerminalThemePreset(
      id: 'solarized_light',
      name: 'Solarized Daylight',
      background: Color(0xFFFDF6E3),
      chromeSurface: Color(0xFFEEE8D5),
      border: Color(0xFFD5CEB8),
      foreground: Color(0xFF073642),
      cursor: Color(0xFF268BD2),
      selection: Color(0x33268BD2),
      isLight: true,
      ansi16: [
        Color(0xFF073642),
        Color(0xFFDC322F),
        Color(0xFF859900),
        Color(0xFFB58900),
        Color(0xFF268BD2),
        Color(0xFFD33682),
        Color(0xFF2AA198),
        Color(0xFF586E75),
        Color(0xFF657B83),
        Color(0xFFCB4B16),
        Color(0xFF5E7400),
        Color(0xFF8F6B00),
        Color(0xFF1D6FA8),
        Color(0xFF6C71C4),
        Color(0xFF1F7F78),
        Color(0xFF002B36),
      ],
    ),
  ];

  static TerminalThemePreset byId(String id) {
    return presets.firstWhere(
      (t) => t.id == id,
      orElse: () => presets.first,
    );
  }
}

///Categorized command snippet item for the Snippets Studio & quick launcher.
class TerminalSnippetItem {
  final String id;
  final String label;
  final String command;
  final String category;
  final bool runImmediately;
  final int updatedAtMs;

  const TerminalSnippetItem({
    required this.id,
    required this.label,
    required this.command,
    required this.category,
    this.runImmediately = true,
    this.updatedAtMs = 0,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'label': label,
        'command': command,
        'category': category,
        'runImmediately': runImmediately,
        'updatedAtMs': updatedAtMs,
      };

  factory TerminalSnippetItem.fromJson(Map<String, dynamic> json) {
    return TerminalSnippetItem(
      id: (json['id'] as String?) ?? DateTime.now().microsecondsSinceEpoch.toString(),
      label: (json['label'] as String?) ?? 'Snippet',
      command: (json['command'] as String?) ?? '',
      category: (json['category'] as String?) ?? 'Custom',
      runImmediately: (json['runImmediately'] as bool?) ?? true,
      updatedAtMs: (json['updatedAtMs'] as num?)?.toInt() ?? 0,
    );
  }

  static const List<TerminalSnippetItem> builtIn = [
    TerminalSnippetItem(
      id: 'sys_uptime',
      label: 'uptime',
      command: 'uptime',
      category: 'System',
    ),
    TerminalSnippetItem(
      id: 'sys_htop',
      label: 'top / cpu',
      command: 'top -bn1 | head -n 18',
      category: 'System',
    ),
    TerminalSnippetItem(
      id: 'sys_disk',
      label: 'df -h',
      command: 'df -h',
      category: 'System',
    ),
    TerminalSnippetItem(
      id: 'sys_mem',
      label: 'free -h',
      command: 'free -h',
      category: 'System',
    ),
    TerminalSnippetItem(
      id: 'sys_logs',
      label: 'journalctl',
      command: 'journalctl -n 40 --no-pager',
      category: 'System',
    ),
    TerminalSnippetItem(
      id: 'dock_ps',
      label: 'docker ps',
      command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
      category: 'Docker',
    ),
    TerminalSnippetItem(
      id: 'dock_stats',
      label: 'docker stats',
      command: 'docker stats --no-stream',
      category: 'Docker',
    ),
    TerminalSnippetItem(
      id: 'k8s_pods',
      label: 'kubectl get pods',
      command: 'kubectl get pods -A',
      category: 'Kubernetes',
    ),
    TerminalSnippetItem(
      id: 'net_ports',
      label: 'ss -tulpn',
      command: 'ss -tulpn',
      category: 'Network',
    ),
    TerminalSnippetItem(
      id: 'net_ip',
      label: 'ip -br a',
      command: 'ip -br addr',
      category: 'Network',
    ),
  ];
}

class TerminalCellStyle {
  final int? fgAnsi; // 0..255
  final int? bgAnsi; // 0..255
  final Color? fgRgb;
  final Color? bgRgb;
  final bool bold;
  final bool inverse;
  final bool underline;

  const TerminalCellStyle({
    this.fgAnsi,
    this.bgAnsi,
    this.fgRgb,
    this.bgRgb,
    this.bold = false,
    this.inverse = false,
    this.underline = false,
  });

  static const TerminalCellStyle plain = TerminalCellStyle();

  TerminalCellStyle copyWith({
    int? fgAnsi,
    bool clearFg = false,
    int? bgAnsi,
    bool clearBg = false,
    Color? fgRgb,
    Color? bgRgb,
    bool? bold,
    bool? inverse,
    bool? underline,
  }) {
    return TerminalCellStyle(
      fgAnsi: clearFg ? null : (fgAnsi ?? this.fgAnsi),
      bgAnsi: clearBg ? null : (bgAnsi ?? this.bgAnsi),
      fgRgb: clearFg ? null : (fgRgb ?? this.fgRgb),
      bgRgb: clearBg ? null : (bgRgb ?? this.bgRgb),
      bold: bold ?? this.bold,
      inverse: inverse ?? this.inverse,
      underline: underline ?? this.underline,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TerminalCellStyle &&
          fgAnsi == other.fgAnsi &&
          bgAnsi == other.bgAnsi &&
          fgRgb == other.fgRgb &&
          bgRgb == other.bgRgb &&
          bold == other.bold &&
          inverse == other.inverse &&
          underline == other.underline;

  @override
  int get hashCode => Object.hash(fgAnsi, bgAnsi, fgRgb, bgRgb, bold, inverse, underline);
}

class TerminalCell {
  final String char;
  final TerminalCellStyle style;

  const TerminalCell(this.char, [this.style = TerminalCellStyle.plain]);
}

/// ANSI / VT100 stateful terminal screen & scrollback buffer.
/// Handles colors (16/256/TrueColor), cursor movement, `\r`, `\x08` backspace,
/// `\x1b[K` erase-in-line, `\x1b[2J` clear-screen, and OSC window titles.
class AnsiTerminalBuffer extends ChangeNotifier {
  final int maxScrollbackLines;
  final List<List<TerminalCell>> _lines = [<TerminalCell>[]];
  int _cursorRow = 0;
  int _cursorCol = 0;
  TerminalCellStyle _currentStyle = TerminalCellStyle.plain;
  String _pendingSeq = '';
  String windowTitle = '';

  AnsiTerminalBuffer({this.maxScrollbackLines = 1200});

  int get lineCount => _lines.length;
  int get cursorRow => _cursorRow;
  int get cursorCol => _cursorCol;

  List<TerminalCell> lineAt(int index) => _lines[index];

  String toPlainText() {
    return _lines.map((row) => row.map((c) => c.char).join().trimRight()).join('\n');
  }

  void clear() {
    _lines
      ..clear()
      ..add(<TerminalCell>[]);
    _cursorRow = 0;
    _cursorCol = 0;
    _currentStyle = TerminalCellStyle.plain;
    _pendingSeq = '';
    notifyListeners();
  }

  void write(String chunk) {
    if (chunk.isEmpty) return;
    final data = _pendingSeq + chunk;
    _pendingSeq = '';

    int i = 0;
    while (i < data.length) {
      final code = data.codeUnitAt(i);

      if (code == 0x1B) {
        // ESC sequence
        if (i + 1 >= data.length) {
          _pendingSeq = data.substring(i);
          break;
        }
        final next = data[i + 1];
        if (next == '[') {
          // CSI: ESC [ params intermediate finalByte(0x40..0x7E)
          int j = i + 2;
          while (j < data.length) {
            final c = data.codeUnitAt(j);
            if (c >= 0x40 && c <= 0x7E) {
              break;
            }
            j++;
          }
          if (j >= data.length) {
            if (data.length - i < 32) {
              _pendingSeq = data.substring(i);
              break;
            } else {
              i += 2;
              continue;
            }
          }
          final paramsStr = data.substring(i + 2, j);
          final finalChar = data[j];
          _handleCsi(paramsStr, finalChar);
          i = j + 1;
          continue;
        } else if (next == ']') {
          // OSC: ESC ] ... (BEL \x07 or ST \x1b\\)
          int j = i + 2;
          int endSeq = -1;
          int titleEnd = -1;
          while (j < data.length) {
            final c = data.codeUnitAt(j);
            if (c == 0x07) {
              titleEnd = j;
              endSeq = j + 1;
              break;
            }
            if (c == 0x1B && j + 1 < data.length && data[j + 1] == '\\') {
              titleEnd = j;
              endSeq = j + 2;
              break;
            }
            j++;
          }
          if (endSeq == -1) {
            if (data.length - i < 256) {
              _pendingSeq = data.substring(i);
              break;
            } else {
              i += 2;
              continue;
            }
          }
          final oscBody = data.substring(i + 2, titleEnd);
          final semi = oscBody.indexOf(';');
          if (semi != -1) {
            final oscCode = oscBody.substring(0, semi);
            if (oscCode == '0' || oscCode == '2') {
              windowTitle = oscBody.substring(semi + 1).trim();
            }
          }
          i = endSeq;
          continue;
        } else if (next == '(' || next == ')' || next == '*' || next == '+') {
          // Charset selection (3 bytes total, e.g. ESC ( B)
          if (i + 2 >= data.length) {
            _pendingSeq = data.substring(i);
            break;
          }
          i += 3;
          continue;
        } else {
          // 2-byte ESC (e.g., ESC =, ESC >, ESC M)
          i += 2;
          continue;
        }
      } else if (code == 0x0D) {
        // CR
        _cursorCol = 0;
        i++;
      } else if (code == 0x0A) {
        // LF
        _cursorRow++;
        while (_lines.length <= _cursorRow) {
          _lines.add(<TerminalCell>[]);
        }
        _trimScrollback();
        i++;
      } else if (code == 0x08 || code == 0x7F) {
        // BS
        if (_cursorCol > 0) {
          _cursorCol--;
        }
        i++;
      } else if (code == 0x07) {
        // BEL
        i++;
      } else if (code == 0x09) {
        // TAB -> advance to next 8-column stop
        final spaces = 8 - (_cursorCol % 8);
        for (int s = 0; s < spaces; s++) {
          _putChar(' ');
        }
        i++;
      } else if (code < 0x20) {
        i++;
      } else {
        String ch;
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < data.length) {
          final low = data.codeUnitAt(i + 1);
          ch = (low >= 0xDC00 && low <= 0xDFFF)
              ? data.substring(i, i + 2)
              : String.fromCharCode(code);
        } else {
          ch = String.fromCharCode(code);
        }
        _putChar(ch);
        i += ch.length;
      }
    }
    notifyListeners();
  }

  void _putChar(String ch) {
    while (_lines.length <= _cursorRow) {
      _lines.add(<TerminalCell>[]);
    }
    final line = _lines[_cursorRow];
    while (line.length < _cursorCol) {
      line.add(const TerminalCell(' '));
    }
    final cell = TerminalCell(ch, _currentStyle);
    if (_cursorCol < line.length) {
      line[_cursorCol] = cell;
    } else {
      line.add(cell);
    }
    _cursorCol++;
  }

  void _trimScrollback() {
    if (_lines.length > maxScrollbackLines) {
      final excess = _lines.length - maxScrollbackLines;
      _lines.removeRange(0, excess);
      _cursorRow = max(0, _cursorRow - excess);
    }
  }

  void _handleCsi(String rawParams, String finalChar) {
    if (rawParams.startsWith('?') || rawParams.startsWith('>')) {
      // Private DEC modes (e.g., ?2004h bracketed paste, ?25h cursor show, ?1049h alt screen)
      if (finalChar == 'h' && rawParams == '?1049') {
        // Enter alternate screen (e.g., htop/vim/less): add fresh visual separation
      }
      return;
    }

    final parts = rawParams.isEmpty
        ? <int>[]
        : rawParams.split(';').map((s) => int.tryParse(s) ?? 0).toList();
    final p0 = parts.isNotEmpty ? parts[0] : 0;

    switch (finalChar) {
      case 'm':
        _applySgr(parts.isEmpty ? const [0] : parts);
        break;
      case 'K':
        // Erase in Line: 0 = cursor..end, 1 = 0..cursor, 2 = entire line
        while (_lines.length <= _cursorRow) {
          _lines.add(<TerminalCell>[]);
        }
        final line = _lines[_cursorRow];
        if (p0 == 0) {
          if (_cursorCol < line.length) {
            line.removeRange(_cursorCol, line.length);
          }
        } else if (p0 == 1) {
          for (int c = 0; c <= _cursorCol && c < line.length; c++) {
            line[c] = const TerminalCell(' ');
          }
        } else if (p0 == 2) {
          line.clear();
        }
        break;
      case 'J':
        // Erase in Display
        if (p0 == 2 || p0 == 3) {
          _lines
            ..clear()
            ..add(<TerminalCell>[]);
          _cursorRow = 0;
          _cursorCol = 0;
        } else if (p0 == 0) {
          while (_lines.length <= _cursorRow) {
            _lines.add(<TerminalCell>[]);
          }
          final line = _lines[_cursorRow];
          if (_cursorCol < line.length) {
            line.removeRange(_cursorCol, line.length);
          }
          if (_cursorRow + 1 < _lines.length) {
            _lines.removeRange(_cursorRow + 1, _lines.length);
          }
        }
        break;
      case 'H':
      case 'f':
        final targetRow = max(0, (parts.isNotEmpty && parts[0] > 0 ? parts[0] : 1) - 1);
        final targetCol = max(0, (parts.length > 1 && parts[1] > 0 ? parts[1] : 1) - 1);
        final viewportBase = max(0, _lines.length - 24);
        _cursorRow = viewportBase + targetRow;
        while (_lines.length <= _cursorRow) {
          _lines.add(<TerminalCell>[]);
        }
        _cursorCol = targetCol;
        break;
      case 'A':
        _cursorRow = max(0, _cursorRow - max(1, p0));
        break;
      case 'B':
        _cursorRow += max(1, p0);
        while (_lines.length <= _cursorRow) {
          _lines.add(<TerminalCell>[]);
        }
        break;
      case 'C':
        _cursorCol += max(1, p0);
        break;
      case 'D':
        _cursorCol = max(0, _cursorCol - max(1, p0));
        break;
      case 'G':
        _cursorCol = max(0, (p0 > 0 ? p0 : 1) - 1);
        break;
      case 'P':
        // DCH: delete N chars at cursor
        if (_cursorRow < _lines.length) {
          final line = _lines[_cursorRow];
          final n = max(1, p0);
          if (_cursorCol < line.length) {
            line.removeRange(_cursorCol, min(line.length, _cursorCol + n));
          }
        }
        break;
      case '@':
        // ICH: insert N blank chars at cursor
        if (_cursorRow < _lines.length) {
          final line = _lines[_cursorRow];
          final n = max(1, p0);
          while (line.length < _cursorCol) {
            line.add(const TerminalCell(' '));
          }
          line.insertAll(_cursorCol, List<TerminalCell>.filled(n, const TerminalCell(' ')));
        }
        break;
      default:
        break;
    }
  }

  void _applySgr(List<int> codes) {
    int idx = 0;
    while (idx < codes.length) {
      final c = codes[idx];
      if (c == 0) {
        _currentStyle = TerminalCellStyle.plain;
      } else if (c == 1) {
        _currentStyle = _currentStyle.copyWith(bold: true);
      } else if (c == 22) {
        _currentStyle = _currentStyle.copyWith(bold: false);
      } else if (c == 4) {
        _currentStyle = _currentStyle.copyWith(underline: true);
      } else if (c == 24) {
        _currentStyle = _currentStyle.copyWith(underline: false);
      } else if (c == 7) {
        _currentStyle = _currentStyle.copyWith(inverse: true);
      } else if (c == 27) {
        _currentStyle = _currentStyle.copyWith(inverse: false);
      } else if (c >= 30 && c <= 37) {
        _currentStyle = _currentStyle.copyWith(fgAnsi: c - 30);
      } else if (c == 39) {
        _currentStyle = _currentStyle.copyWith(clearFg: true);
      } else if (c >= 40 && c <= 47) {
        _currentStyle = _currentStyle.copyWith(bgAnsi: c - 40);
      } else if (c == 49) {
        _currentStyle = _currentStyle.copyWith(clearBg: true);
      } else if (c >= 90 && c <= 97) {
        _currentStyle = _currentStyle.copyWith(fgAnsi: (c - 90) + 8);
      } else if (c >= 100 && c <= 107) {
        _currentStyle = _currentStyle.copyWith(bgAnsi: (c - 100) + 8);
      } else if ((c == 38 || c == 48) && idx + 1 < codes.length) {
        final isFg = c == 38;
        final mode = codes[idx + 1];
        if (mode == 5 && idx + 2 < codes.length) {
          final n = codes[idx + 2].clamp(0, 255);
          _currentStyle = isFg
              ? _currentStyle.copyWith(fgAnsi: n)
              : _currentStyle.copyWith(bgAnsi: n);
          idx += 2;
        } else if (mode == 2 && idx + 4 < codes.length) {
          final col = Color.fromARGB(
            255,
            codes[idx + 2].clamp(0, 255),
            codes[idx + 3].clamp(0, 255),
            codes[idx + 4].clamp(0, 255),
          );
          _currentStyle = isFg
              ? _currentStyle.copyWith(fgRgb: col)
              : _currentStyle.copyWith(bgRgb: col);
          idx += 4;
        }
      }
      idx++;
    }
  }

  static Color resolveAnsiColor(int index, TerminalThemePreset theme, {bool bold = false}) {
    int idx = index.clamp(0, 255);
    if (bold && idx < 8) {
      idx += 8;
    }
    if (idx < 16) {
      return theme.ansi16[idx];
    }
    if (idx < 232) {
      final cube = idx - 16;
      final r = (cube ~/ 36) % 6;
      final g = (cube ~/ 6) % 6;
      final b = cube % 6;
      int ch(int v) => v == 0 ? 0 : 55 + v * 40;
      return Color.fromARGB(255, ch(r), ch(g), ch(b));
    }
    final gray = 8 + (idx - 232) * 10;
    return Color.fromARGB(255, gray, gray, gray);
  }
}

/// Interactive Termius-class SSH Terminal Surface + Tactile Shortcut Keybar + Snippets Launcher.
/// Typing happens directly inside the terminal surface with live inline cursor and full soft/hardware keyboard support.
class TermiusInteractiveTerminal extends StatefulWidget {
  final AnsiTerminalBuffer buffer;
  final TerminalThemePreset theme;
  final double fontSize;
  final bool isLiveSshConnected;
  final List<TerminalSnippetItem> snippets;
  final void Function(String rawData) onSendRaw;
  final void Function(TerminalSnippetItem snippet) onRunSnippet;
  final VoidCallback onOpenThemePicker;
  final VoidCallback onOpenSnippetsStudio;
  final void Function(int cols, int rows)? onTerminalResize;
  final bool showAccessoryDeck;
  final ValueChanged<double>? onFontSizeChanged;
  final VoidCallback? onUserInteraction;

  const TermiusInteractiveTerminal({
    super.key,
    required this.buffer,
    required this.theme,
    required this.fontSize,
    required this.isLiveSshConnected,
    required this.snippets,
    required this.onSendRaw,
    required this.onRunSnippet,
    required this.onOpenThemePicker,
    required this.onOpenSnippetsStudio,
    this.onTerminalResize,
    this.showAccessoryDeck = true,
    this.onFontSizeChanged,
    this.onUserInteraction,
  });

  @override
  State<TermiusInteractiveTerminal> createState() => _TermiusInteractiveTerminalState();
}

class _TermiusInteractiveTerminalState extends State<TermiusInteractiveTerminal> {
  static const String _kSentinel = '\u200B\u200B';

  late final TextEditingController _imeController;
  final FocusNode _imeFocusNode = FocusNode();
  final ScrollController _scrollController = ScrollController();

  bool _stickyCtrl = false;
  bool _stickyAlt = false;
  bool _cursorBlinkVisible = true;
  bool _showQuickSnippetsStrip = true;
  bool _softWrapLines = true;
  bool _isScrolledUp = false;
  double _pinchBaseFont = 13.0;
  bool _suppressImeCallback = false;
  int _lastCols = 0;
  int _lastRows = 0;
  Timer? _blinkTimer;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScrollPositionChanged);
    _imeController = TextEditingController.fromValue(
      const TextEditingValue(
        text: _kSentinel,
        selection: TextSelection.collapsed(offset: _kSentinel.length),
      ),
    );
    widget.buffer.addListener(_onBufferUpdated);
    _imeFocusNode.addListener(() {
      if (mounted) setState(() {});
    });
    _blinkTimer = Timer.periodic(const Duration(milliseconds: 530), (_) {
      if (mounted && _imeFocusNode.hasFocus) {
        setState(() => _cursorBlinkVisible = !_cursorBlinkVisible);
      }
    });
  }

  @override
  void didUpdateWidget(covariant TermiusInteractiveTerminal oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.buffer != widget.buffer) {
      oldWidget.buffer.removeListener(_onBufferUpdated);
      widget.buffer.addListener(_onBufferUpdated);
    }
  }

  @override
  void dispose() {
    _blinkTimer?.cancel();
    widget.buffer.removeListener(_onBufferUpdated);
    _imeController.dispose();
    _imeFocusNode.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _onScrollPositionChanged() {
    if (!_scrollController.hasClients) return;
    final distFromBottom =
        _scrollController.position.maxScrollExtent - _scrollController.offset;
    final up = distFromBottom > 48;
    if (up != _isScrolledUp && mounted) {
      setState(() => _isScrolledUp = up);
    }
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) return;
    _scrollController.animateTo(
      _scrollController.position.maxScrollExtent,
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
    );
  }

  void _onBufferUpdated() {
    if (!mounted) return;
    setState(() {
      _cursorBlinkVisible = true;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    });
  }

  void _resetSentinel() {
    _suppressImeCallback = true;
    _imeController.value = const TextEditingValue(
      text: _kSentinel,
      selection: TextSelection.collapsed(offset: _kSentinel.length),
    );
    _suppressImeCallback = false;
  }

  void _emitWithModifiers(String raw) {
    if (raw.isEmpty) return;
    String payload = raw;
    if (_stickyCtrl && raw.length == 1) {
      final upper = raw.toUpperCase().codeUnitAt(0);
      if (upper >= 64 && upper <= 95) {
        payload = String.fromCharCode(upper - 64);
      }
      setState(() => _stickyCtrl = false);
    }
    if (_stickyAlt) {
      payload = '\x1b$payload';
      setState(() => _stickyAlt = false);
    }
    widget.onSendRaw(payload);
  }

  void _handleImeChanged(String val) {
    if (_suppressImeCallback || val == _kSentinel) return;

    if (_kSentinel.startsWith(val)) {
      final deletedCount = _kSentinel.length - val.length;
      if (deletedCount > 0) {
        widget.onSendRaw('\x7f' * deletedCount);
      }
    } else if (val.startsWith(_kSentinel)) {
      final inserted = val.substring(_kSentinel.length);
      for (final rune in inserted.runes) {
        final ch = String.fromCharCode(rune);
        if (ch == '\n' || ch == '\r') {
          widget.onSendRaw('\r');
        } else {
          _emitWithModifiers(ch);
        }
      }
    } else {
      final cleaned = val.replaceAll('\u200B', '');
      if (cleaned.isEmpty) {
        widget.onSendRaw('\x7f');
      } else {
        for (final rune in cleaned.runes) {
          final ch = String.fromCharCode(rune);
          if (ch == '\n' || ch == '\r') {
            widget.onSendRaw('\r');
          } else {
            _emitWithModifiers(ch);
          }
        }
      }
    }
    _resetSentinel();
  }

  KeyEventResult _handleHardwareKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    final ctrlHeld = HardwareKeyboard.instance.isControlPressed || _stickyCtrl;

    if (ctrlHeld) {
      final label = key.keyLabel;
      if (label.length == 1) {
        final code = label.toUpperCase().codeUnitAt(0);
        if (code >= 64 && code <= 95) {
          widget.onSendRaw(String.fromCharCode(code - 64));
          if (_stickyCtrl) setState(() => _stickyCtrl = false);
          return KeyEventResult.handled;
        }
      }
    }

    if (key == LogicalKeyboardKey.arrowUp) {
      widget.onSendRaw('\x1b[A');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.arrowDown) {
      widget.onSendRaw('\x1b[B');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.arrowRight) {
      widget.onSendRaw('\x1b[C');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.arrowLeft) {
      widget.onSendRaw('\x1b[D');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.home) {
      widget.onSendRaw('\x1b[H');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.end) {
      widget.onSendRaw('\x1b[F');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.pageUp) {
      widget.onSendRaw('\x1b[5~');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.pageDown) {
      widget.onSendRaw('\x1b[6~');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.escape) {
      widget.onSendRaw('\x1b');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.tab) {
      widget.onSendRaw('\t');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.delete) {
      widget.onSendRaw('\x1b[3~');
      return KeyEventResult.handled;
    } else if (key == LogicalKeyboardKey.enter || key == LogicalKeyboardKey.numpadEnter) {
      widget.onSendRaw('\r');
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  void _focusTerminal() {
    if (!_imeFocusNode.hasFocus) {
      _imeFocusNode.requestFocus();
    } else {
      SystemChannels.textInput.invokeMethod<void>('TextInput.show');
    }
    _resetSentinel();
  }

  void _toggleKeyboard() {
    if (_imeFocusNode.hasFocus) {
      _imeFocusNode.unfocus();
    } else {
      _focusTerminal();
    }
  }

  Future<void> _pasteClipboard() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text != null && text.isNotEmpty) {
      widget.onSendRaw(text);
    }
  }

  TextSpan _buildTerminalLineSpan(int rowIdx) {
    final cells = widget.buffer.lineAt(rowIdx);
    final isCursorLine = rowIdx == widget.buffer.cursorRow;
    final cursorCol = widget.buffer.cursorCol;
    final theme = widget.theme;

    final maxCol = isCursorLine ? max(cells.length, cursorCol + 1) : cells.length;
    if (maxCol == 0) {
      return const TextSpan(text: ' ');
    }

    final spans = <InlineSpan>[];
    StringBuffer runText = StringBuffer();
    Color? runFg;
    Color? runBg;
    bool runBold = false;
    bool runUnderline = false;

    void flushRun() {
      if (runText.isEmpty) return;
      spans.add(
        TextSpan(
          text: runText.toString(),
          style: TextStyle(
            color: runFg ?? theme.foreground,
            backgroundColor: runBg,
            fontWeight: runBold ? FontWeight.w700 : FontWeight.w400,
            decoration: runUnderline ? TextDecoration.underline : TextDecoration.none,
          ),
        ),
      );
      runText = StringBuffer();
    }

    for (int col = 0; col < maxCol; col++) {
      final cell = col < cells.length ? cells[col] : const TerminalCell(' ');
      final st = cell.style;
      Color fg = st.fgRgb ??
          (st.fgAnsi != null
              ? AnsiTerminalBuffer.resolveAnsiColor(st.fgAnsi!, theme, bold: st.bold)
              : theme.foreground);
      Color? bg = st.bgRgb ??
          (st.bgAnsi != null ? AnsiTerminalBuffer.resolveAnsiColor(st.bgAnsi!, theme) : null);

      if (st.inverse) {
        final tmp = fg;
        fg = bg ?? theme.background;
        bg = tmp;
      }

      final isCursorHere = isCursorLine && col == cursorCol;
      if (isCursorHere) {
        final showFilledCursor = !_imeFocusNode.hasFocus || _cursorBlinkVisible;
        if (showFilledCursor) {
          bg = theme.cursor;
          fg = theme.isLight ? Colors.white : const Color(0xFF06090F);
        }
      }

      if (fg != runFg || bg != runBg || st.bold != runBold || st.underline != runUnderline) {
        flushRun();
        runFg = fg;
        runBg = bg;
        runBold = st.bold;
        runUnderline = st.underline;
      }
      runText.write(cell.char);
    }
    flushRun();
    return TextSpan(children: spans);
  }

  @override
  Widget build(BuildContext context) {
    final theme = widget.theme;
    final mediaPadding = MediaQuery.paddingOf(context);
    final symInsetX = max(mediaPadding.left, mediaPadding.right);
    final baseTextStyle = TextStyle(
      fontFamily: 'monospace',
      fontSize: widget.fontSize,
      height: 1.38,
      color: theme.foreground,
    );

    return Column(
      children: [
        // Terminal Screen Surface (tapping anywhere focuses inline PTY input)
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final charW = widget.fontSize * 0.61;
              final lineH = widget.fontSize * 1.38;
              final cols = ((constraints.maxWidth - 24 - symInsetX * 2) / charW).floor().clamp(32, 240);
              final rows = ((constraints.maxHeight - 20) / lineH).floor().clamp(10, 120);
              if ((cols != _lastCols || rows != _lastRows) && widget.onTerminalResize != null) {
                _lastCols = cols;
                _lastRows = rows;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  widget.onTerminalResize?.call(cols, rows);
                });
              }

              return GestureDetector(
                key: const ValueKey('termius_terminal_surface'),
                behavior: HitTestBehavior.opaque,
                onTap: () {
                  widget.onUserInteraction?.call();
                  _focusTerminal();
                },
                onScaleStart: (_) {
                  _pinchBaseFont = widget.fontSize;
                },
                onScaleUpdate: (details) {
                  if (details.pointerCount >= 2 && widget.onFontSizeChanged != null) {
                    final nextSize = (_pinchBaseFont * details.scale).clamp(10.0, 18.0);
                    if ((nextSize - widget.fontSize).abs() >= 0.35) {
                      widget.onFontSizeChanged!(double.parse(nextSize.toStringAsFixed(1)));
                    }
                  }
                },
                child: Container(
                  width: double.infinity,
                  decoration: BoxDecoration(
                    color: theme.background,
                    border: Border(
                      bottom: BorderSide(color: theme.border, width: 1),
                    ),
                  ),
                  child: Stack(
                    children: [
                      // Invisible In-Viewport Android/iOS/Hardware IME Capture Field
                      Positioned(
                        left: 4,
                        top: 4,
                        width: 16,
                        height: 16,
                        child: IgnorePointer(
                          child: Opacity(
                            opacity: 0.0,
                            child: Focus(
                              onKeyEvent: _handleHardwareKey,
                              child: TextField(
                                key: const ValueKey('termius_hidden_ime_input'),
                                controller: _imeController,
                                focusNode: _imeFocusNode,
                                autocorrect: false,
                                enableSuggestions: false,
                                enableIMEPersonalizedLearning: false,
                                keyboardType: TextInputType.visiblePassword,
                                textInputAction: TextInputAction.send,
                                textCapitalization: TextCapitalization.none,
                                smartDashesType: SmartDashesType.disabled,
                                smartQuotesType: SmartQuotesType.disabled,
                                onChanged: _handleImeChanged,
                                onSubmitted: (_) {
                                  widget.onSendRaw('\r');
                                  _resetSentinel();
                                  _imeFocusNode.requestFocus();
                                },
                              ),
                            ),
                          ),
                        ),
                      ),
                      // Scrollable ANSI Terminal Output + Live Inline Prompt Cursor
                      Scrollbar(
                        controller: _scrollController,
                        child: ListView.builder(
                          controller: _scrollController,
                          padding: EdgeInsets.fromLTRB(symInsetX + 14, 10, symInsetX + 14, 18),
                          itemCount: widget.buffer.lineCount,
                          itemBuilder: (context, rowIdx) {
                            final richRow = Text.rich(
                              TextSpan(
                                style: baseTextStyle,
                                children: [_buildTerminalLineSpan(rowIdx)],
                              ),
                              softWrap: _softWrapLines,
                              overflow: _softWrapLines ? TextOverflow.clip : TextOverflow.visible,
                            );
                            if (_softWrapLines) return richRow;
                            return SingleChildScrollView(
                              scrollDirection: Axis.horizontal,
                              child: richRow,
                            );
                          },
                        ),
                      ),
                      // Terminal Geometry & Mode Micro-Pill (top-right subtle telemetry)
                      Positioned(
                        top: 8,
                        right: symInsetX + 10,
                        child: IgnorePointer(
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
                            decoration: BoxDecoration(
                              color: theme.chromeSurface.withValues(alpha: 0.78),
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: theme.border.withValues(alpha: 0.85)),
                            ),
                            child: Text(
                              '${cols}x$rows • ${widget.fontSize.toStringAsFixed(0)}pt',
                              style: TextStyle(
                                fontFamily: 'monospace',
                                fontSize: 9.5,
                                fontFeatures: const [FontFeature.tabularFigures()],
                                color: theme.foreground.withValues(alpha: 0.62),
                              ),
                            ),
                          ),
                        ),
                      ),
                      // Scroll-to-Bottom Pill when viewing history
                      if (_isScrolledUp)
                        Positioned(
                          right: 12,
                          bottom: 10,
                          child: Material(
                            color: theme.chromeSurface.withValues(alpha: 0.94),
                            borderRadius: BorderRadius.circular(99),
                            child: InkWell(
                              borderRadius: BorderRadius.circular(99),
                              onTap: _scrollToBottom,
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                                decoration: BoxDecoration(
                                  borderRadius: BorderRadius.circular(99),
                                  border: Border.all(color: theme.cursor.withValues(alpha: 0.6)),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(Icons.south_rounded, size: 13, color: theme.cursor),
                                    const SizedBox(width: 4),
                                    Text(
                                      'Bottom',
                                      style: TextStyle(
                                        fontSize: 10.5,
                                        fontWeight: FontWeight.w700,
                                        color: theme.foreground,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),

        // Termius-Class Tactile Accessory Bar & Quick Snippets Strip (harmonized with theme & auto-hideable)
        if (widget.showAccessoryDeck) _buildTactileAccessoryDeck(theme),
      ],
    );
  }

  Widget _buildTactileAccessoryDeck(TerminalThemePreset theme) {
    final deckBg = theme.chromeSurface;
    final deckBorder = theme.border;
    final mediaPadding = MediaQuery.paddingOf(context);
    final symPadX = max(mediaPadding.left, mediaPadding.right) + 8.0;
    final bottomSafe = MediaQuery.viewInsetsOf(context).bottom == 0 ? mediaPadding.bottom : 0.0;
    return Container(
      decoration: BoxDecoration(
        color: deckBg,
        border: Border(
          top: BorderSide(color: deckBorder, width: 1),
        ),
      ),
      padding: EdgeInsets.only(bottom: bottomSafe),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Optional Quick-Launch Snippets Strip (1-tap DevOps & Custom Snippets)
          if (_showQuickSnippetsStrip)
            Container(
              height: 34,
              padding: EdgeInsets.symmetric(horizontal: symPadX),
              decoration: BoxDecoration(
                color: theme.chromeSurface,
                border: Border(
                  bottom: BorderSide(color: theme.border, width: 1),
                ),
              ),
              child: Row(
                children: [
                  InkWell(
                    key: const ValueKey('btn_open_snippets_studio'),
                    borderRadius: BorderRadius.circular(6),
                    onTap: widget.onOpenSnippetsStudio,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFF182438),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0xFF334B6E)),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.bolt_rounded, size: 13, color: Color(0xFFE0B454)),
                          SizedBox(width: 3),
                          Text(
                            'Snippets',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFFE0B454),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: widget.snippets.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 5),
                      itemBuilder: (context, index) {
                        final snip = widget.snippets[index];
                        return Center(
                          child: InkWell(
                            borderRadius: BorderRadius.circular(6),
                            onTap: () => widget.onRunSnippet(snip),
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                              decoration: BoxDecoration(
                                color: const Color(0xFF141D2B),
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: const Color(0xFF25344B)),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(
                                    Icons.play_arrow_rounded,
                                    size: 12,
                                    color: Color(0xFF5CA8FF),
                                  ),
                                  const SizedBox(width: 3),
                                  Text(
                                    snip.label,
                                    style: const TextStyle(
                                      fontFamily: 'monospace',
                                      fontSize: 11,
                                      fontWeight: FontWeight.w600,
                                      color: Color(0xFFDCE5F2),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                  const SizedBox(width: 6),
                  InkWell(
                    key: const ValueKey('btn_open_terminal_theme'),
                    borderRadius: BorderRadius.circular(6),
                    onTap: widget.onOpenThemePicker,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFF182438),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0xFF334B6E)),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: theme.cursor,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 5),
                          const Text(
                            'Theme',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFF9AC5FF),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

          // Precision Tactile Terminal Keycaps Row (Keyboard, Esc, Tab, Ctrl, Alt, Arrows, Signals, Symbols)
          SizedBox(
            height: 40,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: EdgeInsets.symmetric(horizontal: symPadX, vertical: 4),
              child: Row(
                children: [
                  _buildIconKeycap(
                    icon: _imeFocusNode.hasFocus
                        ? Icons.keyboard_hide_rounded
                        : Icons.keyboard_alt_outlined,
                    tooltip: _imeFocusNode.hasFocus ? 'Hide Keyboard' : 'Show Keyboard',
                    active: _imeFocusNode.hasFocus,
                    onTap: _toggleKeyboard,
                  ),
                  _buildKeycap(
                    label: 'Esc',
                    onTap: () => widget.onSendRaw('\x1b'),
                  ),
                  _buildKeycap(
                    label: 'Tab',
                    onTap: () => widget.onSendRaw('\t'),
                  ),
                  _buildKeycap(
                    label: 'Ctrl',
                    active: _stickyCtrl,
                    onTap: () => setState(() => _stickyCtrl = !_stickyCtrl),
                  ),
                  _buildKeycap(
                    label: 'Alt',
                    active: _stickyAlt,
                    onTap: () => setState(() => _stickyAlt = !_stickyAlt),
                  ),
                  _buildIconKeycap(
                    icon: Icons.keyboard_arrow_up_rounded,
                    tooltip: 'Up (History Prev)',
                    onTap: () => widget.onSendRaw('\x1b[A'),
                  ),
                  _buildIconKeycap(
                    icon: Icons.keyboard_arrow_down_rounded,
                    tooltip: 'Down (History Next)',
                    onTap: () => widget.onSendRaw('\x1b[B'),
                  ),
                  _buildIconKeycap(
                    icon: Icons.keyboard_arrow_left_rounded,
                    tooltip: 'Left',
                    onTap: () => widget.onSendRaw('\x1b[D'),
                  ),
                  _buildIconKeycap(
                    icon: Icons.keyboard_arrow_right_rounded,
                    tooltip: 'Right',
                    onTap: () => widget.onSendRaw('\x1b[C'),
                  ),
                  _buildKeycap(
                    label: '^C',
                    accent: const Color(0xFFF06A6A),
                    onTap: () => widget.onSendRaw('\x03'),
                  ),
                  _buildKeycap(
                    label: '^D',
                    onTap: () => widget.onSendRaw('\x04'),
                  ),
                  _buildKeycap(
                    label: '^L',
                    onTap: () => widget.onSendRaw('\x0c'),
                  ),
                  _buildKeycap(
                    label: '-',
                    mono: true,
                    onTap: () => _emitWithModifiers('-'),
                  ),
                  _buildKeycap(
                    label: '/',
                    mono: true,
                    onTap: () => _emitWithModifiers('/'),
                  ),
                  _buildKeycap(
                    label: '|',
                    mono: true,
                    onTap: () => _emitWithModifiers('|'),
                  ),
                  _buildKeycap(
                    label: '~',
                    mono: true,
                    onTap: () => _emitWithModifiers('~'),
                  ),
                  _buildKeycap(
                    label: '_',
                    mono: true,
                    onTap: () => _emitWithModifiers('_'),
                  ),
                  _buildKeycap(
                    label: 'Paste',
                    onTap: _pasteClipboard,
                  ),
                  _buildKeycap(
                    label: _softWrapLines ? 'Wrap' : 'NoWrap',
                    active: !_softWrapLines,
                    onTap: () => setState(() => _softWrapLines = !_softWrapLines),
                  ),
                  _buildIconKeycap(
                    icon: Icons.palette_outlined,
                    tooltip: 'Terminal Themes',
                    onTap: widget.onOpenThemePicker,
                  ),
                  _buildIconKeycap(
                    icon: _showQuickSnippetsStrip
                        ? Icons.expand_more_rounded
                        : Icons.bolt_rounded,
                    tooltip: 'Toggle Quick Snippets Bar',
                    active: _showQuickSnippetsStrip,
                    onTap: () => setState(() => _showQuickSnippetsStrip = !_showQuickSnippetsStrip),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildKeycap({
    required String label,
    required VoidCallback onTap,
    bool active = false,
    bool mono = false,
    Color? accent,
  }) {
    final borderColor = active
        ? const Color(0xFFE0B454)
        : (accent != null ? accent.withValues(alpha: 0.45) : const Color(0xFF28364D));
    final bgColor = active ? const Color(0xFF2B2518) : const Color(0xFF162030);
    final fgColor = active
        ? const Color(0xFFE0B454)
        : (accent ?? const Color(0xFFE6EDF7));

    return Padding(
      padding: const EdgeInsets.only(right: 5),
      child: Material(
        color: bgColor,
        borderRadius: BorderRadius.circular(6),
        child: InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: () {
            HapticFeedback.selectionClick();
            onTap();
            _focusTerminal();
          },
          child: Container(
            constraints: const BoxConstraints(minWidth: 34),
            padding: const EdgeInsets.symmetric(horizontal: 9),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: borderColor, width: 1),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontFamily: mono ? 'monospace' : null,
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                color: fgColor,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildIconKeycap({
    required IconData icon,
    required String tooltip,
    required VoidCallback onTap,
    bool active = false,
  }) {
    return Padding(
      padding: const EdgeInsets.only(right: 5),
      child: Tooltip(
        message: tooltip,
        child: Material(
          color: active ? const Color(0xFF2B2518) : const Color(0xFF162030),
          borderRadius: BorderRadius.circular(6),
          child: InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: () {
              HapticFeedback.selectionClick();
              onTap();
              _focusTerminal();
            },
            child: Container(
              width: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(6),
                border: Border.all(
                  color: active ? const Color(0xFFE0B454) : const Color(0xFF28364D),
                ),
              ),
              child: Icon(
                icon,
                size: 17,
                color: active ? const Color(0xFFE0B454) : const Color(0xFFE6EDF7),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
