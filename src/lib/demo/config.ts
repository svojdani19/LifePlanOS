import type { UserRole } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Demo mode (docs/28 §6). Pure configuration — no DB, no side effects — so the
// gate and persona roster are unit-testable and shared by the /demo page, the
// one-click login API, and the seed/reset scripts.
//
// The demo environment is a fully synthetic tenant ("Life Care Plan Partners
// Demo", Firm.isDemo = true). Every name, record, and figure in it is
// fictional; nothing in this module or the seed derives from a real person.
// ─────────────────────────────────────────────────────────────────────────────

export const DEMO_FIRM_SLUG = "life-care-plan-partners-demo";
export const DEMO_FIRM_NAME = "Life Care Plan Partners Demo";

/**
 * Development-only fallback password for the demo personas. NEVER used in
 * production: there, DEMO_PASSWORD must be set explicitly or seeding refuses.
 */
export const DEV_DEFAULT_DEMO_PASSWORD = "LifePlanOS-Demo-2026!";

type Env = Record<string, string | undefined>;

/**
 * Demo mode is opt-in via ENABLE_DEMO_MODE=true, and in production it
 * additionally requires an explicit DEMO_MODE_PRODUCTION_ACK=true so a demo
 * login surface can never appear on a production deployment by accident.
 */
export function demoModeEnabled(env: Env = process.env): boolean {
  if (env.ENABLE_DEMO_MODE !== "true") return false;
  return env.NODE_ENV !== "production" || env.DEMO_MODE_PRODUCTION_ACK === "true";
}

/**
 * The password every demo persona is seeded with: DEMO_PASSWORD when set,
 * else the documented dev default — but ONLY outside production. Returns null
 * in production without an explicit DEMO_PASSWORD (callers must refuse).
 */
export function demoPassword(env: Env = process.env): string | null {
  if (env.DEMO_PASSWORD) return env.DEMO_PASSWORD;
  return env.NODE_ENV !== "production" ? DEV_DEFAULT_DEMO_PASSWORD : null;
}

export interface DemoPersona {
  email: string;
  name: string;
  /** Legacy UserRole enum value stored on User.role. */
  role: UserRole;
  /**
   * Built-in role-template assignments (UserRoleAssignment.builtInRole keys
   * from src/lib/authz/roles.ts). The first entry is the persona's primary
   * template; extra entries model multi-role seats (e.g. medical director).
   */
  templateAssignments: string[];
  /** Workspace key from src/lib/workspaces.ts — drives post-login routing. */
  preferredWorkspace: string;
  description: string;
  /** Working title stored on the persona's template assignment (hero display). */
  assignmentResponsibility?: string;
}

/**
 * The 13 demo personas (MDIP brief). Emails live under demo.lifeplanos.com and
 * names are obviously fictional. Template assignments carry the REAL authz
 * semantics (each persona holds ONLY its intended template(s)); the legacy
 * User.role is deliberately the narrowest enum value that keeps the persona's
 * workflow functional WITHOUT granting specialist authority:
 *
 * - platform.admin: authority comes exclusively from the ACTIVE org-scoped
 *   PLATFORM_SYSTEM_ADMINISTRATOR assignment (src/lib/authz/platform.ts).
 *   Legacy role is BILLING_USER — the only legacy role with zero case/PHI
 *   permissions — so workspace guards evaluate the platform-admin path, never
 *   a legacy ADMIN bypass.
 * - vocational/economist: PLANNER (futurecare.edit powers their intake/compute
 *   APIs) — NOT PHYSICIAN_REVIEWER; attestation stays credential-gated with
 *   the physicians.
 * - qa: PARALEGAL-level (validation APIs need only case.view).
 * - observer: ATTORNEY_REVIEWER (genuinely attorney-facing, read + released
 *   downloads only).
 * - medical.director: the multi-role PHYSICIAN_REVIEWER seat stays.
 */
