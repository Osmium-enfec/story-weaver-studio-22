import { useQuery } from "@tanstack/react-query";
import { apiReviewGrants } from "@/lib/reviews-api";

/**
 * Round-2 reviewers are course-wide reviewers: they get the Review page only,
 * no course / episode / compose access. A user counts as review-only when an
 * admin granted them the "Issues Found (R2)" column and they are not an admin.
 */
export function useReviewOnly(): { loading: boolean; reviewOnly: boolean } {
  const { data, isPending } = useQuery({
    queryKey: ["review-grants"],
    queryFn: () => apiReviewGrants(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const reviewOnly =
    !!data && !data.isAdmin && !!data.fields?.includes("issues_found_2");
  return { loading: isPending, reviewOnly };
}
