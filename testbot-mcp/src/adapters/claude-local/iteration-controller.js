'use strict';

/**
 * Decides whether the claude-local adapter should keep iterating, stop on
 * success, stop on Claude's self-DONE marker, stop on the iteration cap,
 * stop on no-progress, or stop on external abort.
 *
 * Inputs are pure: pass in the latest run state and the controller returns
 * a single string decision. Designed to be trivially table-driven in tests.
 *
 * Decision priority (WS-3 + CL3-B):
 *   1. aborted                       → stop_aborted     (external signal trumps everything)
 *   2. CL3-B qa_cycle_complete       → stop_qa_cycle_complete
 *                                      (only real bugs left + passRate plateaued; iter>=2)
 *   3. selfDone && iter>=1           → stop_self_done   (Claude said DONE)
 *   4. iter >= maxIterations         → stop_coverage_degraded | stop_max_iterations
 *   5. real coverage win             → stop_success     (only when totalAcTags >= 5)
 *   6. passRate >= target            → stop_success
 *   7. no-progress stall             → stop_no_progress
 *   8. default                       → continue
 */

const DEFAULT_PASS_TARGET = 0.95;
const DEFAULT_UNCOVERED_FRACTION = 0.05;
const DEFAULT_PROGRESS_DELTA = 0.02;
const DEFAULT_NO_PROGRESS_LIMIT = 3;
const DEFAULT_MAX_ITERATIONS = 5;
// Below this many AC tags the uncoveredFraction metric is unreliable (it
// trivially evaluates to 0/N for tiny denominators — the exact bug WS-3 is
// fixing). 5 was picked as the smallest universe where the ratio is at least
// directionally informative.
const MIN_TOTAL_ACS_FOR_COVERAGE_STOP = 5;

/**
 * @param {object} input
 * @param {number}  input.passRate                 0–1 (passed/total) for the latest iteration
 * @param {number}  [input.previousPassRate]       0–1 from prior iteration (null on iter 1)
 * @param {number}  input.iteration                1-based iteration counter (current iter)
 * @param {number}  [input.uncoveredAcTagsCount]   Remaining uncovered ACs
 * @param {number}  [input.previousUncoveredCount] Uncovered count from prior iter (null on iter 1)
 * @param {number}  input.totalAcTags              Universe of AC tags
 * @param {number}  [input.noProgressCounter]      Consecutive iters with delta < progressDelta
 * @param {boolean} [input.aborted]                External abort signal
 * @param {boolean} [input.selfDone]               Claude emitted the "DONE" marker (WS-3)
 * @param {number}  [input.maxIterations]          Cap iterations (default 5; HEALIX_CLAUDE_MAX_ITERATIONS overrides)
 * @param {object}  [input.targets]                Override thresholds
 * @param {object}  [input.failureBreakdown]       CL3-B: { real, bad, env } counts from failure classifier
 * @returns {{ decision: 'continue'|'stop_success'|'stop_self_done'|'stop_qa_cycle_complete'|'stop_max_iterations'|'stop_coverage_degraded'|'stop_no_progress'|'stop_aborted',
 *             reason: string,
 *             noProgressCounter: number,
 *             targetsMet: boolean }}
 */
