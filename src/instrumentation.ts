// ─────────────────────────────────────────────────────────────────────────────
// Next.js instrumentation hook (requires experimental.instrumentationHook in
// next.config.js on Next 14). Runs once per server bootstrap, before traffic.
// Validation logic is pure and tested in src/lib/envCheck.ts; this file is the
// thin runtime wrapper: collect ALL failures, throw one aggregate error (no
// secrets/PHI in the message), warn once in non-production.
// ─────────────────────────────────────────────────────────────────────────────

export async function register(): Promise<void> {
  // Node runtime only — never the edge/browser bundles.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { checkEnv } = await import("@/lib/envCheck");
  const production = process.env.NODE_ENV === "production";
  const { failures, warnings } = checkEnv(process.env, production);

  if (failures.length) {
    throw new Error(
      `Startup environment validation failed (${failures.length} issue${failures.length === 1 ? "" : "s"}):\n` +
        failures.map((f) => `  - ${f}`).join("\n"),
    );
  }
  if (warnings.length) {
    console.warn(`[lifeplanos] env not production-ready (non-blocking): ${warnings.join(" | ")}`);
  }
}