export const DEMO_PERSONAS: DemoPersona[] = [
  {
    email: "platform.admin@demo.lifeplanos.com",
    name: "Robin Demo-Vance",
    role: "BILLING_USER",
    templateAssignments: ["PLATFORM_SYSTEM_ADMINISTRATOR"],
    preferredWorkspace: "PLATFORM_SYSTEM_ADMINISTRATOR",
    description:
      "Platform administrator: operates tenant configuration, integrations, and platform audit visibility — never assumes a clinical identity. Authority comes from an explicit platform role assignment, not an email list.",
  },
  {
    email: "firm.admin@demo.lifeplanos.com",
    name: "Morgan Demo-Ellison",
    role: "ADMIN",
    templateAssignments: ["FIRM_ADMINISTRATOR"],
    preferredWorkspace: "FIRM_ADMINISTRATOR",
    description:
      "Firm administrator: manages people, roles, offices, billing, and auditable firm configuration for the demo practice.",
  },
  {
    email: "attorney@demo.lifeplanos.com",
    name: "Harper Demo-Quinn, Esq.",
    role: "ATTORNEY_REVIEWER",
    templateAssignments: ["ATTORNEY_CLIENT"],
    preferredWorkspace: "ATTORNEY_CLIENT",
    assignmentResponsibility: "Attorney",
    description:
      "Retaining attorney: reviews damages posture, decides on expert engagements, and downloads released work product.",
  },
  {
    email: "paralegal@demo.lifeplanos.com",
    name: "Casey Demo-Alvarez",
    // The paralegal works the matter exactly the way the retaining attorney
    // does — identical viewpoint and access (attorney seat + template).
    role: "ATTORNEY_REVIEWER",
    templateAssignments: ["ATTORNEY_CLIENT"],
    preferredWorkspace: "ATTORNEY_CLIENT",
    assignmentResponsibility: "Paralegal",
    description:
      "Paralegal: works the matter with the same viewpoint and access as the retaining attorney — intake, records, report ordering, and released work product.",
  },
  {
    email: "records.analyst@demo.lifeplanos.com",
    name: "Rowan Demo-Fitzgerald, RHIA",
    role: "PARALEGAL",
    templateAssignments: ["MEDICAL_RECORD_ANALYST"],
    preferredWorkspace: "MEDICAL_RECORD_ANALYST",
    description:
      "Medical records analyst: turns raw uploads into a structured, source-traceable record set and works the extraction-issue queue.",
  },
  {
    email: "planner@demo.lifeplanos.com",
    name: "Jordan Demo-Blakely, RN CLCP",
    role: "PLANNER",
    templateAssignments: ["LIFE_CARE_PLANNER"],
    preferredWorkspace: "LIFE_CARE_PLANNER",
    assignmentResponsibility: "Life Care Planner",
    description:
      "Life care planner: authors defensible future-care recommendations, costs them, and builds the expert report.",
  },
  {
    email: "physician@demo.lifeplanos.com",
    name: "Dr. Samir Demo-Okafor, MD",
    role: "PHYSICIAN_REVIEWER",
    templateAssignments: ["PHYSICIAN_REVIEWER"],
    preferredWorkspace: "PHYSICIAN_REVIEWER",
    assignmentResponsibility: "Physician Reviewer",
    description:
      "Physician reviewer: independently reviews medical necessity and signs credential-gated attestations. Holds an org-verified license.",
  },
  {
    email: "vocational@demo.lifeplanos.com",
    name: "Riley Demo-Brooks, CRC",
    // A read-oriented seat: the expert's authority comes from the case-scoped
    // VOCATIONAL_EXPERT assignment/engagement, never from a planner seat —
    // a planner seat would smuggle in life-care-plan authoring powers.
    role: "ATTORNEY_REVIEWER",
    templateAssignments: ["VOCATIONAL_EXPERT"],
    preferredWorkspace: "VOCATIONAL_EXPERT",
    assignmentResponsibility: "Vocational Expert",
    description:
      "Vocational expert: analyzes work capacity, transferable skills, and vocational loss for engaged cases. Org-verified CRC credential.",
  },
  {
    email: "economist@demo.lifeplanos.com",
    name: "Cameron Demo-Price, PhD",
    // Least-privileged compatibility seat: the expert authority comes from the
    // FORENSIC_ECONOMIST assignment/engagement — a planner seat would smuggle
    // in clinical authoring and case-management powers.
    role: "ATTORNEY_REVIEWER",
    templateAssignments: ["FORENSIC_ECONOMIST"],
    preferredWorkspace: "FORENSIC_ECONOMIST",
    assignmentResponsibility: "Forensic Economist",
    description:
      "Forensic economist: models deterministic present-value loss scenarios from explicitly sourced assumptions. Org-verified credential.",
  },
  {
    email: "qa@demo.lifeplanos.com",
    name: "Drew Demo-Winslow, RN",
    role: "PARALEGAL",
    templateAssignments: ["QUALITY_ASSURANCE_REVIEWER"],
    preferredWorkspace: "QUALITY_ASSURANCE_REVIEWER",
    description:
      "Quality assurance reviewer: works citation, consistency, and export-blocking findings at the release gate.",
  },
  {
    email: "operations@demo.lifeplanos.com",
    name: "Jamie Demo-Ortega",
    role: "BILLING_USER",
    templateAssignments: ["LEGACY_BILLING"],
    preferredWorkspace: "LEGACY_BILLING",
    description:
      "Operations & billing: manages subscription, seats, engagements, and delivery visibility — with no clinical access.",
  },
  {
    email: "observer@demo.lifeplanos.com",
    name: "Sydney Demo-Marsh",
    role: "ATTORNEY_REVIEWER",
    templateAssignments: ["READ_ONLY_OBSERVER"],
    preferredWorkspace: "READ_ONLY_OBSERVER",
    description:
      "Read-only observer: inspects case status, plans, and released information without any mutation rights.",
  },
  {
    email: "medical.director@demo.lifeplanos.com",
    name: "Dr. Noor Demo-Haddad, MD",
    role: "PHYSICIAN_REVIEWER",
    templateAssignments: ["PHYSICIAN_REVIEWER", "QUALITY_ASSURANCE_REVIEWER"],
    preferredWorkspace: "PHYSICIAN_REVIEWER",
    assignmentResponsibility: "Medical Director",
    description:
      "Medical director (multi-role): physician reviewer who also carries the QA template — demonstrates multi-assignment workspace switching.",
  },
];

/** Case-insensitive persona lookup for the one-click demo login. */
export function demoPersonaByEmail(email: string): DemoPersona | undefined {
  const needle = email.trim().toLowerCase();
  return DEMO_PERSONAS.find((p) => p.email === needle);
}