function decide(input) {
  const targets = input.targets || {};
  const passTarget = Number.isFinite(targets.passTarget) ? targets.passTarget : DEFAULT_PASS_TARGET;
  const uncoveredFractionTarget = Number.isFinite(targets.uncoveredFraction)
    ? targets.uncoveredFraction
    : DEFAULT_UNCOVERED_FRACTION;
  const progressDelta = Number.isFinite(targets.progressDelta) ? targets.progressDelta : DEFAULT_PROGRESS_DELTA;
  const noProgressLimit = Number.isFinite(targets.noProgressLimit)
    ? targets.noProgressLimit
    : DEFAULT_NO_PROGRESS_LIMIT;

  // Iteration cap: explicit input wins; env override is next; default last.
  const envMax = Number.parseInt(process.env.HEALIX_CLAUDE_MAX_ITERATIONS || '', 10);
  const maxIterations = Number.isFinite(input.maxIterations) && input.maxIterations > 0
    ? Math.floor(input.maxIterations)
    : (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_ITERATIONS);

  const passRate = clamp01(input.passRate);
  const previousPassRate = Number.isFinite(input.previousPassRate) ? clamp01(input.previousPassRate) : null;
  const iteration = Number.isFinite(input.iteration) ? input.iteration : 1;
  const uncoveredAcTagsCount = Number.isFinite(input.uncoveredAcTagsCount) ? input.uncoveredAcTagsCount : 0;
  const totalAcTags = Number.isFinite(input.totalAcTags) ? input.totalAcTags : 0;
  const prevUncovered = Number.isFinite(input.previousUncoveredCount) ? input.previousUncoveredCount : null;
  const aborted = Boolean(input.aborted);
  const selfDone = Boolean(input.selfDone);
  const prevNoProgress = Number.isFinite(input.noProgressCounter) ? input.noProgressCounter : 0;

  // 1. External abort — highest priority.
  if (aborted) {
    return {
      decision: 'stop_aborted',
      reason: 'external abort signal received',
      noProgressCounter: prevNoProgress,
      targetsMet: false,
    };
  }

  // 2. CL3-B — graceful exit when only REAL bugs remain and we're plateauing.
  //    The QA cycle has done its job; the rest is dev's job.
  //    Requires iter >= 2 AND a previousPassRate baseline AND realCount > 0 AND
  //    no bad/env failures AND pass rate plateaued (|delta| < 0.02).
  if (iteration >= 2 && Number.isFinite(input.previousPassRate)) {
    const breakdown = input.failureBreakdown || {};
    const allRemaining = (breakdown.bad || 0) + (breakdown.env || 0);
    const realCount = breakdown.real || 0;
    const prevPass = clamp01(input.previousPassRate);
    const plateaued = Math.abs(passRate - prevPass) < 0.02;
    if (allRemaining === 0 && realCount > 0 && plateaued) {
      return {
        decision: 'stop_qa_cycle_complete',
        reason: `${realCount} real bug(s) confirmed; iteration ${iteration} plateaued at passRate=${passRate.toFixed(3)}. Pipeline cannot fix product bugs — handing off to developer.`,
        noProgressCounter: prevNoProgress,
        targetsMet: true,
      };
    }
  }

  // 3. Claude self-DONE — but CL2-C override: refuse premature DONE.
  //    If Claude says DONE while metrics are clearly below the QA-replacement
  //    bar, we treat it as wishful thinking and keep iterating. Specifically:
  //      * passRate must be >= SELF_DONE_PASS_FLOOR (0.90)
  //      * acCoverage (covered/total) must be >= SELF_DONE_AC_FLOOR (0.80)
  //        — but only when totalAcTags is reliable (>= MIN_TOTAL_ACS_FOR_COVERAGE_STOP).
  //    Floors are tunable via targets.* or env HEALIX_CLAUDE_DONE_PASS_FLOOR /
  //    HEALIX_CLAUDE_DONE_AC_FLOOR.
  if (selfDone && iteration >= 1) {
    const envPassFloor = Number.parseFloat(process.env.HEALIX_CLAUDE_DONE_PASS_FLOOR || '');
    const envAcFloor = Number.parseFloat(process.env.HEALIX_CLAUDE_DONE_AC_FLOOR || '');
    const passFloor = Number.isFinite(targets.selfDonePassFloor) ? targets.selfDonePassFloor
      : (Number.isFinite(envPassFloor) ? envPassFloor : 0.90);
    const acFloor = Number.isFinite(targets.selfDoneAcFloor) ? targets.selfDoneAcFloor
      : (Number.isFinite(envAcFloor) ? envAcFloor : 0.80);
    const coveredFraction = totalAcTags > 0 ? Math.max(0, (totalAcTags - uncoveredAcTagsCount) / totalAcTags) : 0;
    const acReliable = totalAcTags >= MIN_TOTAL_ACS_FOR_COVERAGE_STOP;
    const passOk = passRate >= passFloor;
    const acOk = !acReliable || coveredFraction >= acFloor;
    if (passOk && acOk) {
      return {
        decision: 'stop_self_done',
        reason: `claude DONE at iteration ${iteration} (passRate=${passRate.toFixed(3)}>=${passFloor}, coveredFraction=${coveredFraction.toFixed(3)}>=${acFloor})`,
        noProgressCounter: prevNoProgress,
        targetsMet: true,
      };
    }
    return {
      decision: 'continue',
      reason: `claude DONE rejected — premature (passRate=${passRate.toFixed(3)} need>=${passFloor}, coveredFraction=${coveredFraction.toFixed(3)} need>=${acFloor}, acReliable=${acReliable})`,
      noProgressCounter: prevNoProgress,
      targetsMet: false,
      selfDoneOverridden: true,
    };
  }

  // 3. Iteration cap — hard ceiling, cost guard.
  if (iteration >= maxIterations) {
    const allowCoverageDegraded = input.allowCoverageDegraded !== false;
    const usefulTestsRan = (Number.isFinite(input.totalTests) && input.totalTests > 0)
      || passRate > 0
      || (Number.isFinite(input.executedTests) && input.executedTests > 0);
    const breakdown = input.failureBreakdown || {};
    const envFailures = Number(breakdown.env || 0);
    if (allowCoverageDegraded && usefulTestsRan && envFailures === 0) {
      return {
        decision: 'stop_coverage_degraded',
        reason: `reached max iterations (${maxIterations}) with useful tests executed; reporting coverage_degraded instead of pipeline error`,
        noProgressCounter: prevNoProgress,
        targetsMet: false,
      };
    }
    return {
      decision: 'stop_max_iterations',
      reason: `reached max iterations (${maxIterations})`,
      noProgressCounter: prevNoProgress,
      targetsMet: false,
    };
  }

  // 4 & 5. Targets met — coverage signal is ONLY honored when we have
  // enough AC tags to make the ratio meaningful (WS-3 bug fix).
  const uncoveredFraction = totalAcTags > 0 ? (uncoveredAcTagsCount / totalAcTags) : 0;
  const coverageSignalReliable = totalAcTags >= MIN_TOTAL_ACS_FOR_COVERAGE_STOP;
  const coverageWin = coverageSignalReliable && uncoveredFraction <= uncoveredFractionTarget;
  const passWin = passRate >= passTarget;
  const targetsMet = passWin || coverageWin;

  if (targetsMet) {
    const reasonParts = [];
    if (passWin) reasonParts.push(`passRate=${passRate.toFixed(3)} ≥ ${passTarget}`);
    if (coverageWin) reasonParts.push(`uncoveredFraction=${uncoveredFraction.toFixed(3)} ≤ ${uncoveredFractionTarget} (totalAcTags=${totalAcTags})`);
    return {
      decision: 'stop_success',
      reason: reasonParts.join(' AND '),
      noProgressCounter: 0,
      targetsMet: true,
    };
  }

  // 6. No-progress detection only kicks in once we have a baseline.
  if (previousPassRate != null && iteration > 1) {
    const passDelta = passRate - previousPassRate;
    const uncoveredUnchanged = prevUncovered == null ? false : prevUncovered === uncoveredAcTagsCount;
    const stalled = passDelta < progressDelta && uncoveredUnchanged;
    const nextNoProgress = stalled ? prevNoProgress + 1 : 0;
    if (nextNoProgress >= noProgressLimit) {
      return {
        decision: 'stop_no_progress',
        reason: `passDelta=${passDelta.toFixed(3)} < ${progressDelta} and uncovered count unchanged for ${nextNoProgress} iterations`,
        noProgressCounter: nextNoProgress,
        targetsMet: false,
      };
    }
    return {
      decision: 'continue',
      reason: `passRate=${passRate.toFixed(3)} below ${passTarget}; iterating`,
      noProgressCounter: nextNoProgress,
      targetsMet: false,
    };
  }

  return {
    decision: 'continue',
    reason: 'first iteration baseline established; continuing',
    noProgressCounter: 0,
    targetsMet: false,
  };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

module.exports = {
  decide,
  DEFAULTS: {
    DEFAULT_PASS_TARGET,
    DEFAULT_UNCOVERED_FRACTION,
    DEFAULT_PROGRESS_DELTA,
    DEFAULT_NO_PROGRESS_LIMIT,
    DEFAULT_MAX_ITERATIONS,
    MIN_TOTAL_ACS_FOR_COVERAGE_STOP,
  },
};
