import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Visual touch feedback pulse rendered briefly on Direct Touch clicks / Right-Clicks.
class _TouchRipplePulse {
  final int id;
  final Offset localPos;
  final bool isRightClick;

  const _TouchRipplePulse({
    required this.id,
    required this.localPos,
    required this.isRightClick,
  });
}

/// Zero-Latency Multi-Touch Gesture Surface for Remote Desktop (FreeRDP 3.x & VNC RFB 3.8).
///
/// Eliminates Flutter's `GestureDetector` vs `InteractiveViewer` Gesture Arena starvation
/// and removes the 300ms `onDoubleTap` delay on Direct Touch:
/// - **Trackpad Mode**:
///   - 1-finger move: 0ms latency relative movement with ballistic velocity acceleration.
///   - 1-finger tap: immediate Left Click (consecutive taps register native OS Double-Click).
///   - Double-tap & hold-drag: Left-button drag (move windows, resize panes, select text).
///   - 2-finger tap or 1-finger stationary long-press (430ms): Right Click.
///   - 2-finger vertical drag: smooth Mouse Wheel scroll.
///   - 2-finger pinch: smooth 1.0x–5.0x viewport zoom.
/// - **Direct Touch Mode**:
///   - 1-finger tap: immediate 0ms Left Click mapped through inverse zoom `Matrix4`
///     (rapid second tap snaps within 24px for pixel-exact OS Double-Click).
///   - 1-finger drag: Left-button drag (`down -> move -> up`).
///   - 1-finger stationary long-press (430ms) or 2-finger tap: Right Click with haptic pulse.
///   - 2-finger pinch: smooth 1.0x–5.0x zoom + pan when zoomed; 2-finger vertical scroll at 1.0x.
class DesktopGestureSurface extends StatefulWidget {
  final Widget child;
  final TransformationController transformationController;
  final Rect desktopRect;
  final Size viewportSize;
  final double canvasMargin;
  final double bottomObstructionPx;
  final bool isTrackpadMode;
  final bool viewOnly;
  final Offset cursorNorm;

  final void Function(Offset norm, {bool isDragging}) onCursorMoved;
  final void Function(Offset norm, {required bool isConsecutiveDoubleTap}) onLeftClick;
  final void Function(Offset norm) onRightClick;
  final void Function(Offset norm) onLeftDragStart;
  final void Function(Offset norm) onLeftDragEnd;
  final void Function(Offset norm, int wheelDelta) onMouseWheel;
  final VoidCallback? onThreeFingerTap;
  final VoidCallback? onUserCanvasInteraction;

  const DesktopGestureSurface({
    super.key,
    required this.child,
    required this.transformationController,
    required this.desktopRect,
    required this.viewportSize,
    required this.canvasMargin,
    this.bottomObstructionPx = 0.0,
    required this.isTrackpadMode,
    required this.viewOnly,
    required this.cursorNorm,
    required this.onCursorMoved,
    required this.onLeftClick,
    required this.onRightClick,
    required this.onLeftDragStart,
    required this.onLeftDragEnd,
    required this.onMouseWheel,
    this.onThreeFingerTap,
    this.onUserCanvasInteraction,
  });

  @override
  State<DesktopGestureSurface> createState() => _DesktopGestureSurfaceState();
}

class _DesktopGestureSurfaceState extends State<DesktopGestureSurface> {
  final Map<int, Offset> _activePointers = <int, Offset>{};

  // Single-finger tracking state
  int? _primaryPointerId;
  Offset _primaryDownLocal = Offset.zero;
  Offset _primaryLastLocal = Offset.zero;
  Offset _directDownNorm = const Offset(0.5, 0.5);
  DateTime _primaryDownAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastMoveAt = DateTime.fromMillisecondsSinceEpoch(0);
  double _primaryMaxTravel = 0.0;
  bool _isLeftButtonDragging = false;
  bool _longPressFired = false;
  bool _hadMultiTouch = false;
  Timer? _longPressTimer;

