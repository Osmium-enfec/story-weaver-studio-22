// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Pin Node for DigitalOcean / Docker. Local `vite dev` is unaffected (nitro is build-only).
  // Do not set DATABASE_URL / Spaces keys in local .env — keep SQLite + .data on disk.
  nitro: {
    preset: "node-server",
  },
  vite: {
    server: {
      // LAN-stable for other Macs. Do not change this port.
      // Dev / experimental work belongs on :8081 (divStudio-do-deploy).
      host: true,
      port: 8080,
      strictPort: true,
      allowedHosts: true,
      // node_modules is a symlink into do-deploy — Vite must serve those files.
      fs: {
        allow: [
          "/Users/enfecsolutions/Enfec Content/divStudio-lan-stable",
          "/Users/enfecsolutions/Enfec Content/divStudio-do-deploy/node_modules",
        ],
      },
    },
    // Never prebundle native / Node-only packages into the browser graph.
    // Including them (esp. playwright) deadlocks Vite dep optimization.
    optimizeDeps: {
      exclude: [
        "playwright",
        "playwright-core",
        "better-sqlite3",
        "ffmpeg-static",
        "fsevents",
        "pg",
        "@aws-sdk/client-s3",
        "@napi-rs/canvas",
        "node-web-audio-api",
      ],
    },
    ssr: {
      external: [
        "playwright",
        "playwright-core",
        "better-sqlite3",
        "ffmpeg-static",
        "pg",
        "@aws-sdk/client-s3",
        "@napi-rs/canvas",
        "node-web-audio-api",
      ],
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
