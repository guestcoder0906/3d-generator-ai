export enum AppPhase {
  IDLE = 'IDLE',
  PLANNING = 'PLANNING',
  GENERATING = 'GENERATING',
  QC_ANALYSIS = 'QC_ANALYSIS',
  FIXING = 'FIXING',
  ASSEMBLING = 'ASSEMBLING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export interface ComponentPlan {
  id: string;
  name: string;
  description: string;
  geometryType: string;
  materialType: string;
  dependencies: string[];
}

export interface BuildPlan {
  overview: string;
  components: ComponentPlan[];
}

export interface QCResult {
  passed: boolean;
  feedback: string;
  score: number; // 0-100
}

export interface ComponentArtifact {
  plan: ComponentPlan;
  code: string;
  status: 'PENDING' | 'GENERATED' | 'VERIFIED' | 'FAILED';
  retryCount: number;
  qcHistory: QCResult[];
  errorLogs: string[];
}

export interface LogEntry {
  timestamp: number;
  phase: AppPhase;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}