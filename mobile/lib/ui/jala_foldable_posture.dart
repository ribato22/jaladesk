import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'jala_enterprise_components.dart';

/// Resolved hardware folding posture for Android foldables & dual-screen devices.
enum JalaPostureMode {
  /// Standard single-plane display (flat unfolded, cover screen, slab phone, or overridden).
  flat,

  /// Half-opened horizontal fold/hinge (Mini-Laptop / Tabletop posture).
  tabletop,

  /// Vertical fold/hinge spanning the screen height (Book / Dual-Pane posture).
  book,
}

/// Pure Flutter posture resolver built directly on `dart:ui` [ui.DisplayFeature]
/// (backed natively by Jetpack WindowManager in Flutter's Android embedding).
@immutable
class JalaFoldablePosture {
  /// Minimum protected buffer (logical px) around 0px OLED folds so interactive
  /// controls and remote taskbars never sit directly on the bent crease.
  static const double minCreaseGuardPx = 16.0;

  /// Minimum fraction of the parallel screen edge a fold/hinge must span.
  static const double minSpanFraction = 0.70;

  /// Minimum height (logical px) required for both top and bottom tabletop panes.
  static const double minTabletopPaneHeight = 180.0;

  /// Minimum width (logical px) required for both left and right book panes.
  static const double minBookPaneWidth = 200.0;

  /// Minimum local pane extent retained after subtracting outer chrome insets.
  static const double minAdjustedTabletopPaneHeight = 120.0;
  static const double minAdjustedBookPaneWidth = 140.0;

  /// Effective posture mode (`flat` when [isOverridden] is true).
  final JalaPostureMode mode;

  /// Hardware-detected posture mode ignoring [overrideDisabled].
  final JalaPostureMode rawMode;

  /// True when hardware is in tabletop/book posture but the user forced flat layout.
  final bool isOverridden;

  /// Logical viewport dimensions used to compute split bounds.
  final Size screenSize;

  /// Raw [ui.DisplayFeature.bounds] of the matched fold/hinge, if any.
  final Rect? featureBounds;

  /// Matched display feature type (`fold` or `hinge`), if any.
  final ui.DisplayFeatureType? featureType;

  /// Matched display feature state, if any.
  final ui.DisplayFeatureState? featureState;

  /// Start coordinate of the protected crease guard zone along the split axis
  /// (`y` in tabletop mode, `x` in book mode, `0.0` in flat mode).
  final double gapStart;

  /// End coordinate of the protected crease guard zone along the split axis
  /// (`y` in tabletop mode, `x` in book mode, `0.0` in flat mode).
  final double gapEnd;

  /// Total protected crease thickness (`gapEnd - gapStart`), always `>= 16.0`
  /// when [isActive] is true, or `0.0` when [isFlat] is true.
  final double effectiveGap;

  const JalaFoldablePosture._({
    required this.mode,
    required this.rawMode,
    required this.isOverridden,
    required this.screenSize,
    required this.featureBounds,
    required this.featureType,
    required this.featureState,
    required this.gapStart,
    required this.gapEnd,
    required this.effectiveGap,
  });

  /// Flat posture fallback with no active hinge split.
  const JalaFoldablePosture.flat({
    Size screenSize = Size.zero,
    JalaPostureMode rawMode = JalaPostureMode.flat,
    bool isOverridden = false,
    Rect? featureBounds,
    ui.DisplayFeatureType? featureType,
    ui.DisplayFeatureState? featureState,
  }) : this._(
         mode: JalaPostureMode.flat,
         rawMode: rawMode,
         isOverridden: isOverridden,
         screenSize: screenSize,
         featureBounds: featureBounds,
         featureType: featureType,
         featureState: featureState,
         gapStart: 0.0,
         gapEnd: 0.0,
         effectiveGap: 0.0,
       );

  /// Resolves the foldable posture directly from [MediaQueryData].
  factory JalaFoldablePosture.fromMediaQuery(
    MediaQueryData mq, {
    bool overrideDisabled = false,
  }) {
    return JalaFoldablePosture.fromValues(
      screenSize: mq.size,
      displayFeatures: mq.displayFeatures,
      overrideDisabled: overrideDisabled,
    );
  }

