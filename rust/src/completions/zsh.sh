#compdef codsh
# codsh --rust zsh completion. Place this file on fpath; it does not start a session.
_codsh_rust() {
  local -a shells commands flags formats modes
  shells=(bash elvish fish powershell zsh)
  commands=(
    'help:Print help'
    'completions:Generate a shell completion script'
    'inspect:Show discovered configuration'
    'import:Preview or apply imported settings'
    'feedback:Send feedback'
    'plugin:Manage plugins'
    'login:Sign in'
    'logout:Sign out'
    'setup:Fetch managed configuration'
    'voice:List microphones'
    'sessions:List or search sessions'
    'dashboard:Open the agent dashboard'
    'web:Call the configured web substitutes'
    'export:Export a session as Markdown'
    'share:Share a session with the configured service'
    'du:Show isolated-home disk usage'
    'disk-usage:Show isolated-home disk usage'
    'usage:Show a session token usage ledger'
    'memory:Manage local memory notes'
    'worktree:Manage git worktrees'
    'doctor:Diagnose terminal and clipboard setup'
    'wrap:Run a command with local clipboard forwarding'
  )
  flags=(
    '--help[Print help]' '-h[Print a short summary]'
    '--version[Print version]' '-V[Print version]' '-v[Print version]'
    '--continue[Continue the most recent session]'
    '-c[Continue the most recent session]'
    '--resume[Resume a session by id or title]'
    '-r[Resume a session by id or title]'
    '--fork-session[Copy a resumed session]'
    '--session-id[Session id for --fork-session]'
    '-s[Session id for --fork-session]'
    '--model[Model id]' '-m[Model id]'
    '--effort[Reasoning effort]' '--reasoning-effort[Reasoning effort]'
    '--cwd[Working directory]'
    '-p[Plain prompt]' '--single[Plain prompt]'
    '--prompt-file[Plain prompt file]' '--prompt-json[Plain prompt JSON]'
    '--verbatim[Send the prompt as given]'
    '--tools[Allow listed tools]' '--disallowed-tools[Remove listed tools]'
    '--max-turns[Maximum agent steps]'
    '--rules[Append session rules]' '--append-system-prompt[Append session rules]'
    '--system-prompt-override[Replace the system prompt]' '--system-prompt[Replace the system prompt]'
    '--allow[Permission allow rule]' '--deny[Permission deny rule]'
    '--allowedTools[Permission allow rule]' '--disallowedTools[Permission deny rule]'
    '--always-approve[Auto-approve tool executions]' '--yolo[Auto-approve tool executions]'
    '--permission-mode[Permission mode]'
    '--output-format[Output format]'
    '--trust[Trust this folder]' '--revoke-trust[Withdraw folder trust]'
    '--minimal[Minimal screen]' '--fullscreen[Fullscreen screen]'
    '--sandbox[Filesystem sandbox profile]' '--no-memory[Hide memory for this process]'
    '--disable-web-search[Disable web search and web fetch tools]'
    '--worktree[Start in a new git worktree]' '-w[Start in a new git worktree]'
    '--worktree-ref[Base ref for --worktree]' '--ref[Base ref for --worktree]'
  )
  formats=(plain json streaming-json streaming-messages-json)
  modes=(ask auto always-approve dontAsk acceptEdits)
  if (( CURRENT > 2 )) && [[ ${words[2]} == completions ]]; then
    _values 'shell' $shells
    return
  fi
  case ${words[CURRENT-1]} in
    --output-format) _values 'format' $formats; return ;;
    --permission-mode) _values 'mode' $modes; return ;;
    --resume|-r|--session-id|-s|--model|-m|--effort|--reasoning-effort|--cwd|--prompt-file|--max-turns|--tools|--disallowed-tools|--rules|--append-system-prompt|--system-prompt-override|--system-prompt|--allow|--deny|--allowedTools|--disallowedTools|-p|--single|--prompt-json|--sandbox|--worktree-ref|--ref)
      return
      ;;
  esac
  _arguments -s : $flags '*::command:->cmd' && return
  _describe 'command' commands
}
compdef _codsh_rust codsh
