import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { getStoredSession } from "@/lib/auth-client";
import { useReviewOnly } from "@/hooks/useReviewOnly";

function AuthenticatedLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { reviewOnly } = useReviewOnly();

  useEffect(() => {
    if (reviewOnly && !pathname.startsWith("/review")) {
      void navigate({ to: "/review", replace: true });
    }
  }, [reviewOnly, pathname, navigate]);

  if (reviewOnly && !pathname.startsWith("/review")) return null;
  return <Outlet />;
}

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const session = getStoredSession();
    if (!session?.user) throw redirect({ to: "/auth" });
    return { user: session.user };
  },
  component: AuthenticatedLayout,
});
