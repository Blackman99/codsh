//! `/feedback` form. Write saves or sends one draft; Drafts edits, retries, and deletes.

use crate::privacy::{DraftStore, FeedbackDraft, FeedbackType, PrivacyError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedbackTab {
    Write,
    Drafts,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Field {
    Title,
    Details,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedbackForm {
    pub tab: FeedbackTab,
    pub title: String,
    pub details: String,
    field: Field,
    pub cursor: usize,
    pub editing: Option<String>,
    pub notice: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeedbackAction {
    None,
    Close,
    Saved(String),
    Sent(String),
    Failed(String),
}

impl FeedbackForm {
    pub fn open() -> Self {
        Self {
            tab: FeedbackTab::Write,
            title: String::new(),
            details: String::new(),
            field: Field::Title,
            cursor: 0,
            editing: None,
            notice: String::new(),
        }
    }

    pub fn render(&self, drafts: &[FeedbackDraft]) -> String {
        let mut lines = vec![
            "Feedback  Write | Drafts  [ ] switches".into(),
            match self.tab {
                FeedbackTab::Write => {
                    "tab=Write  Enter sends  Ctrl+S saves local  Esc closes".into()
                }
                FeedbackTab::Drafts => {
                    "tab=Drafts  Enter retries submit  e edits  x deletes  Esc closes".into()
                }
            },
        ];
        match self.tab {
            FeedbackTab::Write => {
                let title_mark = if self.field == Field::Title { ">" } else { " " };
                let details_mark = if self.field == Field::Details {
                    ">"
                } else {
                    " "
                };
                lines.push(format!("{title_mark} title: {}", self.title));
                lines.push(format!("{details_mark} details: {}", self.details));
                lines.push("type=bug  Not sent until Enter.".into());
            }
            FeedbackTab::Drafts => {
                if drafts.is_empty() {
                    lines.push("no local feedback drafts".into());
                }
                for (index, draft) in drafts.iter().enumerate() {
                    let mark = if index == self.cursor { ">" } else { " " };
                    let editing = if self.editing.as_deref() == Some(draft.id.as_str()) {
                        " editing"
                    } else {
                        ""
                    };
                    lines.push(format!(
                        "{mark} {}  rev {}  {}{editing}",
                        draft.id, draft.revision, draft.title
                    ));
                }
                if let Some(id) = &self.editing {
                    lines.push(format!("edit title: {}", self.title));
                    lines.push(format!("edit details: {}", self.details));
                    lines.push(format!("editing {id}  Enter saves locally"));
                }
            }
        }
        if !self.notice.is_empty() {
            lines.push(self.notice.clone());
        }
        lines.join("\n")
    }

    pub fn handle(
        &mut self,
        key: FormKey,
        store: &DraftStore,
        submit: &mut dyn FnMut(&str) -> Result<String, PrivacyError>,
    ) -> FeedbackAction {
        if key == FormKey::Esc {
            return FeedbackAction::Close;
        }
        if key == FormKey::Tab || key == FormKey::Next || key == FormKey::Prev {
            self.tab = match (self.tab, key) {
                (_, FormKey::Next) => FeedbackTab::Drafts,
                (_, FormKey::Prev) => FeedbackTab::Write,
                (FeedbackTab::Write, _) => FeedbackTab::Drafts,
                (FeedbackTab::Drafts, _) => FeedbackTab::Write,
            };
            self.editing = None;
            self.notice.clear();
            return FeedbackAction::None;
        }
        match self.tab {
            FeedbackTab::Write => self.write_key(key, store, submit),
            FeedbackTab::Drafts => self.drafts_key(key, store, submit),
        }
    }

    fn write_key(
        &mut self,
        key: FormKey,
        store: &DraftStore,
        submit: &mut dyn FnMut(&str) -> Result<String, PrivacyError>,
    ) -> FeedbackAction {
        match key {
            FormKey::Up | FormKey::Down => {
                self.field = match self.field {
                    Field::Title => Field::Details,
                    Field::Details => Field::Title,
                };
                FeedbackAction::None
            }
            FormKey::Char(ch) => {
                self.buffer_mut().push(ch);
                FeedbackAction::None
            }
            FormKey::Backspace => {
                self.buffer_mut().pop();
                FeedbackAction::None
            }
            FormKey::Save => self.save_new(store),
            FormKey::Enter => {
                let FeedbackAction::Saved(message) = self.save_new(store) else {
                    return FeedbackAction::Failed(self.notice.clone());
                };
                let Some(id) = message.split_whitespace().nth(3).map(str::to_string) else {
                    return FeedbackAction::Failed("saved draft had no id".into());
                };
                match submit(&id) {
                    Ok(sent) => {
                        self.title.clear();
                        self.details.clear();
                        self.notice = sent.clone();
                        FeedbackAction::Sent(sent)
                    }
                    Err(error) => {
                        self.notice = error.to_string();
                        self.tab = FeedbackTab::Drafts;
                        FeedbackAction::Failed(error.to_string())
                    }
                }
            }
            _ => FeedbackAction::None,
        }
    }

    fn drafts_key(
        &mut self,
        key: FormKey,
        store: &DraftStore,
        submit: &mut dyn FnMut(&str) -> Result<String, PrivacyError>,
    ) -> FeedbackAction {
        let drafts = store.list().unwrap_or_default();
        if self.editing.is_some() {
            return self.edit_key(key, store);
        }
        match key {
            FormKey::Char('[') => {
                self.tab = FeedbackTab::Write;
                FeedbackAction::None
            }
            FormKey::Char(']') => FeedbackAction::None,
            FormKey::Up | FormKey::Char('k') if self.cursor > 0 => {
                self.cursor -= 1;
                FeedbackAction::None
            }
            FormKey::Down | FormKey::Char('j') if self.cursor + 1 < drafts.len() => {
                self.cursor += 1;
                FeedbackAction::None
            }
            FormKey::Char('x') => {
                let Some(draft) = drafts.get(self.cursor) else {
                    self.notice = "no local feedback drafts".into();
                    return FeedbackAction::None;
                };
                let id = draft.id.clone();
                match store.delete(&id) {
                    Ok(true) => {
                        self.notice = format!("deleted local draft {id}");
                        if self.cursor > 0 && self.cursor >= drafts.len().saturating_sub(1) {
                            self.cursor -= 1;
                        }
                        FeedbackAction::Saved(self.notice.clone())
                    }
                    Ok(false) => {
                        self.notice = "feedback draft not found".into();
                        FeedbackAction::Failed(self.notice.clone())
                    }
                    Err(error) => {
                        self.notice = error.to_string();
                        FeedbackAction::Failed(self.notice.clone())
                    }
                }
            }
            FormKey::Char('e') => {
                let Some(draft) = drafts.get(self.cursor) else {
                    self.notice = "no local feedback drafts".into();
                    return FeedbackAction::None;
                };
                self.editing = Some(draft.id.clone());
                self.title = draft.title.clone();
                self.details = draft.details.clone();
                self.field = Field::Title;
                self.notice.clear();
                FeedbackAction::None
            }
            FormKey::Enter => {
                let Some(draft) = drafts.get(self.cursor) else {
                    self.notice = "no local feedback drafts".into();
                    return FeedbackAction::None;
                };
                let id = draft.id.clone();
                match submit(&id) {
                    Ok(sent) => {
                        self.notice = sent.clone();
                        FeedbackAction::Sent(sent)
                    }
                    Err(error) => {
                        self.notice = error.to_string();
                        FeedbackAction::Failed(error.to_string())
                    }
                }
            }
            _ => FeedbackAction::None,
        }
    }

    fn edit_key(&mut self, key: FormKey, store: &DraftStore) -> FeedbackAction {
        match key {
            FormKey::Up | FormKey::Down => {
                self.field = match self.field {
                    Field::Title => Field::Details,
                    Field::Details => Field::Title,
                };
                FeedbackAction::None
            }
            FormKey::Char(ch) => {
                self.buffer_mut().push(ch);
                FeedbackAction::None
            }
            FormKey::Backspace => {
                self.buffer_mut().pop();
                FeedbackAction::None
            }
            FormKey::Enter | FormKey::Save => {
                let Some(id) = self.editing.clone() else {
                    return FeedbackAction::None;
                };
                let existing = store.get(&id).ok().flatten();
                let kind = existing
                    .as_ref()
                    .map(|draft| draft.r#type.clone())
                    .unwrap_or(FeedbackType::Bug);
                let area = existing.as_ref().and_then(|draft| draft.area.clone());
                let task_category = existing
                    .as_ref()
                    .and_then(|draft| draft.task_category.clone());
                let failure_mode = existing
                    .as_ref()
                    .and_then(|draft| draft.failure_mode.clone());
                match store.update(
                    &id,
                    crate::privacy::DraftInput {
                        title: &self.title,
                        details: &self.details,
                        area: area.as_deref(),
                        kind,
                        task_category: task_category.as_deref(),
                        failure_mode: failure_mode.as_deref(),
                    },
                ) {
                    Ok(draft) => {
                        self.editing = None;
                        self.title.clear();
                        self.details.clear();
                        self.notice = format!(
                            "updated local draft {} revision {}. Not sent.",
                            draft.id, draft.revision
                        );
                        FeedbackAction::Saved(self.notice.clone())
                    }
                    Err(error) => {
                        self.notice = error.to_string();
                        FeedbackAction::Failed(error.to_string())
                    }
                }
            }
            _ => FeedbackAction::None,
        }
    }

    fn save_new(&mut self, store: &DraftStore) -> FeedbackAction {
        match store.append(crate::privacy::DraftInput {
            title: &self.title,
            details: &self.details,
            area: None,
            kind: FeedbackType::Bug,
            task_category: None,
            failure_mode: None,
        }) {
            Ok(draft) => {
                self.notice = format!(
                    "saved local draft {} revision {}. Not sent.",
                    draft.id, draft.revision
                );
                FeedbackAction::Saved(self.notice.clone())
            }
            Err(error) => {
                self.notice = error.to_string();
                FeedbackAction::Failed(error.to_string())
            }
        }
    }

    fn buffer_mut(&mut self) -> &mut String {
        match self.field {
            Field::Title => &mut self.title,
            Field::Details => &mut self.details,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormKey {
    Char(char),
    Enter,
    Esc,
    Tab,
    Backspace,
    Up,
    Down,
    Save,
    Next,
    Prev,
}

/// `/feedback <text>` becomes an immediate send. Bare `/feedback` opens the form.
pub fn immediate_message(rest: &str) -> Option<String> {
    let trimmed = rest.trim();
    if trimmed.is_empty() || trimmed.split_whitespace().next().is_some_and(is_verb) {
        return None;
    }
    Some(trimmed.to_string())
}

fn is_verb(word: &str) -> bool {
    matches!(
        word,
        "save"
            | "send"
            | "list"
            | "show"
            | "edit"
            | "delete"
            | "submit"
            | "preview"
            | "--help"
            | "-h"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privacy::PrivacyError;

    #[test]
    fn write_enter_sends_and_escape_closes() {
        let dir = tempfile::tempdir().unwrap();
        let store = DraftStore::new(dir.path());
        let mut form = FeedbackForm::open();
        assert!(form.render(&[]).contains("tab=Write"));
        assert_eq!(
            form.handle(FormKey::Esc, &store, &mut |_| unreachable!()),
            FeedbackAction::Close
        );
        let mut form = FeedbackForm::open();
        for ch in "Fold".chars() {
            form.handle(FormKey::Char(ch), &store, &mut |_| unreachable!());
        }
        form.handle(FormKey::Down, &store, &mut |_| unreachable!());
        for ch in "The fold hid the prompt".chars() {
            form.handle(FormKey::Char(ch), &store, &mut |_| unreachable!());
        }
        let mut saw = String::new();
        let action = form.handle(FormKey::Enter, &store, &mut |id| {
            saw = id.to_string();
            Err(PrivacyError::Http(500))
        });
        assert!(matches!(action, FeedbackAction::Failed(_)));
        assert!(form.notice.contains("HTTP 500"));
        assert_eq!(form.tab, FeedbackTab::Drafts);
        assert!(store.list().unwrap().len() == 1);
        form.cursor = 0;
        let retry = form.handle(FormKey::Enter, &store, &mut |id| {
            assert_eq!(id, saw);
            store.delete(id)?;
            Ok(format!("submitted draft {id}"))
        });
        assert!(matches!(retry, FeedbackAction::Sent(_)));
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn drafts_edit_and_delete_stay_local() {
        let dir = tempfile::tempdir().unwrap();
        let store = DraftStore::new(dir.path());
        let mut form = FeedbackForm::open();
        form.title = "Keep".into();
        form.details = "Local only".into();
        assert!(matches!(
            form.handle(FormKey::Save, &store, &mut |_| unreachable!()),
            FeedbackAction::Saved(_)
        ));
        form.tab = FeedbackTab::Drafts;
        form.handle(FormKey::Char('e'), &store, &mut |_| unreachable!());
        form.handle(FormKey::Char('!'), &store, &mut |_| unreachable!());
        let saved = form.handle(FormKey::Enter, &store, &mut |_| unreachable!());
        assert!(matches!(saved, FeedbackAction::Saved(_)));
        assert!(store.list().unwrap()[0].title.ends_with('!'));
        form.cursor = 0;
        form.handle(FormKey::Char('x'), &store, &mut |_| unreachable!());
        assert!(store.list().unwrap().is_empty());
        assert!(form.notice.contains("deleted"));
    }
}
