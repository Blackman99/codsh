---
"codsh-bundle": patch
---

An approval can be remembered. Its third answer, `d`, writes a rule such as `bash(git push *)` to `.dsh/permissions.local.json`, and every later call the rule covers — in this session and the next — is allowed with one dim line naming the rule instead of a question. The prefix is the command's first word, plus the subcommand for git, npm, pnpm, cargo, go, and docker; a tool without a command line is remembered whole; a compound command (`&&`, `;`, `|`, a newline) is offered nothing and never matches a prefix. `.dsh/permissions.json` and `~/.dsh/permissions.json` hold hand-written rules in the same `{ "allow": [...] }` shape, read on every question; a file that does not parse is named once and left alone.