  /// Resolves the foldable posture from explicit logical [screenSize] and
  /// [displayFeatures] (ideal for deterministic unit & widget testing).
  factory JalaFoldablePosture.fromValues({
    required Size screenSize,
    required List<ui.DisplayFeature> displayFeatures,
    bool overrideDisabled = false,
  }) {
    if (screenSize.width <= 0 || screenSize.height <= 0) {
      return JalaFoldablePosture.flat(screenSize: screenSize);
    }

    JalaFoldablePosture? tabletopMatch;
    JalaFoldablePosture? bookMatch;

    for (final feature in displayFeatures) {
      final type = feature.type;
      if (type != ui.DisplayFeatureType.fold &&
          type != ui.DisplayFeatureType.hinge) {
        continue;
      }

      final bounds = feature.bounds;
      final isHorizontal =
          bounds.width >= screenSize.width * minSpanFraction &&
          bounds.width > bounds.height;
      final isVertical =
          bounds.height >= screenSize.height * minSpanFraction &&
          bounds.height > bounds.width;

      if (isHorizontal &&
          feature.state == ui.DisplayFeatureState.postureHalfOpened) {
        final gap = math.max(bounds.shortestSide, minCreaseGuardPx);
        final centerY = bounds.top + (bounds.height / 2.0);
        final gStart = (centerY - (gap / 2.0)).clamp(0.0, screenSize.height);
        final gEnd = (centerY + (gap / 2.0)).clamp(gStart, screenSize.height);
        final bottomExtent = screenSize.height - gEnd;

        if (gStart >= minTabletopPaneHeight &&
            bottomExtent >= minTabletopPaneHeight) {
          tabletopMatch = JalaFoldablePosture._(
            mode: JalaPostureMode.tabletop,
            rawMode: JalaPostureMode.tabletop,
            isOverridden: false,
            screenSize: screenSize,
            featureBounds: bounds,
            featureType: type,
            featureState: feature.state,
            gapStart: gStart,
            gapEnd: gEnd,
            effectiveGap: gEnd - gStart,
          );
          break;
        }
      }

      if (isVertical &&
          (feature.state == ui.DisplayFeatureState.postureHalfOpened ||
              type == ui.DisplayFeatureType.hinge)) {
        final gap = math.max(bounds.shortestSide, minCreaseGuardPx);
        final centerX = bounds.left + (bounds.width / 2.0);
        final gStart = (centerX - (gap / 2.0)).clamp(0.0, screenSize.width);
        final gEnd = (centerX + (gap / 2.0)).clamp(gStart, screenSize.width);
        final rightExtent = screenSize.width - gEnd;

        if (gStart >= minBookPaneWidth && rightExtent >= minBookPaneWidth) {
          bookMatch ??= JalaFoldablePosture._(
            mode: JalaPostureMode.book,
            rawMode: JalaPostureMode.book,
            isOverridden: false,
            screenSize: screenSize,
            featureBounds: bounds,
            featureType: type,
            featureState: feature.state,
            gapStart: gStart,
            gapEnd: gEnd,
            effectiveGap: gEnd - gStart,
          );
        }
      }
    }

    final matched = tabletopMatch ?? bookMatch;
    if (matched == null) {
      return JalaFoldablePosture.flat(screenSize: screenSize);
    }

    if (overrideDisabled) {
      return JalaFoldablePosture.flat(
        screenSize: screenSize,
        rawMode: matched.rawMode,
        isOverridden: true,
        featureBounds: matched.featureBounds,
        featureType: matched.featureType,
        featureState: matched.featureState,
      );
    }

    return matched;
  }

  bool get isFlat => mode == JalaPostureMode.flat;
  bool get isTabletop => mode == JalaPostureMode.tabletop;
  bool get isBook => mode == JalaPostureMode.book;
  bool get isActive => mode != JalaPostureMode.flat;

  /// True when hardware reported an active fold/hinge posture even if overridden.
  bool get hasPhysicalFlexPosture => rawMode != JalaPostureMode.flat;

