---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` gains dsh plan mode, `ask_user_question`, and todos: `/plan [task|off]`, Shift+Tab (normal → plan → always-approve), `enter_plan_mode`, a plan gate that allows only the session `plan.md` in every permission mode, the plan review (approve with comments, request changes, line comments, copy, quit), `/view-plan`, the question card with timeout and dismissal, the todos pane (Ctrl+T), `--no-plan`, `--no-ask-user`, and the hidden `--todo-gate`. Plain prompts and editor sessions get the no-operator answer and an approved plan review.
