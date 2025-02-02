/*
 * Copyright (c) 2022, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { Messages, Org, SfError } from '@salesforce/core';
import { SfCommand, toHelpSection, Flags } from '@salesforce/sf-plugins-core';
import { DeployResult, MetadataApiDeploy } from '@salesforce/source-deploy-retrieve';
import { Duration } from '@salesforce/kit';
import { DeployStages } from '../../../utils/deployStages.js';
import { DeployResultFormatter } from '../../../formatters/deployResultFormatter.js';
import { API, DeployResultJson } from '../../../utils/types.js';
import {
  buildComponentSet,
  buildDeployUrl,
  determineExitCode,
  executeDeploy,
  isNotResumable,
} from '../../../utils/deploy.js';
import { DeployCache } from '../../../utils/deployCache.js';
import { DEPLOY_STATUS_CODES_DESCRIPTIONS } from '../../../utils/errorCodes.js';
import { coverageFormattersFlag } from '../../../utils/flags.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-deploy-retrieve', 'deploy.metadata.resume');

const testFlags = 'Test';

export default class DeployMetadataResume extends SfCommand<DeployResultJson> {
  public static readonly description = messages.getMessage('description');
  public static readonly summary = messages.getMessage('summary');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['deploy:metadata:resume'];
  public static readonly deprecateAliases = true;

  public static readonly flags = {
    concise: Flags.boolean({
      summary: messages.getMessage('flags.concise.summary'),
      exclusive: ['verbose'],
    }),
    'job-id': Flags.salesforceId({
      char: 'i',
      startsWith: '0Af',
      length: 'both',
      description: messages.getMessage('flags.job-id.description'),
      summary: messages.getMessage('flags.job-id.summary'),
      exactlyOne: ['use-most-recent', 'job-id'],
    }),
    'use-most-recent': Flags.boolean({
      char: 'r',
      description: messages.getMessage('flags.use-most-recent.description'),
      summary: messages.getMessage('flags.use-most-recent.summary'),
      exactlyOne: ['use-most-recent', 'job-id'],
    }),
    verbose: Flags.boolean({
      summary: messages.getMessage('flags.verbose.summary'),
      exclusive: ['concise'],
    }),
    // we want this to allow undefined so that we can use the default value from the cache
    // eslint-disable-next-line sf-plugin/flag-min-max-default
    wait: Flags.duration({
      char: 'w',
      summary: messages.getMessage('flags.wait.summary'),
      description: messages.getMessage('flags.wait.description'),
      unit: 'minutes',
      helpValue: '<minutes>',
      min: 1,
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
  };

  public static envVariablesSection = toHelpSection('ENVIRONMENT VARIABLES');

  public static errorCodes = toHelpSection('ERROR CODES', DEPLOY_STATUS_CODES_DESCRIPTIONS);

  private deployUrl?: string;

  public async run(): Promise<DeployResultJson> {
    const [{ flags }, cache] = await Promise.all([this.parse(DeployMetadataResume), DeployCache.create()]);
    const jobId = cache.resolveLatest(flags['use-most-recent'], flags['job-id'], true);

    // if it was async before, then it should not be async now.
    const deployOpts = { ...cache.maybeGet(jobId), async: false };

    let result: DeployResult;
    const org = await Org.create({ aliasOrUsername: deployOpts['target-org'] });

    // If we already have a status from cache that is not resumable, display a warning and the deploy result.
    if (isNotResumable(deployOpts.status)) {
      this.warn(messages.getMessage('warning.DeployNotResumable', [jobId, deployOpts.status]));
      const componentSet = await buildComponentSet({ ...deployOpts, wait: Duration.seconds(0) });
      const mdapiDeploy = new MetadataApiDeploy({
        // setting an API version here won't matter since we're just checking deploy status
        // eslint-disable-next-line sf-plugin/get-connection-with-version
        usernameOrConnection: org.getConnection(),
        id: jobId,
        components: componentSet,
        apiOptions: {
          rest: deployOpts.api === API['REST'],
        },
      });
      const deployStatus = await mdapiDeploy.checkStatus();
      result = new DeployResult(deployStatus, componentSet);
    } else {
      const wait = flags.wait ?? Duration.minutes(deployOpts.wait ?? 33);
      const { deploy } = await executeDeploy(
        // there will always be conflicts on a resume if anything deployed--the changes on the server are not synced to local
        {
          ...deployOpts,
          wait,
          'dry-run': false,
          'ignore-conflicts': true,
          // TODO: isMdapi is generated from 'metadata-dir' flag, but we don't have that flag here
          // change the cache value to actually cache the metadata-dir, and if there's a value, it isMdapi
          // deployCache~L38, so to tell the executeDeploy method it's ok to not have a project, we spoof a metadata-dir
          // in deploy~L140, it checks the if the id is present, so this metadata-dir value is never _really_ used
          'metadata-dir': deployOpts.isMdapi ? { type: 'file', path: 'testing' } : undefined,
        },
        this.project,
        jobId
      );
      this.deployUrl = buildDeployUrl(org, jobId);
      new DeployStages({
        title: 'Resuming Deploy',
        jsonEnabled: this.jsonEnabled(),
      }).start(
        {
          deploy,
          username: deployOpts['target-org'],
        },
        {
          deployUrl: this.deployUrl,
          verbose: flags.verbose ?? deployOpts.verbose,
        }
      );

      result = await deploy.pollStatus(500, wait.seconds);

      if (!deploy.id) {
        throw new SfError('The deploy id is not available.');
      }

      cache.update(deploy.id, { status: result.response.status });
      await cache.write();
    }

    process.exitCode = determineExitCode(result);

    const formatter = new DeployResultFormatter(result, {
      ...flags,
      verbose: deployOpts.verbose,
      concise: deployOpts.concise,
    });

    if (!this.jsonEnabled()) formatter.display();

    return this.mixinUrlMeta(await formatter.getJson());
  }

  private mixinUrlMeta(json: DeployResultJson): DeployResultJson {
    if (this.deployUrl) {
      json.deployUrl = this.deployUrl;
    }
    return json;
  }
}
