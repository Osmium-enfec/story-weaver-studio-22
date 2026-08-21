import { createFileRoute, redirect } from "@tanstack/react-router";

/** Home opens My Courses after sign-in. */
export const Route = createFileRoute("/")({
  ssr: false,
  beforeLoad: () => {
    throw redirect({ to: "/courses" });
  },
});
