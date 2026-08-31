import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { apiLogout } from "@/lib/auth-api";
import {
  clearAuthSession,
  getStoredSession,
  getStoredSessionToken,
  subscribeAuth,
} from "@/lib/auth-client";
import { Sparkles, LogOut, FolderOpen, Film, Shield, Upload, Loader2, PackageOpen } from "lucide-react";
import { isAdminEmail } from "@/lib/admin";

export function NavBar() {
  const [email, setEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushHint, setPushHint] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    function sync() {
      const session = getStoredSession();
      setEmail(session?.user.email ?? null);
      setIsAdmin(
        session?.user.isAdmin === true || isAdminEmail(session?.user.email),
      );
      setLoaded(true);
    }
    sync();
    return subscribeAuth(sync);
  }, []);

  async function signOut() {
    try {
      await apiLogout();
    } catch {
      /* clear local session even if server logout fails */
    }
    clearAuthSession();
    navigate({ to: "/compose", search: {}, replace: true });
  }

  const pushAssignments = useCallback(async () => {
    const token = getStoredSessionToken();
    if (!token) {
      setPushHint("Sign in required");
      return;
    }
    setPushBusy(true);
    setPushHint(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: "pushAssignments" }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `Push failed (${res.status})`);
      setPushHint(data.message || "Assignments pushed.");
    } catch (e: unknown) {
      setPushHint(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
    }
  }, []);

  return (
    <nav className="border-b bg-background/80 backdrop-blur sticky top-0 z-40">
      <div className="flex w-full items-center justify-between px-4 py-3 xl:px-8">
        <Link to="/courses" className="flex items-center gap-2 font-semibold">
          <Sparkles size={18} className="text-primary" />
          <span>Explainer Studio</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {loaded && email ? (
            <>
              {isAdmin && (
                <div className="relative inline-flex flex-col items-end">
                  <button
                    type="button"
                    disabled={pushBusy}
                    onClick={() => void pushAssignments()}
                    title="Publish assignments so collaborators can Get latest data"
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                  >
                    {pushBusy ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Upload size={12} />
                    )}
                    Push assignments
                  </button>
                  {pushHint && (
                    <span className="absolute top-full right-0 z-50 mt-1 max-w-[260px] whitespace-normal rounded border bg-popover px-2 py-1 text-[10px] text-muted-foreground shadow">
                      {pushHint}
                    </span>
                  )}
                </div>
              )}
              <Link
                to="/export"
                search={{}}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
              >
                <Film size={14} /> Export
              </Link>
              {isAdmin && (
                <Link
                  to="/admin"
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
                >
                  <Shield size={14} /> Admin
                </Link>
              )}
              {isAdmin && (
                <Link
                  to="/import-pack"
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
                >
                  <PackageOpen size={14} /> Import pack
                </Link>
              )}
              <Link
                to="/courses"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
              >
                <FolderOpen size={14} /> My Courses
              </Link>
              <span className="text-xs text-muted-foreground hidden sm:inline">{email}</span>
              <button
                onClick={signOut}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
              >
                <LogOut size={12} /> Sign out
              </button>
            </>
          ) : loaded ? (
            <Link
              to="/auth"
              className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-xs font-medium hover:opacity-90"
            >
              Sign in
            </Link>
          ) : null}
        </div>
      </div>
    </nav>
  );
}
