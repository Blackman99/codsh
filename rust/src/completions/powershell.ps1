# codsh --rust PowerShell completion. Dot-source this file; it does not start a session.
Register-ArgumentCompleter -CommandName codsh -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $shells = @('bash', 'elvish', 'fish', 'powershell', 'zsh')
  $commands = @('help', 'completions', 'inspect', 'import', 'feedback', 'plugin', 'login', 'logout', 'setup', 'voice', 'sessions', 'dashboard')
  $flags = @(
    '--help', '-h', '--version', '-V', '--continue', '--resume', '--fork-session',
    '--session-id', '-s', '--model', '-m', '--effort', '--reasoning-effort', '--cwd',
    '-p', '--single', '--prompt-file', '--prompt-json', '--verbatim', '--tools',
    '--disallowed-tools', '--max-turns', '--rules', '--append-system-prompt',
    '--system-prompt-override', '--system-prompt', '--allow', '--deny',
    '--allowedTools', '--disallowedTools', '--always-approve', '--yolo',
    '--permission-mode', '--output-format', '--trust', '--revoke-trust',
    '--minimal', '--fullscreen'
  )
  $text = $commandAst.ToString()
  $candidates = if ($text -match 'completions\s+\S*$') { $shells }
    elseif ($wordToComplete.StartsWith('-')) { $flags }
    else { $commands + $flags }
  $candidates | Where-Object { $_.StartsWith($wordToComplete) } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
