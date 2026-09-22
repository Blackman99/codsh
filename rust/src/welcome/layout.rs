// Modified for codsh: extracted offline welcome layout; removed remote announcement inputs.
// Copyright 2023-2026 xAI. Apache-2.0; see ../../upstream/LICENSE.

use super::hero_box::HERO_BOX_MIN_WIDTH;
use super::{hero_box, logo::LogoTier};
use ratatui::layout::{Constraint, Layout, Rect};
const PROMPT_HEIGHT: u16 = 3;
/// The stacked column's rows around the logo, for one prompt height.
struct StackedColumn {
    content_height: u16,
    gap_after_logo: u16,
    pub(super) error_height: u16,
    pub(super) menu_height: u16,
    fixed_below: u16,
}

impl StackedColumn {
    fn new(input: &WelcomeLayoutInput, prompt_height: u16) -> Self {
        Self {
            content_height: input.content_area.height,
            gap_after_logo: if input.error_height > 0 { 1 } else { 0 },
            error_height: input.error_height,
            menu_height: input.menu_height,
            fixed_below: WelcomeLayout::fixed_below(input.tip_height, prompt_height),
        }
    }

    /// Logo rows, the gap after them, and the error block.
    fn fixed_above(&self, tier: LogoTier) -> u16 {
        tier.rows() + 1 + self.gap_after_logo + self.error_height
    }

    /// Whether the column fits with this tier beside `reserved` info rows (slot + gap) and a one-row flex gap.
    fn fits(&self, tier: LogoTier, reserved: u16) -> bool {
        self.fixed_above(tier) + self.menu_height + reserved + 1 + self.fixed_below
            <= self.content_height
    }

    /// The tier the terminal height allows, stepped down only while the column would overflow beside the draft and the reserved rows.
    fn logo_tier(&self, reserved: u16) -> LogoTier {
        let mut tier = LogoTier::for_height(self.content_height);
        while !self.fits(tier, reserved) {
            match tier.step_down() {
                Some(smaller) => tier = smaller,
                None => break,
            }
        }
        tier
    }
}
/// Gap between prompt and version line.
const VERSION_GAP: u16 = 1;

/// Computed areas for the welcome screen vertical layout.
pub(super) struct WelcomeLayout {
    pub(super) logo: Rect,
    pub(super) menu: Rect,
    pub(super) tip: Rect,
    pub(super) prompt: Rect,
    pub(super) version: Rect,
    // Hero box sub-rects (all zero when hero box is inactive).
    pub(super) hero_box: Rect,
    pub(super) hero_logo: Rect,
    pub(super) hero_version: Rect,
    pub(super) hero_subtitle: Rect,
    pub(super) hero_menu: Rect,
    /// The art the stacked `logo` rows were reserved for; paint it with [`render_logo_tier`].
    pub(super) logo_tier: LogoTier,
}

/// Inputs to [`WelcomeLayout::compute`].
#[derive(Default)]
pub(super) struct WelcomeLayoutInput {
    pub(super) content_area: Rect,
    /// Error/warning row height; 0 when there's nothing to show.
    pub(super) error_height: u16,
    pub(super) menu_height: u16,
    pub(super) tip_height: u16,
    /// Desired changelog height (collapsed to 0 if the terminal is too short).
    pub(super) changelog_height: u16,
    /// Vertical compaction (session picker visible): skip the logo and the info slot.
    pub(super) compact: bool,
    /// Rows reserved for the prompt box.
    /// `None` keeps the default; the blocking screens that paint no prompt pass 0 to give the rows back to their message.
    pub(super) prompt_height: Option<u16>,
}

impl WelcomeLayout {
    /// Whether the hero box (side-by-side logo and menu inside a border) is active.
    pub(super) fn has_hero_box(&self) -> bool {
        self.hero_box.width > 0 && self.hero_box.height > 0
    }

    pub(super) fn fixed_below(tip_height: u16, prompt_height: u16) -> u16 {
        let tip_gap = if tip_height > 0 { 1u16 } else { 0 };
        tip_height + tip_gap + prompt_height + VERSION_GAP + 1
    }

    pub(super) fn effective_changelog(
        content_height: u16,
        fixed_above: u16,
        content_slot: u16,
        fixed_below: u16,
        requested: u16,
    ) -> (u16, u16) {
        let gap = if requested > 0 { 1u16 } else { 0 };
        let min_without = fixed_above + content_slot + 1 + fixed_below;
        if requested > 0 && content_height >= min_without + gap + requested {
            (requested, 1)
        } else {
            (0, 0)
        }
    }

