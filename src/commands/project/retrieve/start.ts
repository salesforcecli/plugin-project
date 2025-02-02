/*
 * Copyright (c) 2022, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as fs from 'node:fs';

import { MultiStageOutput } from '@oclif/multi-stage-output';
import { EnvironmentVariable, Lifecycle, Messages, OrgConfigProperties, SfError, SfProject } from '@salesforce/core';
import {
  RetrieveResult,
  ComponentSetBuilder,
  RetrieveSetOptions,
  RetrieveVersionData,
  ComponentSet,
  FileResponse,
  MetadataApiRetrieveStatus,
  RegistryAccess,
  RequestStatus,
} from '@salesforce/source-deploy-retrieve';
import { SfCommand, toHelpSection, Flags, Ux } from '@salesforce/sf-plugins-core';
import { getString } from '@salesforce/ts-types';
import { SourceTracking, SourceConflictError } from '@salesforce/source-tracking';
import { Duration } from '@salesforce/kit';
import { Interfaces } from '@oclif/core';

import { DEFAULT_ZIP_FILE_NAME, ensuredDirFlag, zipFileFlag } from '../../../utils/flags.js';
import { RetrieveResultFormatter } from '../../../formatters/retrieveResultFormatter.js';
import { MetadataRetrieveResultFormatter } from '../../../formatters/metadataRetrieveResultFormatter.js';
import { getOptionalProject, getPackageDirs } from '../../../utils/project.js';
import { RetrieveResultJson } from '../../../utils/types.js';
import { writeConflictTable } from '../../../utils/conflicts.js';
import { promisesQueue } from '../../../utils/promiseQueue.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-deploy-retrieve', 'retrieve.start');
const mdTransferMessages = Messages.loadMessages('@salesforce/plugin-deploy-retrieve', 'metadata.transfer');

type Format = 'source' | 'metadata';
const mdapiFlagGroup = 'Metadata API Format';

export default class RetrieveMetadata extends SfCommand<RetrieveResultJson> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['retrieve:metadata'];
  public static readonly deprecateAliases = true;

  public static readonly flags = {
    'api-version': Flags.orgApiVersion({
      char: 'a',
      summary: messages.getMessage('flags.api-version.summary'),
      description: messages.getMessage('flags.api-version.description'),
    }),
    'ignore-conflicts': Flags.boolean({
      char: 'c',
      summary: messages.getMessage('flags.ignore-conflicts.summary'),
      description: messages.getMessage('flags.ignore-conflicts.description'),
      default: false,
    }),
    manifest: Flags.file({
      char: 'x',
      summary: messages.getMessage('flags.manifest.summary'),
      description: messages.getMessage('flags.manifest.description'),
      exclusive: ['metadata', 'source-dir'],
      exists: true,
    }),
    metadata: Flags.string({
      char: 'm',
      summary: messages.getMessage('flags.metadata.summary'),
      multiple: true,
      exclusive: ['manifest', 'source-dir'],
    }),
    'package-name': Flags.string({
      char: 'n',
      summary: messages.getMessage('flags.package-name.summary'),
      description: messages.getMessage('flags.package-name.description'),
      multiple: true,
    }),
    'output-dir': Flags.directory({
      char: 'r',
      summary: messages.getMessage('flags.output-dir.summary'),
      description: messages.getMessage('flags.output-dir.description'),
      exclusive: ['package-name', 'source-dir'],
    }),
    'single-package': Flags.boolean({
      summary: messages.getMessage('flags.single-package.summary'),
      dependsOn: ['target-metadata-dir'],
      exclusive: ['ignore-conflicts'],
      helpGroup: mdapiFlagGroup,
    }),
    'source-dir': Flags.string({
      char: 'd',
      summary: messages.getMessage('flags.source-dir.summary'),
      description: messages.getMessage('flags.source-dir.description'),
      multiple: true,
      exclusive: ['manifest', 'metadata'],
    }),
    'target-metadata-dir': ensuredDirFlag({
      char: 't',
      summary: messages.getMessage('flags.target-metadata-dir.summary'),
      relationships: [
        {
          type: 'some',
          flags: ['manifest', 'metadata', 'source-dir', 'package-name'],
        },
      ],
      exclusive: ['ignore-conflicts'],
      helpGroup: mdapiFlagGroup,
    }),
    'target-org': Flags.requiredOrg(),
    wait: Flags.duration({
      char: 'w',
      defaultValue: 33,
      default: Duration.minutes(33),
      unit: 'minutes',
      summary: messages.getMessage('flags.wait.summary'),
      description: messages.getMessage('flags.wait.description'),
    }),
    unzip: Flags.boolean({
      char: 'z',
      summary: messages.getMessage('flags.unzip.summary'),
      dependsOn: ['target-metadata-dir'],
      exclusive: ['ignore-conflicts'],
      helpGroup: mdapiFlagGroup,
    }),
    'zip-file-name': zipFileFlag({
      summary: messages.getMessage('flags.zip-file-name.summary'),
      dependsOn: ['target-metadata-dir'],
      exclusive: ['ignore-conflicts'],
      helpGroup: mdapiFlagGroup,
    }),
  };

  public static configurationVariablesSection = toHelpSection(
    'CONFIGURATION VARIABLES',
    OrgConfigProperties.TARGET_ORG,
    OrgConfigProperties.ORG_API_VERSION
  );
  public static envVariablesSection = toHelpSection('ENVIRONMENT VARIABLES', EnvironmentVariable.SF_TARGET_ORG);

  protected retrieveResult!: RetrieveResult;
  protected ms:
    | MultiStageOutput<{
        status: string;
        apiData: RetrieveVersionData;
      }>
    | undefined;

  // eslint-disable-next-line complexity
  public async run(): Promise<RetrieveResultJson> {
    const { flags } = await this.parse(RetrieveMetadata);
    let resolvedTargetDir: string | undefined;
    if (flags['output-dir']) {
      resolvedTargetDir = resolve(flags['output-dir']);
      if (SfProject.getInstance()?.getPackageNameFromPath(resolvedTargetDir)) {
        throw messages.createError('retrieveTargetDirOverlapsPackage', [flags['output-dir']]);
      }
    }
    const format = flags['target-metadata-dir'] ? 'metadata' : 'source';
    const zipFileName = flags['zip-file-name'] ?? DEFAULT_ZIP_FILE_NAME;

    const { componentSetFromNonDeletes, fileResponsesFromDelete = [] } = await buildRetrieveAndDeleteTargets(
      flags,
      format
    );
    if (format === 'source' && (Boolean(flags.manifest) || Boolean(flags.metadata))) {
      const access = new RegistryAccess(undefined, SfProject.getInstance()?.getPath());
      if (wantsToRetrieveCustomFields(componentSetFromNonDeletes, access)) {
        this.warn(messages.getMessage('wantsToRetrieveCustomFields'));
        componentSetFromNonDeletes.add({
          fullName: ComponentSet.WILDCARD,
          type: access.getTypeByName('CustomObject'),
        });
      }
    }

    const stages = ['Preparing retrieve request', 'Sending request to org', 'Waiting for the org to respond', 'Done'];
    this.ms = new MultiStageOutput<{
      status: string;
      apiData: RetrieveVersionData;
    }>({
      stages,
      title: 'Retrieving Metadata',
      jsonEnabled: this.jsonEnabled(),
      preStagesBlock: [
        {
          type: 'message',
          get: (data) =>
            data?.apiData &&
            messages.getMessage('apiVersionMsgDetailed', [
              'Retrieving',
              `v${data.apiData.manifestVersion}`,
              flags['target-org'].getUsername(),
              data.apiData.apiVersion,
            ]),
        },
      ],
      postStagesBlock: [
        {
          label: 'Status',
          get: (data) => data?.status,
          bold: true,
          type: 'dynamic-key-value',
        },
      ],
    });

    this.ms.goto('Preparing retrieve request');

    const retrieveOpts = await buildRetrieveOptions(flags, format, zipFileName, resolvedTargetDir);

    this.ms.goto('Sending request to org');

    this.retrieveResult = new RetrieveResult({} as MetadataApiRetrieveStatus, componentSetFromNonDeletes);

    if (componentSetFromNonDeletes.size !== 0 || retrieveOpts.packageOptions?.length) {
      Lifecycle.getInstance().on('apiVersionRetrieve', async (apiData: RetrieveVersionData) =>
        Promise.resolve(this.ms?.updateData({ apiData }))
      );
      const retrieve = await componentSetFromNonDeletes.retrieve(retrieveOpts);
      this.ms.goto('Waiting for the org to respond', { status: 'Pending' });

      retrieve.onUpdate((data) => {
        this.ms?.goto('Waiting for the org to respond', { status: mdTransferMessages.getMessage(data.status) });
      });
      retrieve.onFinish((data) => {
        this.ms?.goto('Done', { status: mdTransferMessages.getMessage(data.response.status) });
      });
      retrieve.onCancel((data) => {
        this.ms?.updateData({ status: mdTransferMessages.getMessage(data?.status ?? 'Canceled') });
        this.ms?.error();
      });
      retrieve.onError((error: Error) => {
        if (error.message.includes('client has timed out')) {
          this.ms?.updateData({ status: 'Client Timeout' });
        }

        this.ms?.error();
        throw error;
      });

      this.retrieveResult = await retrieve.pollStatus(500, flags.wait.seconds);
    }

    this.ms.stop();

    // flags['output-dir'] will set resolvedTargetDir var, so this check is redundant, but allows for nice typings in the moveResultsForRetrieveTargetDir method
    if (flags['output-dir'] && resolvedTargetDir) {
      await this.moveResultsForRetrieveTargetDir(flags['output-dir'], resolvedTargetDir);
    }

    // reference the flag instead of `format` so we get correct type
    const formatter = flags['target-metadata-dir']
      ? new MetadataRetrieveResultFormatter(this.retrieveResult, {
          'target-metadata-dir': flags['target-metadata-dir'],
          'zip-file-name': zipFileName,
          unzip: flags.unzip,
        })
      : new RetrieveResultFormatter(
          new Ux({ jsonEnabled: this.jsonEnabled() }),
          this.retrieveResult,
          flags['package-name'],
          fileResponsesFromDelete
        );
    if (!this.jsonEnabled()) {
      // in the case where we didn't retrieve anything, check if we have any deletes
      if (
        !this.retrieveResult.response.status ||
        this.retrieveResult.response.status === RequestStatus['Succeeded'] ||
        fileResponsesFromDelete.length !== 0
      ) {
        await formatter.display();
      } else {
        throw new SfError(
          getString(this.retrieveResult.response, 'errorMessage', this.retrieveResult.response.status),
          getString(this.retrieveResult.response, 'errorStatusCode', 'unknown')
        );
      }
    }

    if (format === 'metadata' && flags.unzip) {
      try {
        await rm(resolve(join(flags['target-metadata-dir'] ?? '', zipFileName)), {
          recursive: true,
        });
      } catch (e) {
        // do nothing
      }
    }

    return formatter.getJson();
  }

  protected catch(error: Error | SfError): Promise<never> {
    if (!this.jsonEnabled() && error instanceof SourceConflictError && error.data) {
      this.ms?.updateData({ status: 'Failed' });
      this.ms?.error();
      writeConflictTable(error.data);
      // set the message and add plugin-specific actions
      return super.catch({
        ...error,
        message: messages.getMessage('error.Conflicts'),
        actions: messages.getMessages('error.Conflicts.Actions'),
      });
    } else {
      this.ms?.error();
    }

    return super.catch(error);
  }

  private async moveResultsForRetrieveTargetDir(targetDir: string, resolvedTargetDir: string): Promise<void> {
    async function mv(src: string): Promise<string[]> {
      let directories: string[] = [];
      let files: string[] = [];
      const srcStat = await fs.promises.stat(src);
      if (srcStat.isDirectory()) {
        const contents = await fs.promises.readdir(src, { withFileTypes: true });
        [directories, files] = contents.reduce<[string[], string[]]>(
          (acc, dirent) => {
            if (dirent.isDirectory()) {
              acc[0].push(dirent.name);
            } else {
              acc[1].push(dirent.name);
            }
            return acc;
          },
          [[], []]
        );

        directories = directories.map((dir) => join(src, dir));
      } else {
        files.push(src);
      }
      await promisesQueue(
        files,
        async (file: string): Promise<string> => {
          const dest = join(src.replace(join('main', 'default'), ''), file);
          const destDir = dirname(dest);
          await fs.promises.mkdir(destDir, { recursive: true });
          await fs.promises.rename(join(src, file), dest);
          return dest;
        },
        50
      );
      return directories;
    }
    // If we retrieved only a package.xml, just return.
    if (this.retrieveResult.getFileResponses().length < 2) {
      return;
    }

    // getFileResponses fails once the files have been moved, calculate where they're moved to, and then move them
    this.retrieveResult.getFileResponses().forEach((fileResponse) => {
      fileResponse.filePath = fileResponse.filePath?.replace(join('main', 'default'), '');
    });
    // move contents of 'main/default' to 'retrievetargetdir'
    await promisesQueue([join(resolvedTargetDir, 'main', 'default')], mv, 5, true);
    // remove 'main/default'
    await fs.promises.rm(join(targetDir, 'main'), { recursive: true });
  }
}

type RetrieveAndDeleteTargets = {
  /** componentSet that can be used to retrieve known changes */
  componentSetFromNonDeletes: ComponentSet;
  /** optional Array of artificially constructed FileResponses from the deletion of local files */
  fileResponsesFromDelete?: FileResponse[];
};

