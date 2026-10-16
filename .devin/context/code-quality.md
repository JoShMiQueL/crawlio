<!-- Context: standards/code-quality | Priority: high -->

# Code quality (global)

- Match the surrounding codebase's conventions before adding new patterns.
- Read a file fully before editing it; keep changes scoped to the task.
- Prefer the project's own build/test/lint commands — discover them from package.json, Makefile, pyproject, etc.
- Do not introduce dependencies without a reason; flag it in the report when you do.
- Report verification honestly: real command output, or "not verified" with the reason.
