#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CLOUDFRONT_PREFIX_LIST_ID, EXISTING_VPC_ID, STACK_NAME, TARGET_ACCOUNT, TARGET_REGION } from '../lib/settings.js';
import { TurboPalsStack } from '../lib/stack.js';

const app = new cdk.App();
const context = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

new TurboPalsStack(app, STACK_NAME, {
  env: {
    account: context('account') ?? TARGET_ACCOUNT,
    region: context('region') ?? TARGET_REGION,
  },
  vpcId: context('vpcId') ?? EXISTING_VPC_ID,
  cloudfrontPrefixListId: context('cloudfrontPrefixListId') ?? CLOUDFRONT_PREFIX_LIST_ID,
  // `-c originSecretGeneration=2` arrives as a string, a cdk.json value may be a number.
  originSecretGeneration: Number(app.node.tryGetContext('originSecretGeneration') ?? 1),
  // `-c domainName=` (empty) serves only the default *.cloudfront.net hostname.
  domainName: context('domainName'),
  certificateArn: context('certificateArn'),
});

// cdk-nag 3 runs through CDK's policy-validation API (reported at synth; errors fail the synth).
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, {
  verbose: true,
  writeSuppressionsToCloudFormation: true,
}));
app.synth();
