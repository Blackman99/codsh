# Security Policy

codsh executes model-driven tool calls (shell, filesystem) under the dsh permission and sandbox model, and `!` lines run directly in your own shell by design. Treat any bypass of the permission preset, the approval prompt, or the workspace-write boundary as a security bug.

## Reporting

Please do not open public issues for vulnerabilities. Use GitHub private vulnerability reporting (Security → Report a vulnerability) on this repository. Issues in the underlying harness (agent loop, tools, sandbox) should go to [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) instead.
