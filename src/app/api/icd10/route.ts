import { getContext } from "@/lib/tenant";
import { searchIcd10 } from "@/lib/icd10";
import { ok, handleError } from "@/lib/api";

// Typeahead ICD-10-CM search. Auth-gated (internal app) but not tenant-scoped —
// it only returns public diagnosis codes.
export async function GET(req: Request) {
  try {
    const ctx = await getContext();
    if (!ctx) return ok({ results: [] }, 401);
    const q = new URL(req.url).searchParams.get("q") ?? "";
    const { results, source } = await searchIcd10(q);
    return ok({ results, source });
  } catch (err) {
    return handleError(err);
  }
}