    /// Compute the welcome screen layout, allowing the wide hero-box variant.
    pub(super) fn compute(input: WelcomeLayoutInput) -> Self {
        Self::compute_inner(input, true)
    }

    /// Width depends only on content size, so the two phases cannot disagree. `allow_hero_box` gates
    /// the wide variant; stacked-only callers pass `false`.
    fn compute_inner(input: WelcomeLayoutInput, allow_hero_box: bool) -> Self {
        if allow_hero_box
            && !input.compact
            && input.content_area.width >= HERO_BOX_MIN_WIDTH
            && input.menu_height > 0
            && let Some(layout) = hero_box::compute_hero_box(&input)
        {
            return layout;
        }

        let WelcomeLayoutInput {
            content_area,
            error_height,
            menu_height,
            tip_height,
            changelog_height,
            compact,
            prompt_height,
            ..
        } = input;
        let zero = Rect::default();
        let prompt_height = prompt_height.unwrap_or(PROMPT_HEIGHT);
        // Centering and the info budget see the one-line box, so a growing draft does not shift the column or reflow the slot
        // The consent screen passes 0 rows and must not be charged for a box it never paints
        let one_line_prompt = prompt_height.min(PROMPT_HEIGHT);

        let gap_after_logo = if error_height > 0 { 1 } else { 0 };
        let tip_gap = if tip_height > 0 { 1u16 } else { 0 };
        let fixed_below = Self::fixed_below(tip_height, prompt_height);
        let column = StackedColumn::new(&input, prompt_height);

        let info_height = changelog_height;
        let reserved = 0;
        // Stacked layout: skip the logo in compact mode (the session picker needs the space); otherwise the height picks the tier and only an overflowing column steps it down
        let logo_tier = if compact {
            LogoTier::Hidden
        } else {
            column.logo_tier(reserved)
        };
        let fixed_above = column.fixed_above(logo_tier);

        // The stacked info slot below the menu holds whichever block is shown (announcement or changelog), matching the hero box's single-slot rule
        let (eff_changelog_height, _) = if !compact {
            Self::effective_changelog(
                content_area.height,
                fixed_above,
                menu_height,
                fixed_below,
                info_height,
            )
        } else {
            (0, 0)
        };
        let eff_changelog_gap = if eff_changelog_height > 0 { 1u16 } else { 0 };
        let logo_gap = 1u16;
        let flex_gap = 1u16;
        // Compute top_pad using the *default* menu height (4 items, 7 rows) and the one-line prompt so the logo position stays constant regardless of picker/focus state or draft length
        let top_pad = if compact {
            0
        } else {
            let default_menu_height = 4u16;
            let remaining = content_area.height.saturating_sub(fixed_above);
            let centered = remaining
                .saturating_sub(default_menu_height)
                .saturating_sub(eff_changelog_gap + eff_changelog_height)
                .saturating_sub(Self::fixed_below(tip_height, one_line_prompt))
                / 3;
            // A growing draft consumes the flex gap before the padding
            centered.min(content_area.height.saturating_sub(
                fixed_above
                    + menu_height
                    + eff_changelog_gap
                    + eff_changelog_height
                    + flex_gap
                    + fixed_below,
            ))
        };
        // The notice takes only the rows above the prompt. A wrapped status must
        // not push the draft box below the terminal.
        let reserved = prompt_height.saturating_add(VERSION_GAP).saturating_add(1);
        let notice_room = content_area.height.saturating_sub(reserved);
        let [body, prompt, _, version] = Layout::vertical([
            Constraint::Length(notice_room),
            Constraint::Length(prompt_height),
            Constraint::Length(VERSION_GAP),
            Constraint::Length(1),
        ])
        .areas(content_area);
        let [_, logo, _, _, _, menu, _, _, _, tip, _] = Layout::vertical([
            Constraint::Length(top_pad.min(notice_room)),
            Constraint::Length(logo_tier.rows()),
            Constraint::Length(logo_gap), // gap after logo
            Constraint::Length(gap_after_logo),
            Constraint::Length(error_height),
            Constraint::Length(menu_height),
            Constraint::Length(eff_changelog_gap),
            Constraint::Length(eff_changelog_height),
            Constraint::Min(0),
            Constraint::Length(tip_height.min(notice_room)),
            Constraint::Length(tip_gap),
        ])
        .areas(body);
        Self {
            logo,
            menu,
            tip,
            prompt,
            version,
            hero_box: zero,
            hero_logo: zero,
            hero_version: zero,
            hero_subtitle: zero,
            hero_menu: zero,
            logo_tier,
        }
    }
}
