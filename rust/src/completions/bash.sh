# codsh --rust bash completion. Source this file; it does not start a session.
_codsh_rust_complete() {
  local cur prev
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  local shells="bash elvish fish powershell zsh"
  local commands="help completions inspect import feedback plugin login logout setup voice web sessions dashboard export share du disk-usage memory"
  local flags="--help -h --version -V -v --continue -c --resume -r --fork-session --session-id -s --model -m --effort --reasoning-effort --cwd -p --single --prompt-file --prompt-json --verbatim --tools --disallowed-tools --max-turns --rules --append-system-prompt --system-prompt-override --system-prompt --allow --deny --allowedTools --disallowedTools --always-approve --yolo --permission-mode --output-format --trust --revoke-trust --minimal --fullscreen --sandbox --no-memory --disable-web-search"
  case "$prev" in
    completions)
      COMPREPLY=( $(compgen -W "$shells" -- "$cur") )
      return 0
      ;;
    --output-format)
      COMPREPLY=( $(compgen -W "plain json streaming-json streaming-messages-json" -- "$cur") )
      return 0
      ;;
    --permission-mode)
      COMPREPLY=( $(compgen -W "ask auto always-approve dontAsk acceptEdits" -- "$cur") )
      return 0
      ;;
    --resume|-r|--session-id|-s|--model|-m|--effort|--reasoning-effort|--cwd|--prompt-file|--max-turns|--tools|--disallowed-tools|--rules|--append-system-prompt|--system-prompt-override|--system-prompt|--allow|--deny|--allowedTools|--disallowedTools|-p|--single|--prompt-json|--sandbox)
      return 0
      ;;
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  fi
}
complete -F _codsh_rust_complete codsh
