import { mock } from "bun:test";

mock.module("zustand", () => ({
  create: () => () => ({}),
}));
mock.module("zustand/middleware", () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({}),
}));
mock.module("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve([]),
}));
mock.module("./analysis/scalp-engine", () => ({
  ScalpEngine: {
    recordUserTradeEmission: () => {}
  }
}));
