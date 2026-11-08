#!/usr/bin/env node
// proof/scheduler-proof.mjs
// 离线证明 DESIGN.md §9.3「任务与自动化」的调度语义。
// 纯 Node（>=20），零依赖、无网络、不连 DSH：用可注入时钟做离散事件模拟。

const HOP_LIMIT = 8;
const results = [];

function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
}

class Engine {
  constructor(seed) {
    this.t = 0;
    this.seq = 0;
    this.jobs = new Map();
    this.runs = [];
    this.idem = new Set();
    this.blocked = [];
    this.artifacts = [];
    if (seed) this.load(seed);
  }

  addJob(job) {
    const j = {
      id: 'job', durMs: 100, lane: null, concurrency: 1, intervalMs: null,
      nextRunAt: 0, catchUp: 'skip', after: null, hops: 0, attempts: 0, ...job,
    };
    this.jobs.set(j.id, j);
    return j;
  }

  runningOf(id) { return this.runs.filter((r) => r.jobId === id && r.state === 'running'); }

  laneBusy(lane) { return !!lane && this.runs.some((r) => r.state === 'running' && r.lane === lane); }

  idemKey(job, scheduledAt) { return job.id + '@' + scheduledAt; }

  canStart(job) {
    if (this.t < job.nextRunAt) return false;
    if (this.idem.has(this.idemKey(job, job.nextRunAt))) return false;
    if (this.laneBusy(job.lane)) return false;
    if (this.runningOf(job.id).length >= job.concurrency) return false;
    return true;
  }

  nextDueTime() {
    let t = Infinity;
    for (const job of this.jobs.values()) {
      if (job.nextRunAt === Infinity) continue;
      if (this.t < job.nextRunAt) t = Math.min(t, job.nextRunAt);
      else if (this.canStart(job)) t = Math.min(t, job.nextRunAt);
    }
    return t;
  }

  nextEndTime() {
    let t = Infinity;
    for (const r of this.runs) if (r.state === 'running') t = Math.min(t, r.end);
    return t;
  }

  start(job, scheduledAt) {
    this.idem.add(this.idemKey(job, scheduledAt));
    const run = {
      id: 'run-' + ++this.seq, jobId: job.id, scheduledAt,
      start: this.t, end: this.t + job.durMs, lane: job.lane,
      hops: job.hops || 0, state: 'running', attempts: 1,
    };
    this.runs.push(run);
    job.attempts += 1;
    if (job.intervalMs) {
      let next = scheduledAt + job.intervalMs;
      if (next <= this.t) next = this.t + job.intervalMs;
      job.nextRunAt = next;
    } else job.nextRunAt = Infinity;
    return run;
  }

  finishAt(t) {
    for (const r of this.runs) {
      if (r.state !== 'running' || r.end !== t) continue;
      r.state = 'succeeded';
      this.artifacts.push(r.id);
      const job = this.jobs.get(r.jobId);
      for (const child of this.jobs.values()) {
        if (child.after !== r.jobId) continue;
        if (r.hops + 1 > HOP_LIMIT) { this.blocked.push({ jobId: child.id, hops: r.hops + 1, at: t }); continue; }
        child.hops = r.hops + 1;
        child.nextRunAt = t;
      }
      if (job && job.retryOnce && !r.retried) { r.retried = true; }
    }
  }

  startDue() {
    for (const job of this.jobs.values()) {
      if (this.canStart(job)) this.start(job, job.nextRunAt);
    }
  }

  advance(until) {
    for (let guard = 0; guard < 10000; guard++) {
      const due = this.nextDueTime();
      const end = this.nextEndTime();
      const t = Math.min(due, end, until);
      if (!Number.isFinite(t)) break;
      this.t = t;
      this.finishAt(t);
      this.startDue();
      if (t >= until) break;
    }
    if (this.t < until) this.t = until;
  }

  startupCatchUp() {
    for (const job of this.jobs.values()) {
      if (!job.intervalMs || job.nextRunAt === Infinity || this.t < job.nextRunAt) continue;
      const missed = Math.floor((this.t - job.nextRunAt) / job.intervalMs) + 1;
      let next = job.nextRunAt + missed * job.intervalMs;
      while (next <= this.t) next += job.intervalMs;
      if (job.catchUp === 'run-once' && !this.idem.has(this.idemKey(job, job.nextRunAt))) {
        const r = this.start(job, job.nextRunAt);
        r.start = this.t;
        r.end = this.t + job.durMs;
      }
      job.nextRunAt = next;
    }
  }

  recover() {
    for (const r of this.runs) {
      if (r.state !== 'running') continue;
      r.state = 'interrupted';
      const job = this.jobs.get(r.jobId);
      if (job && job.retryOnce) {
        r.state = 'running';
        r.attempts = 2;
        r.start = this.t;
        r.end = this.t + job.durMs;
        r.retried = true;
      }
    }
  }

