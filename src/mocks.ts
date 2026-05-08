import { mock } from 'bun:test';

mock.module('@tauri-apps/api/core', () => ({
  invoke: mock(() => Promise.resolve()),
}));