  /// Top pane logical height in tabletop mode (or full screen height otherwise).
  double get topPaneHeight => isTabletop ? gapStart : screenSize.height;

  /// Horizontal crease guard height in tabletop mode (`0.0` otherwise).
  double get gapHeight => isTabletop ? effectiveGap : 0.0;

  /// Bottom pane logical height in tabletop mode (`0.0` otherwise).
  double get bottomPaneHeight =>
      isTabletop ? math.max(0.0, screenSize.height - gapEnd) : 0.0;

  /// Left pane logical width in book mode (or full screen width otherwise).
  double get leftPaneWidth => isBook ? gapStart : screenSize.width;

  /// Vertical crease guard width in book mode (`0.0` otherwise).
  double get gapWidth => isBook ? effectiveGap : 0.0;

  /// Right pane logical width in book mode (`0.0` otherwise).
  double get rightPaneWidth =>
      isBook ? math.max(0.0, screenSize.width - gapEnd) : 0.0;

  /// Translates root-window coordinates into a nested container offset by
  /// [topOffset] (e.g. AppBar + status bar) and [leftOffset] (e.g. NavigationRail).
  ///
  /// Falls back to [JalaPostureMode.flat] if subtracting the outer chrome leaves
  /// either pane too narrow/short to render comfortably without overflow.
  JalaFoldablePosture adjustForInsets({
    double topOffset = 0.0,
    double leftOffset = 0.0,
    double? viewportWidth,
    double? viewportHeight,
  }) {
    final localWidth =
        viewportWidth ?? math.max(0.0, screenSize.width - leftOffset);
    final localHeight =
        viewportHeight ?? math.max(0.0, screenSize.height - topOffset);
    final localSize = Size(localWidth, localHeight);

    if (isFlat) {
      return JalaFoldablePosture.flat(
        screenSize: localSize,
        rawMode: rawMode,
        isOverridden: isOverridden,
        featureBounds: featureBounds,
        featureType: featureType,
        featureState: featureState,
      );
    }

    if (isTabletop) {
      final adjustedStart = (gapStart - topOffset).clamp(0.0, localHeight);
      final adjustedEnd = (gapEnd - topOffset).clamp(
        adjustedStart,
        localHeight,
      );
      final bottomHeight = localHeight - adjustedEnd;

      if (adjustedStart < minAdjustedTabletopPaneHeight ||
          bottomHeight < minAdjustedTabletopPaneHeight ||
          (adjustedEnd - adjustedStart) <= 0) {
        return JalaFoldablePosture.flat(
          screenSize: localSize,
          rawMode: rawMode,
          isOverridden: isOverridden,
          featureBounds: featureBounds,
          featureType: featureType,
          featureState: featureState,
        );
      }

      return JalaFoldablePosture._(
        mode: JalaPostureMode.tabletop,
        rawMode: rawMode,
        isOverridden: false,
        screenSize: localSize,
        featureBounds: featureBounds?.shift(Offset(-leftOffset, -topOffset)),
        featureType: featureType,
        featureState: featureState,
        gapStart: adjustedStart,
        gapEnd: adjustedEnd,
        effectiveGap: adjustedEnd - adjustedStart,
      );
    }

    // Book mode
    final adjustedStart = (gapStart - leftOffset).clamp(0.0, localWidth);
    final adjustedEnd = (gapEnd - leftOffset).clamp(adjustedStart, localWidth);
    final rightWidth = localWidth - adjustedEnd;

    if (adjustedStart < minAdjustedBookPaneWidth ||
        rightWidth < minAdjustedBookPaneWidth ||
        (adjustedEnd - adjustedStart) <= 0) {
      return JalaFoldablePosture.flat(
        screenSize: localSize,
        rawMode: rawMode,
        isOverridden: isOverridden,
        featureBounds: featureBounds,
        featureType: featureType,
        featureState: featureState,
      );
    }

    return JalaFoldablePosture._(
      mode: JalaPostureMode.book,
      rawMode: rawMode,
      isOverridden: false,
      screenSize: localSize,
      featureBounds: featureBounds?.shift(Offset(-leftOffset, -topOffset)),
      featureType: featureType,
      featureState: featureState,
      gapStart: adjustedStart,
      gapEnd: adjustedEnd,
      effectiveGap: adjustedEnd - adjustedStart,
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is JalaFoldablePosture &&
        other.mode == mode &&
        other.rawMode == rawMode &&
        other.isOverridden == isOverridden &&
        other.screenSize == screenSize &&
        other.featureBounds == featureBounds &&
        other.featureType == featureType &&
        other.featureState == featureState &&
        other.gapStart == gapStart &&
        other.gapEnd == gapEnd &&
        other.effectiveGap == effectiveGap;
  }

  @override
  int get hashCode => Object.hash(
    mode,
    rawMode,
    isOverridden,
    screenSize,
    featureBounds,
    featureType,
    featureState,
    gapStart,
    gapEnd,
    effectiveGap,
  );

  @override
  String toString() =>
      'JalaFoldablePosture(mode: $mode, rawMode: $rawMode, '
      'gapStart: ${gapStart.toStringAsFixed(1)}, '
      'gapEnd: ${gapEnd.toStringAsFixed(1)}, '
      'effectiveGap: ${effectiveGap.toStringAsFixed(1)}, '
      'isOverridden: $isOverridden)';
}

/// Matte hardware crease guard divider bridging the physical fold or hinge.
///
/// Contains zero interactive touch targets so fingers never strike controls
/// resting on the bent OLED crease.
class JalaCreaseDivider extends StatelessWidget {
  static const Color _creaseSurface = Color(0xFF090E17);
  static const Color _creaseHairline = Color(0xFF233246);
  static const Color _pillSurface = Color(0xFF101926);

