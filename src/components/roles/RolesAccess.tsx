"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Copy, Plus, ShieldAlert } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { cn, formatDate } from "@/lib/utils";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_REGISTRY,
  resolveKey,
  type PermissionDefinition,
  type PermissionRisk,
} from "@/lib/authz/registry";
import { BUILT_IN_ROLES } from "@/lib/authz/roles";

// ─────────────────────────────────────────────────────────────────────────────
// Roles & Access console (docs/26 P5). Six tabs: protected built-in templates,
// the custom-role builder (grouped picker + explicit denials + impact/confirm),
// scoped assignments, the role × permission matrix, the access-review dry-run
// (authz-preview), and per-role version history. Server messages (version
// conflicts, delegation-ceiling refusals) are rendered verbatim.
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared metadata ──────────────────────────────────────────────────────────

const RISK_TONE: Record<PermissionRisk, BadgeTone> = {
  LOW: "neutral",
  MODERATE: "info",
  HIGH: "warning",
  CRITICAL: "danger",
};

const CRED_LABEL: Record<string, string> = {
  PHYSICIAN: "physician",
  VOCATIONAL: "vocational expert",
  ECONOMIST: "economist",
  CLCP: "CLCP",
  RN: "RN",
};

/** Registry categories in definition order, each with its canonical keys. */
const CATEGORY_GROUPS: { category: string; keys: string[] }[] = (() => {
  const map = new Map<string, string[]>();
  for (const key of ALL_PERMISSION_KEYS) {
    const def = PERMISSION_REGISTRY[key];
    if (!def) continue;
    const list = map.get(def.category) ?? [];
    list.push(key);
    map.set(def.category, list);
  }
  return [...map.entries()].map(([category, keys]) => ({ category, keys }));
})();

function isCriticalKey(key: string): boolean {
  const def = PERMISSION_REGISTRY[key];
  return Boolean(def && (def.risk === "CRITICAL" || def.privileged));
}

/** Why this key cannot be ALLOWed on a custom role, or null if it can. */
function allowDisabledReason(def: PermissionDefinition): string | null {
  if (def.platformOnly) return "Platform-only — never grantable to firm roles";
  if (!def.customRoleAssignable) return "Not assignable to custom roles";
  if (!def.delegable) return "Not delegable — cannot be granted onward";
  return null;
}

// ── API DTOs ─────────────────────────────────────────────────────────────────

interface BuiltInRoleDto {
  key: string;
  name: string;
  description: string;
  defaultScope: string;
  externalFacing: boolean;
  assignable: boolean;
  permissions: string[];
}

interface RolePermDto {
  permissionKey: string;
  effect: "ALLOW" | "DENY";
  scopeType: string;
}

interface CustomRoleDto {
  id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  clonedFromSystemRole: string | null;
  isAssignable: boolean;
  permissions: RolePermDto[];
}

interface ImpactDto {
  usersAssigned: number;
  activeCasesAffected: number;
  added: string[];
  removed: string[];
  newlyDenied: string[];
  criticalChanged: string[];
  sessionsShouldRefresh: boolean;
}

interface VersionDto {
  id: string;
  version: number;
  changedById: string;
  changeReason: string | null;
  createdAt: string;
}

interface UserDto {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
}

interface OfficeDto {
  id: string;
  name: string;
  archivedAt: string | null;
}

interface AssignmentDto {
  id: string;
  userId: string;
  builtInRole: string | null;
  customRoleId: string | null;
  officeId: string | null;
  caseId: string | null;
  responsibility: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  status: string;
  assignmentReason: string | null;
  user: UserDto | null;
  roleLabel: string;
  roleKind: "built-in" | "custom";
}

interface MatrixDto {
  generatedAt: string;
  permissionKeys: string[];
  roles: {
    id: string;
    name: string;
    kind: "built-in" | "custom";
    status: string;
    permissions: Record<string, "ALLOW" | "DENY">;
  }[];
}

// ── Small shared pieces ──────────────────────────────────────────────────────

function RiskBadge({ risk }: { risk: PermissionRisk }) {
  return <Badge tone={RISK_TONE[risk]}>{risk.toLowerCase()}</Badge>;
}

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>;
}

function Loading() {
  return <p className="text-meta py-4">Loading…</p>;
}

// ── Permission picker (grouped, searchable, scope-aware) ─────────────────────

