# /spec

Use this command to extract a specific Seasonals requirements section from `docs/spec.md`.

Expected input:

```text
/spec §X.Y
```

Workflow:

1. Read `CLAUDE.md` first for the compressed canonical rules.
2. Open `docs/spec.md` and find the requested section heading.
3. Return only the relevant section and any immediately required child subsections.
4. If implementation touches shared types, compare the section against `lib/types/`.
5. If implementation touches financial values, compare the section against `lib/utils/numeric.ts`.