const wantsToRetrieveCustomFields = (cs: ComponentSet, registry: RegistryAccess): boolean => {
  const hasCustomField = cs.has({
    type: registry.getTypeByName('CustomField'),
    fullName: ComponentSet.WILDCARD,
  });

  const hasCustomObject = cs.has({
    type: registry.getTypeByName('CustomObject'),
    fullName: ComponentSet.WILDCARD,
  });
  return hasCustomField && !hasCustomObject;
};

const buildRetrieveAndDeleteTargets = async (
  flags: Interfaces.InferredFlags<typeof RetrieveMetadata.flags>,
  format: Format
): Promise<RetrieveAndDeleteTargets> => {
  const isChanges =
    !flags['source-dir'] &&
    !flags['manifest'] &&
    !flags['metadata'] &&
    !flags['target-metadata-dir'] &&
    !flags['package-name']?.length;

  if (isChanges) {
    if (!(await flags['target-org'].supportsSourceTracking())) {
      throw new SfError(
        messages.getMessage('noSourceTracking'),
        'noSourceTracking',
        messages.getMessages('noSourceTracking.actions')
      );
    }
    const stl = await SourceTracking.create({
      org: flags['target-org'],
      project: await SfProject.resolve(),
      subscribeSDREvents: true,
      ignoreConflicts: flags['ignore-conflicts'],
    });
    const result = await stl.maybeApplyRemoteDeletesToLocal(true);
    // STL returns a componentSet that gets these from the project/config.
    // if the command has a flag, we'll override
    if (flags['api-version']) {
      result.componentSetFromNonDeletes.apiVersion = flags['api-version'];
    }
    return result;
  } else {
    const retrieveFromOrg = flags.metadata?.some(isRegexMatch) ? flags['target-org'].getUsername() : undefined;
    if (format === 'source' && (await flags['target-org'].supportsSourceTracking())) {
      await SourceTracking.create({
        org: flags['target-org'],
        project: await SfProject.resolve(),
        subscribeSDREvents: true,
        ignoreConflicts: flags['ignore-conflicts'],
      });
    }

    return {
      componentSetFromNonDeletes: await ComponentSetBuilder.build({
        sourceapiversion: (
          await (await getOptionalProject())?.resolveProjectConfig()
        )?.sourceApiVersion as string | undefined,
        apiversion: flags['api-version'],
        sourcepath: flags['source-dir'],
        packagenames: flags['package-name'],
        ...(flags.manifest
          ? {
              manifest: {
                manifestPath: flags.manifest,
                // if mdapi format, there might not be a project
                directoryPaths: format === 'metadata' || flags['output-dir'] ? [] : await getPackageDirs(),
              },
            }
          : {}),
        ...(flags.metadata
          ? {
              metadata: {
                metadataEntries: flags.metadata,
                // if mdapi format, there might not be a project
                directoryPaths: format === 'metadata' || flags['output-dir'] ? [] : await getPackageDirs(),
              },
            }
          : {}),
        ...(retrieveFromOrg ? { org: { username: retrieveFromOrg, exclude: [] } } : {}),
        ...(format === 'source' ? { projectDir: await SfProject.resolveProjectPath() } : {}),
      }),
    };
  }
};