function PermissionPicker({
  effect,
  selected,
  onToggle,
  onScopeChange,
  enabledFlags,
}: {
  effect: "ALLOW" | "DENY";
  /** key → scopeType */
  selected: Record<string, string>;
  onToggle: (key: string) => void;
  onScopeChange: (key: string, scope: string) => void;
  enabledFlags: Record<string, boolean>;
}) {
  const [search, setSearch] = useState("");
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const q = search.trim().toLowerCase();

  const groups = CATEGORY_GROUPS.map((g) => ({
    ...g,
    keys: g.keys.filter((k) => {
      const def = PERMISSION_REGISTRY[k];
      if (!def) return false;
      if (effect === "DENY" && def.platformOnly) return false;
      if (!q) return true;
      return (
        k.toLowerCase().includes(q) ||
        def.name.toLowerCase().includes(q) ||
        def.category.toLowerCase().includes(q)
      );
    }),
  })).filter((g) => g.keys.length > 0);

  function toggleCat(cat: string) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  return (
    <div className="space-y-2">
      <input
        className="input text-sm"
        placeholder={`Filter permissions to ${effect === "ALLOW" ? "grant" : "deny"}…`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-ink-200 p-2">
        {groups.map((g) => {
          const open = Boolean(q) || openCats.has(g.category);
          const selectedCount = g.keys.filter((k) => k in selected).length;
          return (
            <div key={g.category}>
              <button
                type="button"
                onClick={() => toggleCat(g.category)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-600 hover:bg-ink-50"
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {g.category}
                <span className="ml-auto font-normal normal-case text-ink-400">
                  {selectedCount > 0 ? `${selectedCount} selected · ` : ""}
                  {g.keys.length} keys
                </span>
              </button>
              {open && (
                <ul className="mt-1 space-y-1 pl-2">
                  {g.keys.map((key) => {
                    const def = PERMISSION_REGISTRY[key];
                    if (!def) return null;
                    const critical = isCriticalKey(key);
                    const disabledReason = effect === "ALLOW" ? allowDisabledReason(def) : def.platformOnly ? "Platform-only" : null;
                    const checked = key in selected;
                    const flagOff = def.featureFlag && !enabledFlags[def.featureFlag];
                    return (
                      <li
                        key={key}
                        className={cn(
                          "rounded-md px-2 py-1.5",
                          critical && "border-l-2 border-red-400 bg-red-50/50",
                          disabledReason && "opacity-60",
                        )}
                      >
                        <label className="flex flex-wrap items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={checked}
                            disabled={Boolean(disabledReason)}
                            onChange={() => onToggle(key)}
                          />
                          <span className="font-medium text-ink-800">{def.name}</span>
                          <code className="text-[11px] text-ink-400">{key}</code>
                          <RiskBadge risk={def.risk} />
                          {def.privileged && <Badge tone="slate">privileged</Badge>}
                          {checked && (
                            <select
                              className="ml-auto rounded-md border border-ink-300 bg-white px-1.5 py-0.5 text-xs"
                              value={selected[key]}
                              onChange={(e) => onScopeChange(key, e.target.value)}
                            >
                              {def.scopes.map((s) => (
                                <option key={s} value={s}>
                                  {s.toLowerCase()}
                                </option>
                              ))}
                            </select>
                          )}
                        </label>
                        {(disabledReason || def.requiresCredential || flagOff) && (
                          <p className="mt-0.5 pl-5 text-[11px] text-amber-700">
                            {[
                              disabledReason,
                              def.requiresCredential
                                ? `Requires verified ${CRED_LABEL[def.requiresCredential] ?? def.requiresCredential.toLowerCase()} credential`
                                : null,
                              flagOff ? `Feature not enabled: ${def.featureFlag}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
        {groups.length === 0 && <p className="text-meta px-2 py-1">No permissions match “{search}”.</p>}
      </div>
    </div>
  );
}

// ── Custom role editor ───────────────────────────────────────────────────────

interface EditorState {
  roleId: string | null;
  expectedVersion: number;
  name: string;
  description: string;
  cloneFrom: string;
  /** false only while the prefilled clone source is untouched. */
  permsDirty: boolean;
  allows: Record<string, string>;
  denies: Record<string, string>;
  changeReason: string;
}

/** Prefill permission maps from a built-in template key or a custom role. */
function permsFromSource(source: string, customRoles: CustomRoleDto[]): Pick<EditorState, "allows" | "denies"> {
  const tpl = BUILT_IN_ROLES[source];
  if (tpl) {
    const preferred = tpl.defaultScope === "CASE" ? "CASE" : "ORGANIZATION";
    const allows: Record<string, string> = {};
    for (const raw of tpl.permissions) {
      const key = resolveKey(raw);
      const def = PERMISSION_REGISTRY[key];
      if (!def || allowDisabledReason(def)) continue; // outside any firm ceiling — the server would drop it
      allows[key] = def.scopes.includes(preferred) ? preferred : def.scopes.includes("ORGANIZATION") ? "ORGANIZATION" : def.scopes[0];
    }
    return { allows, denies: {} };
  }
  const role = customRoles.find((r) => r.id === source);
  const allows: Record<string, string> = {};
  const denies: Record<string, string> = {};
  for (const p of role?.permissions ?? []) {
    const key = resolveKey(p.permissionKey);
    if (p.effect === "DENY") denies[key] = p.scopeType;
    else allows[key] = p.scopeType;
  }
  return { allows, denies };
}

function DeltaChips({ label, keys, tone }: { label: string; keys: string[]; tone: BadgeTone }) {
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-ink-600">{label}:</span>
      {keys.map((k) => (
        <Badge key={k} tone={tone} className={cn(isCriticalKey(k) && "ring-1 ring-red-400")}>
          {k}
        </Badge>
      ))}
    </div>
  );
}

function RoleEditor({
  editor,
  setEditor,
  customRoles,
  impact,
  enabledFlags,
  onSaved,
  onCancel,
}: {
  editor: EditorState;
  setEditor: (e: EditorState) => void;
  customRoles: CustomRoleDto[];
  /** Server impact for the role as configured (edit mode only). */
  impact: ImpactDto | null;
  enabledFlags: Record<string, boolean>;
  onSaved: (notice: string | null) => void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmCritical, setConfirmCritical] = useState(false);

  const isEdit = editor.roleId !== null;
  const originalRole = isEdit ? customRoles.find((r) => r.id === editor.roleId) : undefined;

  // Client-side delta vs the role's current permission rows — mirrors the
  // server's impactAnalysis so the confirm step can gate BEFORE saving.
  const delta = useMemo(() => {
    if (!originalRole) return null;
    const curAllows = new Set(
      originalRole.permissions.filter((p) => p.effect === "ALLOW").map((p) => resolveKey(p.permissionKey)),
    );
    const curDenies = new Set(
      originalRole.permissions.filter((p) => p.effect === "DENY").map((p) => resolveKey(p.permissionKey)),
    );
    const added = Object.keys(editor.allows).filter((k) => !curAllows.has(k)).sort();
    const removed = [...curAllows].filter((k) => !(k in editor.allows)).sort();
    const newlyDenied = Object.keys(editor.denies).filter((k) => !curDenies.has(k)).sort();
    const criticalChanged = [...new Set([...added, ...removed, ...newlyDenied])].filter(isCriticalKey).sort();
    return { added, removed, newlyDenied, criticalChanged };
  }, [originalRole, editor.allows, editor.denies]);

  const selectedCriticalNew = useMemo(
    () => (isEdit ? [] : Object.keys(editor.allows).filter(isCriticalKey).sort()),
    [isEdit, editor.allows],
  );

  function patch(next: Partial<EditorState>) {
    setEditor({ ...editor, ...next });
    setConfirmCritical(false);
  }

  function togglePerm(map: "allows" | "denies", key: string) {
    const next = { ...editor[map] };
    if (key in next) delete next[key];
    else {
      const def = PERMISSION_REGISTRY[key];
      next[key] = def?.scopes.includes("ORGANIZATION") ? "ORGANIZATION" : (def?.scopes[0] ?? "ORGANIZATION");
    }
    patch({ [map]: next, permsDirty: true } as Partial<EditorState>);
  }

  function setScope(map: "allows" | "denies", key: string, scope: string) {
    patch({ [map]: { ...editor[map], [key]: scope }, permsDirty: true } as Partial<EditorState>);
  }

  const permCount = Object.keys(editor.allows).length + Object.keys(editor.denies).length;
  const canSave =
    editor.name.trim().length >= 2 &&
    (isEdit ? editor.changeReason.trim().length > 0 : permCount > 0 || Boolean(editor.cloneFrom)) &&
    !saving;

  async function save() {
    if (isEdit && delta && delta.criticalChanged.length > 0 && !confirmCritical) {
      setConfirmCritical(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const permissions = [
      ...Object.entries(editor.allows).map(([key, scopeType]) => ({ key, effect: "ALLOW", scopeType })),
      ...Object.entries(editor.denies).map(([key, scopeType]) => ({ key, effect: "DENY", scopeType })),
    ];
    try {
      let res: Response;
      if (isEdit) {
        res = await fetch(`/api/firm/roles/${editor.roleId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedVersion: editor.expectedVersion,
            permissions,
            name: editor.name.trim(),
            description: editor.description,
            changeReason: editor.changeReason.trim(),
          }),
        });
      } else {
        const body: Record<string, unknown> = { name: editor.name.trim() };
        if (editor.description) body.description = editor.description;
        if (editor.changeReason.trim()) body.reason = editor.changeReason.trim();
        // POST ignores `permissions` when cloneFrom is present, so send
        // cloneFrom ONLY while the prefilled source is untouched.
        if (editor.cloneFrom && !editor.permsDirty) body.cloneFrom = editor.cloneFrom;
        else body.permissions = permissions;
        res = await fetch("/api/firm/roles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        // Verbatim server message (VERSION_CONFLICT, DELEGATION_CEILING, …).
        setSaveError(data.error ?? `Save failed (${res.status})`);
        return;
      }
      const dropped: { key: string; reason: string }[] = data.droppedKeys ?? [];
      onSaved(
        dropped.length > 0
          ? `Saved. Outside your delegation ceiling and dropped: ${dropped.map((d) => `${d.key} (${d.reason})`).join(", ")}.`
          : null,
      );
    } catch {
      setSaveError("Network error — the role was not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h3 className="h-section">{isEdit ? `Edit role — v${editor.expectedVersion}` : "New custom role"}</h3>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input className="input" value={editor.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Senior Planner (no exports)" />
        </div>
        <div>
          <label className="label">Start from (clone)</label>
          <select
            className="input"
            value={editor.cloneFrom}
            disabled={isEdit}
            onChange={(e) => {
              const source = e.target.value;
              if (!source) {
                patch({ cloneFrom: "", allows: {}, denies: {}, permsDirty: false });
                return;
              }
              setEditor({ ...editor, cloneFrom: source, ...permsFromSource(source, customRoles), permsDirty: false });
              setConfirmCritical(false);
            }}
          >
            <option value="">Blank role</option>
            <optgroup label="Built-in templates">
              {Object.values(BUILT_IN_ROLES)
                .filter((t) => t.key !== "PLATFORM_SYSTEM_ADMINISTRATOR")
                .map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
            </optgroup>
            {customRoles.filter((r) => r.status === "ACTIVE").length > 0 && (
              <optgroup label="Custom roles">
                {customRoles
                  .filter((r) => r.status === "ACTIVE")
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Description</label>
        <input className="input" value={editor.description} onChange={(e) => patch({ description: e.target.value })} placeholder="What this role is for" />
      </div>

      <div>
        <h4 className="text-label mb-2">Permissions ({Object.keys(editor.allows).length} granted)</h4>
        <PermissionPicker
          effect="ALLOW"
          selected={editor.allows}
          onToggle={(k) => togglePerm("allows", k)}
          onScopeChange={(k, s) => setScope("allows", k, s)}
          enabledFlags={enabledFlags}
        />
      </div>

      <div>
        <h4 className="text-label mb-2">Explicit denials ({Object.keys(editor.denies).length})</h4>
        <p className="text-meta mb-2">A deny always wins over any allow — use it to carve exceptions out of a broad clone.</p>
        <PermissionPicker
          effect="DENY"
          selected={editor.denies}
          onToggle={(k) => togglePerm("denies", k)}
          onScopeChange={(k, s) => setScope("denies", k, s)}
          enabledFlags={enabledFlags}
        />
      </div>

      <div>
        <label className="label">Change reason {isEdit ? "(required)" : "(optional)"}</label>
        <input
          className="input"
          value={editor.changeReason}
          onChange={(e) => patch({ changeReason: e.target.value })}
          placeholder="Recorded in the role's version history"
        />
      </div>

      {/* Impact panel */}
      {isEdit && (impact || delta) && (
        <div className="space-y-2 rounded-lg bg-ink-50/70 p-3">
          <h4 className="text-label">Impact</h4>
          {impact && (
            <p className="text-sm text-ink-700">
              {impact.usersAssigned} user{impact.usersAssigned === 1 ? "" : "s"} hold this role
              {impact.activeCasesAffected > 0 ? ` · ${impact.activeCasesAffected} case-scoped assignment target(s)` : ""}.
            </p>
          )}
          {delta && (
            <div className="space-y-1.5">
              <DeltaChips label="Added" keys={delta.added} tone="success" />
              <DeltaChips label="Removed" keys={delta.removed} tone="neutral" />
              <DeltaChips label="Newly denied" keys={delta.newlyDenied} tone="danger" />
              {delta.criticalChanged.length > 0 && (
                <p className="flex items-start gap-1.5 text-sm text-red-700">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  Critical/privileged keys change: {delta.criticalChanged.join(", ")}. Affected sessions will refresh.
                </p>
              )}
              {delta.added.length + delta.removed.length + delta.newlyDenied.length === 0 && (
                <p className="text-meta">No permission changes yet.</p>
              )}
            </div>
          )}
        </div>
      )}
      {!isEdit && selectedCriticalNew.length > 0 && (
        <p className="flex items-start gap-1.5 text-sm text-amber-700">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          This role grants critical/privileged keys: {selectedCriticalNew.join(", ")}.
        </p>
      )}

      <ErrorNote message={saveError} />
      <div className="flex items-center gap-3">
        <button className={cn("btn-primary", confirmCritical && "bg-red-600 hover:bg-red-700")} disabled={!canSave} onClick={save}>
          {saving ? "Saving…" : confirmCritical ? "Confirm critical change" : isEdit ? "Save changes" : "Create role"}
        </button>
        {confirmCritical && (
          <button className="btn-outline" onClick={() => setConfirmCritical(false)}>
            Back
          </button>
        )}
        {isEdit && !editor.changeReason.trim() && <span className="text-meta">Enter a change reason to save.</span>}
      </div>
    </div>
  );
}

// ── Tab: Built-in roles ──────────────────────────────────────────────────────

function BuiltInTab({ onClone }: { onClone: (templateKey: string) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Object.values(BUILT_IN_ROLES).map((tpl) => {
        const operatorOnly = tpl.key === "PLATFORM_SYSTEM_ADMINISTRATOR";
        return (
          <div key={tpl.key} className="card flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink-900">{tpl.name}</h3>
              <Badge tone="info">Protected template</Badge>
            </div>
            <p className="mt-2 flex-1 text-sm text-ink-600">{tpl.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{tpl.permissions.length} permissions</Badge>
              <Badge tone="neutral">{tpl.defaultScope.toLowerCase()} scope</Badge>
              {tpl.externalFacing && <Badge tone="warning">external-facing</Badge>}
            </div>
            <div className="mt-4">
              <button
                className="btn-outline px-3 py-1.5 text-xs"
                disabled={operatorOnly}
                title={operatorOnly ? "Operator-only — every key is platform-only." : "Clone into a custom role"}
                onClick={() => onClone(tpl.key)}
              >
                <Copy className="h-3.5 w-3.5" /> Clone
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab: Custom roles ────────────────────────────────────────────────────────

function CustomRolesTab({
  customRoles,
  loading,
  error,
  editor,
  setEditor,
  editImpact,
  enabledFlags,
  notice,
  onNewRole,
  onEditRole,
  onSaved,
  onCancelEdit,
  onArchived,
}: {
  customRoles: CustomRoleDto[];
  loading: boolean;
  error: string | null;
  editor: EditorState | null;
  setEditor: (e: EditorState | null) => void;
  editImpact: ImpactDto | null;
  enabledFlags: Record<string, boolean>;
  notice: string | null;
  onNewRole: () => void;
  onEditRole: (role: CustomRoleDto) => void;
  onSaved: (notice: string | null) => void;
  onCancelEdit: () => void;
  onArchived: (notice: string) => void;
}) {
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  async function archive(role: CustomRoleDto) {
    if (confirmArchiveId !== role.id) {
      setConfirmArchiveId(role.id);
      return;
    }
    setConfirmArchiveId(null);
    setArchiveError(null);
    const res = await fetch(`/api/firm/roles/${role.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: role.version, status: "ARCHIVED", changeReason: "archived from Roles & Access" }),
    });
    const data = await res.json();
    if (!res.ok) {
      setArchiveError(data.error ?? "Archive failed");
      return;
    }
    onArchived(
      data.activeAssignments > 0
        ? `“${role.name}” archived. ${data.activeAssignments} active assignment(s) still reference it — review them under Assignments.`
        : `“${role.name}” archived.`,
    );
  }

  return (
    <div className="space-y-4">
      {notice && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>}
      <ErrorNote message={error ?? archiveError} />
      {editor ? (
        <RoleEditor
          editor={editor}
          setEditor={(e) => setEditor(e)}
          customRoles={customRoles}
          impact={editImpact}
          enabledFlags={enabledFlags}
          onSaved={onSaved}
          onCancel={onCancelEdit}
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-200 bg-ink-50 px-4 py-3">
            <h3 className="h-section">Custom roles</h3>
            <button className="btn-primary px-3 py-1.5 text-xs" onClick={onNewRole}>
              <Plus className="h-3.5 w-3.5" /> New role
            </button>
          </div>
          {loading ? (
            <div className="px-4">
              <Loading />
            </div>
          ) : customRoles.length === 0 ? (
            <p className="text-meta px-4 py-6">No custom roles yet. Clone a built-in template or start from a blank role.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Version</th>
                  <th className="px-4 py-2 font-medium">Permissions</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {customRoles.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-900">{r.name}</p>
                      <p className="text-xs text-ink-500">
                        {r.clonedFromSystemRole ? `Cloned from ${BUILT_IN_ROLES[r.clonedFromSystemRole]?.name ?? r.clonedFromSystemRole} · ` : ""}
                        {r.description ?? ""}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={r.status === "ACTIVE" ? "success" : r.status === "ARCHIVED" ? "neutral" : "warning"}>
                        {r.status.toLowerCase()}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink-700">v{r.version}</td>
                    <td className="px-4 py-3 text-ink-700">
                      {r.permissions.filter((p) => p.effect === "ALLOW").length} allowed
                      {r.permissions.some((p) => p.effect === "DENY")
                        ? ` · ${r.permissions.filter((p) => p.effect === "DENY").length} denied`
                        : ""}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === "ACTIVE" && (
                        <span className="flex items-center justify-end gap-3">
                          <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => onEditRole(r)}>
                            Edit
                          </button>
                          {confirmArchiveId === r.id ? (
                            <span className="flex items-center gap-2">
                              <button
                                className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700"
                                onClick={() => archive(r)}
                              >
                                Confirm archive
                              </button>
                              <button className="text-xs font-medium text-ink-500 hover:underline" onClick={() => setConfirmArchiveId(null)}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button className="text-xs font-medium text-red-600 hover:underline" onClick={() => archive(r)}>
                              Archive
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tab: Assignments ─────────────────────────────────────────────────────────

function AssignmentsTab({
  users,
  offices,
  customRoles,
}: {
  users: UserDto[] | null;
  offices: OfficeDto[] | null;
  customRoles: CustomRoleDto[];
}) {
  const [assignments, setAssignments] = useState<AssignmentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    userId: "",
    role: "", // "b:<templateKey>" | "c:<customRoleId>"
    scope: "org" as "org" | "office" | "case",
    officeId: "",
    caseId: "",
    responsibility: "",
    effectiveFrom: "",
    effectiveUntil: "",
    reason: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const officeById = useMemo(() => new Map((offices ?? []).map((o) => [o.id, o.name])), [offices]);

  const load = useCallback(async () => {
    const res = await fetch("/api/firm/assignments");
    const data = await res.json();
    if (res.ok) setAssignments(data.assignments ?? []);
    else setError(data.error ?? "Could not load assignments");
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    const body: Record<string, unknown> = { userId: form.userId };
    if (form.role.startsWith("b:")) body.builtInRole = form.role.slice(2);
    if (form.role.startsWith("c:")) body.customRoleId = form.role.slice(2);
    if (form.scope === "office" && form.officeId) body.officeId = form.officeId;
    if (form.scope === "case" && form.caseId.trim()) body.caseId = form.caseId.trim();
    if (form.responsibility.trim()) body.responsibility = form.responsibility.trim();
    if (form.effectiveFrom) body.effectiveFrom = new Date(form.effectiveFrom).toISOString();
    if (form.effectiveUntil) body.effectiveUntil = new Date(form.effectiveUntil).toISOString();
    if (form.reason.trim()) body.reason = form.reason.trim();
    const res = await fetch("/api/firm/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setFormError(data.error ?? "Could not create assignment");
      return;
    }
    setForm({ ...form, caseId: "", responsibility: "", effectiveFrom: "", effectiveUntil: "", reason: "" });
    load();
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/firm/assignments?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(revokeReason.trim() ? { reason: revokeReason.trim() } : {}),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not revoke assignment");
    setRevokingId(null);
    setRevokeReason("");
    load();
  }

  const activeCustomRoles = customRoles.filter((r) => r.status === "ACTIVE" && r.isAssignable);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Create */}
      <div className="card h-fit p-6">
        <h3 className="h-section flex items-center gap-2">
          <Plus className="h-4 w-4 text-brand-600" /> Assign a role
        </h3>
        <form onSubmit={create} className="mt-4 space-y-3">
          <div>
            <label className="label">User</label>
            <select className="input" required value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
              <option value="">Select a teammate…</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" required value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="">Select a role…</option>
              <optgroup label="Built-in templates">
                {Object.values(BUILT_IN_ROLES)
                  .filter((t) => t.key !== "PLATFORM_SYSTEM_ADMINISTRATOR")
                  .map((t) => (
                    <option key={t.key} value={`b:${t.key}`}>
                      {t.name}
                    </option>
                  ))}
              </optgroup>
              {activeCustomRoles.length > 0 && (
                <optgroup label="Custom roles">
                  {activeCustomRoles.map((r) => (
                    <option key={r.id} value={`c:${r.id}`}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div>
            <label className="label">Scope</label>
            <select
              className="input"
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value as typeof form.scope })}
            >
              <option value="org">Whole organization</option>
              <option value="office">One office</option>
              <option value="case">Single case</option>
            </select>
          </div>
          {form.scope === "office" && (
            <div>
              <label className="label">Office</label>
              <select className="input" required value={form.officeId} onChange={(e) => setForm({ ...form, officeId: e.target.value })}>
                <option value="">Select an office…</option>
                {(offices ?? [])
                  .filter((o) => !o.archivedAt)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {form.scope === "case" && (
            <div>
              <label className="label">Case ID</label>
              <input
                className="input"
                required
                placeholder="Paste the case ID"
                value={form.caseId}
                onChange={(e) => setForm({ ...form, caseId: e.target.value })}
              />
              <p className="text-meta mt-1">From the case URL: /cases/&lt;case-id&gt;.</p>
            </div>
          )}
          <div>
            <label className="label">Responsibility (optional)</label>
            <input
              className="input"
              placeholder="e.g. Primary Planner"
              value={form.responsibility}
              onChange={(e) => setForm({ ...form, responsibility: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Starts</label>
              <input
                className="input"
                type="datetime-local"
                value={form.effectiveFrom}
                onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Ends</label>
              <input
                className="input"
                type="datetime-local"
                value={form.effectiveUntil}
                onChange={(e) => setForm({ ...form, effectiveUntil: e.target.value })}
              />
            </div>
          </div>
          <p className="text-meta">Leave blank for immediate, open-ended access. A future start is scheduled; an end date expires automatically.</p>
          <div>
            <label className="label">Reason (optional)</label>
            <input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Recorded in the audit trail" />
          </div>
          <ErrorNote message={formError} />
          <button className="btn-primary w-full" disabled={busy || !form.userId || !form.role}>
            {busy ? "Assigning…" : "Assign role"}
          </button>
        </form>
      </div>

      {/* Table */}
      <div className="card lg:col-span-2 overflow-x-auto">
        <ErrorNote message={error} />
        {assignments === null ? (
          <div className="px-4">
            <Loading />
          </div>
        ) : assignments.length === 0 ? (
          <p className="text-meta px-4 py-6">No role assignments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Scope</th>
                <th className="px-4 py-3 font-medium">Window</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {assignments.map((a) => (
                <tr key={a.id} className="hover:bg-ink-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink-900">{a.user?.name ?? a.userId}</p>
                    <p className="text-xs text-ink-500">{a.user?.email ?? ""}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-ink-800">{a.roleLabel}</p>
                    <p className="text-xs text-ink-400">
                      {a.roleKind}
                      {a.responsibility ? ` · ${a.responsibility}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-ink-700">
                    {a.caseId ? (
                      <span title={a.caseId}>Case {a.caseId.slice(0, 8)}…</span>
                    ) : a.officeId ? (
                      `Office · ${officeById.get(a.officeId) ?? a.officeId}`
                    ) : (
                      "Organization"
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-600">
                    {formatDate(a.effectiveFrom)} → {a.effectiveUntil ? formatDate(a.effectiveUntil) : "open-ended"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      tone={
                        a.status === "ACTIVE" ? "success" : a.status === "SCHEDULED" ? "info" : a.status === "REVOKED" ? "danger" : "neutral"
                      }
                    >
                      {a.status.toLowerCase()}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(a.status === "ACTIVE" || a.status === "SCHEDULED") &&
                      (revokingId === a.id ? (
                        <span className="flex items-center justify-end gap-2">
                          <input
                            className="input w-40 py-1 text-xs"
                            placeholder="Reason"
                            value={revokeReason}
                            onChange={(e) => setRevokeReason(e.target.value)}
                          />
                          <button
                            className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
                            onClick={() => revoke(a.id)}
                          >
                            Revoke
                          </button>
                          <button
                            className="text-xs font-medium text-ink-500 hover:underline"
                            onClick={() => {
                              setRevokingId(null);
                              setRevokeReason("");
                            }}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button className="text-xs font-medium text-red-600 hover:underline" onClick={() => setRevokingId(a.id)}>
                          Revoke
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Tab: Permission matrix ───────────────────────────────────────────────────

function MatrixTab() {
  const [matrix, setMatrix] = useState<MatrixDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/firm/roles?matrix=1");
      const data = await res.json();
      if (res.ok) setMatrix(data.matrix);
      else setError(data.error ?? "Could not load the matrix");
    })();
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!matrix) return <Loading />;

  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
        <h3 className="h-section">Role × permission matrix</h3>
        <p className="text-meta">
          ✓ allowed · D explicitly denied · ✗ not granted — generated {formatDate(matrix.generatedAt)}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs" style={{ minWidth: `${16 + matrix.roles.length * 7}rem` }}>
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50">
              <th className="sticky left-0 z-10 bg-ink-50 px-4 py-2 text-left font-medium text-ink-600">Permission</th>
              {matrix.roles.map((r) => (
                <th key={r.id} className="px-2 py-2 text-center align-bottom font-medium text-ink-700">
                  <span className="block max-w-[7rem] whitespace-normal">{r.name}</span>
                  <span className="text-[10px] font-normal text-ink-400">
                    {r.kind}
                    {r.status !== "ACTIVE" ? ` · ${r.status.toLowerCase()}` : ""}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {matrix.permissionKeys.map((key) => {
              const def = PERMISSION_REGISTRY[key];
              return (
                <tr key={key} className="hover:bg-ink-50">
                  <td
                    className={cn(
                      "sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-1.5",
                      isCriticalKey(key) && "border-l-2 border-red-400",
                    )}
                  >
                    <span className="font-medium text-ink-800">{def?.name ?? key}</span>{" "}
                    <code className="text-[10px] text-ink-400">{key}</code>
                  </td>
                  {matrix.roles.map((r) => {
                    const cell = r.permissions[key];
                    return (
                      <td key={r.id} className="px-2 py-1.5 text-center">
                        {cell === "ALLOW" ? (
                          <span className="font-semibold text-emerald-600">✓</span>
                        ) : cell === "DENY" ? (
                          <span className="font-bold text-red-600">D</span>
                        ) : (
                          <span className="text-ink-300">✗</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab: Access review ───────────────────────────────────────────────────────

interface PreviewResult {
  allowed: boolean;
  denialCode: string | null;
  userSafeReason: string | null;
  explanation: string[];
}

function AccessReviewTab({ users }: { users: UserDto[] | null }) {
  const [form, setForm] = useState({ userId: "", permission: "", caseId: "", reportType: "", workflowStage: "" });
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const body: Record<string, unknown> = { userId: form.userId, permission: form.permission };
    if (form.caseId.trim()) body.caseId = form.caseId.trim();
    if (form.reportType.trim()) body.reportType = form.reportType.trim();
    if (form.workflowStage.trim()) body.workflowStage = form.workflowStage.trim();
    const res = await fetch("/api/firm/authz-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Preview failed");
      return;
    }
    setResult(data);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="card h-fit p-6">
        <h3 className="h-section">Why can / can’t this user do X?</h3>
        <p className="text-meta mt-1">Dry-runs the enterprise evaluator against the user’s real roles, grants, and credentials. Nothing changes.</p>
        <form onSubmit={run} className="mt-4 space-y-3">
          <div>
            <label className="label">User</label>
            <select className="input" required value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
              <option value="">Select a teammate…</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Permission</label>
            <select className="input" required value={form.permission} onChange={(e) => setForm({ ...form, permission: e.target.value })}>
              <option value="">Select an action…</option>
              {CATEGORY_GROUPS.map((g) => (
                <optgroup key={g.category} label={g.category}>
                  {g.keys.map((k) => (
                    <option key={k} value={k}>
                      {PERMISSION_REGISTRY[k]?.name ?? k} ({k})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Case ID (optional)</label>
            <input className="input" value={form.caseId} onChange={(e) => setForm({ ...form, caseId: e.target.value })} placeholder="Evaluate within a specific case" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Report type (optional)</label>
              <input
                className="input"
                value={form.reportType}
                onChange={(e) => setForm({ ...form, reportType: e.target.value })}
                placeholder="e.g. medical_chronology"
              />
            </div>
            <div>
              <label className="label">Workflow stage (optional)</label>
              <input
                className="input"
                value={form.workflowStage}
                onChange={(e) => setForm({ ...form, workflowStage: e.target.value })}
                placeholder="e.g. REVIEW"
              />
            </div>
          </div>
          <ErrorNote message={error} />
          <button className="btn-primary" disabled={busy || !form.userId || !form.permission}>
            {busy ? "Evaluating…" : "Evaluate access"}
          </button>
        </form>
      </div>

      <div className="card h-fit p-6">
        <h3 className="h-section">Result</h3>
        {result === null ? (
          <p className="text-meta mt-2">Run an evaluation to see the decision and the rule that decided it.</p>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="flex items-center gap-2">
              <Badge tone={result.allowed ? "success" : "danger"} className="text-sm">
                {result.allowed ? "ALLOWED" : "DENIED"}
              </Badge>
              {result.denialCode && <code className="text-xs text-ink-500">{result.denialCode}</code>}
            </div>
            {result.userSafeReason && !result.allowed && <p className="text-sm text-ink-700">{result.userSafeReason}</p>}
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
              {result.explanation.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tab: History ─────────────────────────────────────────────────────────────

function HistoryTab({ customRoles, users }: { customRoles: CustomRoleDto[]; users: UserDto[] | null }) {
  const [roleId, setRoleId] = useState("");
  const [versions, setVersions] = useState<VersionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userById = useMemo(() => new Map((users ?? []).map((u) => [u.id, u.name])), [users]);

  useEffect(() => {
    if (!roleId) {
      setVersions(null);
      return;
    }
    (async () => {
      setVersions(null);
      setError(null);
      const res = await fetch(`/api/firm/roles/${roleId}`);
      const data = await res.json();
      if (res.ok) setVersions(data.versions ?? []);
      else setError(data.error ?? "Could not load history");
    })();
  }, [roleId]);

  return (
    <div className="space-y-4">
      <div className="card p-6">
        <h3 className="h-section">Role version history</h3>
        <p className="text-meta mt-1">Every permission change writes an immutable version snapshot with who changed it and why.</p>
        <select className="input mt-3 max-w-md" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">Select a custom role…</option>
          {customRoles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.status.toLowerCase()}, v{r.version})
            </option>
          ))}
        </select>
        {customRoles.length === 0 && <p className="text-meta mt-2">No custom roles yet — built-in templates are immutable and have no history.</p>}
        <ErrorNote message={error} />
        {roleId && versions === null && !error && <Loading />}
        {versions && (
          <table className="mt-4 w-full text-sm">
            <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Changed by</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="px-3 py-2 tabular-nums text-ink-800">v{v.version}</td>
                  <td className="px-3 py-2 text-ink-700">{userById.get(v.changedById) ?? v.changedById}</td>
                  <td className="px-3 py-2 text-ink-700">{v.changeReason ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-ink-500">{formatDate(v.createdAt)}</td>
                </tr>
              ))}
              {versions.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-meta px-3 py-3">
                    No versions recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-meta">
        Assignment events (assign, revoke, access previews of privileged keys) are recorded in the{" "}
        <Link href="/settings/audit" className="font-medium text-brand-700 hover:underline">
          firm Audit Log
        </Link>
        .
      </p>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

type Tab = "builtin" | "custom" | "assignments" | "matrix" | "review" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "builtin", label: "Built-in Roles" },
  { id: "custom", label: "Custom Roles" },
  { id: "assignments", label: "Assignments" },
  { id: "matrix", label: "Permission Matrix" },
  { id: "review", label: "Access Review" },
  { id: "history", label: "History" },
];

export function RolesAccess({ enabledFlags }: { enabledFlags: Record<string, boolean> }) {
  const [tab, setTab] = useState<Tab>("builtin");
  const [customRoles, setCustomRoles] = useState<CustomRoleDto[] | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [offices, setOffices] = useState<OfficeDto[] | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editImpact, setEditImpact] = useState<ImpactDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadRoles = useCallback(async () => {
    const res = await fetch("/api/firm/roles");
    const data = await res.json();
    if (res.ok) setCustomRoles(data.customRoles ?? []);
    else setRolesError(data.error ?? "Could not load roles");
  }, []);

  const loadUsers = useCallback(async () => {
    const res = await fetch("/api/team");
    const data = await res.json();
    if (res.ok) setUsers(data.users ?? []);
  }, []);

  const loadOffices = useCallback(async () => {
    const res = await fetch("/api/firm/offices");
    const data = await res.json();
    if (res.ok) setOffices(data.offices ?? []);
  }, []);

  useEffect(() => {
    if ((tab === "custom" || tab === "assignments" || tab === "matrix" || tab === "history") && customRoles === null) loadRoles();
    if ((tab === "assignments" || tab === "review" || tab === "history") && users === null) loadUsers();
    if (tab === "assignments" && offices === null) loadOffices();
  }, [tab, customRoles, users, offices, loadRoles, loadUsers, loadOffices]);

  function openBlankEditor(cloneFrom?: string) {
    setNotice(null);
    setEditImpact(null);
    const prefill = cloneFrom ? permsFromSource(cloneFrom, customRoles ?? []) : { allows: {}, denies: {} };
    setEditor({
      roleId: null,
      expectedVersion: 1,
      name: "",
      description: "",
      cloneFrom: cloneFrom ?? "",
      permsDirty: false,
      ...prefill,
      changeReason: "",
    });
    setTab("custom");
  }

  async function openRoleEditor(role: CustomRoleDto) {
    setNotice(null);
    const allows: Record<string, string> = {};
    const denies: Record<string, string> = {};
    for (const p of role.permissions) {
      const key = resolveKey(p.permissionKey);
      if (p.effect === "DENY") denies[key] = p.scopeType;
      else allows[key] = p.scopeType;
    }
    setEditor({
      roleId: role.id,
      expectedVersion: role.version,
      name: role.name,
      description: role.description ?? "",
      cloneFrom: "",
      permsDirty: false,
      allows,
      denies,
      changeReason: "",
    });
    // Impact of the role as configured: who holds it, what a change would touch.
    setEditImpact(null);
    const res = await fetch(`/api/firm/roles/${role.id}`);
    const data = await res.json();
    if (res.ok) setEditImpact(data.impact ?? null);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-1 rounded-xl bg-ink-100 p-1" role="tablist" aria-label="Roles and access">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition",
              tab === t.id ? "bg-white text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-800",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "builtin" && <BuiltInTab onClone={(key) => openBlankEditor(key)} />}
      {tab === "custom" && (
        <CustomRolesTab
          customRoles={customRoles ?? []}
          loading={customRoles === null}
          error={rolesError}
          editor={editor}
          setEditor={(e) => setEditor(e)}
          editImpact={editImpact}
          enabledFlags={enabledFlags}
          notice={notice}
          onNewRole={() => openBlankEditor()}
          onEditRole={openRoleEditor}
          onSaved={(n) => {
            setEditor(null);
            setEditImpact(null);
            setNotice(n ?? "Role saved.");
            loadRoles();
          }}
          onCancelEdit={() => {
            setEditor(null);
            setEditImpact(null);
          }}
          onArchived={(n) => {
            setNotice(n);
            loadRoles();
          }}
        />
      )}
      {tab === "assignments" && <AssignmentsTab users={users} offices={offices} customRoles={customRoles ?? []} />}
      {tab === "matrix" && <MatrixTab />}
      {tab === "review" && <AccessReviewTab users={users} />}
      {tab === "history" && <HistoryTab customRoles={customRoles ?? []} users={users} />}
    </div>
  );
}
