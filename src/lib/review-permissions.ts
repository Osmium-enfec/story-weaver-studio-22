/** Column-level edit rules for the shared review sheet. */

export const REVIEWER_EMAILS = ["imshweta@gmail.com", "shweta.singh@enfec.com"];

export type ReviewField =
  | "script_status"
  | "recording_status"
  | "review_status"
  | "issues_found"
  | "assignee_email"
  | "correction_status"
  | "rendered_uploaded";

export const REVIEW_FIELDS: ReviewField[] = [
  "script_status",
  "recording_status",
  "review_status",
  "issues_found",
  "assignee_email",
  "correction_status",
  "rendered_uploaded",
];

function norm(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function isReviewerEmail(email: string | null | undefined): boolean {
  return REVIEWER_EMAILS.includes(norm(email));
}

export type ReviewActor = {
  email: string;
  isAdmin: boolean;
};

export type ReviewRowContext = {
  /** Person the part is assigned to for composing (from the assignment sheet). */
  composerEmail: string | null;
  /** Person assigned to fix / follow up the review. */
  reviewAssigneeEmail: string | null;
};

export function canEditReviewField(
  field: ReviewField,
  actor: ReviewActor,
  row: ReviewRowContext,
): boolean {
  if (actor.isAdmin) return true;
  const me = norm(actor.email);
  const composer = norm(row.composerEmail);
  const reviewAssignee = norm(row.reviewAssigneeEmail);

  switch (field) {
    case "script_status":
    case "recording_status":
      return me.length > 0 && me === composer;
    case "review_status":
    case "issues_found":
    case "assignee_email":
      return isReviewerEmail(me);
    case "correction_status":
      return me.length > 0 && (me === composer || me === reviewAssignee);
    case "rendered_uploaded":
      return false;
  }
}
