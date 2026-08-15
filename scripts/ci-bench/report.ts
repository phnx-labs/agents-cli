import { extractAllPhaseTimes, valuesForPhase } from './phases';
import { gatedPercentiles } from './percentile';
import { compareAllProviders } from './providers';
import {
  allTargetsPass,
  evaluateCiTargets,
  evaluateReleaseTargets,
  windowsRequiredFromWorkflow,
} from './gates';
import type {
  BenchInput,
  PhasePercentiles,
  PhaseTimes,
  ProviderComparison,
  TargetEvaluation,
  WindowsRequiredFinding,
} from './types';
import { PHASES, REPORTED_PERCENTILES } from './types';

export interface BenchReport {
  requiredCi: {
    n: number;
    phases: PhasePercentiles[];
    targets: TargetEvaluation[];
  };
  release: {
    n: number;
    phases: PhasePercentiles[];
    targets: TargetEvaluation[];
  };
  providers: ProviderComparison[];
  windows: WindowsRequiredFinding | null;
  pass: boolean;
}

function phaseTable(times: readonly PhaseTimes[]): PhasePercentiles[] {
  return PHASES.map((phase) => {
    const key = `${phase}Ms` as 'queueMs' | 'setupMs' | 'executionMs' | 'reportMs' | 'e2eMs';
    const values = valuesForPhase(times, key);
    return {
      phase,
      n: values.length,
      percentiles: gatedPercentiles(values, REPORTED_PERCENTILES),
    };
  });
}

export function buildReport(
  input: BenchInput,
  workflowSource?: string,
): BenchReport {
  const times = extractAllPhaseTimes(input.runs);
  const ci = times.filter((t) => t.kind === 'required-ci');
  const release = times.filter((t) => t.kind === 'release');
  const ciTargets = evaluateCiTargets(valuesForPhase(ci, 'e2eMs'));
  const releaseTargets = evaluateReleaseTargets(valuesForPhase(release, 'e2eMs'));
  const windows = workflowSource ? windowsRequiredFromWorkflow(workflowSource) : null;
  const pass =
    allTargetsPass(ciTargets)
    && allTargetsPass(releaseTargets)
    && (windows ? windows.pass : true);

  return {
    requiredCi: { n: ci.length, phases: phaseTable(ci), targets: ciTargets },
    release: { n: release.length, phases: phaseTable(release), targets: releaseTargets },
    providers: compareAllProviders(ci),
    windows,
    pass,
  };
}

export function formatReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`ci-bench  required-ci n=${report.requiredCi.n}  release n=${report.release.n}  ${report.pass ? 'PASS' : 'FAIL'}`);
  for (const [label, block] of [['required-ci', report.requiredCi], ['release', report.release]] as const) {
    lines.push(`${label}:`);
    for (const phase of block.phases) {
      const cells = phase.percentiles.map((s) => {
        if (s.status === 'insufficient-sample') {
          return `P${s.p}=insufficient(n=${s.n}<${s.required})`;
        }
        return `P${s.p}=${s.valueMs}ms`;
      });
      lines.push(`  ${phase.phase.padEnd(10)} ${cells.join('  ')}`);
    }
    for (const t of block.targets) {
      lines.push(`  ${t.pass ? 'ok  ' : 'fail'} ${t.reason}`);
    }
  }
  lines.push('providers github-hosted vs crabbox:');
  for (const cmp of report.providers) {
    if (cmp.status === 'insufficient-sample') {
      lines.push(
        `  ${cmp.phase} P${cmp.p}: insufficient-sample `
        + `github n=${cmp.left.sample.n}/${cmp.left.sample.required} `
        + `crabbox n=${cmp.right.sample.n}/${cmp.right.sample.required}`,
      );
      continue;
    }
    lines.push(
      `  ${cmp.phase} P${cmp.p}: github=${cmp.left.sample.valueMs}ms `
      + `crabbox=${cmp.right.sample.valueMs}ms `
      + `faster=${cmp.faster} delta=${cmp.deltaMs}ms`,
    );
  }
  if (report.windows) {
    lines.push(
      `windows-required: ${report.windows.pass ? 'ok (not required)' : 'fail (still required)'} `
      + `(${report.windows.evidence})`,
    );
  }
  return lines.join('\n') + '\n';
}