  /// Height of the divider when [axis] is [Axis.horizontal].
  final double height;

  /// Width of the divider when [axis] is [Axis.vertical].
  final double? width;

  /// Orientation of the crease guard (`horizontal` for tabletop, `vertical` for book).
  final Axis axis;

  /// Optional pill label displayed in the center when space permits.
  final String? label;

  /// Optional accent color for the subtle status dot inside the pill.
  final Color? accentColor;

  const JalaCreaseDivider({
    super.key,
    this.height = JalaFoldablePosture.minCreaseGuardPx,
    this.width,
    this.axis = Axis.horizontal,
    this.label,
    this.accentColor,
  });

  @override
  Widget build(BuildContext context) {
    final dotColor = accentColor ?? JalaEnterpriseTokens.accentPrimary;

    if (axis == Axis.vertical) {
      final effectiveWidth = width ?? height;
      return Semantics(
        label: label ?? 'Flex Book Hinge Guard',
        child: Container(
          key: const Key('jala_crease_divider_vertical'),
          width: effectiveWidth,
          decoration: const BoxDecoration(
            color: _creaseSurface,
            border: Border.symmetric(
              vertical: BorderSide(color: _creaseHairline, width: 1.0),
            ),
          ),
          child: effectiveWidth >= 16.0
              ? Center(
                  child: Container(
                    width: 4,
                    height: 36,
                    decoration: BoxDecoration(
                      color: dotColor.withValues(alpha: 0.45),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                )
              : null,
        ),
      );
    }

    final pillText = label ?? 'FLEX MINI-LAPTOP';
    final showPill = height >= 16.0;

    return Semantics(
      label: pillText,
      child: Container(
        key: const Key('jala_crease_divider_horizontal'),
        width: double.infinity,
        height: height,
        decoration: const BoxDecoration(
          color: _creaseSurface,
          border: Border.symmetric(
            horizontal: BorderSide(color: _creaseHairline, width: 1.0),
          ),
        ),
        child: showPill
            ? Center(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 1,
                    ),
                    decoration: BoxDecoration(
                      color: _pillSurface,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: _creaseHairline, width: 1.0),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 5,
                          height: 5,
                          decoration: BoxDecoration(
                            color: dotColor,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          pillText,
                          maxLines: 1,
                          softWrap: false,
                          style: const TextStyle(
                            fontSize: 11.0,
                            height: 1.1,
                            fontWeight: FontWeight.w700,
                            color: JalaEnterpriseTokens.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              )
            : null,
      ),
    );
  }
}
