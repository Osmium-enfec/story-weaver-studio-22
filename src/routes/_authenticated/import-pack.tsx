import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PackageOpen,
  UploadCloud,
} from "lucide-react";
import { Unzip, UnzipInflate } from "fflate";
import { NavBar } from "@/components/NavBar";
import { getStoredSession, getStoredSessionToken } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/import-pack")({
  ssr: false,
  beforeLoad: () => {
    const session = getStoredSession();
    if (!session?.user) throw redirect({ to: "/auth" });
    const email = session.user.email?.toLowerCase() ?? "";
    const isAdmin =
      (session.user as { isAdmin?: boolean }).isAdmin === true ||
      isAdminEmail(email);
    if (!isAdmin) throw redirect({ to: "/compose", search: {} });
  },
  head: () => ({
    meta: [
      { title: "Import data pack — Explainer Studio" },
      {
        name: "description",
        content:
          "Upload an episode data pack zip: media files go straight to object storage and the part's scenes are merged into the episode.",
      },
    ],
  }),
  component: ImportPackPage,
});

type PackManifest = {
  name?: string;
  episode?: string;
  projectId?: string;
  part?: string;
  builtAt?: string;
};

type PackPart = {
  id: string;
  title: string;
  scenes: unknown[];
  [key: string]: unknown;
};

type PackData = {
  manifest: PackManifest;
  projectId: string;
  projectTitle: string;
  parts: PackPart[];
  /** Storage key (`<owner>/<project>/<file>`) -> file chunks. */
  media: Map<string, Uint8Array[]>;
};

type Phase =
  | { kind: "pick" }
  | { kind: "reading"; note: string }
  | { kind: "ready"; pack: PackData }
  | { kind: "importing"; pack: PackData; done: number; total: number; note: string }
  | { kind: "done"; pack: PackData; partTitle: string; replaced: boolean }
  | { kind: "error"; message: string };

function concatChunks(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/** Stream-unzip a data pack entirely in the browser (no server memory cost). */
async function readPack(
  file: File,
  onNote: (note: string) => void,
): Promise<PackData> {
  const manifestChunks: Uint8Array[] = [];
  const dbChunks: Uint8Array[] = [];
  const media = new Map<string, Uint8Array[]>();
  let zipError: Error | null = null;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (entry) => {
    const name = entry.name;
    if (name.includes("__MACOSX") || name.endsWith("/")) return;
    const collect = (target: Uint8Array[]) => {
      entry.ondata = (err, chunk) => {
        if (err) {
          zipError = err instanceof Error ? err : new Error(String(err));
          return;
        }
        target.push(chunk);
      };
      entry.start();
    };
    if (/^([^/]+\/)?MANIFEST\.json$/i.test(name)) {
      collect(manifestChunks);
    } else if (name.endsWith(".data/projects.db")) {
      collect(dbChunks);
    } else if (name.includes(".data/project-assets/")) {
      const key = name.split(".data/project-assets/")[1];
      if (!key) return;
      const chunks: Uint8Array[] = [];
      media.set(key, chunks);
      collect(chunks);
    }
  };

  const reader = file.stream().getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      unzip.push(new Uint8Array(0), true);
      break;
    }
    unzip.push(value, false);
    read += value.length;
    onNote(`Unzipping… ${(read / 1024 / 1024).toFixed(0)} / ${(file.size / 1024 / 1024).toFixed(0)} MB`);
  }
  if (zipError) throw zipError;
  if (dbChunks.length === 0) {
    throw new Error("This zip has no .data/projects.db — is it a Div Studio data pack?");
  }

  const manifest: PackManifest =
    manifestChunks.length > 0
      ? (JSON.parse(new TextDecoder().decode(concatChunks(manifestChunks))) as PackManifest)
      : {};

  onNote("Reading episode database…");
  const { default: initSqlJs } = await import("sql.js");
  const wasmUrl = (await import("sql.js/dist/sql-wasm.wasm?url")).default;
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database(concatChunks(dbChunks));
  try {
    const result = db.exec(
      "SELECT id, title, parts FROM projects ORDER BY updated_at DESC",
    );
    const rows = result[0]?.values ?? [];
    if (rows.length === 0) throw new Error("No episodes found in projects.db");
    const match = manifest.projectId
      ? rows.find((r) => String(r[0]) === manifest.projectId)
      : undefined;
    const row = match ?? rows[0];
    const parts = JSON.parse(String(row[2] ?? "[]")) as PackPart[];
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error("The episode in this pack has no parts.");
    }
    return {
      manifest,
      projectId: String(row[0]),
      projectTitle: String(row[1] ?? "Episode"),
      parts: parts.filter(
        (p) => p && typeof p.id === "string" && typeof p.title === "string",
      ),
      media,
    };
  } finally {
    db.close();
  }
}

async function uploadMediaFile(
  token: string,
  projectId: string,
  key: string,
  chunks: Uint8Array[],
): Promise<void> {
  const type = contentTypeFor(key);
  const blob = new Blob([concatChunks(chunks)], { type });
  const prepRes = await fetch("/api/persist-asset", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: "create-direct-upload",
      projectId,
      ext: key.split(".").pop() ?? "bin",
      contentType: type,
      key,
    }),
  });
  const prep = (await prepRes.json()) as {
    direct?: boolean;
    mode?: string;
    uploadUrl?: string;
    path?: string;
    token?: string;
    error?: string;
  };
  if (!prepRes.ok) throw new Error(prep.error ?? "Could not prepare upload");
  if (prep.direct && prep.mode === "s3-put" && prep.uploadUrl) {
    const put = await fetch(prep.uploadUrl, {
      method: "PUT",
      body: blob,
      headers: { "Content-Type": type },
    });
    if (!put.ok) throw new Error(`Upload failed for ${key.split("/").pop()} [${put.status}]`);
    return;
  }
  if (prep.direct && prep.mode === "supabase" && prep.path && prep.token) {
    const { error } = await supabase.storage
      .from("project-assets")
      .uploadToSignedUrl(prep.path, prep.token, blob, { contentType: type });
    if (error) throw new Error(`Upload failed for ${key.split("/").pop()}: ${error.message}`);
    return;
  }
  throw new Error("Object storage is not configured on this server.");
}

function ImportPackPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setPhase({ kind: "reading", note: "Starting…" });
    try {
      const pack = await readPack(file, (note) =>
        setPhase({ kind: "reading", note }),
      );
      const preferred =
        pack.parts.find((p) => p.title === pack.manifest.part) ?? pack.parts[0];
      setSelectedPartId(preferred?.id ?? null);
      setPhase({ kind: "ready", pack });
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not read this zip.",
      });
    }
  }, []);

  const runImport = useCallback(
    async (pack: PackData, partId: string) => {
      const token = getStoredSessionToken();
      if (!token) {
        setPhase({ kind: "error", message: "Sign in required." });
        return;
      }
      const part = pack.parts.find((p) => p.id === partId);
      if (!part) return;
      const total = pack.media.size;
      const setProgress = (done: number, note: string) =>
        setPhase({ kind: "importing", pack, done, total, note });
      try {
        const keys = [...pack.media.keys()];
        let done = 0;
        const workers = Array.from({ length: 4 }, async () => {
          for (;;) {
            const key = keys.shift();
            if (!key) return;
            setProgress(done, `Uploading ${key.split("/").pop()}`);
            await uploadMediaFile(token, pack.projectId, key, pack.media.get(key)!);
            done += 1;
            setProgress(done, `Uploaded ${done} / ${total} files`);
          }
        });
        await Promise.all(workers);

        setProgress(done, "Merging scenes into the episode…");
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action: "importPart", id: pack.projectId, part }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          replaced?: boolean;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "Import failed");
        setPhase({
          kind: "done",
          pack,
          partTitle: part.title,
          replaced: data.replaced === true,
        });
      } catch (e) {
        setPhase({
          kind: "error",
          message: e instanceof Error ? e.message : "Import failed.",
        });
      }
    },
    [],
  );

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <PackageOpen size={20} /> Import data pack
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop an episode data pack zip. Media goes straight to storage and the
          part&apos;s scenes are merged into the episode — no size limit worries,
          everything happens in your browser.
        </p>

        {(phase.kind === "pick" || phase.kind === "error") && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            onClick={() => inputRef.current?.click()}
            className={`mt-6 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
              dragOver ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
            }`}
          >
            <UploadCloud size={32} className="text-muted-foreground" />
            <p className="text-sm font-medium">
              Drag &amp; drop a data pack .zip here, or click to choose
            </p>
            <p className="text-xs text-muted-foreground">
              Same format as before: MANIFEST.json + .data/projects.db +
              .data/project-assets
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {phase.kind === "error" && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
            <span>{phase.message}</span>
          </div>
        )}

        {phase.kind === "reading" && (
          <div className="mt-6 flex items-center gap-3 rounded-xl border px-6 py-10 text-sm">
            <Loader2 size={18} className="animate-spin" /> {phase.note}
          </div>
        )}

        {phase.kind === "ready" && (
          <div className="mt-6 rounded-xl border p-6">
            <h2 className="text-sm font-semibold">Pack contents</h2>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Pack</dt>
                <dd>{phase.pack.manifest.name ?? "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Episode</dt>
                <dd>
                  {phase.pack.projectTitle}
                  {phase.pack.manifest.builtAt && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      built {new Date(phase.pack.manifest.builtAt).toLocaleString()}
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Media files</dt>
                <dd>{phase.pack.media.size}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Part</dt>
                <dd>
                  <select
                    value={selectedPartId ?? ""}
                    onChange={(e) => setSelectedPartId(e.target.value)}
                    className="rounded-md border bg-background px-2 py-1 text-sm"
                  >
                    {phase.pack.parts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({p.scenes.length} scenes)
                      </option>
                    ))}
                  </select>
                </dd>
              </div>
            </dl>
            <div className="mt-5 flex items-center gap-3">
              <button
                disabled={!selectedPartId}
                onClick={() =>
                  selectedPartId && void runImport(phase.pack, selectedPartId)
                }
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Import this part
              </button>
              <button
                onClick={() => setPhase({ kind: "pick" })}
                className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase.kind === "importing" && (
          <div className="mt-6 rounded-xl border p-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Loader2 size={16} className="animate-spin" /> Importing…
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width:
                    phase.total > 0
                      ? `${Math.round((phase.done / phase.total) * 100)}%`
                      : "100%",
                }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{phase.note}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep this tab open until the import finishes.
            </p>
          </div>
        )}

        {phase.kind === "done" && (
          <div className="mt-6 rounded-xl border p-6">
            <div className="flex items-center gap-2 text-sm font-semibold text-green-600">
              <CheckCircle2 size={18} /> Import complete
            </div>
            <p className="mt-2 text-sm">
              <strong>{phase.partTitle}</strong> was{" "}
              {phase.replaced ? "updated in" : "added to"}{" "}
              <strong>{phase.pack.projectTitle}</strong> with{" "}
              {phase.pack.media.size} media files.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <Link
                to="/episode/$id"
                params={{ id: phase.pack.projectId }}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Open episode
              </Link>
              <button
                onClick={() => setPhase({ kind: "pick" })}
                className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
              >
                Import another pack
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
