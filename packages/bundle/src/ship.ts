/**
 * The `/ship` prompt: a canned workflow that takes a one-sentence requirement
 * from idea to shipped, verified code — a research-grounded interview, a
 * confirmed spec (gate 1), an approved plan (gate 2), then autonomous landing
 * until the spec's acceptance criteria pass.
 */

/** The `/ship` prompt body; `$ARGUMENTS` is the typed one-sentence requirement. */
export const SHIP_PROMPT = `Run the /ship workflow: take the one-sentence requirement below from idea to shipped, verified code in this repository. The requirement, exactly as typed:

<idea>
$ARGUMENTS
</idea>

If the idea between the <idea> tags is empty, that is not an error: before anything else, ask for the one-sentence requirement with ask_user_question, and use the answer as the idea for the rest of this workflow.

Phase 1 — grounded interview. Research before you ask: read the repository layout, the docs, and the code paths the idea touches, so every question is informed by what actually exists. Then interrogate the idea with ask_user_question, one focused question per call, never a batch. Cover, as far as they are genuinely open: who this is for and what success looks like, scope and explicit non-goals, constraints (compatibility, performance, security, dependencies), edge cases and failure behavior, and how the result should be verified. Prefer concrete options grounded in what you found over open-ended prompts. Do not ask what inspection can answer — where code lives or how current behavior works is yours to find out. Stop when answers stop changing the design; do not pad the interview to look thorough.

Phase 2 — the spec (gate 1). Write the agreed design to a spec file inside the repository. Follow the repo's existing convention for design documents if one exists (a specs, rfcs, or ADR directory); otherwise create docs/specs/<kebab-case-slug>.md. The spec must stand alone for a reader without this conversation: the one-sentence requirement, background, each interview decision with its reason, scope and non-goals, constraints, edge cases, and a numbered list of acceptance criteria where every criterion is objectively checkable — named tests, commands with expected output, observable behavior. Present the spec file path and a compact summary through ask_user_question and get an explicit yes. If the answer amends or rejects it, update the file and ask again. Do not proceed on silence or a vague reply.

Phase 3 — the plan (gate 2). Only after the spec is confirmed, produce an implementation plan: ordered milestones with the files each touches, the tests each milestone adds or changes, which acceptance criterion each milestone satisfies, and the commands that prove the whole thing (build, typecheck, test). Present the plan through ask_user_question and get an explicit yes; fold rejections back in and present again. Write no implementation code before this gate passes, and do not use todo_write before it either — it tracks landing, not the interview.

Phase 4 — landing. After gate 2, work autonomously; return to the user only for a genuine blocker that contradicts the spec, never for routine decisions. Choose the mechanism by the approved plan's size. If it has at most three milestones and you expect the whole change to fit comfortably in this session's context, implement in-session: track the milestones with todo_write, and for each one implement, run the tests, and fix until green before moving on. If it is larger — four or more substantially independent milestones, or work you expect to exceed what one session can hold — the user running /ship is their explicit request for a fresh-agent Ralph loop: call the ralph tool once, with an objective that names the spec file path as the durable source of truth, instructs each round to read the spec and plan from disk, pick up the next unfinished milestone, implement and test it, and record progress in the workspace, and defines completion as every acceptance criterion in the spec passing.

Phase 5 — done means verified. The workflow ends only when every acceptance criterion passes with you actually running the named tests and commands and reading their real output. Never report a result you did not run, and never weaken a criterion to make it pass; if one cannot be met, say so plainly and why. When a decision changes mid-flight, update the spec file first so the file on disk stays the truth. Close with a short honest report: what shipped, what was verified and how, and anything left open.

If the session is in plan mode, the plan-mode rules win: nothing here authorizes writes while it is active. Tell the user this workflow needs to write the spec file and ask them to leave plan mode before continuing past the interview.`
