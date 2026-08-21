# Text-to-Image Feature — Full Reference Document

This document describes exactly how the **Text to Image** page in this app generates
images, so you can reproduce the same behavior on any other platform (directly
against Replicate, or through your own backend).

---

## 1. Models used

The UI exposes two models. Both are hosted on **Replicate**.

| UI label | Replicate model path | Notes |
|---|---|---|
| Nano Banana 2 (Gemini 3.1 Flash Image) | `google/nano-banana-2` | Google's fast, high-quality image model. Great prompt adherence. |
| FLUX.2 Klein 9B | `black-forest-labs/flux-2-klein-9b` | Black Forest Labs' 9B FLUX. Sharp detail and typography. |

Internal IDs used in the code: `nano-banana-2`, `flux-2-klein-9b`.

---

## 2. User inputs

The page collects:

- **Model** — one of the two above.
- **Aspect ratio** — one of `1:1`, `16:9`, `9:16`, `4:3`, `3:4` (default `1:1`).
- **Prompt** — free text, 1–8000 chars.
- **Style guide toggle** — when ON *and* the user has saved SVG style references
  in their Style Guide, up to **5** references are attached to the request as
  image inputs.

The style references are stored server-side as raw SVG strings (table
`explainer_style_assets`). Before sending them to Replicate the client
rasterizes each SVG to a **PNG data URL** on a white background at max
1024px using an off-screen `<canvas>` (see `svgToPngDataUrl` in
`src/routes/_authenticated/text-to-image.tsx`).

---

## 3. System prompt / prompt-wrapping logic

The user's raw prompt is **never sent as-is**. The server wraps it with a
fixed preamble that forces the model to (a) treat the input as *source
content to illustrate* (not text to render), (b) match the reference style
if any references are provided, and (c) render on a pure white background.

Final prompt template (built in `startImage` handler):

```
{SYSTEM_PREAMBLE}

{STYLE_LINE}          ← only when references are attached

{WHITE_BG}

--- SOURCE CONTENT ---

{user prompt}
```

Exact strings:

- `SYSTEM_PREAMBLE`
  ```
  You are an illustration generator. Treat the user's input below as the
  SOURCE CONTENT to visually illustrate — never render the raw text, code,
  or script as typography in the image. Instead, create a single clear
  conceptual illustration that visually represents the ideas, objects,
  characters, or concepts described in the content.
  ```
- `STYLE_LINE` (only when 1+ style references are attached; singular/plural adapts)
  ```
  You MUST strictly match the visual style, line weight, color palette,
  shapes and overall aesthetic of the provided reference image(s). The
  references define the required art style for this image.
  ```
- `WHITE_BG`
  ```
  The image MUST be rendered on a totally plain, pure white (#FFFFFF)
  background — no scenery, gradients, textures, background shadows, or
  environmental elements.
  ```

---

## 4. Per-model request body shape

Both models accept `prompt` and `aspect_ratio`, but the reference-image
field is named differently.

- **Nano Banana 2** (`google/nano-banana-2`)
  ```json
  {
    "input": {
      "prompt": "...final wrapped prompt...",
      "aspect_ratio": "1:1",
      "image_input": ["https://...ref1.png", "https://...ref2.png"]
    }
  }
  ```
- **FLUX.2 Klein 9B** (`black-forest-labs/flux-2-klein-9b`)
  ```json
  {
    "input": {
      "prompt": "...final wrapped prompt...",
      "aspect_ratio": "1:1",
      "images": ["https://...ref1.png", "..."]   // max 5
    }
  }
  ```

If no style references are attached, the `image_input` / `images` field is
omitted.

---

## 5. APIs called (end-to-end)

All Replicate traffic in this app goes through the **Lovable Connector
Gateway**, which proxies to `api.replicate.com` and injects the real
Replicate token. Base URL:

```
https://connector-gateway.lovable.dev/replicate/v1
```

Required headers on every gateway call:

```
Authorization:        Bearer <LOVABLE_API_KEY>
X-Connection-Api-Key: <REPLICATE_API_KEY>          ← connection key, not the raw Replicate token
```

If you call Replicate directly instead, use `https://api.replicate.com/v1`
with a single header: `Authorization: Bearer <REPLICATE_API_TOKEN>`.

### 5.1 Upload each style reference (only if references are used)

```
POST {BASE}/files
Content-Type: multipart/form-data
  content=<PNG file, field name "content">
```

