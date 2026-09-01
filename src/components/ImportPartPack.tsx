import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PackageOpen,
  UploadCloud,
  X,
} from "lucide-react";
import { Unzip, UnzipInflate } from "fflate";
import { getStoredSessionToken } from "@/lib/auth-client";
import { supabase } from "@/integrations/supabase/client";

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
  | { kind: "done"; pack: PackData; partTitle: string }
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

type RawEntries = {
  manifestChunks: Uint8Array[];
  dbChunks: Uint8Array[];
  media: Map<string, Uint8Array[]>;
};

function classify(name: string): "manifest" | "db" | "media" | null {
  if (name.includes("__MACOSX") || name.endsWith("/")) return null;
  if (/^([^/]+\/)?MANIFEST\.json$/i.test(name)) return "manifest";
  if (name.endsWith(".data/projects.db")) return "db";
  if (name.includes(".data/project-assets/")) return "media";
  return null;
}

/** Stream-unzip a data pack entirely in the browser (no server memory cost). */
async function streamEntries(
  file: File,
  onNote: (note: string) => void,
): Promise<RawEntries> {
  const manifestChunks: Uint8Array[] = [];
  const dbChunks: Uint8Array[] = [];
  const media = new Map<string, Uint8Array[]>();
  let zipError: Error | null = null;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (entry) => {
    const name = entry.name;
    const kind = classify(name);
    if (!kind) return;
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
    if (kind === "manifest") collect(manifestChunks);
    else if (kind === "db") collect(dbChunks);
    else {
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
    onNote(
      `Unzipping… ${(read / 1024 / 1024).toFixed(0)} / ${(file.size / 1024 / 1024).toFixed(0)} MB`,
    );
  }
  if (zipError) throw zipError;
  return { manifestChunks, dbChunks, media };
}

/**
 * Fallback for zips the streaming reader can't parse (zip64, data descriptors,
 * odd writers): read the whole file and use the central directory instead.
 */
async function bufferEntries(
  file: File,
  onNote: (note: string) => void,
): Promise<RawEntries> {
  onNote("Retrying with full-archive reader…");
  const buf = new Uint8Array(await file.arrayBuffer());
  const { unzip } = await import("fflate");
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(buf, { filter: (f) => classify(f.name) !== null }, (err, out) =>
      err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(out),
    );
  });

  const manifestChunks: Uint8Array[] = [];
  const dbChunks: Uint8Array[] = [];
  const media = new Map<string, Uint8Array[]>();
  for (const [name, data] of Object.entries(files)) {
    const kind = classify(name);
    if (kind === "manifest") manifestChunks.push(data);
    else if (kind === "db") dbChunks.push(data);
    else if (kind === "media") {
      const key = name.split(".data/project-assets/")[1];
      if (key) media.set(key, [data]);
    }
  }
  return { manifestChunks, dbChunks, media };
}

async function readPack(
  file: File,
  onNote: (note: string) => void,
): Promise<PackData> {
  let entries: RawEntries;
  try {
    entries = await streamEntries(file, onNote);
    if (entries.dbChunks.length === 0) throw new Error("no projects.db in stream");
  } catch {
    entries = await bufferEntries(file, onNote);
  }
  const { manifestChunks, dbChunks, media } = entries;
  if (dbChunks.length === 0) {
    throw new Error("This zip has no .data/projects.db — is it a Div Studio data pack?");
  }


  const manifest: PackManifest =
    manifestChunks.length > 0
      ? (JSON.parse(
          new TextDecoder().decode(concatChunks(manifestChunks)),
        ) as PackManifest)
      : {};

  onNote("Reading episode database…");
  const { default: initSqlJs } = await import("sql.js");
  // The wasm binary lives in public/wasm/ and is fetched by URL — never
  // import it from source, or it lands in the server bundle.
  const SQL = await initSqlJs({ locateFile: () => "/wasm/sql-wasm.wasm" });
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
    if (!put.ok)
      throw new Error(`Upload failed for ${key.split("/").pop()} [${put.status}]`);
    return;
  }
  if (prep.direct && prep.mode === "supabase" && prep.path && prep.token) {
    const { error } = await supabase.storage
      .from("project-assets")
      .uploadToSignedUrl(prep.path, prep.token, blob, { contentType: type });
    if (error)
      throw new Error(`Upload failed for ${key.split("/").pop()}: ${error.message}`);
    return;
  }
  throw new Error("Object storage is not configured on this server.");
}

/** Pick the pack part that best matches the part currently open in compose. */
function guessSourcePart(pack: PackData, targetTitle: string): string | null {
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  const byTitle = pack.parts.find((p) => norm(p.title) === norm(targetTitle));
  if (byTitle) return byTitle.id;
  const num = /(\d+)/.exec(targetTitle)?.[1];
  if (num) {
    const byNum = pack.parts.find((p) => /(\d+)/.exec(p.title)?.[1] === num);
    if (byNum) return byNum.id;
  }
  const byManifest = pack.parts.find((p) => p.title === pack.manifest.part);
  return (byManifest ?? pack.parts[0])?.id ?? null;
}

