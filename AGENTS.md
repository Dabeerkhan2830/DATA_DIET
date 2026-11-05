# AGENTS.md — contributor guide for DataDiet

Instructions for AI agents and new engineers working in this repository. Read
`docs/architecture.md` and `docs/decisions.md` before making design changes.

## Non-negotiable safety rules

1. **Never implement automatic deletion, bulk disposal, or irreversible
   operations.** Lifecycle actions require documented policy evaluation and
   explicit human approval; Phase 1 has no destructive actions at all.
2. **Never connect to real institutional systems or upload real personal
   data.** Development uses synthetic fixtures only.
3. **Never fabricate an integration.** If it is not implemented, the UI must say
   "not implemented" — no fake success states, no placeholder service dressed up
   as working.
4. **Never expose secrets to the frontend.** `DATABASE_URL`, API keys, and
   privileged credentials stay in backend environment variables. Only `VITE_*`
   variables reach the browser bundle — and never put a secret in one.
5. **Never claim a capability that is untested.** Update
   `docs/architecture.md`'s status table when behaviour changes.
6. **Never create production tables by hand.** Edit models, generate an Alembic
   revision, review it, then apply it.
7. **Never add an arbitrary score.** Any risk/priority number must come from a
   documented rule table with unit tests plus a decision record.

## Where things live

| Change | Location |
| --- | --- |
| HTTP endpoint, status codes, request/response shape | `backend/app/api/routes/`, schemas in `backend/app/api/schemas/` |
| Business logic (no HTTP, no SQL) | `backend/app/services/` |
| Tables, columns, indexes | `backend/app/db/models.py`, then a migration in `database/migrations/versions/` |
| Configuration / new env var | `backend/app/core/config.py` **and** `.env.example` |
| UI page / navigation entry | `frontend/src/pages/`, `frontend/src/components/nav.ts` |
| API call | `frontend/src/api/`, types in `frontend/src/api/types.ts` |
| Shared UI primitives | `frontend/src/components/ui/` |
| CI workflow or validation gate | `.github/workflows/ci.yml`, `scripts/check.ps1` |

## Conventions

- **Backend**: Python 3.11+ typing, Pydantic v2 models at the boundary, no SQL
  outside `app/db`, line length 100 (ruff: `E,F,I,UP,B`), English docstrings.
- **Frontend**: TypeScript strict (`noUnusedLocals`, `noUnusedParameters`,
  `verbatimModuleSyntax`). Functional components, no `any`, explicit prop
  interfaces, Tailwind utility classes (no CSS files per component).
- **API types**: `frontend/src/api/types.ts` mirrors the backend Pydantic
  schemas. When you change a schema, update the type and any affected view.
- **Demo data**: keep the `SYNTH-` identifier prefix and the
  `synthetic_demo_data` envelope on anything synthetic. Never bypass
  `DemoEnvelope`.
- **Tests**: add a backend test for new logic and a frontend test for new
  interactive or data-rendering components. Prefer testing documented rules over
  snapshots.

## Required workflow before finishing a task

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet
.\scripts\check.ps1
```

That runs, in order: backend ruff, operator-script ruff, backend pytest,
frontend typecheck, frontend Vitest, and the production build. All six must
pass. If Docker is available and you touched models, also verify migrations:

```powershell
Set-Location backend
..\.venv\Scripts\alembic.exe upgrade head
..\.venv\Scripts\alembic.exe current
```

## Common commands

```powershell
# Backend dev server (from backend/)
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000

# Backend tests / lint (from backend/)
..\.venv\Scripts\python.exe -m pytest
..\.venv\Scripts\python.exe -m ruff check . --fix

# Frontend (from frontend/)
npm run dev
npm run typecheck
npm test
npm run build

# New migration (from backend/)
..\.venv\Scripts\alembic.exe revision --autogenerate -m "describe change"
```

## Definition of done for a feature

1. Layering respected (route → service → db), inputs validated with Pydantic.
2. Loading, empty, and error states handled in the UI for any data view.
3. Synthetic-only development data, clearly labeled.
4. Tests added and `.\scripts\check.ps1` passes.
5. `docs/architecture.md` status table and, if a decision was made,
   `docs/decisions.md` updated.