Response contains `urls.get`, which is the URL passed into the model's
`image_input` / `images` array.

### 5.2 Create the prediction

```
POST {BASE}/models/{model_path}/predictions
Content-Type: application/json

{ "input": { ...see §4... } }
```

Response: `{ "id": "<prediction_id>", "status": "starting", ... }`.

Special handling: HTTP **402** on this call means the Replicate account
has no credit — surface a billing error, do not retry.

### 5.3 Poll the prediction

```
GET {BASE}/predictions/{prediction_id}
```

The client polls every **3 seconds** until `status` is `succeeded`,
`failed`, or `canceled`. On success, `output` is either a string URL or an
array whose first element is the image URL.

### 5.4 (Optional) Re-download the image server-side for the browser

To let the user click "Download" and save the file cleanly, the app fetches
the Replicate output URL server-side and returns a base64 data URL:

```
fetch(imageUrl)  → arrayBuffer → base64 → data:{contentType};base64,...
```

This step is app-side convenience only — you can just download the URL
directly on any other platform.

---

## 6. Client-side flow (state machine)

1. User clicks **Generate**.
2. Client rasterizes up to 5 SVG style references to PNG data URLs (if the
   Style Guide toggle is on and references exist).
3. Client calls the server `startImage` function with
   `{ model, prompt, aspectRatio, styleReferences }`.
4. Server uploads references (§5.1), wraps the prompt (§3), builds the
   per-model input (§4), and creates the prediction (§5.2). Returns
   `predictionId`.
5. Client polls `pollImage` every 3 s (§5.3). UI shows `Queued → Rendering
   → Done/Failed` with elapsed seconds.
6. On success, the image URL is shown; the Download button calls
   `fetchImageAsDataUrl` (§5.4) and triggers a browser download.

---

## 7. Reproducing on another platform — minimal recipe

Using Replicate directly (no Lovable gateway):

```bash
# 1. (optional) upload each PNG style reference
curl -sS -X POST https://api.replicate.com/v1/files \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
  -F "content=@ref1.png;type=image/png"
# → capture .urls.get from the JSON response

# 2. create a prediction (Nano Banana 2 example)
curl -sS -X POST \
  https://api.replicate.com/v1/models/google/nano-banana-2/predictions \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "prompt": "<< wrapped prompt from §3 >>",
      "aspect_ratio": "1:1",
      "image_input": ["<url from step 1>"]
    }
  }'
# → returns { "id": "...", "status": "starting", ... }

# 3. poll
curl -sS https://api.replicate.com/v1/predictions/<id> \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN"
# → when status == "succeeded", "output" holds the image URL(s)
```

For FLUX, swap the model path to `black-forest-labs/flux-2-klein-9b` and
replace `image_input` with `images` (max 5).

---

## 8. Full source — server logic (`src/lib/text-to-image.functions.ts`)

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const REPLICATE_GATEWAY = "https://connector-gateway.lovable.dev/replicate/v1";

function authHeaders() {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const replicateKey = process.env.REPLICATE_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!replicateKey)
    throw new Error("Replicate connector is not linked (REPLICATE_API_KEY missing)");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": replicateKey,
  };
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; filename: string } {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) throw new Error("Invalid image data URL");
  const mime = match[1];
  const b64 = match[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = mime.split("/")[1]?.split("+")[0] ?? "png";
  return { blob: new Blob([bytes], { type: mime }), filename: `style.${ext}` };
}

