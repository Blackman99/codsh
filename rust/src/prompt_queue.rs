//! Follow-ups typed while a turn runs. The composer owns the rows; this module
//! holds the row type and the pure rules for combining and releasing them.
//!
//! Release rules (reference: user-guide 03 "During an active turn"):
//! - Rows leave in order when the agent is idle. A local command runs and the
//!   drain continues; the drain stops once a row starts a model turn.
//! - A row under edit holds the drain at that row. So does a row that was
//!   handed to dsh as a steer and has not been claimed or returned yet.
//! - `ui.combine_queued_prompts` merges consecutive plain prompts into one
//!   turn. Commands, `!` lines, rows under edit, steering rows, followers with
//!   images, and rows with file chips never merge.

use crate::prompt_edit::SubmittedPrompt;

/// Separator between merged follow-ups (reference `TEXT_SEPARATOR`).
pub const TEXT_SEPARATOR: &str = "\n\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueKind {
    /// Plain prompt text.
    Prompt,
    /// A slash line: a local command or a turn-producing command.
    Command,
    /// A `!` shell line. It goes to dsh like any prompt but never merges.
    Bash,
}

pub fn classify(text: &str) -> QueueKind {
    let trimmed = text.trim_start();
    if trimmed.starts_with('/') {
        QueueKind::Command
    } else if trimmed.starts_with('!') {
        QueueKind::Bash
    } else {
        QueueKind::Prompt
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedItem {
    pub id: u64,
    pub kind: QueueKind,
    pub prompt: SubmittedPrompt,
    /// Handed to dsh as a steer; waiting for claimed / returned.
    pub steering: bool,
    /// Sent with the send-now chord: runs alone as the next turn.
    pub solo: bool,
}

impl QueuedItem {
    pub fn wire_id(&self) -> String {
        format!("q{}", self.id)
    }

    /// One-line label for the queue panel and `/queue`.
    pub fn label(&self, max: usize) -> String {
        let flat = self.prompt.text.replace('\n', " ⏎ ");
        let mut out: String = flat.chars().take(max).collect();
        if flat.chars().count() > max {
            out.push('…');
        }
        out
    }

    /// Only text-only plain prompts can be steered. Images and file chips
    /// need send-time admission, so those rows wait for the turn to end.
    pub fn steer_eligible(&self) -> bool {
        self.kind == QueueKind::Prompt
            && !self.steering
            && self.prompt.images.is_empty()
            && self.prompt.mentions.is_empty()
            && !self.prompt.text.trim().is_empty()
            && self
                .prompt
                .blocks
                .iter()
                .all(|block| block.get("type").and_then(|kind| kind.as_str()) == Some("text"))
    }

    fn can_merge_front(&self) -> bool {
        self.kind == QueueKind::Prompt
            && !self.steering
            && !self.solo
            && self.prompt.mentions.is_empty()
            && !self.prompt.text.trim().is_empty()
    }

    fn can_merge_follower(&self, held: Option<u64>) -> bool {
        self.can_merge_front() && self.prompt.images.is_empty() && held != Some(self.id)
    }
}

/// Rows the front of the queue would take as one turn (1 = front alone).
pub fn combine_prefix_len(items: &[QueuedItem], held: Option<u64>) -> usize {
    let Some(front) = items.first() else {
        return 0;
    };
    if !front.can_merge_front() || held == Some(front.id) {
        return 1;
    }
    1 + items[1..]
        .iter()
        .take_while(|item| item.can_merge_follower(held))
        .count()
}

/// Join a combine run into one prompt. The front keeps its id and images;
/// the text becomes the joined body, so the blocks are rebuilt from it.
pub fn merge(mut run: Vec<QueuedItem>) -> QueuedItem {
    if run.len() <= 1 {
        return run.pop().expect("merge needs one row");
    }
    let text = run
        .iter()
        .map(|item| item.prompt.text.as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(TEXT_SEPARATOR);
    let mut front = run.remove(0);
    front.prompt.blocks = vec![serde_json::json!({ "type": "text", "text": text })];
    front.prompt.text = text;
    front
}

/// What the front of the queue allows right now.
#[derive(Debug, PartialEq, Eq)]
pub enum Release {
    Empty,
    /// The front row is under edit.
    HeldForEdit,
    /// The front row was handed to dsh and has not come back.
    Steering,
    Item(QueuedItem),
}

/// Take the next release from the front, merging when `combine` is on.
pub fn next_release(queue: &mut Vec<QueuedItem>, held: Option<u64>, combine: bool) -> Release {
    let Some(front) = queue.first() else {
        return Release::Empty;
    };
    if held == Some(front.id) {
        return Release::HeldForEdit;
    }
    if front.steering {
        return Release::Steering;
    }
    let take = if combine {
        combine_prefix_len(queue, held)
    } else {
        1
    };
    let run: Vec<QueuedItem> = queue.drain(..take.max(1)).collect();
    Release::Item(merge(run))
}

/// Result of running one released row.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// A model turn started. The drain stops here.
    Started,
    /// A local command ran. The drain continues with the next row.
    Local,
    /// The row could not run and was put back (or into the composer).
    Hold,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DrainStop {
    Empty,
    Started,
    HeldForEdit,
    Steering,
    Hold,
}

/// Release rows until one starts a turn, the queue empties, or the front is
/// held. There is no iteration cap: any number of local commands in a row
/// run before the next model turn. `take` and `run` are separate so the
/// caller can lend the composer that owns the queue to `run`.
pub fn drain<C>(
    ctx: &mut C,
    mut take: impl FnMut(&mut C) -> Release,
    mut run: impl FnMut(&mut C, QueuedItem) -> Step,
) -> DrainStop {
    loop {
        let item = match take(ctx) {
            Release::Empty => return DrainStop::Empty,
            Release::HeldForEdit => return DrainStop::HeldForEdit,
            Release::Steering => return DrainStop::Steering,
            Release::Item(item) => item,
        };
        match run(ctx, item) {
            Step::Started => return DrainStop::Started,
            Step::Local => continue,
            Step::Hold => return DrainStop::Hold,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: u64, text: &str) -> QueuedItem {
        QueuedItem {
            id,
            kind: classify(text),
            prompt: SubmittedPrompt {
                text: text.into(),
                blocks: vec![serde_json::json!({ "type": "text", "text": text })],
                mentions: Vec::new(),
                images: Vec::new(),
            },
            steering: false,
            solo: false,
        }
    }

    #[test]
    fn classifies_commands_and_bash() {
        assert_eq!(classify("/theme dark"), QueueKind::Command);
        assert_eq!(classify("  /my-skill go"), QueueKind::Command);
        assert_eq!(classify("!ls"), QueueKind::Bash);
        assert_eq!(classify("fix the bug"), QueueKind::Prompt);
    }

    /// Nine local commands then a prompt: every command runs, then the prompt
    /// starts the turn and the drain stops before the row after it.
    #[test]
    fn drain_runs_nine_local_commands_then_stops_at_the_first_turn() {
        let mut queue: Vec<QueuedItem> =
            (1..=9).map(|id| row(id, &format!("/local{id}"))).collect();
        queue.push(row(10, "model prompt"));
        queue.push(row(11, "after"));
        let mut ran = Vec::new();
        let stop = drain(
            &mut queue,
            |queue| next_release(queue, None, false),
            |_, item| {
                ran.push(item.prompt.text.clone());
                if item.kind == QueueKind::Command {
                    Step::Local
                } else {
                    Step::Started
                }
            },
        );
        assert_eq!(stop, DrainStop::Started);
        assert_eq!(ran.len(), 10, "{ran:?}");
        assert_eq!(ran[8], "/local9");
        assert_eq!(ran[9], "model prompt");
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].prompt.text, "after");
    }

    #[test]
    fn drain_of_only_local_commands_empties_the_queue() {
        let mut queue: Vec<QueuedItem> = (1..=25).map(|id| row(id, &format!("/l{id}"))).collect();
        let mut count = 0;
        let stop = drain(
            &mut queue,
            |queue| next_release(queue, None, false),
            |_, _| {
                count += 1;
                Step::Local
            },
        );
        assert_eq!(stop, DrainStop::Empty);
        assert_eq!(count, 25);
    }

    #[test]
    fn drain_stops_at_a_row_under_edit_and_at_a_steering_row() {
        let mut queue = vec![row(1, "/l"), row(2, "held"), row(3, "later")];
        let mut ran = 0;
        let stop = drain(
            &mut queue,
            |queue| next_release(queue, Some(2), false),
            |_, _| {
                ran += 1;
                Step::Local
            },
        );
        assert_eq!(stop, DrainStop::HeldForEdit);
        assert_eq!(ran, 1);
        assert_eq!(queue.len(), 2, "held row and the one after it stay");
        queue[0].steering = true;
        let stop = drain(
            &mut queue,
            |queue| next_release(queue, None, false),
            |_, _| Step::Started,
        );
        assert_eq!(stop, DrainStop::Steering);
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn combine_merges_only_consecutive_plain_prompts() {
        let queue = vec![row(1, "a"), row(2, "b"), row(3, "!ls"), row(4, "c")];
        assert_eq!(combine_prefix_len(&queue, None), 2);
        let queue = vec![row(1, "a"), row(2, "b"), row(3, "/skill"), row(4, "c")];
        assert_eq!(combine_prefix_len(&queue, None), 2);
        let queue = vec![row(1, "/x"), row(2, "b")];
        assert_eq!(combine_prefix_len(&queue, None), 1);
        let queue = vec![row(1, "a"), row(2, "b"), row(3, "c")];
        assert_eq!(
            combine_prefix_len(&queue, Some(2)),
            1,
            "row under edit stops it"
        );
        let mut queue = vec![row(1, "a"), row(2, "b")];
        queue[1].prompt.images.push(crate::images::PreparedImage {
            id: 1,
            media_type: "image/png".into(),
            bytes: vec![1, 2, 3],
            width: Some(1),
            height: Some(1),
            digest: "d".into(),
            saved_path: None,
            modified: None,
        });
        assert_eq!(
            combine_prefix_len(&queue, None),
            1,
            "follower image stops it"
        );
        let mut queue = vec![row(1, "a"), row(2, "b")];
        queue[0].solo = true;
        assert_eq!(
            combine_prefix_len(&queue, None),
            1,
            "send-now row runs alone"
        );
    }

    #[test]
    fn combined_release_joins_with_the_reference_separator() {
        let mut queue = vec![row(1, "first"), row(2, "second"), row(3, "/cmd")];
        let Release::Item(item) = next_release(&mut queue, None, true) else {
            panic!("expected a release");
        };
        assert_eq!(item.id, 1);
        assert_eq!(item.prompt.text, "first\n\nsecond");
        assert_eq!(item.prompt.blocks[0]["text"], "first\n\nsecond");
        assert_eq!(queue.len(), 1);
        let Release::Item(item) = next_release(&mut queue, None, true) else {
            panic!("expected a release");
        };
        assert_eq!(item.prompt.text, "/cmd");
        assert_eq!(next_release(&mut queue, None, true), Release::Empty);
    }

    #[test]
    fn steer_eligibility_is_text_only_plain_prompts() {
        assert!(row(1, "go left").steer_eligible());
        assert!(!row(1, "/cmd").steer_eligible());
        assert!(!row(1, "!ls").steer_eligible());
        let mut chip = row(1, "see @a.rs");
        chip.prompt.mentions.push("a.rs".into());
        assert!(!chip.steer_eligible());
        let mut busy = row(1, "x");
        busy.steering = true;
        assert!(!busy.steer_eligible());
    }
}
