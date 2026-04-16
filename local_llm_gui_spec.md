# Specification & Implementation Plan: Local LLM GUI with llama.cpp

## 1. Architecture Overview

The application is a locally serveable, high-performance GUI for local LLMs, utilizing `llama-server` as the inference backend. It is designed as a single-user local web application.

*   **Frontend**: Next.js 16.X, TypeScript, the actual shadcn/ui 4.2.X component system, and Tailwind CSS v4.X. In this specification, `shadcn` means the real shadcn/ui workflow and component registry from `ui.shadcn.com` / `shadcn-ui/ui`, not ad-hoc Tailwind-only recreations of similar-looking controls.
*   **Backend**: Bun (Bun.serve) local server.
*   **Communication**: The frontend communicates exclusively with the Bun.serve backend via REST and Server-Sent Events (SSE). The Bun.serve backend in turn communicates with the `llama-server` child process via HTTP — proxying generation requests, forwarding SSE streams, querying `/props`, `/health`, and `/v1/models` as needed. The frontend never speaks directly to `llama-server`.
*   **State Management**: Zustand v5 for reactive frontend state; The backend acts as the source of truth using local SQLite in the app's user data directory for persistent chat history and presets, avoiding massive network payloads. Small global configuration values (for example binary paths) may still live in JSON files under the same user data directory. IndexedDB (via `idb`) acts solely as a client-side cache of:
    *   the last-known scanned model list payload,
    *   the last-opened chat ID and UI view state,
    *   and any other purely ephemeral UI caches that can be safely discarded.
    Cache entries MUST be invalidated when the backend returns a monotonically increasing `db_revision` (or equivalent) value that changes on any persistent write affecting the cached data.

*Note: All mentioned TypeScript packages (Next.js 16.X, shadcn 4.2.X, Zustand v5.X, Tailwind CSS v4.X) represent the latest major versions as of April 9, 2026, and MUST be reflected in the project bootstrap. Because `src/app/globals.css` imports `tailwindcss` and `tw-animate-css` directly by package name, those packages MUST exist in the package graph. `shadcn` here means the actual shadcn/ui CLI and registry workflow (`init`, `add`, generated components under `src/components/ui/`), not generic Tailwind styling used as a substitute for shadcn/ui primitives.*

*   **Bundling & Distribution**: The Next.js frontend is built into static assets (emitted to the `out/` directory via `next build`) served directly by the Bun.serve backend from that `out/` directory. The Bun backend and static assets are bundled into a single executable using `bun build --compile`, providing a zero-dependency, double-click launch experience for the user. The backend uses Bun's built-in `bun:sqlite` module for all SQLite access. `bun:sqlite` is a native, synchronous SQLite implementation built into the Bun runtime, requiring no external addon, no `node-pre-gyp` resolution, and embedding into the compiled executable with zero additional configuration. Cross-platform executables are produced from a single CI runner using the `--target` flag without requiring per-OS native runners. The executable intentionally leaves a lightweight terminal window open instructing the user to close it to shut down the server, ensuring intuitive application lifecycle and VRAM management.
*   **Process Management**: The backend uses `node:child_process` to spawn and manage a single persistent `llama-server` child process. All inference is performed by sending HTTP requests to that process's local HTTP API. The Bun.serve backend acts as the sole orchestrator: it manages `llama-server`'s lifecycle, proxies streaming responses, persists chat history, and serves the frontend. `llama-server` handles KV caching, template rendering, multimodal encoding, and token generation internally.

## 2. Strict Configuration Standards

The application MUST adhere to the following configurations in all written code.

### 2.1. TypeScript Configuration

Because the frontend and backend have fundamentally different runtime environments (browser DOM vs. Bun runtime), the project MUST use two separate TypeScript configuration files. Both enforce the same strict compiler flags from the shared root. `src/backend/` MUST be excluded from the frontend config to prevent `bun:*` modules from being compiled by Next.js, and `src/app/`, `src/components/`, and `src/store/` MUST be excluded from the backend config to prevent DOM types from polluting the backend type environment.

#### `tsconfig.json` — Project root; read by `next build` (frontend)

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noImplicitThis": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "useUnknownInCatchVariables": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,

    "target": "ES2024",
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,

    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },

    "plugins": [{ "name": "next" }]
  },
  "include": [
    "next-env.d.ts",
    ".next/types/**/*.ts",
    "src/app/**/*.ts",
    "src/app/**/*.tsx",
    "src/components/**/*.ts",
    "src/components/**/*.tsx",
    "src/store/**/*.ts"
  ],
  "exclude": [
    "node_modules",
    "src/backend",
    "src/test",
    "out",
    "dist"
  ]
}
```

**Required field notes:**
- `"jsx": "preserve"` is mandatory — Next.js performs its own JSX transform; omitting it prevents `.tsx` files from being processed.
- `"lib": ["dom", "dom.iterable", "esnext"]` is mandatory — without `dom`, browser APIs used across the frontend (`EventSource`, `IndexedDB`, etc.) have no type declarations.
- `"isolatedModules": true` is mandatory — Next.js requires each file to be independently compilable for its fast refresh pipeline.
- `"plugins": [{ "name": "next" }]` enables the Next.js TypeScript plugin for typed routes and editor IntelliSense.
- `next-env.d.ts` MUST appear in the `include` array. This file is auto-generated by `next dev` / `next build` and references Next.js global type definitions. A seed copy MUST be committed to version control so that cold builds succeed before any `next` command has been run (see §2.7).
- The canonical frontend bootstrap path uses `next.config.mjs`, so the root frontend `tsconfig.json` intentionally does not include a Next config file. If a TypeScript config variant is adopted later, it MAY be type-checked separately.

#### `tsconfig.backend.json` — Backend only; read by Bun directly

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["esnext"],
    "types": ["bun-types"]
  },
  "include": [
    "src/backend/**/*.ts",
    "src/test/backend/**/*.ts"
  ],
  "exclude": [
    "node_modules",
    "src/app",
    "src/components",
    "src/store",
    "out",
    "dist"
  ]
}
```

### 2.2. Prettier Configuration (`.prettierrc`)
```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": false,
  "quoteProps": "as-needed",
  "trailingComma": "all",
  "bracketSpacing": true,
  "bracketSameLine": true,
  "arrowParens": "always",
  "proseWrap": "always",
  "endOfLine": "lf"
}
```

### 2.3. Documentation Standards
All hand-written TypeScript files MUST be thoroughly documented using properly formatted `TSDoc` comments. Every interface, type alias, class, method, and exported function must have a `/** ... */` block detailing its purpose, parameters (`@param`), return values (`@returns`), and any potential exceptions (`@throws`). Auto-generated shadcn/ui primitives under `src/components/ui/` are exempt from this requirement unless they are materially modified beyond routine styling or composition adjustments.

### 2.3.1 Testing Standards
Unit and integration tests MUST be written against the `bun:test` framework and MUST be placed in either `src/test/backend/` or `src/test/frontend/` as appropriate. Browser end-to-end tests MAY use Playwright and MUST live outside `src/app/` and `src/components/` (for example `src/test/frontend/`). Test files MUST NOT be co-located inside `src/app/` or `src/components/`, as Next.js will attempt to compile any `.ts`/`.tsx` file it discovers within those trees.

### 2.4. Anti-Mocking Policy
Mocks, simulated code, and simulated data (e.g., fake models, dummy responses) are **STRICTLY BANNED** in the application source code. They are only permitted within the isolated context of the test suite.

### 2.5. Next.js Static Export Configuration (`next.config.mjs` or `next.config.ts`)
The canonical frontend bootstrap path described in §2.6 currently yields a root `next.config.mjs` file. A root Next.js config file MUST exist and MUST preserve the following settings regardless of whether the project uses `next.config.mjs` or `next.config.ts`. The `output: "export"` setting is required to emit static HTML/CSS/JS assets into the `out/` directory so they can be served by the Bun.serve backend. Without it, `next build` produces a Node.js server bundle incompatible with `bun build --compile` packaging.

```js
/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "export",      // Emit static assets into `out/` for Bun.serve to serve
  trailingSlash: true,    // Ensures asset paths resolve correctly when served from a sub-path
  images: {
    unoptimized: true,    // next/image optimisation endpoint is unavailable in static export
  },
}

export default nextConfig
```

**SPA routing note**: Because this application is a static export (`output: "export"`), all in-app navigation (e.g., switching between chats) MUST be implemented as pure Zustand client state mutations, not as Next.js `router.push()` URL changes. No dynamic Next.js routes (e.g., `[chatId]`) are used. The entire application renders from the single root `src/app/page.tsx`. Direct browser navigation to any client-side application path is handled by the Bun.serve backend's SPA fallback handler (see §3.1), which serves `out/index.html` only for non-API HTML requests, allowing the client-side application to boot and restore its last-opened state from the IndexedDB UI cache. Backend REST and SSE routes are excluded from this fallback and MUST return normal API status codes.

### 2.6. Frontend Bootstrap & `components.json`

The frontend MUST bootstrap from an actual `create-next-app` App Router project using `--src-dir`, and only then have shadcn/ui initialized inside that existing project. The canonical bootstrap sequence is:

1.  `npx create-next-app@latest local-llm-gui --src-dir`
2.  Enable the App Router, TypeScript, and the standard `@/*` alias during project creation.
3.  From the generated project root, run `npx shadcn@latest init --preset bbVJxYW`.

The chosen preset code `bbVJxYW` corresponds to the selected `radix-maia` design system variant for this project.

Running `npx shadcn@latest init --preset bbVJxYW --template next` directly into an empty directory is **not** the canonical route for this repository, because it currently defaults to root-level `app/` and `components/` trees rather than the required `src/` layout.

A committed root `components.json` file MUST exist and is the authoritative shadcn/ui configuration for style, CSS path, aliases, icon library, RTL, menu tone, and registry settings. For this project, it MUST resolve to the canonical `src/` layout, for example:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "radix-maia",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```

If a tool-generated scaffold ever produces root-level `app/`, `components/`, `hooks/`, or `lib/` directories instead of `src/app`, `src/components`, `src/hooks`, and `src/lib`, that scaffold MUST either be normalized into the canonical `src/` layout immediately or discarded in favor of the canonical bootstrap path above.

If the project intentionally switches to a different shadcn preset later, it SHOULD do so via `npx shadcn@latest apply --preset <code>` inside the existing project rather than by regenerating the application skeleton.

### 2.7. Build Scripts, Package Configuration & Required Seed Files

#### `next-env.d.ts` — Committed seed file

Next.js auto-generates `next-env.d.ts` at the project root during `next dev` / `next build`. Because `tsconfig.json` references it in `include`, its absence on a cold bootstrap (before any `next` command has run) will cause TypeScript to error. A seed copy MUST be committed to version control:

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited manually.
// It is auto-generated by Next.js and will be overwritten on each build.
```

