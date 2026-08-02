# Medical Damages Intelligence demo

This seed is synthetic and must only be run in a local or disposable development database. It deletes and rebuilds the `meridian-life-care` demo tenant; it must not be run against production.

## Local launch

1. Start PostgreSQL 16 locally (the repository includes `docker-compose.yml`).
2. Copy `.env.example` to `.env` and use the documented localhost `DATABASE_URL` and `DIRECT_URL`.
3. Run `npm install`, `npm run setup`, and `npm run dev`.
4. Open `http://localhost:3100/login`.

Every active demo account uses the password `password123`.

| Workspace | Login | Route |
| --- | --- | --- |
| Firm administrator | `demo@lifeplanos.app` | `/firm-admin` |
| Life care planner | `planner@lifeplanos.app` | `/planner` |
| Physician reviewer | `physician@lifeplanos.app` | `/physician` |
| Case manager | `para@lifeplanos.app` | `/case-manager` |
| Attorney client | `attorney@lifeplanos.app` | `/attorney` |
| Medical records analyst | `records@lifeplanos.app` | `/records` |
| Vocational expert | `vocational@lifeplanos.app` | `/vocational` |
| Forensic economist | `economist@lifeplanos.app` | `/economist` |
| Quality assurance | `qa@lifeplanos.app` | `/qa` |
| Billing and operations | `billing@lifeplanos.app` | `/operations` |
| Platform administrator | `platform@lifeplanos.app` | `/platform-admin` |
| External expert | `expert@lifeplanos.app` | `/external-expert` |
| Read-only observer | `observer@lifeplanos.app` | `/observer` |
| Insurance client | `insurance@lifeplanos.app` | `/insurance` |

The physician, vocational, and economist credentials are conspicuously synthetic demo records. They exercise credential gates but must never be represented as real professional credentials.

## Demo data

The seed creates five synthetic matters. David Chen is the showcase matter and includes synthetic records, chronology, causation, future-care recommendations, cost projections, and physician-review work. Other cases cover orthopedic trauma, arthroplasty, amputation, and brain injury workflows.

## Safety notes

- Workspace routes validate active assignments on the server; knowing a route is not sufficient for access.
- Tenant-scoped queries are used for all workspace metrics.
- Professional review and attestation gates remain enforced independently of workspace visibility.
- Do not use real patient data in the demo tenant.

## Guarded demo environment (`/demo`)

Separately from the dev seed above, an env-guarded demo environment ships with the platform (MDIP docs/28):

- **Gate:** every demo surface is disabled unless `ENABLE_DEMO_MODE=true`; in production an explicit acknowledgment env is additionally required (see `src/lib/demo/config.ts`). When disabled, `/demo` and its APIs return 404.
- **Tenant:** `Life Care Plan Partners Demo` (`Firm.isDemo = true`). The app shell renders a persistent "DEMO ENVIRONMENT — SYNTHETIC DATA ONLY" banner for demo tenants.
- **Personas:** 13 one-click personas at `@demo.lifeplanos.com`, one per workspace, defined in `src/lib/demo/config.ts`. Password comes from `DEMO_PASSWORD` (dev default only outside production; no default in production).
- **Login:** visit `/demo` for the persona card grid; `POST /api/demo/login` creates a real session and routes each persona to their workspace via `workspaceHrefForRole`.
- **Data:** 8 synthetic cases spanning intake → records QA → chronology/causation → physician review → attorney decision → QA gate → released final report → vocational/economic work, plus engagements across their lifecycle and notifications.
- **Seed / reset:** `npx tsx --env-file=.env scripts/demo-seed.ts` builds the tenant; `npx tsx --env-file=.env scripts/demo-reset.ts --confirm` deletes (demo tenant only — the delete refuses non-demo firms) and reseeds. `POST /api/demo/reset` performs the same reset for demo-tenant admins. Every reset is audited.
- Demo users and data are never created in production without the explicit env acknowledgments; passwords are always stored hashed.
