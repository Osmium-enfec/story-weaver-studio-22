import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy /projects → My Courses. */
export const Route = createFileRoute("/_authenticated/projects")({
  beforeLoad: () => {
    throw redirect({ to: "/courses" });
  },
});
