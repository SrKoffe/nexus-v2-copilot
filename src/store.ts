import { create } from 'zustand';

export interface PipelineState {
    pipelineStage: number;
    pipelineStatus: 'evaluating' | 'passed' | 'rejected' | 'idle';
    pipelineDirection: 'bullish' | 'bearish' | 'neutral' | null;
    pipelineReason: string;
    pendingSetup: any | null; // Final setup to display in HUD
    leverage: number;
    balanceUsd: number;
    
    updatePipelineStatus: (stage: number, status: 'evaluating' | 'passed' | 'rejected', direction: 'bullish'|'bearish'|'neutral', reason: string) => void;
    setPendingSetup: (setup: any) => void;
    setLeverage: (lev: number) => void;
}

export const useNexusStore = create<PipelineState>((set) => ({
    pipelineStage: 0,
    pipelineStatus: 'idle',
    pipelineDirection: null,
    pipelineReason: 'Waiting for volatility...',
    pendingSetup: null,
    leverage: 50,
    balanceUsd: 10000,
    
    updatePipelineStatus: (stage, status, direction, reason) => 
        set({
            pipelineStage: stage,
            pipelineStatus: status,
            pipelineDirection: direction,
            pipelineReason: reason
        }),
        
    setPendingSetup: (setup) => set({ pendingSetup: setup }),
    setLeverage: (lev) => set({ leverage: lev })
}));
