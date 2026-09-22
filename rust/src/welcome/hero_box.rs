// Modified for codsh: extracted offline hero layout; removed remote announcements.
// Copyright 2023-2026 xAI. Apache-2.0; see ../../upstream/LICENSE.

use super::layout::{WelcomeLayout, WelcomeLayoutInput};
use ratatui::layout::{Constraint, Flex, Layout, Rect};
/// Minimum terminal width for the side-by-side hero box layout.
pub(super) const HERO_BOX_MIN_WIDTH: u16 = 90;

/// Vertical padding (rows) between the box border and its inner content.
const V_PAD: u16 = 1;

/// Horizontal inset (cols) between the right column's content and the box border; also the collapsed left-column width when the logo is hidden.
const H_INSET: u16 = 2;

/// Horizontal gap (cols) between the logo and the right column inside the box.
const LOGO_H_PAD: u16 = 3;

use super::logo::LogoTier;
const PROMPT_HEIGHT: u16 = 3;
const VERSION_GAP: u16 = 1;

/// Rows the "thanks" subtitle occupies.
/// Hidden when the in-box info slot (changelog or announcement) is shown, to keep the box compact.
fn subtitle_rows(info_height: u16) -> u16 {
    if info_height > 0 { 0 } else { 1 }
}

/// Height of the hero box's right column: version + optional subtitle + optional info block + the gap before the menu + the menu itself.
fn right_col_height(menu_height: u16, info_height: u16) -> u16 {
    let info_gap = if info_height > 0 { 1u16 } else { 0 };
    // version(1) + subtitle + [info_gap + info] + gap-before-menu(1) + menu
    1 + subtitle_rows(info_height) + info_gap + info_height + 1 + menu_height
}

/// Minimum content-area height the hero box needs to render without truncating.
/// That covers the optional error row, the box, a one-row flex gap, and the fixed rows below (tip + prompt + version).
/// The box always shows the full-height logo, so a terminal shorter than this falls back to the stacked layout instead of overflowing.
pub(super) fn min_content_height(
    input: &WelcomeLayoutInput,
    info_height: u16,
    prompt_height: u16,
) -> u16 {
    let inner =
        super::logo::full_logo_line_count().max(right_col_height(input.menu_height, info_height));
    let hero_box_height = 2 + V_PAD * 2 + inner;
    let gap_after_error = if input.error_height > 0 { 1u16 } else { 0 };
    gap_after_error
        + input.error_height
        + hero_box_height
        + 1
        + WelcomeLayout::fixed_below(input.tip_height, prompt_height)
}

/// Width (cols) of the hero box's left (logo) column, including padding.
/// Collapses to a small inset when the logo is hidden.
fn left_col_width() -> u16 {
    let logo_width = super::logo::full_logo_visual_width();
    if logo_width == 0 {
        H_INSET
    } else {
        logo_width + LOGO_H_PAD.saturating_sub(1) + LOGO_H_PAD
    }
}

