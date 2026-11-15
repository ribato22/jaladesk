import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Shared World-Class Enterprise UI Design Tokens & Primitives (`v1.15.0+17`).
/// Engineered for Linear / Raycast / 1Password / Termius visual precision.
class JalaEnterpriseTokens {
  static const Color dialogSurface = Color(0xFF141D29);
  static const Color dialogBorder = Color(0xFF2B3D54);
  static const Color headerBg = Color(0xFF0D141F);
  static const Color headerBorder = Color(0xFF233246);
  static const Color headerBadgeBg = Color(0xFF1A293D);
  static const Color footerBg = Color(0xFF0A1018);
  static const Color footerBorder = Color(0xFF26364A);

  static const Color trackBg = Color(0xFF0A1018);
  static const Color trackBorder = Color(0xFF263649);
  static const Color segmentSelectedBg = Color(0xFF213650);
  static const Color segmentGold = Color(0xFFF3C66F);

  static const Color fieldFill = Color(0xFF0E1520);
  static const Color fieldBorder = Color(0xFF28384C);
  static const Color primaryButtonBg = Color(0xFF1F6FEB);
  static const Color dangerButtonBg = Color(0xFFD64545);

  static const Color bgCanvas = Color(0xFF080C12);
  static const Color accentPrimary = Color(0xFF63A8FF);
  static const Color statusOk = Color(0xFF3FB97C);
  static const Color statusWarn = Color(0xFFF3C66F);
  static const Color statusDanger = Color(0xFFF06A6A);

  static const Color textPrimary = Color(0xFFE6EEF7);
  static const Color textSecondary = Color(0xFFB4C3D4);
  static const Color textMuted = Color(0xFF8C9AA8);
  static const Color sectionHeader = Color(0xFF9FB0C3);
}

/// Option descriptor for [JalaSegmentedBar].
class JalaSegmentedOption<T> {
  final T value;
  final String label;
  final IconData? icon;
  final Key? segmentKey;
  final String? tooltip;

  const JalaSegmentedOption({
    required this.value,
    required this.label,
    this.icon,
    this.segmentKey,
    this.tooltip,
  });
}

/// Individual segment pill inside [JalaSegmentedBar].
/// Exposes [selected] for clean widget-test inspection via `segmentKey`.
class JalaSegmentPill extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool selected;
  final double height;
  final double fontSize;
  final double iconSize;
  final VoidCallback? onTap;
  final String? tooltip;

  const JalaSegmentPill({
    super.key,
    required this.label,
    required this.selected,
    this.icon,
    this.height = 34.0,
    this.fontSize = 11.5,
    this.iconSize = 13.5,
    this.onTap,
    this.tooltip,
  });

  @override
  Widget build(BuildContext context) {
    final Widget pill = Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(7.5),
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: Curves.easeOutCubic,
          height: height,
          padding: const EdgeInsets.symmetric(horizontal: 6),
          decoration: BoxDecoration(
            color: selected
                ? JalaEnterpriseTokens.segmentSelectedBg
                : Colors.transparent,
            borderRadius: BorderRadius.circular(7.5),
            border: Border.all(
              color: selected
                  ? JalaEnterpriseTokens.segmentGold.withValues(alpha: 0.78)
                  : Colors.transparent,
              width: 1.0,
            ),
          ),
          child: Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[
                    Icon(
                      icon,
                      size: iconSize,
                      color: selected
                          ? JalaEnterpriseTokens.segmentGold
                          : JalaEnterpriseTokens.textMuted,
                    ),
                    const SizedBox(width: 4.5),
                  ],
                  Text(
                    label,
                    maxLines: 1,
                    softWrap: false,
                    style: TextStyle(
                      fontSize: fontSize,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
                      letterSpacing: -0.1,
                      color: selected
                          ? JalaEnterpriseTokens.textPrimary
                          : JalaEnterpriseTokens.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );

    if (tooltip != null && tooltip!.isNotEmpty) {
      return Tooltip(message: tooltip!, child: pill);
    }
    return pill;
  }
}

