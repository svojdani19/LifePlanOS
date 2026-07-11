import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Liveness/readiness probe for load balancers and uptime monitors. No auth, no
// PHI — just process + database reachability.
export async function GET() {
  let db = "up";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = "down";
  }
  const healthy = db === "up";
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", db, time: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}
