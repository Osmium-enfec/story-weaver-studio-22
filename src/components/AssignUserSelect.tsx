import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, UserRound } from "lucide-react";
import { apiAdminUsersOnly } from "@/lib/admin-api";
import {
  getStoredSession,
  subscribeAuth,
} from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin";

export function useIsAdminClient(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    function sync() {
      const session = getStoredSession();
      setIsAdmin(
        session?.user.isAdmin === true || isAdminEmail(session?.user.email),
      );
    }
    sync();
    return subscribeAuth(sync);
  }, []);
  return isAdmin;
}

export function WorkingOnLabel({
  episodeEmail,
  partEmails,
}: {
  episodeEmail?: string | null;
  partEmails?: string[];
}) {
  const parts = (partEmails ?? []).filter(Boolean);
  const episode = episodeEmail?.trim() || null;
  if (!episode && parts.length === 0) {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <UserRound size={12} className="shrink-0 opacity-70" />
        Unassigned
      </p>
    );
  }
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {episode && (
        <p className="flex items-start gap-1">
          <UserRound size={12} className="mt-0.5 shrink-0 opacity-70" />
          <span>
            Episode: <span className="text-foreground/80">{episode}</span>
          </span>
        </p>
      )}
      {parts.length > 0 && (
        <p className="flex items-start gap-1">
          <UserRound size={12} className="mt-0.5 shrink-0 opacity-70" />
          <span>
            Parts: <span className="text-foreground/80">{parts.join(", ")}</span>
          </span>
        </p>
      )}
    </div>
  );
}

export function AssignUserSelect({
  valueUserId,
  valueEmail,
  onAssign,
  disabled,
  label = "Assign user",
}: {
  valueUserId?: string | null;
  valueEmail?: string | null;
  onAssign: (userId: string | null) => Promise<void>;
  disabled?: boolean;
  label?: string;
}) {
  const isAdmin = useIsAdminClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ["admin", "users-for-assign"],
    queryFn: async () => {
      const list = await apiAdminUsersOnly();
      return list
        .filter((u) => !u.isAdmin)
        .map((u) => ({ id: u.id, email: u.email }))
        .sort((a, b) => a.email.localeCompare(b.email));
    },
    enabled: isAdmin,
    staleTime: 60_000,
  });

  if (!isAdmin) {
    return null;
  }

  async function handleChange(next: string) {
    setError(null);
    setSaving(true);
    try {
      await onAssign(next ? next : null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not assign");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 space-y-1">
      <label className="block text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <select
          value={valueUserId ?? ""}
          disabled={disabled || saving || isLoading}
          onChange={(e) => void handleChange(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
        >
          <option value="">Unassigned</option>
          {users?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>
        {(saving || isLoading) && (
          <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
