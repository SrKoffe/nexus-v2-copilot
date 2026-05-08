import { mock } from "bun:test";

mock.module('zustand/middleware', () => ({
    persist: (creator: any) => creator,
    createJSONStorage: () => undefined,
}));

mock.module('zustand', () => {
    return {
        create: (stateCreator: any) => {
            if (!stateCreator) {
                return (realCreator: any) => createStoreMock(realCreator);
            }
            return createStoreMock(stateCreator);
        }
    };
});

function createStoreMock(stateCreator: any) {
    let state: any;
    const listeners = new Set<Function>();

    const set = (partial: any) => {
        const nextState = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...nextState };
        listeners.forEach(l => l(state));
    };

    const get = () => state;

    const store = (selector?: any) => {
        if (selector) return selector(state);
        return state;
    };

    store.getState = get;
    store.setState = set;
    store.subscribe = (listener: Function) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };

    state = stateCreator(set, get);
    return store;
}
mock.module("@tauri-apps/api/core", () => ({
  invoke: mock(() => Promise.resolve([])),
}));
mock.module("./analysis/scalp-engine", () => ({
  ScalpEngine: {
    recordUserTradeEmission: () => {}
  }
}));
