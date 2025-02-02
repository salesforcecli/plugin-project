/*
 * Copyright (c) 2022, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as os from 'node:os';

import ansis from 'ansis';
import { EnvironmentVariable, Lifecycle, Messages, OrgConfigProperties, SfError } from '@salesforce/core';
import { CodeCoverageWarnings, DeployVersionData, RequestStatus } from '@salesforce/source-deploy-retrieve';
import { Duration, ensureArray } from '@salesforce/kit';
import { SfCommand, toHelpSection, Flags } from '@salesforce/sf-plugins-core';
import { DeployStages } from '../../../utils/deployStages.js';
import { AsyncDeployResultFormatter } from '../../../formatters/asyncDeployResultFormatter.js';
import { DeployResultFormatter } from '../../../formatters/deployResultFormatter.js';
import { DeployResultJson, TestLevel } from '../../../utils/types.js';
import { executeDeploy, resolveApi, determineExitCode, validateTests, buildDeployUrl } from '../../../utils/deploy.js';
import { DEPLOY_STATUS_CODES_DESCRIPTIONS } from '../../../utils/errorCodes.js';
import { ConfigVars } from '../../../configMeta.js';
import { coverageFormattersFlag, fileOrDirFlag, testLevelFlag, testsFlag } from '../../../utils/flags.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-deploy-retrieve', 'deploy.metadata.validate');
const deployMessages = Messages.loadMessages('@salesforce/plugin-deploy-retrieve', 'deploy.metadata');

const EXACTLY_ONE_FLAGS = ['manifest', 'source-dir', 'metadata', 'metadata-dir'];
const destructiveFlags = 'Delete';
const testFlags = 'Test';
const sourceFormatFlags = 'Source Format';
const mdapiFormatFlags = 'Metadata API Format';

export default class DeployMetadataValidate extends SfCommand<DeployResultJson> {
  public static readonly description = messages.getMessage('description');
  public static readonly summary = messages.getMessage('summary');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['deploy:metadata:validate'];
  public static readonly deprecateAliases = true;

  public static readonly flags = {
    'api-version': Flags.orgApiVersion({
      char: 'a',
      summary: messages.getMessage('flags.api-version.summary'),
      description: messages.getMessage('flags.api-version.description'),
    }),
    async: Flags.boolean({
      summary: messages.getMessage('flags.async.summary'),
      description: messages.getMessage('flags.async.description'),
    }),
    concise: Flags.boolean({
      summary: messages.getMessage('flags.concise.summary'),
      exclusive: ['verbose'],
    }),
    manifest: Flags.file({
      char: 'x',
      description: messages.getMessage('flags.manifest.description'),
      summary: messages.getMessage('flags.manifest.summary'),
      exactlyOne: EXACTLY_ONE_FLAGS,
      helpGroup: sourceFormatFlags,
    }),
    metadata: Flags.string({
      char: 'm',
      summary: messages.getMessage('flags.metadata.summary'),
      multiple: true,
      exactlyOne: EXACTLY_ONE_FLAGS,
      helpGroup: sourceFormatFlags,
    }),
    'source-dir': Flags.string({
      char: 'd',
      description: messages.getMessage('flags.source-dir.description'),
      summary: messages.getMessage('flags.source-dir.summary'),
      multiple: true,
      exactlyOne: EXACTLY_ONE_FLAGS,
      helpGroup: sourceFormatFlags,
    }),
    'metadata-dir': fileOrDirFlag({
      summary: messages.getMessage('flags.metadata-dir.summary'),
      exactlyOne: EXACTLY_ONE_FLAGS,
      exists: true,
      helpGroup: mdapiFormatFlags,
    }),
    'single-package': Flags.boolean({
      summary: messages.getMessage('flags.single-package.summary'),
      dependsOn: ['metadata-dir'],
      helpGroup: mdapiFormatFlags,
    }),
    'target-org': Flags.requiredOrg(),
    tests: testsFlag({ helpGroup: testFlags }),
    'test-level': testLevelFlag({
      options: [TestLevel.RunAllTestsInOrg, TestLevel.RunLocalTests, TestLevel.RunSpecifiedTests],
      default: TestLevel.RunLocalTests,
      description: messages.getMessage('flags.test-level.description'),
      summary: messages.getMessage('flags.test-level.summary'),
      helpGroup: testFlags,
    }),
    verbose: Flags.boolean({
      summary: messages.getMessage('flags.verbose.summary'),
      exclusive: ['concise'],
    }),
    wait: Flags.duration({
      char: 'w',
      summary: messages.getMessage('flags.wait.summary'),
      description: messages.getMessage('flags.wait.description'),
      unit: 'minutes',
      default: Duration.minutes(33),
      helpValue: '<minutes>',
      min: 1,
    }),
    'ignore-warnings': Flags.boolean({
      char: 'g',
      summary: deployMessages.getMessage('flags.ignore-warnings.summary'),
      description: deployMessages.getMessage('flags.ignore-warnings.description'),
      default: false,
    }),
    'coverage-formatters': coverageFormattersFlag({ helpGroup: testFlags }),
    junit: Flags.boolean({
      summary: messages.getMessage('flags.junit.summary'),
      helpGroup: testFlags,
    }),
    'results-dir': Flags.directory({
      relationships: [{ type: 'some', flags: ['coverage-formatters', 'junit'] }],
      summary: messages.getMessage('flags.results-dir.summary'),
      helpGroup: testFlags,
    }),
    'purge-on-delete': Flags.boolean({
      summary: messages.getMessage('flags.purge-on-delete.summary'),
      dependsOn: ['manifest'],
      relationships: [{ type: 'some', flags: ['pre-destructive-changes', 'post-destructive-changes'] }],
      helpGroup: destructiveFlags,
    }),
    'pre-destructive-changes': Flags.file({
      summary: messages.getMessage('flags.pre-destructive-changes.summary'),
      dependsOn: ['manifest'],
      helpGroup: destructiveFlags,
    }),
    'post-destructive-changes': Flags.file({
      summary: messages.getMessage('flags.post-destructive-changes.summary'),
      dependsOn: ['manifest'],
      helpGroup: destructiveFlags,
    }),
  };

  public static configurationVariablesSection = toHelpSection(
    'CONFIGURATION VARIABLES',
    OrgConfigProperties.TARGET_ORG,
    OrgConfigProperties.ORG_API_VERSION,
    ConfigVars.ORG_METADATA_REST_DEPLOY
  );

  public static envVariablesSection = toHelpSection('ENVIRONMENT VARIABLES', EnvironmentVariable.SF_TARGET_ORG);

  public static errorCodes = toHelpSection('ERROR CODES', DEPLOY_STATUS_CODES_DESCRIPTIONS);

  private deployUrl?: string;

  public async run(): Promise<DeployResultJson> {
    const [{ flags }, api] = await Promise.all([this.parse(DeployMetadataValidate), resolveApi(this.configAggregator)]);

    if (!validateTests(flags['test-level'], flags.tests)) {
      throw messages.createError('error.NoTestsSpecified');
    }

    const username = flags['target-org'].getUsername();

    // eslint-disable-next-line @typescript-eslint/require-await
    Lifecycle.getInstance().on('apiVersionDeploy', async (apiData: DeployVersionData) => {
      this.log(
        deployMessages.getMessage('apiVersionMsgDetailed', [
          'Validating Deployment of',
          // technically manifestVersion can be undefined, but only on raw mdapi deployments.
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          flags['metadata-dir'] ? '<version specified in manifest>' : `v${apiData.manifestVersion}`,
          username,
          apiData.apiVersion,
          apiData.webService,
        ])
      );
    });

    const { deploy } = await executeDeploy(
      {
        ...flags,
        'ignore-conflicts': true,
        'dry-run': true,
        'target-org': username,
        api,
      },
      this.project,
      undefined,
      true
    );

    if (!deploy.id) {
      throw new SfError('The deploy id is not available.');
    }

    this.deployUrl = buildDeployUrl(flags['target-org'], deploy.id);

    if (flags.async) {
      this.log(`Deploy ID: ${ansis.bold(deploy.id)}`);
      this.log(`Deploy URL: ${ansis.bold(this.deployUrl)}`);
      const asyncFormatter = new AsyncDeployResultFormatter(deploy.id);
      if (!this.jsonEnabled()) asyncFormatter.display();
      return this.mixinUrlMeta(await asyncFormatter.getJson());
    }

    new DeployStages({
      title: 'Validating Deployment',
      jsonEnabled: this.jsonEnabled(),
    }).start(
      {
        deploy,
        username,
      },
      {
        deployUrl: this.deployUrl,
        verbose: flags.verbose,
      }
    );

    const result = await deploy.pollStatus(500, flags.wait?.seconds);
    process.exitCode = determineExitCode(result);
    const formatter = new DeployResultFormatter(result, {
      ...flags,
    });

    if (!this.jsonEnabled()) {
      formatter.display();
    }

    if (result.response.status === RequestStatus.Succeeded) {
      this.log();
      this.logSuccess(messages.getMessage('info.SuccessfulValidation', [deploy.id]));
      this.log(messages.getMessage('info.suggestedQuickDeploy', [deploy.id]));
    } else {
      let componentDeployErrors = result.response.errorMessage;
      if (!result.response.errorMessage) {
        componentDeployErrors = '';
        // gather component deployment errors
        const failures = formatter.getFileResponseFailures();
        failures?.map((f) => {
          componentDeployErrors += `${f.problemType} in ${f.fullName} - ${f.error}${os.EOL}`;
        });
      }
      throw messages
        .createError('error.FailedValidation', [
          deploy.id,
          [
            // I think the type might be wrong in SDR
            ...ensureArray(result.response.details.runTestResult?.codeCoverageWarnings).map(
              (warning: CodeCoverageWarnings & { name?: string }) =>
                `${warning.name ? `${warning.name} - ` : ''}${warning.message}`
            ),
            componentDeployErrors,
            result.response.numberComponentErrors ? `${result.response.numberComponentErrors} component error(s)` : '',
            ensureArray(result.response.details.runTestResult?.failures).map(
              (f) => `${f.name}.${f.methodName} - ${f.message}`
            ),
          ]
            .join(os.EOL)
            .trim(),
        ])
        .setData({ deployId: deploy.id });
    }

    return this.mixinUrlMeta(await formatter.getJson());
  }
  private mixinUrlMeta(json: DeployResultJson): DeployResultJson {
    if (this.deployUrl) {
      json.deployUrl = this.deployUrl;
    }
    return json;
  }
}
