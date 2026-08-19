import type { CodexBarDesktopApi } from "../ipc/api.js";

declare global {
  interface Window {
    readonly codexbar: CodexBarDesktopApi;
  }
}

export {};
