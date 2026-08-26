import {
  Siren, Syringe, Stethoscope, Dumbbell, Microscope, ClipboardList, Receipt, Scale, Gavel, Camera,
  File as FileIcon,
  type LucideIcon,
} from "lucide-react";
import { TYPE_GROUP } from "@/lib/documents/taxonomy";

/**
 * One icon per document CATEGORY.
 *
 * Lifted out of CaseWorkspace verbatim so the Records components can share it
 * without importing a 5,900-line module — and without the circular import that
 * would follow. The mapping and the fallback are unchanged.
 */
export const GROUP_ICON: Record<string, LucideIcon> = {
  "Emergency & Acute Care": Siren,
  "Surgical & Procedural": Syringe,
  "Outpatient / Clinic": Stethoscope,
  "Rehabilitation & Therapy": Dumbbell,
  Diagnostics: Microscope,
  "Life Care Plan & Vocational": ClipboardList,
  "Financial & Economic": Receipt,
  "Medicolegal / Expert": Scale,
  "Legal & Liability": Gavel,
  "Scene & Evidence": Camera,
  Other: FileIcon,
};

export const iconForType = (type: string): LucideIcon => GROUP_ICON[TYPE_GROUP[type] ?? "Other"] ?? FileIcon;
