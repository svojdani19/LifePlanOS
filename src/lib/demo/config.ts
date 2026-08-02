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
}

/**
 * The 13 demo personas (MDIP brief). Emails live under demo.lifeplanos.com and
 * names are obviously fictional. Legacy-role mapping follows docs/28: template
 * assignments carry the real authz semantics; preferredWorkspace routes the
 * persona to their workspace after one-click login.
 */
export const DEMO_PERSONAS: DemoPersona[] = [
  {
    email: "platform.admin@demo.lifeplanos.com",
    name: "Robin Demo-Vance",
    role: "ADMIN",
    templateAssignments: ["PLATFORM_SYSTEM_ADMINISTRATOR"],
    preferredWorkspace: "PLATFORM_SYSTEM_ADMINISTRATOR",
    description:
      "Platform administrator: operates tenant configuration, integrations, and platform audit visibility — never assumes a clinical identity.",
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
    description:
      "Retaining attorney: reviews damages posture, decides on expert engagements, and downloads released work product.",
  },
  {
    email: "case.manager@demo.lifeplanos.com",
    name: "Casey Demo-Alvarez",
    role: "PARALEGAL",
    templateAssignments: ["CASE_MANAGER"],
    preferredWorkspace: "CASE_MANAGER",
    description:
      "Case manager: moves matters through intake, record collection, assignments, deadlines, and escalations.",
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
    description:
      "Life care planner: authors defensible future-care recommendations, costs them, and builds the expert report.",
  },
  {
    email: "physician@demo.lifeplanos.com",
    name: "Dr. Samir Demo-Okafor, MD",
    role: "PHYSICIAN_REVIEWER",
    templateAssignments: ["PHYSICIAN_REVIEWER"],
    preferredWorkspace: "PHYSICIAN_REVIEWER",
    description:
      "Physician reviewer: independently reviews medical necessity and signs credential-gated attestations. Holds an org-verified license.",
  },
  {
    email: "vocational@demo.lifeplanos.com",
    name: "Riley Demo-Brooks, CRC",
    role: "PHYSICIAN_REVIEWER",
    templateAssignments: ["VOCATIONAL_EXPERT"],
    preferredWorkspace: "VOCATIONAL_EXPERT",
    description:
      "Vocational expert: analyzes work capacity, transferable skills, and vocational loss for engaged cases. Org-verified CRC credential.",
  },
  {
    email: "economist@demo.lifeplanos.com",
    name: "Cameron Demo-Price, PhD",
    role: "PHYSICIAN_REVIEWER",
    templateAssignments: ["FORENSIC_ECONOMIST"],
    preferredWorkspace: "FORENSIC_ECONOMIST",
    description:
      "Forensic economist: models deterministic present-value loss scenarios from explicitly sourced assumptions. Org-verified credential.",
  },
  {
    email: "qa@demo.lifeplanos.com",
    name: "Drew Demo-Winslow, RN",
    role: "PHYSICIAN_REVIEWER",
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
    description:
      "Medical director (multi-role): physician reviewer who also carries the QA template — demonstrates multi-assignment workspace switching.",
  },
];

/** Case-insensitive persona lookup for the one-click demo login. */
export function demoPersonaByEmail(email: string): DemoPersona | undefined {
  const needle = email.trim().toLowerCase();
  return DEMO_PERSONAS.find((p) => p.email === needle);
}
