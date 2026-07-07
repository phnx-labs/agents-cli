import type { Command } from 'commander';
import chalk from 'chalk';
import {
  ALL_BETA_FEATURES,
  getBetaConfigLocation,
  getEnabledBetaFeatures,
  setBetaEnabled,
} from '../lib/beta.js';
import type { BetaFeatureName } from '../lib/types.js';

const BETA_DESCRIPTIONS: Record<BetaFeatureName, string> = {
  drive: 'Google Drive integration for reading and writing files',
  factory: 'Cloud-based agent dispatch via Rush Factory',
  'session-sync': 'Cross-machine session transcript sync via R2 (daemon push/pull)',
};

function parseFeatures(values: string[]): BetaFeatureName[] {
  const valid = new Set<BetaFeatureName>(ALL_BETA_FEATURES);
  const invalid = values.filter((value) => !valid.has(value as BetaFeatureName));
  if (invalid.length > 0) {
    console.error(chalk.red(`Unknown beta feature: ${invalid.join(', ')}`));
    console.error(chalk.gray(`Valid features: ${ALL_BETA_FEATURES.join(', ')}`));
    process.exit(1);
  }
  return values as BetaFeatureName[];
}

export function registerBetaCommands(program: Command): void {
  const beta = program
    .command('beta')
    .description('Enable or disable preview features like drive and factory.')
    .addHelpText('after', `
Examples:
  agents beta list
  agents beta enable drive factory
  agents beta disable drive
`);

  beta
    .command('list')
    .description('Show available beta features and whether they are enabled.')
    .action(() => {
      const enabled = new Set(getEnabledBetaFeatures());
      const location = getBetaConfigLocation();
      console.log(chalk.bold('Beta Features'));
      for (const feature of ALL_BETA_FEATURES) {
        const state = enabled.has(feature) ? chalk.green('enabled') : chalk.gray('disabled');
        const desc = BETA_DESCRIPTIONS[feature] || '';
        console.log(`  ${feature.padEnd(10)} ${state.padEnd(18)} ${chalk.dim(desc)}`);
      }
      console.log('');
      console.log(chalk.gray(`Config: ${location.path}`));
    });

  beta
    .command('enable <features...>')
    .description('Enable one or more beta features.')
    .action((features: string[]) => {
      const result = setBetaEnabled(parseFeatures(features), true);
      console.log(chalk.green(`Enabled: ${features.join(', ')}`));
      console.log(chalk.gray(`Saved to ${result.path}`));
    });

  beta
    .command('disable <features...>')
    .description('Disable one or more beta features.')
    .action((features: string[]) => {
      const result = setBetaEnabled(parseFeatures(features), false);
      console.log(chalk.green(`Disabled: ${features.join(', ')}`));
      console.log(chalk.gray(`Saved to ${result.path}`));
    });
}