export type ImportPartPackProps = {
  /** Destination episode id (the one open in compose). */
  projectId: string;
  /** Destination part id — this exact part is replaced. */
  partId: string;
  /** Destination part title, for labels and auto-matching. */
  partTitle: string;
  /** Destination episode title, for labels. */
  episodeTitle?: string;
  /** Called after a successful import so the caller can reload the part. */
  onImported?: () => void;
};

export function ImportPartPack({
  projectId,
  partId,
  partTitle,
  episodeTitle,
  onImported,
}: ImportPartPackProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [sourcePartId, setSourcePartId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setPhase({ kind: "reading", note: "Starting…" });
      try {
        const pack = await readPack(file, (note) =>
          setPhase({ kind: "reading", note }),
        );
        setSourcePartId(guessSourcePart(pack, partTitle));
        setPhase({ kind: "ready", pack });
      } catch (e) {
        setPhase({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not read this zip.",
        });
      }
    },
    [partTitle],
  );

  const runImport = useCallback(
    async (pack: PackData, srcPartId: string) => {
      const token = getStoredSessionToken();
      if (!token) {
        setPhase({ kind: "error", message: "Sign in required." });
        return;
      }
      const part = pack.parts.find((p) => p.id === srcPartId);
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

        setProgress(done, `Replacing ${partTitle}…`);
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            action: "importPart",
            id: projectId,
            part,
            target_part_id: partId,
          }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Import failed");
        setPhase({ kind: "done", pack, partTitle: part.title });
        onImported?.();
      } catch (e) {
        setPhase({
          kind: "error",
          message: e instanceof Error ? e.message : "Import failed.",
        });
      }
    },
    [projectId, partId, partTitle, onImported],
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setPhase({ kind: "pick" });
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
      >
        <PackageOpen size={14} /> Import pack into this part
      </button>
    );
  }

  const busy = phase.kind === "reading" || phase.kind === "importing";

  return (
    <div className="mt-3 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <PackageOpen size={16} /> Import data pack into{" "}
            <span className="text-primary">{partTitle}</span>
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Media goes straight to storage and{" "}
            <strong>{partTitle}</strong>
            {episodeTitle ? ` of ${episodeTitle}` : ""} is{" "}
            <strong>fully replaced</strong> by the zip version — everything
            currently saved in this part is removed.
          </p>
        </div>
        {!busy && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            aria-label="Close import panel"
          >
            <X size={16} />
          </button>
        )}
      </div>

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
          className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragOver ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
          }`}
        >
          <UploadCloud size={26} className="text-muted-foreground" />
          <p className="text-sm font-medium">
            Drag &amp; drop a data pack .zip here, or click to choose
          </p>
          <p className="text-xs text-muted-foreground">
            MANIFEST.json + .data/projects.db + .data/project-assets
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
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
          <span>{phase.message}</span>
        </div>
      )}

      {phase.kind === "reading" && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border px-4 py-6 text-sm">
          <Loader2 size={16} className="animate-spin" /> {phase.note}
        </div>
      )}

      {phase.kind === "ready" && (
        <div className="mt-4 rounded-lg border p-4">
          <dl className="space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Pack</dt>
              <dd>{phase.pack.manifest.name ?? phase.pack.projectTitle}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Media files</dt>
              <dd>{phase.pack.media.size}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Part from zip</dt>
              <dd>
                <select
                  value={sourcePartId ?? ""}
                  onChange={(e) => setSourcePartId(e.target.value)}
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
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Replaces</dt>
              <dd>
                <span className="font-medium">{partTitle}</span>
                {episodeTitle ? (
                  <span className="text-muted-foreground"> · {episodeTitle}</span>
                ) : null}
                <span className="ml-2 text-xs text-amber-600">
                  current content will be wiped
                </span>
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={!sourcePartId}
              onClick={() =>
                sourcePartId && void runImport(phase.pack, sourcePartId)
              }
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Replace {partTitle}
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: "pick" })}
              className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
            >
              Choose another zip
            </button>
          </div>
        </div>
      )}

      {phase.kind === "importing" && (
        <div className="mt-4 rounded-lg border p-4">
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
        <div className="mt-4 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-green-600">
            <CheckCircle2 size={18} /> Import complete
          </div>
          <p className="mt-2 text-sm">
            <strong>{partTitle}</strong> now holds the zip's{" "}
            <strong>{phase.partTitle}</strong> with {phase.pack.media.size} media
            files. Reload the page to see the imported scenes.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Reload part
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
