/*
 * Copyright (c) 2022, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'path';
import { SourceTestkit } from '@salesforce/source-testkit';
import { expect } from 'chai';
import { DeployResultJson } from '../../../../src/utils/types';

describe('deploy metadata cancel NUTs', () => {
  let testkit: SourceTestkit;

  before(async () => {
    testkit = await SourceTestkit.create({
      repository: 'https://github.com/trailheadapps/dreamhouse-lwc.git',
      executable: path.join(process.cwd(), 'bin', 'dev'),
      nut: __filename,
    });
  });

  after(async () => {
    await testkit?.clean();
  });

  describe('--use-most-recent', () => {
    it('should cancel most recently started deployment', async () => {
      await testkit.execute<DeployResultJson>('deploy:metadata', {
        args: '--source-dir force-app --async',
        json: true,
        exitCode: 0,
      });

      const cancel = await testkit.execute<DeployResultJson>('deploy:metadata:cancel', {
        args: '--use-most-recent',
        json: true,
        exitCode: 0,
      });

      if (cancel.status === 0) {
        // successful cancel
        expect(cancel.result.status).to.equal('Canceled');
        expect(cancel.result.canceledBy).to.not.be.undefined;
        expect(cancel.result.canceledByName).to.not.be.undefined;
        expect(cancel.result.success).to.be.false;
      } else {
        // the deploy likely already finished
        expect(cancel.status).to.equal(1);
        expect(cancel.name).to.equal('CancelFailed');
        expect(cancel.message).to.include('Deployment already completed');
      }
    });
  });

  describe('--job-id', () => {
    it('should cancel the provided job id', async () => {
      const first = await testkit.execute<DeployResultJson>('deploy:metadata', {
        args: '--source-dir force-app --async',
        json: true,
        exitCode: 0,
      });

      const cancel = await testkit.execute<DeployResultJson>('deploy:metadata:cancel', {
        args: `--job-id ${first.result.id}`,
        json: true,
        exitCode: 0,
      });

      if (cancel.status === 0) {
        // successful cancel
        expect(cancel.result.status).to.equal('Canceled');
        expect(cancel.result.canceledBy).to.not.be.undefined;
        expect(cancel.result.canceledByName).to.not.be.undefined;
        expect(cancel.result.success).to.be.false;
      } else {
        // the deploy likely already finished
        expect(cancel.status).to.equal(1);
        expect(cancel.name).to.equal('CancelFailed');
        expect(cancel.message).to.include('Deployment already completed');
      }
    });
  });
});
