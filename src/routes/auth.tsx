import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { login, register } from "@/lib/auth.functions";
import { getStoredSession, persistAuthSession } from "@/lib/auth-client";
import { Loader2, Sparkles } from "lucide-react";
import { NavBar } from "@/components/NavBar";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Explainer Studio" },
      { name: "description", content: "Sign in or create an account to save your explainer videos." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const runLogin = useServerFn(login);
  const runRegister = useServerFn(register);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (getStoredSession()) navigate({ to: "/compose", replace: true });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const result =
        mode === "signin"
          ? await runLogin({ data: { email, password } })
          : await runRegister({ data: { email, password } });
      persistAuthSession({ token: result.token, user: result.user });
      navigate({ to: "/compose" });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="mb-6 text-center">
          <Sparkles className="mx-auto text-primary" size={28} />
          <h1 className="mt-2 text-2xl font-bold">
            {mode === "signin" ? "Welcome back" : "Create account"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Local SQLite storage — no cloud account required.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="Password (min 6 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {err && <div className="text-sm text-destructive">{err}</div>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="mt-4 text-center text-sm">
          {mode === "signin" ? (
            <button
              type="button"
              onClick={() => setMode("signup")}
              className="text-muted-foreground hover:text-foreground"
            >
              Need an account? Sign up
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setMode("signin")}
              className="text-muted-foreground hover:text-foreground"
            >
              Already have an account? Sign in
            </button>
          )}
        </div>

        <div className="mt-6 text-center text-xs">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
