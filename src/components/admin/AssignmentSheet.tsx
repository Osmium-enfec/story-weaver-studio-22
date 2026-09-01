import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { apiAdminUsersOnly } from "@/lib/admin-api";
import {
  apiAssignEpisode,
  apiAssignPart,
  apiListProjects,
  type ProjectListItem,
} from "@/lib/projects-api";

type CourseOption = { id: string; title: string; episode_count: number };

function episodeOrder(a: ProjectListItem, b: ProjectListItem): number {
  const num = (t: string) => {
    const m = t.match(/(\d+)/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  const d = num(a.title) - num(b.title);
  if (d !== 0 && Number.isFinite(d)) return d;
  return a.title.localeCompare(b.title);
}

/** Spreadsheet-style assignment editor: course → episodes → parts. */
export function AssignmentSheet({ courses }: { courses: CourseOption[] }) {
  const [courseId, setCourseId] = useState<string>(courses[0]?.id ?? "");
  const [episodes, setEpisodes] = useState<ProjectListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!courseId && courses[0]) setCourseId(courses[0].id);
  }, [courses, courseId]);

  const { data: users } = useQuery({
    queryKey: ["admin", "users-for-assign"],
    queryFn: async () => {
      const list = await apiAdminUsersOnly();
      return list
        .filter((u) => !u.isAdmin)
        .map((u) => ({ id: u.id, email: u.email }))
        .sort((a, b) => a.email.localeCompare(b.email));
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiListProjects({ courseId })
      .then((rows) => {
        if (!cancelled) setEpisodes([...rows].sort(episodeOrder));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const rows = useMemo(() => {
    if (!episodes) return [];
    return episodes.map((ep) => ({
      ep,
      parts: ep.parts_summary ?? [],
    }));
  }, [episodes]);

  function applyLocal(
    episodeId: string,
    partId: string | null,
    userId: string | null,
  ) {
    const email = users?.find((u) => u.id === userId)?.email ?? null;
    setEpisodes((prev) =>
      (prev ?? []).map((ep) => {
        if (ep.id !== episodeId) return ep;
        if (!partId) {
          return { ...ep, assigned_user_id: userId, assigned_user_email: email };
        }
        return {
          ...ep,
          parts_summary: (ep.parts_summary ?? []).map((p) =>
            p.id === partId
              ? { ...p, assigned_user_id: userId, assigned_user_email: email }
              : p,
          ),
        };
      }),
    );
  }

  async function assign(
    episodeId: string,
    partId: string | null,
    userId: string | null,
  ) {
    const key = `${episodeId}:${partId ?? "ep"}`;
    setSavingKey(key);
    setError(null);
    try {
      if (partId) await apiAssignPart(episodeId, partId, userId);
      else await apiAssignEpisode(episodeId, userId);
      applyLocal(episodeId, partId, userId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not assign");
    } finally {
      setSavingKey(null);
    }
  }

  function AssigneeSelect({
    episodeId,
    partId,
    value,
  }: {
    episodeId: string;
    partId: string | null;
    value: string | null;
  }) {
    const key = `${episodeId}:${partId ?? "ep"}`;
    const busy = savingKey === key;
    return (
      <div className="flex items-center gap-1.5">
        <select
          value={value ?? ""}
          disabled={busy}
          onChange={(e) => void assign(episodeId, partId, e.target.value || null)}
          className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs"
        >
          <option value="">Unassigned</option>
          {users?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>
        {busy && <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-muted-foreground">Course</label>
        <select
          value={courseId}
          onChange={(e) => setCourseId(e.target.value)}
          className="h-9 min-w-[16rem] rounded-md border bg-background px-2 text-sm"
        >
          {courses.length === 0 && <option value="">No courses</option>}
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} ({c.episode_count})
            </option>
          ))}
        </select>
        {loading && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="w-56 border-r px-3 py-2 font-medium">Episode</th>
              <th className="w-56 border-r px-3 py-2 font-medium">Part</th>
              <th className="w-24 border-r px-3 py-2 font-medium">Scenes</th>
              <th className="px-3 py-2 font-medium">Assigned to</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-sm text-muted-foreground">
                  No episodes in this course.
                </td>
              </tr>
            ) : (
              rows.map(({ ep, parts }) => {
                const span = Math.max(1, parts.length) + 1;
                return (
                  <>
                    <tr key={`${ep.id}-head`} className="border-b bg-muted/20">
                      <td
                        rowSpan={span}
                        className="border-r px-3 py-2 align-top font-medium"
                      >
                        {ep.title}
                        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                          {parts.length} part{parts.length === 1 ? "" : "s"}
                        </span>
                      </td>
                      <td className="border-r px-3 py-2 text-xs text-muted-foreground">
                        Whole episode
                      </td>
                      <td className="border-r px-3 py-2 text-xs tabular-nums text-muted-foreground">
                        {ep.scene_count}
                      </td>
                      <td className="px-3 py-1.5">
                        <AssigneeSelect
                          episodeId={ep.id}
                          partId={null}
                          value={ep.assigned_user_id ?? null}
                        />
                      </td>
                    </tr>
                    {parts.length === 0 ? (
                      <tr key={`${ep.id}-empty`} className="border-b">
                        <td
                          colSpan={3}
                          className="px-3 py-2 text-xs text-muted-foreground"
                        >
                          No parts yet.
                        </td>
                      </tr>
                    ) : (
                      parts.map((p, i) => (
                        <tr key={`${ep.id}-${p.id}`} className="border-b">
                          <td className="border-r px-3 py-2">
                            <span className="text-muted-foreground">{i + 1}.</span>{" "}
                            {p.title}
                          </td>
                          <td className="border-r px-3 py-2 tabular-nums text-muted-foreground">
                            {p.scene_count}
                          </td>
                          <td className="px-3 py-1.5">
                            <AssigneeSelect
                              episodeId={ep.id}
                              partId={p.id}
                              value={p.assigned_user_id ?? null}
                            />
                          </td>
                        </tr>
                      ))
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
