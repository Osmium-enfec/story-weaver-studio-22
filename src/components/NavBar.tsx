import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles, LogOut, FolderOpen } from "lucide-react";

export function NavBar() {
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setLoaded(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setEmail(s?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/", replace: true });
  }

  return (
    <nav className="border-b bg-background/80 backdrop-blur sticky top-0 z-40">
      <div className="mx-auto max-w-5xl px-6 py-3 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <Sparkles size={18} className="text-primary" />
          <span>Explainer Studio</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {loaded && email ? (
            <>
              <Link
                to="/projects"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
              >
                <FolderOpen size={14} /> My Projects
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
