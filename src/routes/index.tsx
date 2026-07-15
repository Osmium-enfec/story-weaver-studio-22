import { createFileRoute, redirect } from "@tanstack/react-router";
import { getLastProjectId } from "@/lib/compose-last-project";

/** Home always opens the Compose workflow (not the legacy scene workshop). */
export const Route = createFileRoute("/")({
  ssr: false,
  beforeLoad: () => {
    const last = getLastProjectId();
    throw redirect({
      to: "/compose",
      search: last ? { project: last } : {},
    });
  },
});