  dump() {
    return JSON.stringify({
      t: this.t, jobs: [...this.jobs.values()], runs: this.runs,
      idem: [...this.idem], artifacts: this.artifacts,
    });
  }

  load(snapshot) {
    const s = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    this.t = s.t;
    this.jobs = new Map(s.jobs.map((j) => [j.id, j]));
    this.runs = s.runs;
    this.idem = new Set(s.idem);
    this.artifacts = s.artifacts || [];
  }
}

// S1 幂等：同一到期只跑一次，下个周期正常
{
  const e = new Engine();
  e.addJob({ id: 'hourly', intervalMs: 1000, nextRunAt: 1000 });
  e.advance(1000);
  const first = e.runs.length;
  e.startDue(); e.startDue();
  check('S1 同一到期只跑一次（重复 tick 不重复跑）', first === 1 && e.runs.length === 1, 'runs=' + e.runs.length);
  e.advance(2000);
  check('S1b 下个周期正常再跑', e.runs.length === 2, 'runs=' + e.runs.length);
}

// S2 同 lane 串行
{
  const e = new Engine();
  for (const id of ['a', 'b', 'c']) e.addJob({ id, lane: 'gp/order', concurrency: 3, nextRunAt: 0 });
  e.advance(1000);
  const rs = [...e.runs].sort((x, y) => x.start - y.start);
  const serial = rs.every((r, i) => i === 0 || r.start >= rs[i - 1].end);
  check('S2 同 lane 串行（时间线不重叠）', rs.length === 3 && serial, rs.map((r) => r.start + '-' + r.end).join(' '));
}

// S3 不同 lane 并行
{
  const e = new Engine();
  for (const id of ['x', 'y', 'z']) e.addJob({ id, lane: 'lane-' + id, nextRunAt: 0 });
  e.advance(1000);
  const overlap = e.runs.some((r) => e.runs.some((o) => o !== r && r.start < o.end && o.start < r.end));
  check('S3 不同 lane 可并行（存在重叠）', e.runs.length === 3 && overlap, e.runs.map((r) => r.start + '-' + r.end).join(' '));
}

// S4 catchUp=skip
{
  const e = new Engine();
  e.addJob({ id: 'daily', intervalMs: 1000, nextRunAt: 0, catchUp: 'skip' });
  e.t = 5500; e.startupCatchUp();
  check('S4 错过 5 期 catchUp=skip 不补跑', e.runs.length === 0 && e.jobs.get('daily').nextRunAt > 5500, 'next=' + e.jobs.get('daily').nextRunAt);
}

// S5 catchUp=run-once
{
  const e = new Engine();
  e.addJob({ id: 'daily', intervalMs: 1000, nextRunAt: 0, catchUp: 'run-once' });
  e.t = 5500; e.startupCatchUp();
  check('S5 错过 5 期 catchUp=run-once 只补一次', e.runs.length === 1 && e.jobs.get('daily').nextRunAt > 5500, 'runs=' + e.runs.length + ' next=' + e.jobs.get('daily').nextRunAt);
}

// S6 after 链 9 跳熔断
{
  const e = new Engine();
  e.addJob({ id: 'j0', nextRunAt: 0, durMs: 10 });
  for (let i = 1; i <= 10; i++) e.addJob({ id: 'j' + i, after: 'j' + (i - 1), nextRunAt: Infinity, durMs: 10 });
  e.advance(5000);
  check('S6 after 链第 9 跳后熔断', e.runs.length === 9 && e.blocked.length === 1, 'executed=' + e.runs.length + ' blocked=' + JSON.stringify(e.blocked));
}

// S7 重启恢复
{
  const e = new Engine();
  e.addJob({ id: 'slow', nextRunAt: 0, durMs: 10000, retryOnce: true });
  e.advance(1000);
  const snap = e.dump();
  const e2 = new Engine(snap);
  e2.t = 5000; e2.recover();
  check('S7 重启把 running 标为 interrupted 并重试一次', e2.runs[0].attempts === 2 && e2.runs[0].state === 'running', 'attempts=' + e2.runs[0].attempts);
  e2.advance(20000);
  check('S7b 重试只产出一个产物（不重复）', e2.artifacts.length === 1, 'artifacts=' + e2.artifacts.length);
}

const pass = results.filter((r) => r.pass).length;
console.log('调度语义离线断言');
console.log('='.repeat(64));
for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
console.log('='.repeat(64));
console.log('total=' + results.length + ' pass=' + pass + ' fail=' + (results.length - pass));
process.exit(pass === results.length ? 0 : 1);