/** Column-level edit rules for the shared review sheet. */

export const REVIEWER_EMAILS = [
  "imshweta@gmail.com",
  "shweta.singh@enfec.com",
  "balaji.chokkara@enfec.com",
];

export type ReviewField =
  | "script_status"
  | "recording_status"
  | "review_status"
  | "issues_found"
  | "assignee_email"
  | "correction_status"
  | "review_doc"
  | "rendered_uploaded";

export const REVIEW_FIELDS: ReviewField[] = [
  "script_status",
  "recording_status",
  "review_status",
  "issues_found",
  "assignee_email",
  "correction_status",
  "review_doc",
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
  /**
   * Columns granted by an admin (review access page). When a grant record
   * exists for this user it fully overrides the built-in reviewer rules —
   * pass the array (possibly empty). Pass null/undefined when no record
   * exists to fall back to built-in behaviour.
   */
  grantedFields?: ReviewField[] | null;
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
  // An explicit admin-managed grant replaces the built-in rules entirely.
  if (actor.grantedFields) return actor.grantedFields.includes(field);
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
    case "review_doc":
      return isReviewerEmail(me);
    case "correction_status":
      return me.length > 0 && (me === composer || me === reviewAssignee);
    case "rendered_uploaded":
      return false;
  }
}

