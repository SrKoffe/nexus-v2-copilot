/**
 * Deprecated — superseded by `OpportunityScannerPanel`.
 *
 * The OpportunityScannerPanel (already wired in App.tsx) is more complete:
 *   - Tabs (TOP / FAVORITES / SEARCH)
 *   - Persistent favorites via Zustand persist middleware
 *   - useScannerStore.setActiveSymbol does the full chain:
 *     Rust WS re-subscribe → candleManager.setSymbol → refetch history
 *
 * Re-exports the canonical component so any stale `import { UniversePanel }`
 * still resolves without breaking the build.
 */
export { OpportunityScannerPanel as UniversePanel } from './OpportunityScannerPanel';