  // Consecutive tap tracking (for double-tap-drag in Trackpad & snap-to-pixel double-click in Direct Touch)
  DateTime _lastQuickTapAt = DateTime.fromMillisecondsSinceEpoch(0);
  Offset _lastQuickTapLocal = Offset.zero;
  Offset _lastQuickTapNorm = const Offset(0.5, 0.5);
  bool _armedTrackpadTapDrag = false;

  // Two-finger & three-finger pinch / pan / scroll / right-click / keyboard toggle state
  DateTime _twoFingerStartAt = DateTime.fromMillisecondsSinceEpoch(0);
  double _twoFingerInitialSpan = 0.0;
  double _twoFingerPrevSpan = 0.0;
  Offset _twoFingerPrevCentroid = Offset.zero;
  double _twoFingerMaxDelta = 0.0;
  bool _pinchRecognized = false;
  double _wheelCarryPx = 0.0;
  int _maxPointersInGesture = 0;

  // Subtle visual ripple feedback for Direct Touch
  final List<_TouchRipplePulse> _ripples = <_TouchRipplePulse>[];
  final List<Timer> _rippleTimers = <Timer>[];
  int _rippleSeq = 0;

  @override
  void didUpdateWidget(covariant DesktopGestureSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if ((widget.desktopRect != oldWidget.desktopRect ||
            widget.viewportSize != oldWidget.viewportSize) &&
        !_hasPannableOverflow &&
        _currentZoomScale <= 1.01) {
      final storage = widget.transformationController.value.storage;
      final tx = storage[12];
      final ty = storage[13];
      if (tx.abs() > 0.5 || ty.abs() > 0.5) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _hasPannableOverflow || _currentZoomScale > 1.01) return;
          widget.transformationController.value = Matrix4.identity();
        });
      }
    }
  }

  @override
  void dispose() {
    _longPressTimer?.cancel();
    for (final t in _rippleTimers) {
      t.cancel();
    }
    _rippleTimers.clear();
    super.dispose();
  }

  double get _currentZoomScale {
    final m = widget.transformationController.value.storage;
    return m[0].clamp(1.0, 5.0);
  }

  bool get _hasPannableOverflow {
    if (_currentZoomScale > 1.01 || widget.bottomObstructionPx > 8.0) return true;
    return widget.desktopRect.width > widget.viewportSize.width + 2.0 ||
        widget.desktopRect.height > widget.viewportSize.height + 2.0;
  }

  (double minTx, double maxTx, double minTy, double maxTy) _computePanBounds(double scale) {
    final fullW = widget.viewportSize.width + widget.canvasMargin * 2;
    final fullH = widget.viewportSize.height + widget.canvasMargin * 2;
    final visibleH = (fullH - widget.bottomObstructionPx).clamp(80.0, fullH);

    final contentLeft = (widget.canvasMargin + widget.desktopRect.left) * scale;
    final contentRight = (widget.canvasMargin + widget.desktopRect.right) * scale;
    final contentTop = (widget.canvasMargin + widget.desktopRect.top) * scale;
    final contentBottom = (widget.canvasMargin + widget.desktopRect.bottom) * scale;

    double minTx, maxTx;
    if (contentRight - contentLeft > fullW + 0.5) {
      minTx = fullW - contentRight;
      maxTx = -contentLeft;
    } else {
      minTx = fullW * (1.0 - scale);
      maxTx = 0.0;
    }
    if (minTx > maxTx) {
      final mid = (minTx + maxTx) * 0.5;
      minTx = mid;
      maxTx = mid;
    }

    double minTy, maxTy;
    if (contentBottom - contentTop > visibleH + 0.5) {
      minTy = visibleH - contentBottom;
      maxTy = -contentTop > 0.0 ? -contentTop : 0.0;
    } else {
      minTy = visibleH - fullH * scale;
      maxTy = 0.0;
    }
    if (minTy > maxTy) {
      final mid = (minTy + maxTy) * 0.5;
      minTy = mid;
      maxTy = mid;
    }
    return (minTx, maxTx, minTy, maxTy);
  }

  /// Jump Desktop-style smooth camera follow when desktop overflows viewport (Zoom or Keyboard open).
  /// Note: At 1.0x unzoomed scale with no manual pan offset, `Fill (Proportional)` (`cropCover`) already
  /// pans `desktopRect` directly via `_cursorNorm` so `transformationController` stays `Matrix4.identity()`.
  void _autoPanViewportToFollowCursor(Offset norm) {
    if (!_hasPannableOverflow) return;
    final current = widget.transformationController.value;
    final scale = current.storage[0].clamp(1.0, 5.0);
    double tx = current.storage[12];
    double ty = current.storage[13];
    if (scale <= 1.01 && widget.bottomObstructionPx <= 8.0 && tx.abs() <= 0.5 && ty.abs() <= 0.5) {
      return;
    }

    final fullW = widget.viewportSize.width + widget.canvasMargin * 2;
    final fullH = widget.viewportSize.height + widget.canvasMargin * 2;
    final visibleH = (fullH - widget.bottomObstructionPx).clamp(80.0, fullH);

    final unzoomedX = widget.canvasMargin + widget.desktopRect.left + norm.dx * widget.desktopRect.width;
    final unzoomedY = widget.canvasMargin + widget.desktopRect.top + norm.dy * widget.desktopRect.height;
    final screenX = tx + unzoomedX * scale;
    final screenY = ty + unzoomedY * scale;

    final padX = (fullW * 0.12).clamp(16.0, 46.0);
    final padY = (visibleH * 0.12).clamp(16.0, 42.0);

    double newTx = tx;
    double newTy = ty;
    if (screenX < padX) {
      newTx += (padX - screenX);
    } else if (screenX > fullW - padX) {
      newTx -= (screenX - (fullW - padX));
    }
    if (screenY < padY) {
      newTy += (padY - screenY);
    } else if (screenY > visibleH - padY) {
      newTy -= (screenY - (visibleH - padY));
    }

    final (minTx, maxTx, minTy, maxTy) = _computePanBounds(scale);
    final clampedTx = newTx.clamp(minTx, maxTx);
    final clampedTy = newTy.clamp(minTy, maxTy);
    if ((clampedTx - tx).abs() < 0.25 && (clampedTy - ty).abs() < 0.25) return;

    final next = Matrix4.identity()
      ..translateByDouble(clampedTx, clampedTy, 0.0, 1.0)
      ..scaleByDouble(scale, scale, 1.0, 1.0);
    widget.transformationController.value = next;
  }

  /// Maps a widget-local touch coordinate through the inverse zoom `Matrix4` onto `[0..1]` remote desktop norm.
  Offset _localToDesktopNorm(Offset localWidgetPos) {
    final inv = Matrix4.tryInvert(widget.transformationController.value);
    final Offset unzoomed = inv != null
        ? MatrixUtils.transformPoint(inv, localWidgetPos)
        : localWidgetPos;
    final dxInCanvas = unzoomed.dx - widget.canvasMargin;
    final dyInCanvas = unzoomed.dy - widget.canvasMargin;
    final rect = widget.desktopRect;
    final normX = ((dxInCanvas - rect.left) / rect.width.clamp(1.0, 16384.0)).clamp(0.0, 1.0);
    final normY = ((dyInCanvas - rect.top) / rect.height.clamp(1.0, 16384.0)).clamp(0.0, 1.0);
    return Offset(normX, normY);
  }

  void _spawnTouchRipple(Offset localPos, {required bool isRightClick}) {
    if (widget.isTrackpadMode) return;
    final id = ++_rippleSeq;
    setState(() {
      _ripples.add(_TouchRipplePulse(id: id, localPos: localPos, isRightClick: isRightClick));
    });
    late final Timer rippleTimer;
    rippleTimer = Timer(const Duration(milliseconds: 240), () {
      _rippleTimers.remove(rippleTimer);
      if (!mounted) return;
      setState(() {
        _ripples.removeWhere((r) => r.id == id);
      });
    });
    _rippleTimers.add(rippleTimer);
  }

  void _applyZoomAndPan({
    required Offset focalPoint,
    required double scaleFactor,
    required Offset panDelta,
  }) {
    final current = widget.transformationController.value.clone();
    final currentScale = current.storage[0].clamp(1.0, 5.0);
    final targetScale = (currentScale * scaleFactor).clamp(1.0, 5.0);
    final effectiveRatio = targetScale / currentScale;

    double tx = current.storage[12] + panDelta.dx;
    double ty = current.storage[13] + panDelta.dy;
    tx = focalPoint.dx - (focalPoint.dx - tx) * effectiveRatio;
    ty = focalPoint.dy - (focalPoint.dy - ty) * effectiveRatio;

    final (minTx, maxTx, minTy, maxTy) = _computePanBounds(targetScale);
    if (targetScale <= 1.005 && (maxTx - minTx).abs() < 0.5 && (maxTy - minTy).abs() < 0.5) {
      widget.transformationController.value = Matrix4.identity();
      return;
    }
    final clampedTx = tx.clamp(minTx, maxTx);
    final clampedTy = ty.clamp(minTy, maxTy);

    final next = Matrix4.identity()
      ..translateByDouble(clampedTx, clampedTy, 0.0, 1.0)
      ..scaleByDouble(targetScale, targetScale, 1.0, 1.0);
    widget.transformationController.value = next;
  }

  void _initTwoFingerMetrics() {
    final pts = _activePointers.values.toList();
    if (pts.length < 2) return;
    final p0 = pts[0];
    final p1 = pts[1];
    _twoFingerStartAt = DateTime.now();
    _twoFingerInitialSpan = (p1 - p0).distance.clamp(1.0, 8192.0);
    _twoFingerPrevSpan = _twoFingerInitialSpan;
    _twoFingerPrevCentroid = Offset((p0.dx + p1.dx) * 0.5, (p0.dy + p1.dy) * 0.5);
    _twoFingerMaxDelta = 0.0;
    _pinchRecognized = false;
    _wheelCarryPx = 0.0;
  }

  void _handlePointerDown(PointerDownEvent event) {
    widget.onUserCanvasInteraction?.call();
    _activePointers[event.pointer] = event.localPosition;
    if (_activePointers.length > _maxPointersInGesture) {
      _maxPointersInGesture = _activePointers.length;
    }

    if (_activePointers.length == 1) {
      _maxPointersInGesture = 1;
      final now = DateTime.now();
      _primaryPointerId = event.pointer;
      _primaryDownLocal = event.localPosition;
      _primaryLastLocal = event.localPosition;
      _primaryDownAt = now;
      _lastMoveAt = now;
      _primaryMaxTravel = 0.0;
      _isLeftButtonDragging = false;
      _longPressFired = false;
      _hadMultiTouch = false;

      final sinceLastTapMs = now.difference(_lastQuickTapAt).inMilliseconds;
      final nearLastTap = (event.localPosition - _lastQuickTapLocal).distance <= 26.0;
      final isRapidSecondTouch = sinceLastTapMs >= 0 && sinceLastTapMs <= 300 && nearLastTap;

      _armedTrackpadTapDrag = widget.isTrackpadMode && isRapidSecondTouch;

      if (!widget.isTrackpadMode && !widget.viewOnly) {
        final rawNorm = _localToDesktopNorm(event.localPosition);
        // Snap rapid second tap to exact first-tap pixel so Windows/macOS registers crisp OS double-click
        _directDownNorm = isRapidSecondTouch ? _lastQuickTapNorm : rawNorm;
        widget.onCursorMoved(_directDownNorm);
      }

      // Stationary long-press -> Right Click (both modes, unless viewOnly)
      _longPressTimer?.cancel();
      if (!widget.viewOnly) {
        _longPressTimer = Timer(const Duration(milliseconds: 430), () {
          if (!mounted ||
              _hadMultiTouch ||
              _isLeftButtonDragging ||
              _activePointers.length != 1 ||
              _primaryMaxTravel > 10.0) {
            return;
          }
          _longPressFired = true;
          HapticFeedback.mediumImpact();
          final targetNorm = widget.isTrackpadMode ? widget.cursorNorm : _directDownNorm;
          _spawnTouchRipple(_primaryDownLocal, isRightClick: true);
          widget.onRightClick(targetNorm);
        });
      }
      return;
    }

    // Transitioned to 2+ fingers: cancel pending 1-finger tap/drag/long-press
    _longPressTimer?.cancel();
    if (_isLeftButtonDragging) {
      final endNorm = widget.isTrackpadMode
          ? widget.cursorNorm
          : _localToDesktopNorm(_primaryLastLocal);
      widget.onLeftDragEnd(endNorm);
      _isLeftButtonDragging = false;
    }
    _armedTrackpadTapDrag = false;
    _hadMultiTouch = true;
    if (_activePointers.length == 2) {
      _initTwoFingerMetrics();
    }
  }

  void _handlePointerMove(PointerMoveEvent event) {
    if (!_activePointers.containsKey(event.pointer)) return;
    _activePointers[event.pointer] = event.localPosition;

    // 2-Finger Pinch-Zoom / Pan / Mouse Wheel Scroll
    if (_activePointers.length >= 2) {
      final pts = _activePointers.values.toList();
      final p0 = pts[0];
      final p1 = pts[1];
      final span = (p1 - p0).distance.clamp(1.0, 8192.0);
      final centroid = Offset((p0.dx + p1.dx) * 0.5, (p0.dy + p1.dy) * 0.5);
      final centroidDelta = centroid - _twoFingerPrevCentroid;
      final spanDiffFromStart = (span - _twoFingerInitialSpan).abs();

      _twoFingerMaxDelta = _twoFingerMaxDelta < centroidDelta.distance
          ? centroidDelta.distance + spanDiffFromStart
          : _twoFingerMaxDelta + centroidDelta.distance * 0.5;

      if (spanDiffFromStart > 16.0) {
        _pinchRecognized = true;
      }

      final horizontalPanDominant = centroidDelta.dx.abs() > centroidDelta.dy.abs() * 1.25;
      if (_pinchRecognized ||
          (!widget.isTrackpadMode && _hasPannableOverflow) ||
          (_hasPannableOverflow && horizontalPanDominant)) {
        final ratio = _twoFingerPrevSpan > 1.0 ? (span / _twoFingerPrevSpan) : 1.0;
        _applyZoomAndPan(
          focalPoint: centroid,
          scaleFactor: _pinchRecognized ? ratio : 1.0,
          panDelta: centroidDelta,
        );
      } else if (!widget.viewOnly) {
        // 2-finger parallel vertical drag -> smooth Remote Mouse Wheel Scroll!
        _wheelCarryPx += centroidDelta.dy;
        const double stepPx = 18.0;
        while (_wheelCarryPx.abs() >= stepPx) {
          final sign = _wheelCarryPx > 0 ? 1 : -1;
          _wheelCarryPx -= sign * stepPx;
          final targetNorm = widget.isTrackpadMode
              ? widget.cursorNorm
              : _localToDesktopNorm(centroid);
          widget.onMouseWheel(targetNorm, sign * 120);
        }
      }

      _twoFingerPrevSpan = span;
      _twoFingerPrevCentroid = centroid;
      return;
    }

    // 1-Finger Movement (ignored if multi-touch occurred in this gesture or viewOnly)
    if (_hadMultiTouch || event.pointer != _primaryPointerId) return;

    final now = DateTime.now();
    final stepDelta = event.localPosition - _primaryLastLocal;
    _primaryLastLocal = event.localPosition;
    final distFromDown = (event.localPosition - _primaryDownLocal).distance;
    if (distFromDown > _primaryMaxTravel) {
      _primaryMaxTravel = distFromDown;
    }
    if (_primaryMaxTravel > 10.0) {
      _longPressTimer?.cancel();
    }

    if (widget.viewOnly) {
      if (_hasPannableOverflow) {
        _applyZoomAndPan(focalPoint: event.localPosition, scaleFactor: 1.0, panDelta: stepDelta);
      }
      return;
    }

    if (widget.isTrackpadMode) {
      // Trackpad Mode: immediate relative ballistic cursor movement + Jump camera follow
      if (stepDelta.dx == 0.0 && stepDelta.dy == 0.0) return;

      if (_armedTrackpadTapDrag && !_isLeftButtonDragging && _primaryMaxTravel >= 4.5) {
        _isLeftButtonDragging = true;
        HapticFeedback.selectionClick();
        widget.onLeftDragStart(widget.cursorNorm);
      }

      final dtMs = now.difference(_lastMoveAt).inMilliseconds.clamp(4, 48);
      _lastMoveAt = now;
      final speedPxPerMs = stepDelta.distance / dtMs;
      // Smooth Jump Desktop / macOS-like ballistic acceleration curve
      final gain = (1.15 + (speedPxPerMs * 0.52).clamp(0.0, 1.85)) / _currentZoomScale;

      final rw = widget.desktopRect.width.clamp(64.0, 16384.0);
      final rh = widget.desktopRect.height.clamp(64.0, 16384.0);
      final nextNorm = Offset(
        (widget.cursorNorm.dx + (stepDelta.dx * gain) / rw).clamp(0.0, 1.0),
        (widget.cursorNorm.dy + (stepDelta.dy * gain) / rh).clamp(0.0, 1.0),
      );
      _autoPanViewportToFollowCursor(nextNorm);
      widget.onCursorMoved(nextNorm, isDragging: _isLeftButtonDragging);
    } else {
      // Direct Touch Mode: 1-finger drag = remote Left-Button Drag
      if (_longPressFired) return;
      if (!_isLeftButtonDragging && _primaryMaxTravel >= 10.0) {
        _isLeftButtonDragging = true;
        widget.onLeftDragStart(_directDownNorm);
      }
      if (_isLeftButtonDragging) {
        final norm = _localToDesktopNorm(event.localPosition);
        _autoPanViewportToFollowCursor(norm);
        widget.onCursorMoved(norm, isDragging: true);
      }
    }
  }

  void _handlePointerUp(PointerUpEvent event) {
    _activePointers.remove(event.pointer);
    _longPressTimer?.cancel();

    // Check for quick 3-finger tap (Keyboard toggle) or 2-finger tap (Right Click)!
    if (_hadMultiTouch) {
      if (_activePointers.isEmpty) {
        final elapsedMs = DateTime.now().difference(_twoFingerStartAt).inMilliseconds;
        if (!_pinchRecognized && elapsedMs <= 290 && _twoFingerMaxDelta < 22.0) {
          if (_maxPointersInGesture >= 3 && widget.onThreeFingerTap != null) {
            HapticFeedback.mediumImpact();
            widget.onThreeFingerTap!();
          } else if (_maxPointersInGesture == 2 && !widget.viewOnly) {
            HapticFeedback.selectionClick();
            final norm = widget.isTrackpadMode
                ? widget.cursorNorm
                : _localToDesktopNorm(_twoFingerPrevCentroid);
            _spawnTouchRipple(_twoFingerPrevCentroid, isRightClick: true);
            widget.onRightClick(norm);
          }
        }
        _hadMultiTouch = false;
        _maxPointersInGesture = 0;
      }
      return;
    }

    if (event.pointer != _primaryPointerId) return;
    _primaryPointerId = null;

    if (widget.viewOnly || _longPressFired) {
      _armedTrackpadTapDrag = false;
      return;
    }

    if (_isLeftButtonDragging) {
      final endNorm = widget.isTrackpadMode
          ? widget.cursorNorm
          : _localToDesktopNorm(event.localPosition);
      widget.onLeftDragEnd(endNorm);
      _isLeftButtonDragging = false;
      _armedTrackpadTapDrag = false;
      return;
    }

    // Quick 1-finger tap (< 260ms and < 11px travel) -> ZERO-LATENCY Left Click!
    final now = DateTime.now();
    final tapDurationMs = now.difference(_primaryDownAt).inMilliseconds;
    if (tapDurationMs <= 280 && _primaryMaxTravel <= 11.0) {
      final sincePrevTapMs = now.difference(_lastQuickTapAt).inMilliseconds;
      final isDoubleTap = sincePrevTapMs >= 0 &&
          sincePrevTapMs <= 300 &&
          (event.localPosition - _lastQuickTapLocal).distance <= 26.0;

      final clickNorm = widget.isTrackpadMode ? widget.cursorNorm : _directDownNorm;
      _lastQuickTapAt = now;
      _lastQuickTapLocal = event.localPosition;
      _lastQuickTapNorm = clickNorm;

      _spawnTouchRipple(event.localPosition, isRightClick: false);
      widget.onLeftClick(clickNorm, isConsecutiveDoubleTap: isDoubleTap);
    }
    _armedTrackpadTapDrag = false;
  }

  void _handlePointerCancel(PointerCancelEvent event) {
    _activePointers.remove(event.pointer);
    _longPressTimer?.cancel();
    if (_isLeftButtonDragging) {
      widget.onLeftDragEnd(widget.cursorNorm);
      _isLeftButtonDragging = false;
    }
    if (_activePointers.isEmpty) {
      _primaryPointerId = null;
      _hadMultiTouch = false;
      _armedTrackpadTapDrag = false;
    }
  }

  void _handlePointerSignal(PointerSignalEvent event) {
    if (widget.viewOnly) return;
    if (event is PointerScrollEvent) {
      final norm = widget.isTrackpadMode
          ? widget.cursorNorm
          : _localToDesktopNorm(event.localPosition);
      // Hardware mouse wheel down has positive scrollDelta.dy -> negative RDP wheel rotation
      final wheelDelta = event.scrollDelta.dy < 0 ? 120 : -120;
      widget.onMouseWheel(norm, wheelDelta);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: _handlePointerDown,
      onPointerMove: _handlePointerMove,
      onPointerUp: _handlePointerUp,
      onPointerCancel: _handlePointerCancel,
      onPointerSignal: _handlePointerSignal,
      child: ClipRect(
        child: Stack(
          fit: StackFit.expand,
          children: [
            ValueListenableBuilder<Matrix4>(
              valueListenable: widget.transformationController,
              builder: (context, matrix, child) {
                return Transform(
                  transform: matrix,
                  alignment: Alignment.topLeft,
                  child: child,
                );
              },
              child: widget.child,
            ),
            for (final ripple in _ripples)
              Positioned(
                left: ripple.localPos.dx - 18,
                top: ripple.localPos.dy - 18,
                child: IgnorePointer(
                  child: Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: (ripple.isRightClick
                              ? const Color(0xFFF5C451)
                              : const Color(0xFF4C9AFF))
                          .withValues(alpha: 0.22),
                      border: Border.all(
                        color: ripple.isRightClick
                            ? const Color(0xFFF5C451)
                            : const Color(0xFF79B8FF),
                        width: 1.4,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