/**
 *
 *
 * @param flags
 * @param format 'metadata' or 'source'
 * @param zipFileName
 * @param output
 * @returns RetrieveSetOptions (an object that can be passed as the options for a ComponentSet retrieve)
 */
const buildRetrieveOptions = async (
  flags: Interfaces.InferredFlags<typeof RetrieveMetadata.flags>,
  format: Format,
  zipFileName: string,
  output: string | undefined
): Promise<RetrieveSetOptions> => ({
  usernameOrConnection: flags['target-org'].getUsername() ?? flags['target-org'].getConnection(flags['api-version']),
  merge: true,
  packageOptions: flags['package-name'],
  format,
  ...(format === 'metadata'
    ? {
        singlePackage: flags['single-package'],
        unzip: flags.unzip,
        zipFileName,
        // known to exist because that's how `format` becomes 'metadata'
        output: flags['target-metadata-dir'] as string,
      }
    : {
        output: output ?? (await SfProject.resolve()).getDefaultPackage().fullPath,
      }),
});

// check if we're retrieving metadata based on a pattern ...
const isRegexMatch = (mdEntry: string): boolean => {
  const mdName = mdEntry.split(':')[1];
  return mdName?.includes('*') && mdName?.length > 1 && !mdName?.includes('.*');
};
