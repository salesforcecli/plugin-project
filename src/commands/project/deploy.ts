/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { Command, Flags } from '@oclif/core';
import { fs, Messages } from '@salesforce/core';
import { Env } from '@salesforce/kit';
import {
  Deployable,
  Deployer,
  generateTableChoices,
  ProjectDeployOptions,
  Prompter,
} from '@salesforce/plugin-project-utils';

Messages.importMessagesDirectory(__dirname);

const messages = Messages.loadMessages('@salesforce/plugin-project', 'project.deploy');

export const DEPLOY_OPTIONS_JSON = 'project-deploy-options.json';

export default class ProjectDeploy extends Command {
  public static summary = messages.getMessage('summary');
  public static description = messages.getMessage('description');
  public static examples = messages.getMessages('examples');
  public static disableJsonFlag = true;

  public static flags = {
    interactive: Flags.boolean({
      summary: messages.getMessage('flags.interactive.summary'),
    }),
  };

  public async run(): Promise<void> {
    process.setMaxListeners(new Env().getNumber('SF_MAX_EVENT_LISTENERS') || 1000);
    const { flags } = await this.parse(ProjectDeploy);

    flags.interactive = await this.isInteractive(flags.interactive);
    const options = await this.readOptions();

    this.log('Analyzing project');

    if (!flags.interactive) {
      this.log(`Using options found in ${DEPLOY_OPTIONS_JSON}`);
    }

    let deployers = (await this.config.runHook('project:findDeployers', options)) as Deployer[];
    deployers = deployers.reduce((x, y) => x.concat(y), [] as Deployer[]);

    if (deployers.length === 0) {
      this.log('Found nothing in the project to deploy');
    } else {
      if (flags.interactive) {
        deployers = await this.selectDeployers(deployers);
      }

      if (deployers.length === 0) {
        this.log('Nothing was selected to deploy.');
      }

      const deployOptions: ProjectDeployOptions = {};
      for (const deployer of deployers) {
        const opts = options[deployer.getName()] ?? {};
        deployOptions[deployer.getName()] = await deployer.setup(flags, opts);
      }

      if (flags.interactive && (await this.askToSave())) {
        await fs.writeJson(DEPLOY_OPTIONS_JSON, deployOptions, { space: 2 });
        this.log();
        this.log(`Your deploy options have been saved to ${DEPLOY_OPTIONS_JSON}`);
      }

      for (const deployer of deployers) {
        await deployer.deploy();
      }
    }
  }

  /**
   * If the deploy file exists, we do not want the command to be interactive. But if the file
   * does not exist then we want to force the command to be interactive.
   */
  public async isInteractive(interactive: boolean): Promise<boolean> {
    if (interactive) return true;
    const deployFileExists = await fs.fileExists(DEPLOY_OPTIONS_JSON);
    return deployFileExists ? false : true;
  }

  public async readOptions(): Promise<ProjectDeployOptions> {
    if (await fs.fileExists(DEPLOY_OPTIONS_JSON)) {
      return (await fs.readJson(DEPLOY_OPTIONS_JSON)) as ProjectDeployOptions;
    } else {
      return {};
    }
  }

  public async askToSave(): Promise<boolean> {
    const prompter = new Prompter();
    const { save } = await prompter.prompt<{ save: boolean }>({
      name: 'save',
      message: 'Would you like to save these deploy options for future runs?',
      type: 'confirm',
    });
    return save;
  }

  public async selectDeployers(deployers: Deployer[]): Promise<Deployer[]> {
    const deployables: Deployable[] = deployers.reduce((x, y) => x.concat(y.deployables), [] as Deployable[]);
    const columns = { name: 'APP OR PACKAGE', type: 'TYPE', path: 'PATH' };
    const options = deployables.map((deployable) => ({
      name: deployable.getAppName(),
      type: deployable.getAppType(),
      path: deployable.getAppPath(),
      value: deployable,
    }));
    const prompter = new Prompter();
    const responses = await prompter.prompt<{ deployables: Deployable[] }>([
      {
        name: 'deployables',
        message: 'Select apps and packages to deploy:',
        type: 'checkbox',
        choices: generateTableChoices<Deployable>(columns, options),
      },
    ]);

    const chosenDeployers: Map<Deployer, Deployable[]> = new Map();
    for (const deployable of responses.deployables) {
      const parent = deployable.getParent();
      if (chosenDeployers.has(parent)) {
        const existing = chosenDeployers.get(parent) || [];
        chosenDeployers.set(parent, [...existing, deployable]);
      } else {
        chosenDeployers.set(parent, [deployable]);
      }
    }

    const final: Deployer[] = [];
    for (const [parent, children] of chosenDeployers.entries()) {
      parent.selectDeployables(children);
      final.push(parent);
    }
    return final;
  }
}
