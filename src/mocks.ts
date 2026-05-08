import { mock } from 'bun:test';

mock.module('@tauri-apps/api/core', () => {
    return {
        invoke: mock(async (cmd: string, args: any) => {
            if (cmd === 'mexc_keys_configured') return true;
            if (cmd === 'get_mexc_balance') return 1500;
            if (cmd === 'get_mexc_positions') return [];
            return null;
        }),
    };
});
