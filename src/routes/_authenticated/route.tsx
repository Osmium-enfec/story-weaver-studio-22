import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getStoredSession } from "@/lib/auth-client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const session = getStoredSession();
    if (!session?.user) throw redirect({ to: "/auth" });
    return { user: session.user };
  },
  component: () => <Outlet />,
});