/// Guaranteed 1-Row Segmented Control (`Row` -> `Expanded` per option, NEVER `Wrap`).
/// Scales smoothly on ultra-narrow (`320dp`) viewports with zero line wrapping.
class JalaSegmentedBar<T> extends StatelessWidget {
  final List<JalaSegmentedOption<T>> options;
  final T selectedValue;
  final ValueChanged<T>? onChanged;
  final double height;
  final double fontSize;
  final double iconSize;

  const JalaSegmentedBar({
    super.key,
    required this.options,
    required this.selectedValue,
    required this.onChanged,
    this.height = 34.0,
    this.fontSize = 11.5,
    this.iconSize = 13.5,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: JalaEnterpriseTokens.trackBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: JalaEnterpriseTokens.trackBorder, width: 1.0),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          for (int i = 0; i < options.length; i++) ...[
            if (i > 0) const SizedBox(width: 2),
            Expanded(
              child: JalaSegmentPill(
                key: options[i].segmentKey,
                label: options[i].label,
                icon: options[i].icon,
                selected: options[i].value == selectedValue,
                height: height,
                fontSize: fontSize,
                iconSize: iconSize,
                tooltip: options[i].tooltip,
                onTap: onChanged == null
                    ? null
                    : () => onChanged!(options[i].value),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Clean `11px` enterprise micro-header for modal sections.
class JalaSectionLabel extends StatelessWidget {
  final String label;
  final IconData? icon;
  final Color? color;
  final Widget? trailing;

  const JalaSectionLabel({
    super.key,
    required this.label,
    this.icon,
    this.color,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    final effectiveColor = color ?? JalaEnterpriseTokens.sectionHeader;
    return Row(
      children: [
        if (icon != null) ...[
          Icon(icon, size: 14, color: JalaEnterpriseTokens.segmentGold),
          const SizedBox(width: 5),
        ],
        Expanded(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
              color: effectiveColor,
            ),
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: 6),
          trailing!,
        ],
      ],
    );
  }
}

/// Consistent enterprise input decoration used across modals and forms.
InputDecoration jalaEnterpriseInputDecoration({
  required String label,
  String? hint,
  IconData? icon,
  Widget? suffixIcon,
  Color? iconColor,
  Color? labelColor,
  EdgeInsetsGeometry contentPadding =
      const EdgeInsets.symmetric(horizontal: 12, vertical: 10.5),
}) {
  return InputDecoration(
    labelText: label,
    hintText: hint,
    hintStyle: const TextStyle(
      fontSize: 11.5,
      color: JalaEnterpriseTokens.textMuted,
    ),
    labelStyle: TextStyle(
      fontSize: 11.5,
      color: labelColor ?? JalaEnterpriseTokens.textSecondary,
    ),
    prefixIcon: icon != null
        ? Icon(
            icon,
            size: 17,
            color: iconColor ?? JalaEnterpriseTokens.segmentGold,
          )
        : null,
    suffixIcon: suffixIcon,
    isDense: true,
    filled: true,
    fillColor: JalaEnterpriseTokens.fieldFill,
    contentPadding: contentPadding,
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: const BorderSide(color: JalaEnterpriseTokens.fieldBorder),
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: const BorderSide(color: JalaEnterpriseTokens.fieldBorder),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: const BorderSide(
        color: JalaEnterpriseTokens.segmentGold,
        width: 1.25,
      ),
    ),
  );
}

/// Structured action row for [JalaStudioDialog]'s separated footer tray.
/// Supports an optional left-aligned [leading] widget (e.g. `Test` or `Delete`)
/// and right-aligned `Cancel` + high-contrast primary `FilledButton`.
class JalaDialogFooterBar extends StatelessWidget {
  final Widget? leading;
  final List<Widget> extraActions;
  final String? cancelLabel;
  final VoidCallback? onCancel;
  final String? primaryLabel;
  final VoidCallback? onPrimary;
  final IconData? primaryIcon;
  final Key? primaryKey;
  final bool isDestructive;
  final bool primaryBusy;

  const JalaDialogFooterBar({
    super.key,
    this.leading,
    this.extraActions = const <Widget>[],
    this.cancelLabel = 'Cancel',
    this.onCancel,
    this.primaryLabel,
    this.onPrimary,
    this.primaryIcon,
    this.primaryKey,
    this.isDestructive = false,
    this.primaryBusy = false,
  });

  @override
  Widget build(BuildContext context) {
    final Color primaryBg = isDestructive
        ? JalaEnterpriseTokens.dangerButtonBg
        : JalaEnterpriseTokens.primaryButtonBg;

    final Widget? cancelBtn = cancelLabel == null
        ? null
        : OutlinedButton(
            style: OutlinedButton.styleFrom(
              foregroundColor: JalaEnterpriseTokens.textSecondary,
              backgroundColor: const Color(0xFF121B27),
              side: const BorderSide(color: JalaEnterpriseTokens.fieldBorder),
              minimumSize: const Size(0, 38),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(9),
              ),
            ),
            onPressed: onCancel ?? () => Navigator.of(context).pop(),
            child: Text(
              cancelLabel!,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          );

    Widget? primaryBtn;
    if (primaryLabel != null) {
      final ButtonStyle pStyle = FilledButton.styleFrom(
        backgroundColor: primaryBg,
        foregroundColor: Colors.white,
        disabledBackgroundColor: primaryBg.withValues(alpha: 0.45),
        disabledForegroundColor: Colors.white70,
        minimumSize: const Size(0, 38),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 8),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(9),
        ),
      );
      final Widget labelText = Text(
        primaryLabel!,
        style: const TextStyle(
          fontSize: 12.5,
          fontWeight: FontWeight.w700,
        ),
      );
      if (primaryBusy) {
        primaryBtn = FilledButton.icon(
          key: primaryKey,
          style: pStyle,
          onPressed: null,
          icon: const SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: Colors.white,
            ),
          ),
          label: labelText,
        );
      } else if (primaryIcon != null) {
        primaryBtn = FilledButton.icon(
          key: primaryKey,
          style: pStyle,
          onPressed: onPrimary,
          icon: Icon(primaryIcon, size: 16),
          label: labelText,
        );
      } else {
        primaryBtn = FilledButton(
          key: primaryKey,
          style: pStyle,
          onPressed: onPrimary,
          child: labelText,
        );
      }
    }