This file MUST NOT be listed in `.gitignore`.

#### `package.json`

The frontend `package.json` MUST be created from the real scaffold produced by the canonical bootstrap flow in §2.6. Do **not** hand-derive the baseline frontend dependency set from the shadcn/ui monorepo root `package.json`; the authoritative baseline is the generated consumer application.

The `build:frontend` script MUST be simply `"next build"` with no path arguments, and MUST always be invoked from the project root where the active Next config file lives. Calling `next build` from a subdirectory or passing an incorrect path argument causes Next.js to lose the project root and fail to locate `src/app/`, producing the `Couldn't find any pages or app directory` error. The frontend build (`build:frontend`) MUST always complete and emit `out/` before the embedded-static generator and backend compile step (`build:backend`) are run, as the backend compile embeds the exported frontend through the generated `src/generated/embeddedStatic.generated.ts` manifest.

The scaffolded frontend dependencies and scripts produced by `create-next-app --src-dir` plus `npx shadcn@latest init --preset bbVJxYW` MUST be preserved unless there is a concrete project reason to change them. In particular, if the chosen preset installs packages such as `shadcn`, `@radix-ui/*`, `next-themes`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `tailwindcss`, `postcss`, or `tw-animate-css`, those entries SHOULD remain aligned with the generated scaffold.

The application MUST then add the following project-specific scripts on top of that scaffold:

```json
{
  "scripts": {
    "clean": "bun run scripts/clean.mjs",
    "dev": "bun run scripts/dev.mjs",
    "dev:frontend": "next dev --turbopack",
    "dev:backend": "bun --watch src/backend/server.ts --port=4000",
    "build:frontend": "next build",
    "build:backend": "bun run scripts/generateEmbeddedStatic.ts && bun build --compile --minify --production --target=bun src/backend/server.ts --outfile dist/local-llm-gui",
    "build": "bun run build:frontend && bun run build:backend",
    "build:win": "npm run clean && npm run build:frontend && bun run scripts/generateEmbeddedStatic.ts && bun build --compile --minify --production --target=bun-windows-x64 src/backend/server.ts --outfile dist/local-llm-gui-win.exe",
    "build:mac": "npm run clean && npm run build:frontend && bun run scripts/generateEmbeddedStatic.ts && bun build --compile --minify --production --target=bun-darwin-arm64 src/backend/server.ts --outfile dist/local-llm-gui-mac",
    "build:linux": "npm run clean && npm run build:frontend && bun run scripts/generateEmbeddedStatic.ts && bun build --compile --minify --production --target=bun-linux-x64 src/backend/server.ts --outfile dist/local-llm-gui-linux",
    "test:all": "npm run typecheck && npm run test:attachments:unchecked && npm run test:backend:unchecked && npm run test:e2e:unchecked && npm run test:frontend:unchecked && npm run test:frontend:unit:unchecked",
    "test:attachments": "npm run typecheck && npm run test:attachments:unchecked",
    "test:attachments:unchecked": "bun test src/test/frontend/attachmentCapabilities.test.ts src/test/backend/llamaServer.multimodal.test.ts",
    "test:backend": "npm run typecheck && npm run test:backend:unchecked",
    "test:backend:unchecked": "bun test src/test/backend/",
    "test:backend:files": "npm run typecheck && npm run test:backend:files:unchecked --",
    "test:backend:files:unchecked": "bun test",
    "test:e2e": "npm run typecheck && npm run test:e2e:unchecked",
    "test:e2e:unchecked": "playwright test",
    "test:frontend": "npm run typecheck && npm run test:frontend:unchecked",
    "test:frontend:unchecked": "bun test src/test/frontend --path-ignore-patterns=**/*.spec.ts && playwright test src/test/frontend/",
    "test:frontend:unit": "npm run typecheck && npm run test:frontend:unit:unchecked",
    "test:frontend:unit:unchecked": "bun test src/test/frontend --path-ignore-patterns=**/*.spec.ts",
    "typecheck:frontend": "tsc --noEmit --project tsconfig.json",
    "typecheck:backend": "tsc --noEmit --project tsconfig.backend.json",
    "typecheck": "bun run typecheck:frontend && bun run typecheck:backend",
    "lint": "eslint",
    "format": "prettier --write \"src/**/*.{ts,tsx,css,json}\" \"*.{ts,mjs,json}\""
  }
}
```

The application-specific dependency additions beyond the generated frontend baseline are:

```json
{
  "dependencies": {
    "@base-ui/react": "^1.3.0",
    "@huggingface/gguf": "0.4.2",
    "@huggingface/jinja": "0.5.6",
    "ajv": "^8.18.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "highlight.js": "^11.0.0",
    "idb": "^8.0.0",
    "katex": "^0.16.0",
    "lucide-react": "^1.8.0",
    "mermaid": "^11.0.0",
    "next": "16.2.3",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "react-markdown": "^9.0.0",
    "rehype-katex": "^7.0.0",
    "remark-math": "^6.0.0",
    "shadcn": "^4.2.0",
    "tailwind-merge": "^3.5.0",
    "tw-animate-css": "^1.4.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.40.0",
    "@tailwindcss/postcss": "^4",
    "@types/bun": "^1.3.12",
    "@types/katex": "^0.16.0",
    "@types/node": "^20.19.39",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "concurrently": "^9.2.1",
    "eslint": "^9",
    "eslint-config-next": "16.2.3",
    "prettier": "^3.8.2",
    "tailwindcss": "^4",
    "typescript": "^6.0.2"
  }
}
```

**Dependency notes:**
- `package.json`, the active lockfile, `components.json`, and the generated `src/components/ui/**/*` files from the canonical bootstrap are first-class project artifacts and MUST be committed.
- `src/app/globals.css` MUST stay aligned with the official shadcn/ui scaffold produced by the chosen preset. At time of writing, the selected `bbVJxYW` / `radix-maia` scaffold emits the import block documented in §4.1.
- shadcn/ui components are added to `src/components/ui/` via the official CLI (`init`, `add`, and, when changing presets later, `apply`). They are generated project files, not an excuse to replace the real component system with handwritten Tailwind-only stand-ins.
- `bun-types` is scoped exclusively to the backend via `tsconfig.backend.json` and MUST NOT appear in the frontend `tsconfig.json`'s `types` array, as it conflicts with the `dom` lib.
- `fastify` and `@fastify/static` are removed. Static file serving and routing are handled natively by `Bun.serve`.

## 3. Backend Implementation Details

### 3.1. File Structure & Contents
*   `src/backend/server.ts`: Initializes the `Bun.serve` server, serves static frontend files from the `out/` directory produced by `next build`, registers REST/SSE routes, listens on port `4000` by default (overridable via the `--port` CLI flag or the `LOCAL_LLM_GUI_BACKEND_PORT` environment variable), and natively auto-launches the user's default web browser to the local server URL. Both the development backend and the compiled production binary MUST use the same default port so that there is no behavioural difference between environments. Routing is handled via the `routes` object passed to `Bun.serve`. The server MUST include a `fetch` fallback handler (the catch-all handler invoked for any request that does not match a `routes` entry) that first excludes backend-owned REST/SSE paths from SPA fallback, then attempts to resolve the request path against the `out/` directory using `Bun.file()`, and finally falls back to serving `out/index.html` only for non-API `GET` requests that prefer HTML and do not map to an existing static asset. This implements the SPA fallback required by the `output: "export"` static build, ensuring that a browser refresh on any in-app client route does not produce a 404 error while still allowing misspelled backend endpoints to return proper API errors. SSE responses are returned as standard `Response` objects with a `ReadableStream` body and the appropriate `Content-Type: text/event-stream` header; the `server.timeout(req, 0)` call MUST be made for each SSE request to disable the idle timeout and prevent long-lived streams from being closed mid-response.
*   `src/backend/config.ts`: Manages global user settings (path to the `llama-server` binary, `MODELS_PATH`, and any other user-defined needed binary paths) stored in a local JSON file. References to `llama-cli`, `llama-mtmd-cli`, and the two-binary model are removed entirely — there is only one inference binary: `llama-server`.
*   `src/backend/db.ts`: Manages persistent local SQLite storage (via `bun:sqlite`) for chat histories and presets, ensuring the backend acts as the source of truth. **Chat history is stored as a model-agnostic sequence of messages** (role + content + optional media references + optional structured metadata required for reasoning traces and tool calling, such as persisted tool-call identifiers / payloads and `tool` role results). No model identifier is embedded in individual message rows, only in the chat-level metadata as a "last used model" hint. This means the history can be replayed to any model without schema changes.
*   `src/backend/scanner.ts`: Implements the hierarchical model scanning logic.
*   `src/backend/gguf.ts`: Utilizes the `@huggingface/gguf` library to read GGUF magic bytes and Key-Value metadata headers without loading the entire file into memory.
*   `src/backend/llamaServer.ts`: Manages the `llama-server` child process lifecycle — spawning, health-polling, graceful shutdown, OS-level signal cleanup, and the abort-generation endpoint. Replaces the old `process.ts` entirely. See §3.4.
*   `src/backend/optimizer.ts`: Implements the Model Load Optimization hardware scanning and calculation logic.
*   `src/backend/debug.ts`: Aggregates and categorizes raw output streams (`stdout`, `stderr`) from the spawned `llama-server` child process as well as internal server log events. Broadcasts these entries in real-time to the frontend via a dedicated SSE channel, tagged with a source label (e.g., `process:stdout`, `process:stderr`, `server:log`) and a UTC timestamp, so the frontend can filter and display them in the Debug Log window according to user preferences. The debug SSE channel MUST be a single broadcast channel (not per-client) given the single-user local application context. When the frontend client disconnects (e.g., browser tab is closed), the backend MUST detect the SSE connection close event — via the `AbortSignal` exposed on the incoming `Request` object (`req.signal`) — and stop writing to that response's `ReadableStream` controller. New log entries that arrive while no client is connected MUST be silently discarded — the backend MUST NOT buffer unbounded entries for an absent client. When the client reconnects, it begins receiving new entries only from the point of reconnection. To prevent unbounded memory growth during active connections, the backend MUST enforce the configured "Max log entries" cap on the in-memory buffer, dropping the oldest entry when the cap is exceeded.
*   `src/backend/tools/`: Contains the built-in local tool implementations plus the loader, validator, registry, and argument-validation helpers for file-based user tools discovered from the application data directory. It is responsible for scanning the user's `tools/` folder, importing canonical `tool.ts` entry modules, validating their manifests, merging them with built-in tools, and normalizing tool execution results for reinjection into the chat-completions flow.

