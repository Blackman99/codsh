# codsh --rust elvish completion. Add this file to the module path; it does not start a session.
set edit:completion:arg-completer[codsh] = {|@words|
  var shells = [bash elvish fish powershell zsh]
  var commands = [help completions inspect import feedback plugin login logout setup voice web sessions dashboard export share du disk-usage memory worktree]
  var flags = [--help -h --version -V -v --continue -c --resume -r --fork-session --session-id -s --model -m --effort --reasoning-effort --cwd -p --single --prompt-file --prompt-json --verbatim --tools --disallowed-tools --max-turns --rules --append-system-prompt --system-prompt-override --system-prompt --allow --deny --allowedTools --disallowedTools --always-approve --yolo --permission-mode --output-format --trust --revoke-trust --minimal --fullscreen --sandbox --no-memory --disable-web-search --worktree -w --worktree-ref --ref]
  var cur = $words[-1]
  if (== (count $words) 3) {
    if (==s $words[1] completions) { put $@shells; return }
  }
  if (str:has-prefix $cur '-') { put $@flags; return }
  put $@commands
  put $@flags
}