    final rightClusterItems = <Widget>[
      ...extraActions,
      if (cancelBtn != null) cancelBtn,
      if (primaryBtn != null) primaryBtn,
    ];

    final Widget rightCluster = FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerRight,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (int i = 0; i < rightClusterItems.length; i++) ...[
            if (i > 0) const SizedBox(width: 8),
            rightClusterItems[i],
          ],
        ],
      ),
    );

    if (leading == null) {
      return Align(
        alignment: Alignment.centerRight,
        child: rightCluster,
      );
    }

    return Row(
      children: [
        Flexible(
          fit: FlexFit.loose,
          child: Align(
            alignment: Alignment.centerLeft,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: leading!,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Align(
            alignment: Alignment.centerRight,
            child: rightCluster,
          ),
        ),
      ],
    );
  }
}

/// World-Class Modal Dialog Shell returning an [AlertDialog] with:
/// - Pinned obsidian header (`#0D141F` + bottom border)
/// - Constrained scrollable body (`#141D29`)
/// - Distinct separated footer tray (`#0A1018` + `1px` `#26364A` top border)
class JalaStudioDialog extends StatelessWidget {
  final Key? dialogKey;
  final Key? footerKey;
  final String title;
  final String? subtitle;
  final IconData? icon;
  final Color? iconColor;
  final Widget? leading;
  final Widget? headerTrailing;
  final bool showCloseButton;
  final VoidCallback? onClose;
  final double width;
  final EdgeInsetsGeometry bodyPadding;
  final Color? borderColor;
  final Widget body;
  final Widget footer;

  const JalaStudioDialog({
    super.key,
    this.dialogKey,
    this.footerKey,
    required this.title,
    this.subtitle,
    this.icon,
    this.iconColor,
    this.leading,
    this.headerTrailing,
    this.showCloseButton = true,
    this.onClose,
    this.width = 430.0,
    this.bodyPadding = const EdgeInsets.fromLTRB(16, 14, 16, 16),
    this.borderColor,
    required this.body,
    required this.footer,
  });