async function uploadFile(dataUrl: string): Promise<string> {
  const { blob, filename } = dataUrlToBlob(dataUrl);
  const fd = new FormData();
  fd.append("content", blob, filename);
  const res = await fetch(`${REPLICATE_GATEWAY}/files`, {
    method: "POST",
    headers: authHeaders(),
    body: fd,
  });
  if (!res.ok) throw new Error(`Reference upload failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { urls?: { get?: string } };
  const url = json.urls?.get;
  if (!url) throw new Error("Reference upload returned no URL");
  return url;
}

export const IMAGE_MODEL_OPTIONS = ["nano-banana-2", "flux-2-klein-9b"] as const;
export type ImageModelId = (typeof IMAGE_MODEL_OPTIONS)[number];

const IMAGE_MODEL_PATHS: Record<ImageModelId, string> = {
  "nano-banana-2": "google/nano-banana-2",
  "flux-2-klein-9b": "black-forest-labs/flux-2-klein-9b",
};

function buildImageInput(
  model: ImageModelId,
  opts: {
    prompt: string;
    aspect: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
    referenceUrls: string[];
  },
): Record<string, unknown> {
  const { prompt, aspect, referenceUrls } = opts;
  switch (model) {
    case "nano-banana-2": {
      const input: Record<string, unknown> = { prompt, aspect_ratio: aspect };
      if (referenceUrls.length) input.image_input = referenceUrls;
      return input;
    }
    case "flux-2-klein-9b": {
      const input: Record<string, unknown> = { prompt, aspect_ratio: aspect };
      if (referenceUrls.length) input.images = referenceUrls.slice(0, 5);
      return input;
    }
  }
}

const StartInput = z.object({
  model: z.enum(IMAGE_MODEL_OPTIONS),
  prompt: z.string().min(1).max(8000),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).default("1:1"),
  styleReferences: z.array(z.string().min(1)).max(5).optional(),
});

export const startImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => StartInput.parse(input))
  .handler(async ({ data }) => {
    const refs = data.styleReferences ?? [];
    const referenceUrls = refs.length
      ? await Promise.all(refs.map((r) => uploadFile(r)))
      : [];

    const SYSTEM_PREAMBLE =
      "You are an illustration generator. Treat the user's input below as the SOURCE CONTENT to visually illustrate — never render the raw text, code, or script as typography in the image. Instead, create a single clear conceptual illustration that visually represents the ideas, objects, characters, or concepts described in the content.";
    const WHITE_BG =
      "The image MUST be rendered on a totally plain, pure white (#FFFFFF) background — no scenery, gradients, textures, background shadows, or environmental elements.";
    const styleLine = referenceUrls.length
      ? `You MUST strictly match the visual style, line weight, color palette, shapes and overall aesthetic of the provided reference image${referenceUrls.length > 1 ? "s" : ""}. The references define the required art style for this image.`
      : "";
    const finalPrompt = [
      SYSTEM_PREAMBLE,
      styleLine,
      WHITE_BG,
      "--- SOURCE CONTENT ---",
      data.prompt,
    ].filter(Boolean).join("\n\n");

    const body = {
      input: buildImageInput(data.model, {
        prompt: finalPrompt,
        aspect: data.aspectRatio,
        referenceUrls,
      }),
    };
    const res = await fetch(
      `${REPLICATE_GATEWAY}/models/${IMAGE_MODEL_PATHS[data.model]}/predictions`,
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (res.status === 402) {
      throw new Error(
        "Replicate account has no credit. Enable billing at https://replicate.com/account/billing.",
      );
    }
    if (!res.ok) throw new Error(`Failed to start image generation (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { id: string; status: string };
    return { predictionId: json.id, status: json.status };
  });

const PollInput = z.object({ predictionId: z.string().min(1) });

export const pollImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PollInput.parse(input))
  .handler(async ({ data }) => {
    const res = await fetch(`${REPLICATE_GATEWAY}/predictions/${data.predictionId}`, {
      method: "GET",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Poll failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as {
      status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
      output?: string | string[] | null;
      error?: string | null;
    };
    const output =
      typeof json.output === "string"
        ? json.output
        : Array.isArray(json.output)
          ? json.output[0]
          : undefined;
    return { status: json.status, imageUrl: output, error: json.error ?? undefined };
  });
```

---

## 9. Style Guide storage (for reference)

- Table: `explainer_style_assets` (columns: `id`, `user_id`, `label`, `svg`, `created_at`).
- Rows contain a raw SVG string per reference.
- `listStyleAssets` server function returns the user's assets, ordered by
  `created_at` ascending.
- The client rasterizes each SVG to a 1024px PNG data URL on a white
  background before sending — this is what actually goes to Replicate as
  the reference image bytes.

---

## 10. Summary checklist to reproduce elsewhere

- [ ] Pick model path: `google/nano-banana-2` or `black-forest-labs/flux-2-klein-9b`.
- [ ] Wrap the user prompt with the 3-block template in §3.
- [ ] Convert style references to PNGs on white background, ≤5 images.
- [ ] Upload each PNG to `POST /v1/files`, capture `urls.get`.
- [ ] `POST /v1/models/<path>/predictions` with `{ input: { prompt, aspect_ratio, image_input|images } }`.
- [ ] Poll `GET /v1/predictions/<id>` until `succeeded` / `failed`.
- [ ] Read the image URL from `output` (string or first array element).
