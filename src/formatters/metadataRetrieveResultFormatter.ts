/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { join, parse, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ux } from '@oclif/core';
import { FileResponse, RetrieveResult } from '@salesforce/source-deploy-retrieve';
import { Messages } from '@salesforce/core';
import { Formatter, MetadataRetrieveResultJson } from '../utils/types.js';
import { sortFileResponses, asRelativePaths } from '../utils/output.js';

Messages.importMessagesDirectory(dirname(fileURLToPath(import.meta.url)));
export const retrieveMessages = Messages.loadMessages('@salesforce/plugin-deploy-retrieve', 'retrieve.start');

export class MetadataRetrieveResultFormatter implements Formatter<MetadataRetrieveResultJson> {
  private zipFilePath: string;
  private files: FileResponse[];
  public constructor(
    private result: RetrieveResult,
    private opts: { 'target-metadata-dir': string; 'zip-file-name': string; unzip: boolean }
  ) {
    this.zipFilePath = join(opts['target-metadata-dir'], opts['zip-file-name']);
    this.files = sortFileResponses(asRelativePaths(this.result.getFileResponses() ?? []));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async getJson(): Promise<MetadataRetrieveResultJson> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { zipFile, ...responseWithoutZipFile } = this.result.response;
    return { ...responseWithoutZipFile, zipFilePath: this.zipFilePath, files: this.files };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async display(): Promise<void> {
    ux.log(retrieveMessages.getMessage('info.WroteZipFile', [this.zipFilePath]));
    if (this.opts.unzip) {
      const extractPath = join(this.opts['target-metadata-dir'], parse(this.opts['zip-file-name']).name);
      ux.log(retrieveMessages.getMessage('info.ExtractedZipFile', [this.zipFilePath, extractPath]));
    }
  }
}