/// A taller draft never reflows the slot: when the box no longer fits beside it, this returns
/// `None` and the caller falls back to the stacked layout.
pub(super) fn compute_hero_box(input: &WelcomeLayoutInput) -> Option<WelcomeLayout> {
    let content_area = input.content_area;
    let error_height = input.error_height;
    let menu_height = input.menu_height;
    let tip_height = input.tip_height;
    let prompt_height = input.prompt_height.unwrap_or(PROMPT_HEIGHT);
    let one_line_prompt = prompt_height.min(PROMPT_HEIGHT);
    let zero = Rect::default();
    let tip_gap = if tip_height > 0 { 1u16 } else { 0 };
    let fixed_below = WelcomeLayout::fixed_below(tip_height, prompt_height);

    // Column widths are height-independent, so derive them once and reuse for both the measurement and the rects
    // `hero_info.width == info_slot_width`, so the measured width is the drawn width
    let box_width = content_area.width.saturating_sub(6).min(120);
    let inner_width = box_width.saturating_sub(2);
    let left_col_width = left_col_width();
    let right_width = inner_width.saturating_sub(left_col_width);
    let info_slot_width = right_width.saturating_sub(H_INSET);
    let info_height = 0;
    if content_area.height < min_content_height(input, info_height, prompt_height) {
        return None;
    }
    // A notice taller than the rows left beside the hero uses the stacked layout,
    // which scrolls to the latest line and keeps the draft box.
    let reserved = prompt_height.saturating_add(VERSION_GAP).saturating_add(1);
    let beside_hero = content_area.height.saturating_sub(reserved).saturating_sub(
        min_content_height(input, info_height, prompt_height).saturating_sub(reserved),
    );
    if tip_height > beside_hero {
        return None;
    }

    let logo_rows = super::logo::full_logo_line_count();
    let info_gap = if info_height > 0 { 1u16 } else { 0 };
    let inner_height = logo_rows.max(right_col_height(menu_height, info_height));
    let hero_box_height = 2 + V_PAD * 2 + inner_height;

    let gap_after_error = if error_height > 0 { 1 } else { 0 };
    let fixed_above = gap_after_error + error_height;

    // Top padding for vertical centering (use the default menu height and the one-line prompt so the logo position stays constant regardless of picker/focus state or draft length)
    let default_menu_height = 4u16;
    let default_inner = logo_rows.max(right_col_height(default_menu_height, info_height));
    let default_hero = 2 + V_PAD * 2 + default_inner;
    let remaining = content_area.height.saturating_sub(fixed_above);
    let top_pad = remaining
        .saturating_sub(default_hero)
        .saturating_sub(WelcomeLayout::fixed_below(tip_height, one_line_prompt))
        / 3;
    // Centering derives top_pad from the default-menu box, but the fit gate (min_content_height) sizes for the actual box with no pad
    // Clamp to the real slack so a taller menu or draft can't push the rows below the box off the bottom
    let top_pad = top_pad.min(
        content_area
            .height
            .saturating_sub(fixed_above + hero_box_height + 1 + fixed_below),
    );

    // Pin the prompt. A wrapped notice must not push the draft box off screen.
    let reserved = prompt_height.saturating_add(VERSION_GAP).saturating_add(1);
    let notice_room = content_area.height.saturating_sub(reserved);
    let [body, prompt, _, version_slot] = Layout::vertical([
        Constraint::Length(notice_room),
        Constraint::Length(prompt_height),
        Constraint::Length(VERSION_GAP),
        Constraint::Length(1),
    ])
    .areas(content_area);
    let [_, _, _, hero_box_slot, _, tip, _] = Layout::vertical([
        Constraint::Length(top_pad.min(notice_room)),
        Constraint::Length(gap_after_error),
        Constraint::Length(error_height),
        Constraint::Length(hero_box_height),
        Constraint::Min(0),
        Constraint::Length(tip_height.min(notice_room)),
        Constraint::Length(tip_gap),
    ])
    .areas(body);

    // Horizontally center the hero box (`box_width` derived above).
    let [_, hero_box, _] = Layout::horizontal([
        Constraint::Min(0),
        Constraint::Length(box_width),
        Constraint::Min(0),
    ])
    .flex(Flex::Center)
    .areas(hero_box_slot);

    // Inner area inside the border and the vertical pad
    // Widths reuse the values above; only x and y come from the laid-out box
    let inner = Rect {
        x: hero_box.x + 1,
        y: hero_box.y + 1 + V_PAD,
        width: inner_width,
        height: inner_height,
    };

    // Left column: balanced padding around the logo; collapses to a small inset when the logo is hidden
    let logo_width = super::logo::full_logo_visual_width();
    // Logo body leans right; shave a column off the left pad to optically center.
    let logo_left_pad = LOGO_H_PAD.saturating_sub(1);

    // The logo is top-aligned and horizontally centered within the left column
    let hero_logo = Rect {
        x: inner.x + logo_left_pad,
        y: inner.y,
        width: logo_width.min(inner.width.saturating_sub(logo_left_pad)),
        height: logo_rows.min(inner.height),
    };

    // The right column takes the rest of the inner width after the left column
    let right_x = inner.x + left_col_width;

    // Version line at top of right column.
    let hero_version = Rect {
        x: right_x,
        y: inner.y,
        width: right_width,
        height: 1,
    };

    // Subtitle line below the version; hidden when the info slot is shown
    let hero_subtitle = if subtitle_rows(info_height) > 0 {
        Rect {
            x: right_x,
            y: inner.y + 1,
            width: right_width,
            height: 1,
        }
    } else {
        zero
    };

    // version + subtitle + info_gap + info + gap-before-menu
    let right_header_rows = 1 + subtitle_rows(info_height) + info_gap + info_height + 1;

    // The menu sits below the header rows, left-aligned in the right column
    let hero_menu = Rect {
        x: right_x,
        y: inner.y + right_header_rows,
        width: info_slot_width,
        height: menu_height.min(inner.height.saturating_sub(right_header_rows)),
    };

    Some(WelcomeLayout {
        logo: zero,
        menu: zero,
        tip,
        prompt,
        version: version_slot,
        hero_box,
        hero_logo,
        hero_version,
        hero_subtitle,
        hero_menu,
        // The box paints the full logo through `render_hero_box`; the stacked `logo` rect is empty
        logo_tier: LogoTier::Hidden,
    })
}
