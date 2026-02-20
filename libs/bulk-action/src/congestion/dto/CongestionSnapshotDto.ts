export interface CongestionSnapshot {
  nonReadyCount: number;
  rateLimitSpeed: number;
  backoffMs: number;
  timestamp: number;
}
