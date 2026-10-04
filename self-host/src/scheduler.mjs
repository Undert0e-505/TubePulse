const WORKER_SCHEDULES = Object.freeze({
  posts: '* * * * *',
  aux: '* * * * *',
  'rss-0': '*/5 * * * *',
  'rss-1': '*/5 * * * *',
  'rss-2': '*/5 * * * *',
});

function freshOutcome() {
  return {
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastOutcome: null,
    lastError: null,
    skippedOverlaps: 0,
  };
}

export class SchedulerController {
  constructor({ runtime, mode, stateFile, timers = true }) {
    this.runtime = runtime;
    this.mode = mode;
    this.stateFile = stateFile;
    this.timers = timers;
    this.active = mode === 'standalone';
    this.roleChangedAt = null;
    this.roleChangeReason = null;
    this.timer = null;
    this.stopped = false;
    this.outcomes = Object.fromEntries(Object.keys(WORKER_SCHEDULES).map((name) => [name, freshOutcome()]));
  }

  async start() {
    const state = await this.stateFile.read();
    if (this.mode === 'mirror') {
      this.active = state.mirrorRole === 'active';
      this.roleChangedAt = state.roleChangedAt || null;
      this.roleChangeReason = state.roleChangeReason || null;
    } else {
      this.active = true;
    }
    this.stopped = false;
    if (this.timers) this.armNextMinute();
  }

  armNextMinute() {
    if (this.stopped) return;
    const now = Date.now();
    const next = Math.floor(now / 60_000) * 60_000 + 60_000;
    this.timer = setTimeout(async () => {
      try {
        await this.tick(next);
      } finally {
        this.armNextMinute();
      }
    }, Math.max(1, next - now));
    this.timer.unref?.();
  }

  async tick(scheduledTime = Date.now()) {
    if (!this.active) return [];
    const minute = Math.floor(scheduledTime / 60_000);
    const names = ['posts', 'aux'];
    if (minute % 5 === 0) names.push('rss-0', 'rss-1', 'rss-2');
    return await Promise.all(names.map((name) => this.runWorker(name, scheduledTime)));
  }

  async runWorker(name, scheduledTime) {
    const outcome = this.outcomes[name];
    if (outcome.running) {
      outcome.skippedOverlaps++;
      return { name, outcome: 'overlap-skipped' };
    }
    outcome.running = true;
    outcome.lastStartedAt = new Date(scheduledTime).toISOString();
    outcome.lastError = null;
    try {
      await this.runtime.dispatchScheduled(name, scheduledTime, WORKER_SCHEDULES[name]);
      outcome.lastOutcome = 'ok';
      return { name, outcome: 'ok' };
    } catch (error) {
      outcome.lastOutcome = 'error';
      outcome.lastError = { category: 'scheduled-handler-failed', at: new Date().toISOString() };
      return { name, outcome: 'error' };
    } finally {
      outcome.running = false;
      outcome.lastFinishedAt = new Date().toISOString();
    }
  }

  async changeMirrorRole(role, reason) {
    if (this.mode !== 'mirror') return { changed: false, reason: 'standalone-mode' };
    const nextActive = role === 'active';
    const changed = this.active !== nextActive;
    this.active = nextActive;
    this.roleChangedAt = new Date().toISOString();
    this.roleChangeReason = reason;
    const state = await this.stateFile.read();
    state.mirrorRole = role;
    state.roleChangedAt = this.roleChangedAt;
    state.roleChangeReason = reason;
    await this.stateFile.write(state);
    return { changed, role };
  }

  async takeover(reason = 'admin') {
    return await this.changeMirrorRole('active', reason);
  }

  async standby(reason = 'admin') {
    return await this.changeMirrorRole('standby', reason);
  }

  status() {
    return {
      active: this.active,
      state: this.active ? 'active' : 'standby',
      stickyTakeover: this.mode === 'mirror' && this.active,
      roleChangedAt: this.roleChangedAt,
      roleChangeReason: this.roleChangeReason,
      workers: structuredClone(this.outcomes),
    };
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export { WORKER_SCHEDULES };
