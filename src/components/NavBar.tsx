import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { logout } from "@/lib/auth.functions";
import {
  clearAuthSession,
  getStoredSession,
  subscribeAuth,
} from "@/lib/auth-client";
import { Sparkles, LogOut, FolderOpen } from "lucide-react";

export function NavBar() {
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const navigate = useNavigate();
  const runLogout = useServerFn(logout);

  useEffect(() => {
    function sync() {
      setEmail(getStoredSession()?.user.email ?? null);
      setLoaded(true);
    }
    sync();
    return subscribeAuth(sync);
  }, []);

  async function signOut() {
    try {
      await runLogout();
    } catch {
      /* clear local session even if server logout fails */
    }
    clearAuthSession();
    navigate({ to: "/compose", replace: true });
  }

  return (
    <nav className="border-b bg-background/80 backdrop-blur sticky top-0 z-40">
      <div className="flex w-full items-center justify-between px-4 py-3 xl:px-8">
        <Link to="/compose" className="flex items-center gap-2 font-semibold">
          <Sparkles size={18} className="text-primary" />
          <span>Explainer Studio</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {loaded && email ? (
            <>
              <Link
                to="/compose"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
              >
                Compose
              </Link>
              <Link
                to="/projects"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
              >
                <FolderOpen size={14} /> My Project
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
