/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin. Empty = same origin (Vite dev proxy forwards /api to the backend). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