  @override
  Widget build(BuildContext context) {
    final Size mq = MediaQuery.sizeOf(context);
    final EdgeInsets viewInsets = MediaQuery.viewInsetsOf(context);
    final EdgeInsets viewPadding = MediaQuery.paddingOf(context);
    final double effectiveWidth = math.min(width, math.max(240.0, mq.width - 32.0));
    final double maxBodyH =
        (mq.height - viewInsets.bottom - viewPadding.vertical - 178.0)
            .clamp(72.0, 560.0);
    final Color effectiveIconColor =
        iconColor ?? JalaEnterpriseTokens.segmentGold;

    final Widget leadingBadge = leading ??
        Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(
            color: JalaEnterpriseTokens.headerBadgeBg,
            borderRadius: BorderRadius.circular(9),
            border: Border.all(
              color: effectiveIconColor.withValues(alpha: 0.38),
              width: 1.0,
            ),
          ),
          child: Icon(
            icon ?? Icons.dns_rounded,
            size: 17,
            color: effectiveIconColor,
          ),
        );

    return AlertDialog(
      key: dialogKey,
      titlePadding: EdgeInsets.zero,
      contentPadding: EdgeInsets.zero,
      actionsPadding: EdgeInsets.zero,
      buttonPadding: EdgeInsets.zero,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
      clipBehavior: Clip.antiAlias,
      backgroundColor: JalaEnterpriseTokens.dialogSurface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(
          color: borderColor ?? JalaEnterpriseTokens.dialogBorder,
          width: 1.0,
        ),
      ),
      title: Container(
        decoration: const BoxDecoration(
          color: JalaEnterpriseTokens.headerBg,
          border: Border(
            bottom: BorderSide(
              color: JalaEnterpriseTokens.headerBorder,
              width: 1.0,
            ),
          ),
        ),
        padding: const EdgeInsets.fromLTRB(16, 13, 10, 12),
        child: Row(
          children: [
            leadingBadge,
            const SizedBox(width: 11),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.2,
                      color: borderColor != null &&
                              borderColor == const Color(0xFFFFAAA1)
                          ? borderColor
                          : JalaEnterpriseTokens.textPrimary,
                    ),
                  ),
                  if (subtitle != null && subtitle!.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        color: JalaEnterpriseTokens.textMuted,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (headerTrailing != null) headerTrailing!,
            if (showCloseButton)
              IconButton(
                visualDensity: VisualDensity.compact,
                constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                padding: EdgeInsets.zero,
                tooltip: 'Close',
                onPressed: onClose ?? () => Navigator.of(context).pop(),
                icon: const Icon(
                  Icons.close_rounded,
                  size: 18,
                  color: JalaEnterpriseTokens.textMuted,
                ),
              ),
          ],
        ),
      ),
      content: SizedBox(
        width: effectiveWidth,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: maxBodyH),
              child: SingleChildScrollView(
                padding: bodyPadding,
                child: body,
              ),
            ),
            Container(
              key: footerKey ?? const Key('jala_dialog_footer_tray'),
              decoration: const BoxDecoration(
                color: JalaEnterpriseTokens.footerBg,
                border: Border(
                  top: BorderSide(
                    color: JalaEnterpriseTokens.footerBorder,
                    width: 1.0,
                  ),
                ),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
              child: footer,
            ),
          ],
        ),
      ),
    );
  }
}

/// Precision Enterprise Studio Panel (`#141D29` surface, `14px` radius, `1px` `#263649` border,
/// optional `#0D141F` header bar with `1px` `#223144` bottom divider).
class JalaStudioPanel extends StatelessWidget {
  final Key? panelKey;
  final String? title;
  final IconData? icon;
  final Color? iconColor;
  final Widget? headerTrailing;
  final Widget child;
  final EdgeInsetsGeometry bodyPadding;
  final Color? surfaceColor;
  final Color? borderColor;

  const JalaStudioPanel({
    super.key,
    this.panelKey,
    this.title,
    this.icon,
    this.iconColor,
    this.headerTrailing,
    required this.child,
    this.bodyPadding = const EdgeInsets.all(14),
    this.surfaceColor,
    this.borderColor,
  });

