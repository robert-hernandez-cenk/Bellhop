import { createHash, timingSafeEqual } from 'node:crypto';
import type { Inventory } from '../../lib/inventory.ts';
import {
  completeSetupStep,
  ensurePendingSetup,
  finishSetup,
  loadSetupState,
  setupPhase,
  type SetupPhase,
  type SetupState,
} from '../../lib/setup-state.ts';

// The steps Finish requires (issue #86). Later parts of #70 append their
// own step ids here as they add steps before Finish.
export const REQUIRED_SETUP_STEPS = ['proxmox', 'basics'] as const;
export type SetupStepId = (typeof REQUIRED_SETUP_STEPS)[number];

export const SETUP_STEP_LABELS: Record<SetupStepId, string> = {
  proxmox: 'Proxmox',
  basics: 'Domain and basics',
};

export class SetupIncompleteError extends Error {}

export interface SetupServiceOptions {
  inventoryPath: string;
  // The shared, refreshed-per-request inventory (src/web/app.ts) the setup
  // routes read and write through.
  inventory: Inventory;
  // Where Bellhop's own SSH key lives (<dataDir>/ssh, research R5).
  dataDir: string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// The first-run setup walkthrough's state for one web service process
// (issue #86, research R2/R3). The phase is decided once at start-up and
// changes only through this object (finish), so it is cached rather than
// read from the database on every request; the token likewise.
export class SetupService {
  private currentPhase: SetupPhase;
  private token: string | null = null;

  constructor(readonly opts: SetupServiceOptions | null) {
    this.currentPhase = opts ? setupPhase(opts.inventoryPath, opts.inventory) : 'not-applicable';
  }

  // For an app with no setup at all (every test that predates #86): the
  // gate is a no-op and the setup API answers "not in progress".
  static notApplicable(): SetupService {
    return new SetupService(null);
  }

  // Called once at start-up (server.ts). While setup is pending, makes sure
  // the record and its token exist and returns the token for the log line.
  start(): string | undefined {
    if (this.currentPhase !== 'pending' || !this.opts) return undefined;
    this.token = ensurePendingSetup(this.opts.inventoryPath).token;
    return this.token ?? undefined;
  }

  phase(): SetupPhase {
    return this.currentPhase;
  }

  isPending(): boolean {
    return this.currentPhase === 'pending';
  }

  // Constant-time comparison over fixed-length digests, so neither the
  // token's length nor a matching prefix shows in the response time.
  tokenMatches(candidate: string | undefined): boolean {
    if (!this.isPending() || !this.token || !candidate) return false;
    return timingSafeEqual(digest(candidate), digest(this.token));
  }

  private options(): SetupServiceOptions {
    if (!this.opts) throw new Error('Setup is not in progress');
    return this.opts;
  }

  state(): SetupState {
    const state = loadSetupState(this.options().inventoryPath);
    if (!state) throw new Error('Setup is not in progress');
    return state;
  }

  completeStep(step: SetupStepId): SetupState {
    return completeSetupStep(this.options().inventoryPath, step);
  }

  // Refuses while a required step is incomplete, naming the first one.
  finish(): void {
    const done = this.state().completedSteps;
    const missing = REQUIRED_SETUP_STEPS.find((step) => !done.includes(step));
    if (missing) throw new SetupIncompleteError(`Finish step "${SETUP_STEP_LABELS[missing]}" first`);
    finishSetup(this.options().inventoryPath);
    this.currentPhase = 'finished';
    this.token = null;
  }
}
