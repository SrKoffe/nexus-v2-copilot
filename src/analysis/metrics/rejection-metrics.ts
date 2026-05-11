import { EventBus } from '../event-bus';

export interface PipelineMetrics {
    scanned: number;
    microstructureRejected: number;
    liquidityRejected: number;
    confidenceRejected: number;
    evRejected: number;
    regimeRejected: number;
    riskRejected: number;
    qualified: number;
    analysisPerSec: number;
    setupsPerMin: number;
}

class RejectionMetricsEngine {
    private metrics: PipelineMetrics = {
        scanned: 0,
        microstructureRejected: 0,
        liquidityRejected: 0,
        confidenceRejected: 0,
        evRejected: 0,
        regimeRejected: 0,
        riskRejected: 0,
        qualified: 0,
        analysisPerSec: 0,
        setupsPerMin: 0
    };

    private scanTimestamps: number[] = [];
    private setupTimestamps: number[] = [];

    init() {
        EventBus.on('MARKET_TICK', () => this.trackScan());

        // Listen to L1 failures (Microstructure / Filtering)
        EventBus.on('LEVEL_1_REJECTED', () => this.metrics.microstructureRejected++);

        // Listen to L2/L3 rejections
        EventBus.on('ANALYSIS_SIGNAL', (payload: any) => {
            if (payload.score < 20) this.metrics.confidenceRejected++;
        });

        // Listen to EV/Risk rejections (from leverage-risk)
        EventBus.on('EV_REJECTED', (payload: any) => {
            if (payload?.reason?.includes('Survival')) this.metrics.riskRejected++;
            else if (payload?.reason?.includes('Negative EV') || payload?.reason?.includes('EV based on')) this.metrics.evRejected++;
            else this.metrics.liquidityRejected++;
        });

        EventBus.on('SCALP_SETUP', () => {
            this.metrics.qualified++;
            this.trackSetup();
        });

        // Calculate rolling throughputs every second
        setInterval(() => this.calculateThroughput(), 1000);
    }

    private trackScan() {
        this.metrics.scanned++;
        this.scanTimestamps.push(Date.now());
    }

    private trackSetup() {
        this.setupTimestamps.push(Date.now());
    }

    private calculateThroughput() {
        const now = Date.now();
        // Keep last 1 second for TPS
        this.scanTimestamps = this.scanTimestamps.filter(t => now - t < 1000);
        this.metrics.analysisPerSec = this.scanTimestamps.length;

        // Keep last 60 seconds for Setups Per Min
        this.setupTimestamps = this.setupTimestamps.filter(t => now - t < 60000);
        this.metrics.setupsPerMin = this.setupTimestamps.length;
    }

    getMetrics(): PipelineMetrics {
        return { ...this.metrics };
    }
}

export const RejectionMetrics = new RejectionMetricsEngine();
