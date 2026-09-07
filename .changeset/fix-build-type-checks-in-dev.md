---
'codsh-bundle': patch
---

fix: fix declaration build errors and type narrowing in dev script

Clean up unused parameter in `thinkingFold` and fix TypeScript control flow narrowing in `index.ts` across `turn()` execution so `pnpm run build` and `pnpm run dev` compile without error.
