---
description: When and how to verify changes
trigger: glob
globs: ["src/**/*.ts", "test/**/*.ts"]
---

Before reporting any code change done:
- Run `pnpm check` (lint + typecheck + test) or the closest affected-package equivalent.
- Report real output — no paraphrased "it passed".
