import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import {
  apiAdminReviewAccess,
  apiAdminSetReviewAccess,
  type ReviewAccessUser,
} from "@/lib/admin-api";

const FIELDS: Array<{ id: string; label: string }> = [
  { id: "script_status", label: "Script" },
  { id: "recording_status", label: "Screen Recording" },
  { id: "review_status", label: "Review Status" },
  { id: "issues_found", label: "Issues Found" },
  { id: "assignee_email", label: "Review Assignment" },
  { id: "correction_status", label: "Correction Status" },
  { id: "rendered_uploaded", label: "Rendered & Uploaded" },
];

export function ReviewAccessSheet() {
  const [users, setUsers] = useState<ReviewAccessUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingEmail, setSavingEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setUsers(await apiAdminReviewAccess());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Effective access: explicit grant if saved, otherwise built-in rules. */
  function effective(user: ReviewAccessUser): string[] {
    return user.hasExplicit ? user.fields : (user.implicit ?? []);
  }

  async function toggle(user: ReviewAccessUser, field: string) {
    const current = effective(user);
    const next = current.includes(field)
      ? current.filter((f) => f !== field)
      : [...current, field];
    setUsers((prev) =>
      (prev ?? []).map((u) =>
        u.id === user.id ? { ...u, fields: next, hasExplicit: true } : u,
      ),
    );
    setSavingEmail(user.email);
    try {
      const saved = await apiAdminSetReviewAccess(user.email, next);
      setUsers((prev) =>
        (prev ?? []).map((u) =>
          u.id === user.id ? { ...u, fields: saved, hasExplicit: true } : u,
        ),
      );
    } catch (e: unknown) {
      setUsers((prev) =>
        (prev ?? []).map((u) =>
          u.id === user.id
            ? { ...u, fields: user.fields, hasExplicit: user.hasExplicit }
            : u,
        ),
      );
      setError(e instanceof Error ? e.message : "Could not save access");
    } finally {
      setSavingEmail(null);
    }
  }

  return (
    <div>
      <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck size={13} />
        Tick a column to let that person edit it for every row on the review
        page. Saving once turns built-in defaults into an editable explicit
        grant. Admins can always edit everything.
      </p>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              {FIELDS.map((f) => (
                <th key={f.id} className="px-3 py-2 text-center font-medium">
                  {f.label}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Current access</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id} className="border-b">
                <td className="px-3 py-2">
                  {u.email}
                  {u.isAdmin && (
                    <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                      admin
                    </span>
                  )}
                  {savingEmail === u.email && (
                    <Loader2
                      size={12}
                      className="ml-2 inline animate-spin text-muted-foreground"
                    />
                  )}
                </td>
                {FIELDS.map((f) => {
                  const on = effective(u).includes(f.id);
                  return (
                    <td key={f.id} className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[hsl(var(--primary))]"
                        checked={u.isAdmin || on}
                        disabled={u.isAdmin}
                        title={
                          u.isAdmin ? "Admins can always edit everything" : undefined
                        }
                        onChange={() => void toggle(u, f.id)}
                      />
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {(() => {
                    const all = u.isAdmin ? FIELDS.map((f) => f.id) : effective(u);
                    const labels = FIELDS.filter((f) =>
                      new Set(all).has(f.id),
                    ).map((f) => f.label);
                    return (
                      <>
                        {labels.length > 0 ? (
                          labels.join(", ")
                        ) : (
                          <span className="italic">None</span>
                        )}
                        {!u.isAdmin && !u.hasExplicit && (u.implicit ?? []).length > 0 && (
                          <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            built-in default
                          </span>
                        )}
                      </>
                    );
                  })()}
                </td>
              </tr>
            ))}
            {users && users.length === 0 && (
              <tr>
                <td
                  colSpan={FIELDS.length + 2}
                  className="px-3 py-6 text-sm text-muted-foreground"
                >
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
