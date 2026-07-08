import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { TenantError } from "@/lib/tenant";

// Uniform JSON error handling for API routes.
export function ok<T>(data: T, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

export function handleError(err: unknown) {
  if (err instanceof TenantError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "Validation failed", issues: err.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 400 });
}