  @override
  Widget build(BuildContext context) {
    final Color accent = iconColor ?? JalaEnterpriseTokens.segmentGold;
    return Container(
      key: panelKey,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor ?? JalaEnterpriseTokens.dialogSurface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: borderColor ?? JalaEnterpriseTokens.trackBorder,
          width: 1.0,
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: const BoxDecoration(
                color: JalaEnterpriseTokens.headerBg,
                border: Border(
                  bottom: BorderSide(
                    color: Color(0xFF223144),
                    width: 1.0,
                  ),
                ),
              ),
              child: Row(
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 17, color: accent),
                    const SizedBox(width: 8),
                  ],
                  Expanded(
                    child: Text(
                      title!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.1,
                        color: JalaEnterpriseTokens.textPrimary,
                      ),
                    ),
                  ),
                  if (headerTrailing != null) ...[
                    const SizedBox(width: 8),
                    headerTrailing!,
                  ],
                ],
              ),
            ),
          Padding(
            padding: bodyPadding,
            child: child,
          ),
        ],
      ),
    );
  }
}

/// Cohesive `30×30` or labeled toolbar button (`#141E2C` fill, `1px` `#263649` border).
class JalaToolbarIconBtn extends StatelessWidget {
  final Key? btnKey;
  final IconData icon;
  final String? label;
  final String? tooltip;
  final bool active;
  final Color? iconColor;
  final Color? activeBorderColor;
  final Color? activeBgColor;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final double height;

  const JalaToolbarIconBtn({
    super.key,
    this.btnKey,
    required this.icon,
    this.label,
    this.tooltip,
    this.active = false,
    this.iconColor,
    this.activeBorderColor,
    this.activeBgColor,
    this.onTap,
    this.onLongPress,
    this.height = 28.0,
  });

  @override
  Widget build(BuildContext context) {
    final Color effectiveIcon = iconColor ??
        (active
            ? JalaEnterpriseTokens.segmentGold
            : JalaEnterpriseTokens.textSecondary);
    final Color bg = active
        ? (activeBgColor ?? JalaEnterpriseTokens.segmentSelectedBg)
        : const Color(0xFF141E2C);
    final Color border = active
        ? (activeBorderColor ??
            JalaEnterpriseTokens.segmentGold.withValues(alpha: 0.72))
        : JalaEnterpriseTokens.trackBorder;

    final Widget button = Material(
      color: Colors.transparent,
      child: InkWell(
        key: btnKey,
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        onLongPress: onLongPress,
        child: Container(
          height: height,
          constraints: BoxConstraints(minWidth: label == null ? height : 0),
          padding: EdgeInsets.symmetric(horizontal: label == null ? 0 : 8),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: border, width: 1.0),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14.5, color: effectiveIcon),
              if (label != null) ...[
                const SizedBox(width: 4.5),
                Text(
                  label!,
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                    color: active
                        ? JalaEnterpriseTokens.textPrimary
                        : JalaEnterpriseTokens.textSecondary,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );

    if (tooltip != null && tooltip!.isNotEmpty) {
      return Tooltip(message: tooltip!, child: button);
    }
    return button;
  }
}

/// Tactile enterprise action row used inside bottom sheets and grouped menus.
class JalaActionRow extends StatelessWidget {
  final Key? rowKey;
  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final Color? titleColor;
  final Color? highlightBg;
  final Widget? trailing;
  final VoidCallback onTap;

  const JalaActionRow({
    super.key,
    this.rowKey,
    required this.icon,
    required this.iconColor,
    required this.title,
    this.subtitle,
    this.titleColor,
    this.highlightBg,
    this.trailing,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: highlightBg ?? Colors.transparent,
      child: InkWell(
        key: rowKey,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10.5),
          child: Row(
            children: [
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  color: iconColor.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: iconColor.withValues(alpha: 0.32),
                    width: 1.0,
                  ),
                ),
                child: Icon(icon, size: 16, color: iconColor),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: highlightBg != null
                            ? FontWeight.w700
                            : FontWeight.w600,
                        color: titleColor ?? JalaEnterpriseTokens.textPrimary,
                      ),
                    ),
                    if (subtitle != null && subtitle!.isNotEmpty) ...[
                      const SizedBox(height: 1.5),
                      Text(
                        subtitle!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 11,
                          color: JalaEnterpriseTokens.textMuted,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              trailing ??
                  Icon(
                    Icons.chevron_right_rounded,
                    size: 17,
                    color: JalaEnterpriseTokens.textMuted.withValues(alpha: 0.7),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}
