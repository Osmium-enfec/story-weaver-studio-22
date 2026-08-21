import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy /project/$id → /episode/$id. */
export const Route = createFileRoute("/_authenticated/project/$id")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/episode/$id", params: { id: params.id } });
  },
});