### 3.2. Hierarchical Model Scanner & MMPROJ Logic
The scanner traverses `MODELS_PATH` looking for the exact structure: `MODELS_PATH/PUBLISHERNAME/MODELNAME/MODELFILE.GGUF` (implemented using `path.join(...)` to ensure cross-platform correctness).
1.  Reads all files in the `MODELNAME` directory, utilizing `fs.promises.stat(...)` (or equivalent async stat calls) to capture the exact file size in bytes for each file.
2.  Filters files into `mmprojFiles` (filename starts with `mmproj` case-insensitively, per `llama-server`'s own convention) and `baseFiles` (all other `.gguf` files).
3.  If `baseFiles` is empty, the directory is ignored entirely (MMPROJ files are never detected as standalone models).
4.  If `baseFiles` contains entries, each base model is registered. If `mmprojFiles` has entries, the first MMPROJ file is automatically associated with the base model's load configuration and will be passed to `llama-server` via `--mmproj <path>` at spawn time.

### 3.3. GGUF Header Parsing & Default Presets
When a model is detected, `src/backend/gguf.ts` utilizes `@huggingface/gguf` to read the file header to extract:
*   Architecture (`general.architecture`)
*   Context Length (`llama.context_length`)
*   Parameter Count & Quantization Type
*   Jinja Chat Template (`tokenizer.chat_template`)
*   Default Inference Settings (`general.sampling.top_k`, `general.sampling.top_p`, `general.sampling.temp`, `general.sampling.min_p`, `general.sampling.penalty_repeat`)

If the model has an associated MMPROJ file (as determined by the scanner in §3.2), `gguf.ts` also reads that MMPROJ file's GGUF header and extracts:
*   **`clip.has_audio_encoder`**: If this key exists and its value is `true`, the model record is flagged with `supportsAudio: true`. This is the sole, authoritative signal that the loaded multimodal stack supports audio input — it is not inferred from model architecture name or any other heuristic.

This extracted data, combined with the file size captured during the scan, is sent to the frontend to populate the UI model list. Upon first load, the backend initializes default decoupled presets (one for Load/Inference and one for System Prompts) for the model using these extracted values. Note that not all of the GGUF header values are guaranteed to exist in every GGUF, and the app must handle this gracefully in all necessary areas.

After `llama-server` is spawned for a given model, the backend SHOULD additionally query `GET /props` on the running instance to confirm the active chat template and slot count, reconciling these with any user overrides.

### 3.4. `llama-server` Process Management (`src/backend/llamaServer.ts`)

`llama-server` is a long-running HTTP server process. The Bun.serve backend spawns it as a child process and communicates with it exclusively over HTTP. There is no stdin/stdout prompt-pipe interaction; all inference is performed via the `POST /completion` or `POST /v1/chat/completions` endpoints.

#### 3.4.1. Spawn & Health Check
1.  When a model is selected, `llamaServer.ts` spawns `llama-server` with the appropriate flags (see §3.4.2) and begins polling `GET /health` at a short interval (e.g., every 250 ms). The frontend displays a "Loading model..." progress bar during this period, populated using model-load progress lines parsed from `llama-server`'s `stderr` stream via the existing regex approach.
2.  Once `/health` returns `{"status": "ok"}`, the server is considered ready and the first inference request may be sent.
3.  Only one `llama-server` instance is active at any time. If a new model is selected while one is already running, the old instance is gracefully shut down first (see §3.4.5), then the new one is spawned.

### 3.4.2. Spawn Flags & Per-Request Inference Parameters

`llama-server` is configured at two distinct levels. **Spawn-time flags** are passed as CLI arguments when the child process is started and require a server restart to change. **Per-request inference parameters** are sent in the JSON body of each individual generation request and can change freely between turns without any process restart.

#### Spawn-Time Flags

These are derived from the active Load & Inference Preset and passed to `llama-server` as CLI arguments at spawn time. The process MUST be restarted for any of these to take effect.

```
llama-server

  # ── Model & multimodal ──────────────────────────────────────────────────────
  -m  <model_path>
  [--mmproj <mmproj_path>]          # only when an MMPROJ is associated (§3.2)

  # ── Context & offload ───────────────────────────────────────────────────────
  -c  <context_length>              # UI: "Context Length" slider
  -ngl <gpu_layers>                 # UI: "GPU Offload" slider (-ngl / --n-gpu-layers)

  # ── Threading & batching ────────────────────────────────────────────────────
  -t  <cpu_threads>                 # UI: "CPU Thread Pool Size"
  -b  <batch_size>                  # UI: "Evaluation Batch Size" (logical max batch)
  -ub <ubatch_size>                 # UI: "Evaluation Batch Size" (physical micro-batch)

  # ── KV cache management ─────────────────────────────────────────────────────
  [--cache-type-k <type>]           # UI: "K Cache Quantization Type" (Experimental)
                                    #     allowed: f32, f16, bf16, q8_0, q4_0, q4_1,
                                    #              iq4_nl, q5_0, q5_1 (default: f16)
  [--cache-type-v <type>]           # UI: "V Cache Quantization Type" (Experimental)
                                    #     same allowed values as above (default: f16)
  [--kv-unified]                    # UI: "Unified KV Cache" toggle (Experimental)
                                    #     (-kvu) uses a single unified KV buffer for
                                    #     all sequences; default: disabled
  [--no-kv-offload]                 # UI: "Offload KV Cache to GPU Memory" toggle
                                    #     pass this flag when the toggle is OFF;
                                    #     omit it when the toggle is ON (default: on)
  --cache-reuse <n>                 # always passed; enables KV prefix reuse (§3.4.3)
                                    #     recommended value: 256

  # ── Memory mapping & locking ────────────────────────────────────────────────
  [--no-mmap]                       # UI: "Try mmap()" toggle — pass when toggle is OFF
  [--mlock]                         # UI: "Keep Model in Memory" toggle

  # ── Attention & architecture ─────────────────────────────────────────────────
  [--flash-attn]                    # UI: "Flash Attention" toggle (-fa)
  [--swa-full]                      # UI: "Full SWA Cache" toggle (Experimental)
                                    #     forces full-size sliding-window-attention
                                    #     cache; required for SWA models (e.g. Gemma,
                                    #     Qwen) when context > model's window size;
                                    #     default: disabled

  # ── RoPE ────────────────────────────────────────────────────────────────────
  [--rope-freq-base <f>]            # UI: "RoPE Frequency Base"
  [--rope-freq-scale <f>]           # UI: "RoPE Frequency Scale"

  # ── Context overflow ────────────────────────────────────────────────────────
  [--context-shift]                 # UI: "Context Shift" toggle (default: off)
                                    #     required when overflow mode = "Rolling Window"
                                    #     not supported by all architectures (§3.4.4)

  # ── Vision / dynamic resolution ─────────────────────────────────────────────
  [--image-min-tokens <n>]          # UI: Gemma 4 "Token Budget" slider lower bound
  [--image-max-tokens <n>]          # UI: Gemma 4 "Token Budget" slider upper bound
                                    #     discrete values: 70 | 140 | 280 | 560 | 1120
                                    #     changing these requires a server restart (§5.1)

  # ── Sampling seed ────────────────────────────────────────────────────────────
  [--seed <n>]                      # UI: "Seed" field (default: -1 = random)

  # ── Chat template ────────────────────────────────────────────────────────────
  [--jinja --chat-template-file <path>]
                                    # only when user has set a custom Jinja template
                                    # in the Preset Editor; template written to a
                                    # temp file by the backend before spawning (§4.3)

  # ── Server configuration ─────────────────────────────────────────────────────
  --host 127.0.0.1
  --port <dynamically_allocated>    # selected by OS; read back from process after spawn
  --log-format json                 # structured stderr for debug log parsing (§3.1)
  -np 1                             # single parallel slot; single-user application
```

#### Per-Request Inference Parameters

These are sent in the JSON body of every `POST /completion` or `POST /v1/chat/completions` request. They require **no process restart** and can differ on every turn.

```jsonc
{
  // ── Always present ──────────────────────────────────────────────────────────
  "cache_prompt": true,             // MUST be true for normal chat/history-bearing requests (§3.4.3)
  "stream": true,                   // false only for auto-naming requests (§3.8)

  // ── Response length ─────────────────────────────────────────────────────────
  "n_predict": <n>,                 // UI: "Response Length Limit"; omit or -1 for ∞

  // ── Stop sequences ──────────────────────────────────────────────────────────
  "stop": ["<string>", ...],        // UI: "Stop Strings"; empty array by default

  // ── Sampling ────────────────────────────────────────────────────────────────
  "temperature": <f>,               // UI: "Temperature" slider
  "top_k": <n>,                     // UI: "Top-K" slider
  "top_p": <f>,                     // UI: "Top-P" slider
  "min_p": <f>,                     // UI: "Min-P" slider
  "presence_penalty": <f>,          // UI: "Presence Penalty" slider
  "repeat_penalty": <f>,            // UI: "Repeat Penalty" slider

  // ── Structured output (when active) ─────────────────────────────────────────
  // /completion endpoint (only when Structured Output mode = "json_schema"):
  "json_schema": { ... },
  // /v1/chat/completions endpoint:
  "response_format": { "type": "json_object" }
  // or:
  "response_format": {
    "type": "json_schema",
    "schema": { ... }
  },

  // ── Template / reasoning controls (when supported) ─────────────────────────
  "chat_template_kwargs": {
    "enable_thinking": false
  },
  "reasoning_format": "deepseek"
}
```

**Important distinctions:**
- Sampling parameters (temperature, top-k, top-p, min-p, repeat/presence penalty) are **per-request** and take effect immediately with no restart. They are stored in the Load & Inference Preset and injected by the backend into every outgoing request body.
- The `n_predict` field controls response length per turn. When the UI setting is "off" (unlimited), it is omitted from the request body entirely (defaulting to `llama-server`'s internal `-1` = infinity).
- When Context Overflow Handling is set to `"Rolling Window"`, the backend MUST verify `--context-shift` was passed at spawn time before accepting the setting. If not, it MUST return an error instructing the user to reload the model with Context Shift enabled.

By default, no template override flags are passed when spawning `llama-server`; it uses the GGUF-embedded template internally. When the user provides a custom Jinja template override in the Preset Editor, or when tool calling requires a known tool-compatible template override for the active model, that template is written to a temporary file and passed via `--jinja --chat-template-file <path>` at spawn time.

#### 3.4.3. KV Cache Prefix Reuse — The Foundation of No-Reload Editing

`llama-server` supports the `cache_prompt` field in the `/completion` request body. When `cache_prompt: true` is sent, the server re-uses any matching KV cache prefix from the previous request on the same slot, processing only the tokens that differ (the suffix). This is the mechanism that replaces "Kill & Respawn" for Edit, Regenerate, Branch, chat switching, and auto-naming — none of those operations require restarting the `llama-server` process.

To enable efficient prefix reuse, `llama-server` MUST be spawned with `--cache-reuse <n>` (where `n` is a small positive integer such as `256`), which configures the minimum matching chunk size for KV shift-based cache reuse.

**All normal chat, edit, regenerate, branch, chat-switch, and user-visible generation requests sent to `llama-server` from the Bun.serve backend MUST include `"cache_prompt": true`.** Isolated auxiliary requests that intentionally must not perturb the active chat slot state, such as auto-naming, MAY set `"cache_prompt": false`.

#### 3.4.4. Context Shift
The `--context-shift` flag is passed at spawn time when the user has enabled it in the Advanced load settings. It enables a rolling KV cache window when the token count approaches the context ceiling. The same caveats apply (not all architectures support it; SWA models such as Gemma 4 may ignore it). The flag MUST be exposed as a user-facing toggle in the Advanced load settings, defaulting to off. When Context Overflow Handling is set to "Rolling Window", the UI MUST auto-enable this toggle and warn the user about potential architecture incompatibility.

#### 3.4.5. Graceful Shutdown & Signal Handling
*   The Bun.serve backend tracks the `ChildProcess` reference for the active `llama-server` instance.
*   On POSIX, `SIGINT`, `SIGTERM`, and `SIGHUP` are trapped; the backend first sends `SIGTERM` to `llama-server`, then escalates to `SIGKILL` after a short timeout if the process has not exited.
*   On Windows, the backend uses `child.kill()` and, as a last resort, `taskkill /T /F /PID <pid>`.
*   `process.on("exit")` is registered as a best-effort final cleanup hook but is not relied upon for async work.
*   When the user clicks "Unload Model", the backend calls this shutdown path and sets the active server reference to `null`, freeing RAM/VRAM.

#### 3.4.6. Generation Interruption (Stop Button)
To halt generation mid-stream, the Bun.serve backend uses the verified generation-abort mechanism supported by the bundled `llama-server` build for the active request or slot. The exact HTTP path and payload MUST be confirmed against the shipped binary during implementation and wrapped behind a backend helper rather than hard-coded throughout the codebase. Stopping generation MUST NOT restart the process or intentionally invalidate the KV cache. The UI displays a brief "Stopping..." indicator while cancellation is confirmed (i.e., the upstream stream closes). **No Kill & Respawn occurs for a simple stop.**

#### 3.4.7. Loading Progress Streaming
`llama-server` emits `llama_model_load` progress lines to `stderr` during model load. The backend attaches a listener to the `ChildProcess`'s `stderr` stream, parses the percentage using regex, and streams this to the frontend via SSE to display a real-time progress bar over the chat window — identical in behavior to the old approach.

#### 3.4.8. Tokens Per Second & Context Fullness
After each generation turn, the backend parses the `timings` object returned in the final response JSON from `llama-server`, extracting the `predicted_per_second` field. This value is streamed to the frontend and displayed as a non-intrusive annotation beneath every completed assistant message bubble.

The backend also derives context usage from the `timings` counters returned by `llama-server`. The current token count is calculated as `timings.cache_n + timings.prompt_n + timings.predicted_n` and streamed to the frontend for display as a context usage indicator in the chat window header (e.g., `3,412 / 8,192 tokens`). This indicator is reset whenever a new `llama-server` instance is spawned (i.e., on model load or model switch).

### 3.5. Edit, Regenerate, Branch & Chat Switching — No Model Reloads

This is the most significant behavioral change from the previous architecture. **No operation in normal chat flow — edit, regenerate, branch, chat switching, or model switching — causes a `llama-server` process restart, except for model switching itself** (which unavoidably requires loading a different set of weights). The key insight is that `llama-server`'s `cache_prompt: true` mechanism handles all KV cache management transparently.

#### 3.5.1. Chat History Is Model-Agnostic
The chat history stored in `db.ts` is a flat ordered list of `{role, content, media_refs[]}` rows tied to a `chat_id`. No model identifier is stored per-message. The "last used model" is stored only at the chat level as a UI hint (to pre-select that model when re-opening the chat) and has no effect on the stored messages themselves. This means:

*   The user can change models at any point during a conversation by selecting a new model from the model list.
*   Doing so causes `llama-server` to be restarted with the new model's weights (unavoidable — different weights must be loaded).
*   On the next inference request, the Bun.serve backend sends the **full message history** to the new `llama-server` instance via `POST /v1/chat/completions` with `cache_prompt: true`. The server processes the full history prompt on the first request, then caches it for subsequent turns.
*   From the user's perspective, the conversation continues seamlessly — the new model simply picks up where the old one left off.

#### 3.5.2. Edit
When the user edits a user message at position `N` in the history:
1.  The backend truncates the stored chat history at position `N`, replacing message `N` with the edited content and discarding all messages after `N`.
2.  The backend persists this truncated history to the database.
3.  The backend sends the truncated history (up to and including the edited message at position `N`) to `llama-server` via `POST /v1/chat/completions` with `stream: true` and `cache_prompt: true`.
4.  `llama-server` reuses any matching KV cache prefix (tokens before the edit point that are identical to the previous request) and re-processes only the changed suffix. No process restart occurs. No "Rebuilding context..." delay exists for short-to-medium histories; the server handles cache reuse internally.
5.  The new assistant response streams back to the frontend and is persisted to the database.

The UI MUST display a "Regenerating..." indicator during step 3–5. For very long histories where the cache miss is large, the indicator may be visible for several seconds — this is expected and MUST NOT be confused with a model reload. No "Rebuilding context..." language that implies a reload should be used; prefer "Generating response..." or similar.

#### 3.5.3. Regenerate
Regenerate is a special case of Edit where the user message at position `N` is unchanged but the assistant response at position `N+1` is discarded and re-generated:
1.  The backend removes the last assistant message from the stored history (or the assistant message immediately following the targeted user message).
2.  The backend sends the history up to (and including) the last user message to `llama-server` via `POST /v1/chat/completions` with `stream: true` and `cache_prompt: true`.
3.  `llama-server` reuses the fully cached KV prefix (since no tokens changed) and generates a new response from the sampling point. This is maximally efficient — only the new tokens are generated; nothing is re-processed.
4.  The new response is streamed to the frontend and persisted.

#### 3.5.4. Branch
Branching creates a fork of the conversation at a given point:
1.  The backend copies the chat history up to the branch point into a new `chat_id` row in the database.
2.  The UI navigates to the new chat (via Zustand state, not URL change — see §2.5).
3.  No `llama-server` restart occurs. On the next user message in the new chat, the backend sends the branched history to `llama-server` via `POST /v1/chat/completions` with `cache_prompt: true`. The server reuses any matching KV cache prefix from the previous session (the common prefix of the original chat).

#### 3.5.5. Chat Switching
When the user switches to a different chat while the same model is loaded:
1.  No `llama-server` restart occurs.
2.  On the next user message (or on any other request requiring inference in the new chat), the backend sends the new chat's full history to `llama-server` via `POST /v1/chat/completions` with `cache_prompt: true`.
3.  `llama-server` processes the new history prompt and caches it. If the new chat shares a common prefix with the previous chat (e.g., the same system prompt), the server reuses that prefix automatically — no work is repeated for tokens already in cache.
4.  The context usage indicator in the chat header is updated to reflect the token count of the newly active chat's history.

### 3.6. Multimodal & File Upload Handling

`llama-server` handles multimodal input natively via its HTTP API. There are no `--image` or `--audio` CLI flags passed per-request; instead, media data is base64-encoded and sent inline in the request body. The previous per-request file-path and MTMD marker approach is replaced entirely.

#### 3.6.1. Media Storage
Uploaded image and audio files are saved to a persistent `USER_DATA/media/` directory permanently tied to the chat ID and message index, ensuring long-term stability. Filenames MUST be normalized on write (e.g., using a stable unique ID prefix) to ensure filesystem compatibility. The stored files serve as the canonical source of truth; base64 encoding is performed by the backend at request time by reading the stored file.

#### 3.6.2. Multimodal Capability Detection
Before sending any multimodal request, the backend MUST verify that `llama-server` was started with multimodal support by checking runtime server properties (prefer `GET /props` modalities, and also consume `/v1/models` capability metadata when exposed) and may use the spawn configuration (`--mmproj`) only as a corroborating hint. A client MUST NOT send `multimodal_data` to a server instance that lacks multimodal capability.

#### 3.6.3. Request Format — `POST /completion` (non-OAI)
For the non-OAI `/completion` endpoint, multimodal data is passed as a `multimodal_data` array in the JSON body alongside the prompt string. The `multimodal_data` field is an array of base64-encoded strings — one entry per media file. The prompt string MUST contain an identical number of `<__media__>` marker strings (the canonical MTMD marker, as returned by `mtmd_default_marker()`) acting as ordered placeholders. The server substitutes each marker with the corresponding media embedding in order.

Example (two images):
```json
{
  "prompt": "Describe these two images: <__media__> and <__media__>",
  "multimodal_data": ["<BASE64_IMAGE_1>", "<BASE64_IMAGE_2>"],
  "cache_prompt": true,
  "stream": true
}
```

#### 3.6.4. Request Format — `POST /v1/chat/completions` (OAI-compatible)
For the OAI-compatible endpoint, multimodal content is passed using the standard OpenAI vision message format, where the `content` field of a user message is an array of content parts:
```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe this image:" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,<BASE64>" } }
      ]
    }
  ],
  "stream": true
}
```
Audio content follows the same content-part array pattern. The backend reconstructs this content-part array from the stored message history by reading the saved media files and base64-encoding them at request time.

The Bun.serve backend MUST select between the `/completion` and `/v1/chat/completions` endpoints based on the active inference mode. For all normal chat use, `POST /v1/chat/completions` is preferred, as it lets `llama-server` handle chat template rendering internally.

#### 3.6.5. MTMD Marker Consolidation
The model-specific marker logic (Gemma 4's `<|image|>` / `<|audio|>` vs. the generic `<__media__>`) is **not the application's concern when using `POST /v1/chat/completions`** — `llama-server` applies the model's chat template internally and injects the correct model-specific tokens. The application sends standard OpenAI-format content parts and lets the server handle model-specific formatting. This eliminates the entire category of per-model marker injection code that existed in the previous architecture.

When using the `/completion` endpoint (non-OAI path), the `<__media__>` marker is always used, as it is the canonical marker defined by the MTMD C API (`mtmd_default_marker()`). Gemma 4–specific token injection is handled internally by `llama-server`'s MTMD layer.

#### 3.6.6. Text File Injection
Uploaded `.txt`, `.md`, `.csv`, etc., are parsed by the Bun.serve backend and injected directly into the user's prompt text before the request is sent to `llama-server`, exactly as before.

### 3.7. Error Handling & Crash Recovery
*   **Graceful Crash & OOM Handling**: The backend monitors `llama-server` via `child.on("exit", ...)` and `child.on("error", ...)`. If the process exits unexpectedly (non-zero exit code or crash signal), the backend captures the final lines of `stderr`, marks the active server as `null`, and streams the error to the frontend via SSE. The frontend displays a user-friendly modal explaining the crash (e.g., suggesting lowering GPU layers).
*   **Health Polling During Inference**: The backend MAY maintain a lightweight background health check against `GET /health` during active inference sessions to detect hangs or OOM kills that do not immediately surface as process exit events. If `/health` returns non-200 or times out while a generation is in progress, the backend treats it as a crash and triggers the crash-recovery flow.
*   **Context Fullness Display**: Derived from the final response `timings` counters (see §3.4.8), specifically `cache_n + prompt_n + predicted_n`. The indicator is NOT reset on edit/regenerate/branch (since no process restart occurs); it is updated after each turn to reflect the actual current cache occupancy.

### 3.8. Auto-naming (User-Configurable)
Auto-naming is fundamentally simpler with `llama-server` because there is no process restart required:

1.  Wait until the first assistant response finishes streaming (the chat is idle).
2.  Send a separate, isolated `/completion` request to `llama-server` containing only the title-generation prompt (first user message + optional first assistant message), with `cache_prompt: false` to avoid polluting the main chat's KV cache. Because `/completion` operates on raw prompt strings rather than chat history, it does not interact with the chat-scoped KV cache entries that `cache_prompt: true` maintains for `/v1/chat/completions`.
3.  Capture the generated title, persist it to the database.
4.  No Kill & Respawn cycles are required. No VRAM reload occurs.

Because the server runs with `-np 1`, auto-naming is a low-priority auxiliary task. If the user initiates any foreground inference action (new message, edit, regenerate, branch follow-up, or model switch) while auto-naming is in flight, the backend MUST cancel the auto-naming request and prioritize the user action.

Because no reloads occur, the VRAM cost warning in the auto-naming toggle is removed. The "Naming chat..." indicator persists only for the duration of the title generation request itself.

The UI MUST be resilient to the generation period and MUST cancel the auto-naming request via the same verified generation-abort helper used for normal stop-generation behavior if the user unloads the model or closes the app mid-operation.

### 3.9. Structured Output
Structured output is a **per-request inference feature**, not a spawn-time flag. The UI exposes it as an explicit mode selector with exactly three states:
1.  `Off`
2.  `Any JSON Object`
3.  `JSON Schema`

`POST /v1/chat/completions` is the **primary and preferred** structured-output path for this application. The raw `/completion` endpoint supports structured output only as a secondary advanced-mode compatibility path.

Request behavior by mode:
- `Off`: no structured-output parameters are sent.
- `Any JSON Object`: the backend sends `response_format: { "type": "json_object" }` on `POST /v1/chat/completions`. This mode is out of scope for raw `/completion`.
- `JSON Schema`: the backend sends `json_schema: { ... }` on `/completion`, or `response_format: { "type": "json_schema", "schema": { ... } }` on `POST /v1/chat/completions`.

The schema root is **not** restricted to an object. Arrays, strings, numbers, booleans, and object roots are all valid if supported by the active endpoint and upstream backend.

#### 3.9.1. Pre-Send Validation Rules
Before sending any structured-output request, the application MUST perform lightweight local validation:
- The schema text MUST parse as valid JSON when `JSON Schema` mode is selected.
- In v1, if the pasted schema contains `$ref` anywhere, the application MUST refuse to send it and MUST display a warning explaining that `$ref`-based schemas are not supported in this application version.
- The application MAY impose a reasonable schema-size limit to prevent pathological payloads.

The application MUST NOT attempt to fully reimplement or perfectly emulate `llama-server`'s full schema-acceptance rules locally. Local validation is intentionally conservative; `llama-server` remains the authority for final schema acceptance.

#### 3.9.2. Post-Response Validation & Failure Handling
When structured output is enabled, the application MUST preserve the raw assistant output exactly as generated and then perform local post-response validation after the assistant turn completes:
- In `Any JSON Object` mode, the final assistant content MUST be parsed as JSON.
- In `JSON Schema` mode, the final assistant content MUST first be parsed as JSON and then validated against the submitted schema.

If the generated output is malformed JSON, incomplete JSON, or violates the selected schema:
- the raw assistant text MUST still be preserved;
- the UI MUST mark the turn as a structured-output failure rather than silently treating it as valid;
- parse failure and schema-validation failure MUST be distinguished in the UI or stored metadata;
- the application MUST NOT silently rewrite or discard the original assistant output;
- recovery is manual (for example Regenerate / Retry), not an automatic hidden retry loop.

If a generation is aborted or ends before the output is complete, the response MUST be treated as truncated/incomplete and MUST NOT be marked as a successful structured-output result.

### 3.10. Tool Calling & Local Tool Plugins
This application's custom-tool system is implemented at the Bun.serve layer and is **distinct** from `llama-server`'s experimental built-in `--tools` / `/tools` features. The backend MUST NOT enable `llama-server --tools` as part of this application's custom-tool feature. Instead, the backend discovers local tools, exposes them to the model through the standard OpenAI-style `tools` field in `POST /v1/chat/completions`, intercepts streamed `tool_calls`, executes the selected local tool, and injects the tool result back into the next chat-completions request.

Because this is a single-user local desktop application, user-authored tools are treated as **trusted local plugins** rather than browser-style sandboxed extensions. The application MUST NOT attempt multi-tenant or browser-extension isolation. It MUST still enforce lightweight operational guardrails: schema-based argument validation, deterministic enable/disable state, execution timeouts, cancellation, explicit load errors, and optional confirmation for obviously side-effecting tools.

#### 3.10.1. Tool Sources & On-Disk Layout
There are two tool sources:
1.  Built-in tools shipped with the application.
2.  User-authored local tools discovered from the application data directory's `tools/` subdirectory.

The canonical on-disk layout is:

```text
<APP_DATA>/tools/
  read_text_file/
    tool.ts
  list_directory/
    tool.ts
```

Rules:
- Each immediate child folder under `<APP_DATA>/tools/` is treated as exactly one tool.
- The folder name is the canonical tool ID and MUST match `manifest.name` exactly.
- The canonical authoring entry file is `tool.ts`. If the packaged runtime cannot import external TypeScript directly, the backend MAY transpile or cache that file to an internal JavaScript artifact before importing it; this is an implementation detail and MUST be invisible to the user.
- Only one tool module is allowed per tool folder. Nested recursive tool discovery is out of scope for v1.
- Per-tool package managers, `package.json`, and arbitrary per-tool dependency installation are out of scope for v1. User tools MAY rely on Bun/Node built-ins and on runtime dependencies already shipped with the application.
- The UI MUST provide a manual `Refresh Tools` action that triggers a full rescan of built-in and local tools.

#### 3.10.2. Tool Module Contract
Every tool module MUST default-export an object matching the following TypeScript contract:

```ts
export type ToolJsonPrimitive = string | number | boolean | null;

export type ToolJsonValue =
  | ToolJsonPrimitive
  | readonly ToolJsonValue[]
  | { readonly [key: string]: ToolJsonValue };

interface ToolSchemaBase {
  readonly title?: string;
  readonly description?: string;
}

export type ToolSchema =
  | (ToolSchemaBase & {
      readonly type: "string";
      readonly enum?: readonly string[];
      readonly minLength?: number;
      readonly maxLength?: number;
    })
  | (ToolSchemaBase & {
      readonly type: "number";
      readonly minimum?: number;
      readonly maximum?: number;
    })
  | (ToolSchemaBase & {
      readonly type: "integer";
      readonly minimum?: number;
      readonly maximum?: number;
    })
  | (ToolSchemaBase & {
      readonly type: "boolean";
    })
  | (ToolSchemaBase & {
      readonly type: "array";
      readonly items: ToolSchema;
      readonly minItems?: number;
      readonly maxItems?: number;
    })
  | (ToolSchemaBase & {
      readonly type: "object";
      readonly properties: Readonly<Record<string, ToolSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties?: boolean;
    });

export interface ToolPolicy {
  readonly enabledByDefault?: boolean;
  readonly dangerous?: boolean;
  readonly requiresConfirmation?: boolean;
  readonly allowParallel?: boolean;
  readonly timeoutMs?: number;
  readonly category?: "filesystem" | "network" | "system" | "data" | "custom";
}

export interface ToolManifest {
  readonly name: string;
  readonly displayName?: string;
  readonly description: string;
  readonly inputSchema: Extract<ToolSchema, { readonly type: "object" }>;
  readonly outputSchema?: ToolSchema;
  readonly policy?: ToolPolicy;
}

export interface ToolContext {
  readonly signal: AbortSignal;
  readonly callId: string;
  readonly chatId: string;
  readonly appDataDir: string;
  readonly workspaceDir?: string;
  readonly tempDir: string;
  readonly modelName?: string;
  log(entry: {
    readonly level: "debug" | "info" | "warn" | "error";
    readonly message: string;
    readonly data?: ToolJsonValue;
  }): void;
}

export type ToolResult<TResult extends ToolJsonValue = ToolJsonValue> =
  | {
      readonly ok: true;
      readonly content: string;
      readonly data?: TResult;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable?: boolean;
        readonly data?: ToolJsonValue;
      };
    };

export interface LocalToolModule<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult extends ToolJsonValue = ToolJsonValue,
> {
  readonly apiVersion: 1;
  readonly kind: "local-tool";
  readonly manifest: ToolManifest;
  run(
    args: TArgs,
    context: ToolContext,
  ): Promise<ToolResult<TResult>> | ToolResult<TResult>;
}
```

Additional contract rules:
- `manifest.name` MUST match `^[a-z][a-z0-9_]{0,63}$`.
- `manifest.inputSchema` MUST have `type: "object"` at the root.
- The root input schema MUST set `additionalProperties: false`.
- The supported schema subset is intentionally small. `$ref`, `oneOf`, `anyOf`, `allOf`, `patternProperties`, recursive schemas, and custom runtime validators are out of scope for v1.
- `run(...)` MAY be synchronous or asynchronous.
- `ToolResult.content` is the model-facing summary of what happened. `ToolResult.data` is optional structured payload for follow-up reasoning or UI inspection.
- If omitted, `policy.allowParallel` defaults to `false`, `policy.requiresConfirmation` defaults to `false`, and `policy.timeoutMs` defaults to a backend-defined bounded timeout (for example 30 seconds).

#### 3.10.3. Loader Validation, Registry, & Reload Semantics
At load time, the backend MUST reject a tool module if any of the following are true:
- the module lacks a default export;
- `apiVersion !== 1`;
- `kind !== "local-tool"`;
- `manifest` is missing or malformed;
- `manifest.name` does not match the folder name;
- the root schema is not an object schema;
- unsupported schema features (such as `$ref`) are present;
- a duplicate tool name already exists in the merged built-in + user-tool registry.

Duplicate-name behavior MUST be deterministic. Built-in tools MUST NOT be silently overridden by user tools. If a user-authored tool collides with an existing tool name, the user tool is rejected and the load error is surfaced in the UI.

The loader MUST maintain a registry of both valid and rejected tools. Rejected tools are not exposed to the model, but their exact load errors MUST be displayed to the user. Tool enabled/disabled state MUST be stored in user configuration so the same tools remain enabled or disabled across application restarts.

Tool refresh behavior MUST be conservative:
- `Refresh Tools` performs a fresh scan/import/validation pass.
- A generation already in progress uses the registry snapshot captured at the start of that generation.
- Newly added, edited, removed, enabled, or disabled tools take effect only for subsequent turns.

#### 3.10.4. Prompting, Persistence, & Execution
Tool calling is supported only on `POST /v1/chat/completions`; it is out of scope for the raw `/completion` endpoint. Tool calling MUST only be enabled when chat parsing is running through a Jinja-compatible template that supports tool use. If the active model's embedded template is not tool-compatible, the backend MUST require a compatible template override before exposing tools in the UI.

When tool calling is enabled:
- The backend converts every enabled tool manifest into a standard OpenAI-style `tools` definition and sends it in the request body.
- The backend SHOULD set `parse_tool_calls: true`.
- In v1, the backend MUST set `parallel_tool_calls: false`, even if the upstream API exposes the flag. Parallel/multiple tool calls are deferred until the application has explicit end-to-end support for them.

The backend's Tool Stream State Machine is retained and formalized:
1.  Monitor the SSE stream from `llama-server` for `tool_calls` deltas in the OAI streaming format.
2.  Intercept those deltas before they reach the user-facing chat transcript.
3.  Buffer the full tool-call payload until it is complete.
4.  Validate the requested arguments against the tool's `inputSchema`.
5.  If required by policy, request user confirmation before execution.
6.  Execute the local tool with timeout and abort-signal support.
7.  Normalize the result into `ToolResult`.
8.  Append the assistant-side tool-call metadata plus the matching `tool` role result message (including the `tool_call_id`) to persisted chat history.
9.  Resume generation by sending the updated history back through the next `POST /v1/chat/completions` request.

Invalid arguments, thrown exceptions, timeouts, cancellations, or non-serializable return values MUST be normalized into structured tool failures rather than crashing the backend or leaking raw stack traces into the user-facing chat UI. A tool failure still becomes the tool result for the next model turn, so the model has a chance to recover or explain the problem.

## 4. Frontend Implementation Details

### 4.1. File Structure & Contents

Any component file under `src/app/` or `src/components/` that serves as a client boundary and directly uses React hooks, browser APIs (`IndexedDB`, `window`, `EventSource`, etc.), or interactive event handlers (`onClick`, `onChange`, etc.) MUST declare `"use client";` as its very first line. Next.js App Router renders all components as React Server Components by default; omitting this directive from a true client boundary will produce a hard build error.

The `"use client"` directive marks a **boundary**: once a file is marked `"use client"`, all components imported by it are also considered part of the client bundle. It is therefore not necessary — and is actively incorrect — to mark every descendant component individually. The directive should be placed only at the boundary component level, as deep in the component tree as possible, to preserve the server-rendering benefits of the App Router.

The canonical frontend layout for this project is `src/`-based. If any tool-generated scaffold ever produces root-level `app/`, `components/`, `hooks/`, or `lib/` directories, those paths are non-canonical for this repository and MUST be normalized into `src/app`, `src/components`, `src/hooks`, and `src/lib` immediately or regenerated via the canonical bootstrap path in §2.6.

The following two files are **mandatory for Next.js to recognise the `src/app/` directory at all**. If either is absent or misnamed, `next build` will produce the `Couldn't find any pages or app directory` error even if the directory itself exists:

*   `src/app/layout.tsx`: Root layout shell. MUST contain the `<html>` and `<body>` tags. MUST be a **React Server Component** (no `"use client"` directive). It mounts a thin `<Providers>` client component (see below) that wraps all interactive children, loads fonts, and applies global CSS. It MUST NOT itself be marked `"use client"`, as doing so would prevent the export of the `metadata` object (which requires a Server Component) and force the entire application tree to be rendered client-side.
*   `src/app/page.tsx`: Root route. Composes the full chat UI from `src/components/`. MUST be a **React Server Component** (no `"use client"` directive) that renders a `<ChatApp>` client boundary component (defined in `src/components/`) which carries the `"use client"` directive and contains all interactive chat logic.
*   `src/components/Providers.tsx`: A dedicated `"use client"` boundary component imported by `layout.tsx`. Wraps children with Zustand store initialization and any other client-side context providers (theme, etc.). Keeping all client-side provider logic in this single boundary component is the correct pattern for Next.js App Router and avoids forcing the layout itself into the client bundle.

Additional files:
*   `src/app/globals.css`: The global stylesheet generated and then owned by the chosen shadcn/ui preset. It MUST initially match the official scaffold produced by `npx shadcn@latest init --preset bbVJxYW` in a `src/`-dir Next app. At time of writing, that scaffold begins with the following imports:
    ```css
    @import "tailwindcss";
    @import "tw-animate-css";
    @import "shadcn/tailwind.css";
    ```
  After bootstrap, the file remains editable, but its semantic token structure and required shadcn/ui base imports MUST remain compatible with the installed generated components. No component-scoped styles live here.
*   `src/components/ui/`: Houses the actual generated shadcn/ui primitives used by the application. Core interactive controls MUST be built from these real shadcn/ui components and their documented composition patterns, not from plain Tailwind-only stand-ins.
*   `src/lib/utils.ts`: Holds shared utility helpers required by the generated shadcn/ui layer (for example the canonical `cn(...)` class-merging helper) plus any additional pure frontend utilities that belong beside those aliases.
*   `src/hooks/`: Holds generated or hand-written frontend hooks referenced by `components.json` aliases and by the chosen shadcn/ui preset. These hooks remain normal project source files and MUST follow the same typing and testing rules as the rest of the frontend.
*   `src/store/chatStore.ts`: Zustand store managing chat UI states. Acts as a client-side cache while the backend maintains the source of truth for history data.
*   `src/store/modelStore.ts`: Zustand store managing scanned models, active model, and decoupled presets (System Prompt Presets and Load & Inference Presets).
*   `src/components/Chat/`: Contains `ChatWindow`, `MessageBubble`, `ReasoningTrace`, and `ChatInput`.
*   `src/components/Debug/`: Contains `DebugLogWindow`, a toggleable overlay panel that subscribes to the backend's debug SSE channel and renders a virtualized, auto-scrolling log feed of raw process and server output entries. The panel MUST be toggled via a persistent, accessible button in the main application chrome (e.g., a toolbar icon or keyboard shortcut) and must retain its open/closed state across page refreshes via the IndexedDB UI cache.
*   `src/components/Settings/`: Contains `PresetEditor`, `JinjaEditor`, `HardwareOptimizer`, and `GlobalSettings`.

### 4.2. Chat Interface & Message Actions
*   **Markdown, Syntax Highlighting & Math Rendering**: The UI uses a robust Markdown renderer (e.g., `react-markdown`) paired with `remark-math` and `rehype-katex` for LaTeX math formula rendering, alongside a syntax highlighter (e.g., `Prism` or `highlight.js`) for code blocks. The syntax highlighter must include a dedicated "Copy Code" button in the top-right header of every rendered code block. Additionally, the Markdown configuration must include a Mermaid diagram renderer (e.g., `remark-mermaid` or integrating `mermaid.js`) to parse and display `mermaid` code blocks natively.
*   **Inline Media Rendering**: The `MessageBubble` component is responsible for rendering visual thumbnails of uploaded images and embedding HTML5 audio players (`<audio controls>`) directly within the chat feed for any associated media files.
*   **Smart Auto-Scrolling**: The chat window implements a smart auto-scroll UX: it automatically tracks the bottom of the feed during active SSE token streams *unless* the user manually scrolls up. Doing so engages a temporary "scroll lock" to allow reading of previous messages, which disengages automatically when they manually scroll back to the bottom. To complement this, a visual "Scroll to Bottom" Floating Action Button (FAB) appears when the user scrolls up, allowing them to instantly snap back down to the live stream and re-engage the auto-scroll.
*   **Model List & Active Unloading**: The UI displays a searchable list of all scanned models, prominently featuring the extracted context length, architecture, and file size for each entry. If the backend scanner returns zero models, the UI must display a dedicated "Empty State" onboarding screen explaining what GGUF files are, providing a link to download models (e.g., from HuggingFace), and featuring a button to natively open the `MODELS_PATH` directory in the OS file explorer. The active model header includes a dedicated "Unload Model" button. When clicked, this sends a signal to the backend to gracefully shut down the `llama-server` child process, freeing up system RAM/VRAM.
*   **Model Switching Mid-Conversation**: The user may select a different model from the model list at any point during a conversation. The UI MUST make it clear that switching models requires reloading the inference engine (showing the standard "Loading model..." progress bar), but MUST also clearly communicate that the chat history is preserved and will be replayed to the new model. The model selector MUST NOT be disabled or hidden during an active conversation.
*   **Auto-naming (User-Configurable, Single-Model Only)**:
    *   Auto-naming MUST be a user setting (enabled/disabled) in `GlobalSettings`.
    *   When enabled, the first user message triggers a background auto-naming task after the first assistant response finishes streaming.
    *   The auto-naming request is sent as an isolated `/completion` call to the already-running `llama-server` instance (see §3.8). No Kill & Respawn cycles occur. The VRAM cost warning is removed from the auto-naming toggle.
    *   Because the server runs with a single slot, this task is low-priority and MUST be cancelled if the user starts another foreground inference action before naming completes.
    *   The UI MUST be resilient to the generation period and MUST cancel the auto-naming request if the user unloads the model or closes the app mid-operation.
*   **Multimodal Validation & UX**: The UI implements preventative validation by disabling media upload buttons and showing a clear tooltip or error if a user attempts to upload an incompatible file type for the active model. Specifically: image uploads are disabled when no MMPROJ file is associated with the loaded model (i.e., `llama-server` was not spawned with `--mmproj`) or when runtime multimodal capability is absent from the active server (`/props` modalities and, where available, `/v1/models` capability metadata); audio uploads are disabled unless `supportsAudio: true` on the model record. This check is model-agnostic and applies to any multimodal model, not just specific architectures. The chat input area supports native drag-and-drop for media files and displays a visual thumbnail (or audio waveform preview) with a removal button *before* the user sends the message, ensuring they can verify attachments.
*   **Message Actions (Copy, Stop, Edit, Regenerate, Branch)**: Every message stream can be halted via a "Stop Generation" button. Completed messages feature "Copy Text", "Edit", "Branch", and "Regenerate" buttons.
    *   **Stop Generation**: Triggers an abort request to the Bun.serve backend, which forwards it using the verified generation-abort mechanism supported by the bundled `llama-server` build. No process restart occurs. The button briefly shows "Stopping..." while the SSE stream closes.
    *   **Edit**: Truncates the history at the edited message, updates the database, and sends the truncated history to `llama-server` with `cache_prompt: true`. The server reuses any matching KV prefix automatically. No process restart; no "Rebuilding context..." language. The UI shows "Generating response..." during generation.
    *   **Regenerate**: Removes the last assistant message and re-sends the history to `llama-server` with `cache_prompt: true`. The cached prefix is fully reused (no tokens changed); only new tokens are generated. No process restart.
    *   **Branch**: Copies the history slice to a new chat ID in the database and navigates to it via Zustand state (see §2.5). No process restart. The next inference request for the new chat reuses any matching KV cache prefix.
    *   None of these operations display a "model reload" indicator, because no model reload occurs. The context usage indicator in the chat header updates to reflect the current cache occupancy after each operation.
*   **Search, Export, & Deletion**: A dedicated sidebar component allows full-text search across all chats via the local database. The sidebar automatically groups chat history entries by date (e.g., "Today", "Previous 7 Days", "Older") for intuitive navigation. Chats can be exported as JSON or Markdown. The sidebar also features full chat deletion capabilities. The UI must include a way to delete individual chat histories or clear all chats, securely instructing the backend database to drop the entries and automatically delete any persistently saved media files associated with those chat IDs to free up disk space.
*   **System Prompt Pinning**: The UI explicitly displays a visually distinct, collapsible "System Prompt" block at the very top of every chat feed so the user can review the foundational instructions dictating the current context.

### 4.3. Preset Editors & Configurability
The UI provides comprehensive editors designed as dedicated modal overlays and collapsible side-panels to keep the main chat interface clean:
*   **Global Settings & Binary Paths**: A dedicated settings modal (within `GlobalSettings`) where users can input, validate, and save the absolute file path to `llama-server` and `MODELS_PATH` directly from the frontend. The two-binary configuration (`llama-cli` path + `llama-mtmd-cli` path) is replaced by a single `llama-server` path. It also includes a dynamic 'Custom Binaries' key-value interface, allowing the user to specify and track paths to any other needed binaries (e.g., `llama-quantize`, `llama-bpe`) directly. It also includes a manual toggle for the application theme (Light Mode, Dark Mode, and "System Default" utilizing CSS media queries). It also includes a toggle to enable/disable the Auto-naming feature (with no reload warning, since no reloads occur — see §3.8). It also includes a **Debug Log** configuration section with the following controls:
    *   A master toggle to enable or disable the Debug Log window entirely.
    *   Individual checkboxes to control which stream categories are shown in the log: `llama-server stdout`, `llama-server stderr`, and `Server logs`.
    *   A "Max log entries" numeric input to cap the in-memory log buffer size (default: 1,000 entries) and prevent unbounded memory growth.
    *   A "Clear Log" button to flush all currently buffered entries from the frontend log feed without requiring a restart.
*   **System Prompt Editor**: A prominently placed, resizable text area at the top of the Preset Editor modal for defining the system instruction.
*   **Load & Inference Settings**: Organized into a two-column grid within the Preset Editor. Load Settings are split into two sections:
    *   **Context and Offload**: Includes a Context Length slider (with a token limit indicator for the loaded model) and a GPU Offload slider (`-ngl`).
    *   **Advanced**: Includes CPU Thread Pool Size, Evaluation Batch Size, Unified KV Cache toggle (Experimental), RoPE Frequency Base, RoPE Frequency Scale, Offload KV Cache to GPU Memory toggle, Keep Model in Memory toggle, Try mmap() toggle, Seed, Flash Attention toggle, K Cache Quantization Type (Experimental), V Cache Quantization Type (Experimental), and a **Context Shift** toggle (enables `--context-shift` at spawn time; default: off; labelled with a note that not all model architectures support context shifting — see §3.4.4). The "Max Concurrent Predictions" setting is removed, as `llama-server` is spawned with `-np 1` for this single-user application.
    Inference Settings include Thinking On and Off toggle (on by default; when the active template exposes `enable_thinking`, the backend passes the selected value via `chat_template_kwargs` on each request rather than rewriting and persisting Jinja source text; when the template does not expose `enable_thinking`, the toggle is disabled with an explanatory tooltip), response length limit (off by default), Context Overflow Handling style (`Truncate Middle` is the default, `Rolling Window` and `Stop At Limit` are also options; note that `Rolling Window` requires Context Shift to be enabled — the UI MUST enforce this dependency by auto-enabling Context Shift when Rolling Window is selected and warning the user if their model architecture may not support it), stop strings (none by default), and sliders for Temperature, Top-K, Top-P, Min-P, Presence Penalty, and Repeat Penalty.
*   **Structured Output**: A dedicated control group containing a mode selector with the three states `Off`, `Any JSON Object`, and `JSON Schema`. `POST /v1/chat/completions` is the primary structured-output path. The raw `/completion` path supports only `Off` and `JSON Schema`. The JSON schema editor is shown only when `JSON Schema` mode is selected. If the pasted schema is invalid JSON, the UI MUST block submission with an inline validation error. In v1, if the schema contains `$ref` anywhere, the UI MUST display a warning and MUST NOT allow the schema to be sent. After generation completes, the frontend/backend combination MUST distinguish between valid structured output, malformed/incomplete JSON, and schema-validation failures while preserving the original assistant text.
*   **Jinja Template Editor**: A dedicated tab featuring a syntax-highlighted code editor (using `@huggingface/jinja` for validation) allowing manual override of the GGUF's default template. When a custom template is active, the backend writes it to a temporary file and restarts `llama-server` with `--jinja --chat-template-file <path>`. The user is informed that changing the template requires a server restart.
*   **Thinking Tags Editor**: Two distinct text inputs (Start Tag and End Tag) to define custom reasoning traces, overriding the defaults if necessary. The generic default pair for most raw-tag reasoning models is `startString: "<think>"` and `endString: "</think>"`. Gemma 4 is the notable model-specific exception covered in §5.2, where the raw fallback pair is `startString: "<|channel>thought"` and `endString: "<channel|>"`.

The preset architecture saved in the backend explicitly decouples these configurations into two distinct categories:
1.  **System Prompt Presets**: Bundles the system instruction text, manual Jinja template overrides, and custom thinking tags.
2.  **Load & Inference Presets**: Bundles all Load and Inference settings as well as structured-output mode selection and any associated JSON schema text.
The UI allows the user to independently select and mix-and-match one preset from each category when loading a model, preventing the need to duplicate hardware/inference settings just to change a system prompt.

### 4.4. Tool Calling & Tool Manager UI
*   **Tool Manager UI**: The frontend does **not** provide an in-app TypeScript code editor for tools in v1. Instead, it provides a Tool Manager panel that lists every built-in and user-authored tool discovered by the backend, including its source (`built-in` vs. `local`), display name, description, enabled/disabled state, policy flags (`dangerous`, `requiresConfirmation`), and most recent load status. The panel MUST include an `Open Tools Folder` action and a `Refresh Tools` action.
*   **Load Errors & Validation Feedback**: Invalid or rejected tools MUST appear in the Tool Manager with an exact, user-readable load error (for example: missing default export, invalid manifest, unsupported schema keyword, duplicate name, or folder/name mismatch). This is a local plugin system; opaque "tool failed to load" messages are not acceptable.
*   **Enable/Disable & Persistence**: Each valid tool has an enable/disable toggle. Toggling it updates backend configuration immediately and persists across restarts. Disabled tools remain visible in the Tool Manager but are not exposed to the model.
*   **Prompting Availability UX**: Tool calling is only available when the active chat template is Jinja-compatible and tool-capable. If that condition is not met, the Tool Manager and chat UI MUST clearly explain that a compatible template override is required before any enabled tools can actually be sent to `POST /v1/chat/completions`.
*   **Execution UX**: During a tool call, the chat UI MUST suppress raw streamed `tool_calls` deltas from the user-visible transcript. Instead, it MAY show a compact status row such as `Running tool: read_text_file...`, followed by either a successful tool-result handoff or a concise structured error state. If a tool's policy requires confirmation, the frontend MUST present a confirmation dialog before the backend proceeds with execution.

## 5. Gemma 4 Specific Implementations

The application includes highly specific, accurate handling for Gemma 4's unique features.

### 5.1. Variable Image Resolution (VIR)
Gemma 4 allows balancing inference speed and output accuracy via a token budget. Because `llama-server` exposes `--image-min-tokens` and `--image-max-tokens` as **spawn-time flags** (not per-request parameters), VIR token budget changes require a server restart. The UI MUST communicate this:

*   **UI Implementation**: When a Gemma 4 model is loaded and an image is attached, the UI presents a "Token Budget" slider with strict discrete values: `70`, `140`, `280`, `560`, and `1120`. Changing this value triggers a confirmation dialog informing the user that applying the new budget requires restarting the inference engine (i.e., killing and respawning `llama-server`).
*   **Backend Logic**: The selected token budget is stored in the Load Preset and applied as `--image-max-tokens <N>` (and conditionally `--image-min-tokens`) when `llama-server` is spawned. For other dynamic-resolution vision models, the backend exposes these same flags with model-appropriate value ranges or leaves them at their model-default values.

### 5.2. Gemma 4 Channel Reasoning Tags
Gemma 4 utilizes specific control tokens for its thinking mode. The literal word `channel` is **not** a universal reasoning concept in this application; it is relevant only to Gemma 4's raw fallback tag format. Most other reasoning models that expose raw tags use the simpler pair `startString: "<think>"` and `endString: "</think>"`.
*   **Activation**: The primary mechanism for enabling or disabling thinking is `chat_template_kwargs` (for example `{"enable_thinking": true|false}`) when the active template supports it. If the bundled Gemma 4 template/build still requires a compatibility nudge such as prepending `<|think|>` to the system instruction, that injection MAY be applied as a model-specific fallback, but it MUST NOT be persisted in the database.
*   **Parsing**: The backend SHOULD prefer server-native reasoning parsing by requesting an appropriate `reasoning_format` and consuming `message.reasoning_content` when `llama-server` provides it. If raw-tag fallback parsing is needed, the parser MUST be model-aware: the default raw reasoning pair for most models is `<think>...</think>`, while Gemma 4's raw fallback pair is `<|channel>thought\n...<channel|>`. Gemma 4-specific `channel` parsing MUST NOT be treated as globally relevant for unrelated reasoning models. Any fallback parser MUST implement a rolling buffer, MUST tolerate tag sequences split across multiple SSE events, and MUST preserve partial `reasoning_content` as truncated if generation is cancelled mid-thought.
*   **UI Rendering**: The frontend renders `reasoning_content` inside a collapsible, user-friendly accordion component above the final response.
*   **History Hygiene**: By default, persisted assistant history used for future context reconstruction MUST include only the assistant-visible content plus any separately stored structured `reasoning_content`; raw fallback tags such as `<think>...</think>` or Gemma 4's `<|channel>thought...<channel|>` MUST NOT be re-injected into later prompts. Preserving reasoning input in history is allowed only for model/template combinations where the bundled `llama-server` build explicitly supports it and the application intentionally enables that mode. Any compatibility `<|think|>` injection MUST be applied fresh per request and MUST NOT be stored in the database.

## 6. Model Load Optimization

The application features an optional "Model Load Optimization" button in the load settings UI.
1.  **Hardware & Backend Scanning**: The backend uses Node.js `os.cpus()` and `os.totalmem()` to determine logical core count and system RAM. It attempts to execute `nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader` (or `rocm-smi` equivalents) to determine available VRAM. Additionally, the backend executes `llama-server --help` to detect supported flags and capabilities (and may optionally execute `llama-server --version` for informational display) to determine the specific `llama.cpp` backend type.
2.  **Calculation**:
    *   Reads the model size and bits-per-weight (BPW) from the GGUF header.
    *   Calculates required context memory based on the requested context size.
    *   Uses the detected capability/backend type to decide whether to allocate layers to VRAM (if a GPU backend like CUDA or Metal is present) or rely solely on CPU/RAM (if it is a CPU-only build).
    *   Determines the maximum number of layers that can fit into the available VRAM (leaving a 1GB safety buffer).
3.  **Application**: Automatically sets the `-ngl` (GPU layers) slider, sets CPU threads to `Math.floor(os.cpus().length / 2)` as a reasonable cross-platform default (note: `os.cpus()` returns **logical** cores; on hyperthreaded x86 systems this yields physical core count, which is appropriate for llama.cpp; on Apple Silicon, all cores are reported and dividing by two may under-utilize the performance core cluster — the calculated value MUST therefore be displayed as an editable field that the user can adjust, not silently applied as a fixed constant), and adjusts the context size to prevent Out-Of-Memory errors. If the requested context size mathematically exceeds the total available system RAM (even with 0 GPU layers), the UI must display a prominent warning preventing the load to avoid a hard OS crash.

## 7. Implementation Phases & Testing Strategy

*Note: All tests must use real file system interactions and real child processes. Mocks are strictly banned outside the test suite. Within the isolated test suite context, providing static inputs (e.g., static hardware profiles) is permitted to validate pure functions deterministically.*

### Phase 1: Core Infrastructure & GGUF Management
*   **Implementation**: Build the Bun.serve server (including the SPA fallback in the `fetch` handler), database layer, `config.ts`, `scanner.ts`, and `gguf.ts`. Implement the hierarchical directory traversal and MMPROJ linking logic.
*   **Tests**:
    *   Create a temporary directory structure with real dummy `.gguf` files (containing valid magic bytes) and verify the scanner correctly identifies base models, links MMPROJ files, and extracts file sizes.
    *   Test the `@huggingface/gguf` integration against a known, small, real GGUF file to ensure accurate extraction of architecture and context length.

### Phase 2: `llama-server` Process Management & HTTP Proxy
*   **Implementation**: Build `llamaServer.ts`. Implement the child process wrapper, health-poll loop, graceful shutdown, OS signal cleanup, and the generation abort flow using the verified cancellation mechanism of the bundled `llama-server` build. Build the Bun.serve route handlers that forward `/completion` and `/v1/chat/completions` requests to the running `llama-server` instance, including SSE stream forwarding via `ReadableStream` responses. Intercept `stderr` for loading progress parsing and forward all raw output to `debug.ts` for the Debug Log SSE channel. Implement the `timings` extraction from generation response bodies for tok/s reporting and context usage display (`cache_n`, `prompt_n`, `predicted_n`).
*   **Tests**:
    *   Integration test: Spawn a real `llama-server` binary using a tiny test model (e.g., a 1MB test GGUF). Poll `/health` and assert it reaches `{"status": "ok"}`. Send a `POST /completion` request and verify a non-empty `content` field is returned. Assert the process remains alive after the request completes.
    *   Verify the loading-progress `stderr` parser correctly extracts `llama_model_load` percentage values via regex and emits them as structured SSE events.
    *   Verify the `timings.predicted_per_second` field is extracted from a real or representative completion response body and emitted as a structured SSE event.
    *   Verify the abort flow: initiate a streaming generation, send the abort signal, and assert the SSE stream closes cleanly without the server process exiting.
    *   Verify the debug SSE channel emits entries tagged with the correct source label and timestamp for both `stdout` and `stderr` events.
    *   Verify the debug SSE channel correctly drops new entries when no client is connected (i.e., when `req.signal` has been aborted).

### Phase 3: Frontend Foundation & State
*   **Implementation**: Bootstrap the frontend via the canonical `create-next-app --src-dir` plus `npx shadcn@latest init --preset bbVJxYW` flow from §2.6, then layer in Zustand stores and app-specific dependencies. Connect the frontend to the backend's persistent chat state database. Build the base UI layout, including the `layout.tsx` Server Component shell with its `<Providers>` client boundary and the `page.tsx` Server Component with its `<ChatApp>` client boundary.
*   **Tests**:
    *   E2E tests using Playwright: Verify that creating a chat, sending a message, and refreshing the page successfully loads the persisted state from the backend database.
  *   E2E test: Verify that navigating directly to any non-root client route (simulating a browser refresh mid-session) returns a 200 response with `index.html` content and the application boots correctly, confirming the Bun.serve SPA fallback handler is functioning, while unknown backend API routes still return normal API error statuses.

### Phase 4: Chat Features, Edit/Regenerate/Branch, Multimodal & Gemma 4 Specifics
*   **Implementation**: Build the Chat UI (with Markdown, KaTeX, Mermaid, inline media rendering, and smart auto-scroll) using real shadcn/ui-generated primitives for the main interactive controls. Implement message actions: Stop (verified abort helper), Edit (history truncation + `cache_prompt: true` re-send), Regenerate (last assistant message drop + `cache_prompt: true` re-send), and Branch (DB copy + Zustand navigation). Implement persistent media file storage, base64 encoding at request time, `multimodal_data` / OAI content-part construction, and multimodal capability detection. Prefer server-native `reasoning_content` handling for Gemma 4 and other reasoning-capable models, with a model-aware fallback parser for raw `<think>...</think>` streams in the generic case and raw Gemma 4 `<|channel>thought\n` streams only when the bundled server/template does not emit structured reasoning output.
*   **Tests**:
    *   Playwright E2E: Send a message, then edit the user message. Verify the history is truncated in the database and the new assistant response is generated without a `llama-server` process restart (assert the server PID is unchanged before and after the edit).
    *   Playwright E2E: Regenerate a response. Verify the last assistant message is replaced in the database without a process restart.
    *   Playwright E2E: Branch a conversation. Verify a new chat ID appears in the database with the correct history slice, and the UI navigates to it.
    *   Playwright E2E: Switch models mid-conversation. Verify the full history is preserved in the database and the new assistant response is generated by the new model.
    *   Playwright E2E: Upload multiple test images and verify the backend correctly constructs either a `multimodal_data` array with matching `<__media__>` markers for `/completion`, or an OpenAI-style content-part array for `/v1/chat/completions`, with base64-encoded file data in the correct count and order.
    *   Backend Unit Test: Feed simulated SSE byte streams for both the generic raw reasoning pair `<think>...</think>` and the Gemma 4-specific raw pair `<|channel>thought\n...<channel|>` into the proxy parser — including test cases where the tags are split across multiple buffered SSE events — and verify it correctly separates reasoning content from final content in all cases.
    *   Backend Unit Test: Simulate an abort signal mid-way through a reasoning block and verify the partial `reasoning_content` is preserved and marked as truncated rather than discarded.

### Phase 5: Optimization & Polish
*   **Implementation**: Build the Hardware Optimizer, Preset Editors, Jinja Editor (with server restart on template change), the Tool Manager UI, the local-tool loader / validator / registry, the Tool Calling proxy and Stream State Machine, the Structured Output mode selector / validator / injector (including `json_object`, `json_schema`, `$ref` rejection, and post-response validation), and the Debug Log window with its settings panel. Finalize the Bun compile script.
*   **Tests**:
    *   Optimizer Tests: Provide the optimizer function with static hardware profiles (e.g., 8GB VRAM, 32GB RAM) and verify it outputs the mathematically correct `-ngl` and thread counts.
    *   Preset Tests: Verify that modifying a Jinja template in the UI correctly updates the backend database, triggers a `llama-server` restart, and the new instance is spawned with `--jinja --chat-template-file <path>`. Verify the Tool stream state machine correctly buffers and executes a local tool function from OAI-format `tool_calls` deltas when the active template is tool-compatible.
    *   Tool Loader Tests: Verify that a valid app-data `tools/<name>/tool.ts` module loads into the registry, and that invalid modules are rejected with precise errors for missing default export, invalid `apiVersion`, invalid `kind`, duplicate tool name, folder/name mismatch, or unsupported schema keywords such as `$ref`.
    *   Tool Execution Tests: Verify that tool arguments are validated against `inputSchema`, that invalid arguments become structured tool failures, that tool timeouts and aborts are normalized rather than crashing the backend, and that the persisted chat history contains both the assistant-side tool-call metadata and the final `tool` role result with the matching `tool_call_id`.
    *   Tool Manager UI Tests: Verify that `Refresh Tools` rescans the tool directory, that enable/disable state persists across restart, that `Open Tools Folder` targets the correct application-data path, and that rejected tools are displayed with their exact load error text.
    *   Debug Log Tests: Verify that toggling individual stream categories in `GlobalSettings` causes the frontend to correctly filter incoming SSE entries so that only the selected source labels are rendered in the `DebugLogWindow`. Verify that the log buffer is capped at the configured "Max log entries" value and that "Clear Log" flushes all entries.
    *   Structured Output Mode Tests: Verify that `Off`, `Any JSON Object`, and `JSON Schema` modes map to the correct request payloads, and that `/completion` never attempts to use `json_object` mode.
    *   Structured Output Validation Tests: Verify that invalid JSON pasted into the schema editor blocks submission, and that any schema containing `$ref` causes the UI to display the `$ref` limitation warning and does not attempt to pass the schema to `llama-server`.
    *   Structured Output Response Tests: Verify that valid structured outputs are parsed and marked successful, malformed JSON is preserved but marked as parse failure, schema-violating JSON is preserved but marked as schema-validation failure, and aborted/incomplete generations are marked as truncated rather than valid structured output.