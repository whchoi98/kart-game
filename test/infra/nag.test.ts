import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { afterAll, expect, it } from 'vitest';
import { TurboPalsStack } from '../../infra/lib/stack.js';

const cdkJson = JSON.parse(readFileSync(new URL('../../cdk.json', import.meta.url), 'utf8')) as { context: Record<string, unknown> };
const lookups = JSON.parse(readFileSync(new URL('../../cdk.context.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function checkedApp(extra?: (stack: TurboPalsStack) => void) {
  const outdir = mkdtempSync(join(tmpdir(), 'turbo-pals-nag-'));
  dirs.push(outdir);
  const app = new cdk.App({ outdir, context: { ...cdkJson.context, ...lookups } });
  const stack = new TurboPalsStack(app, 'TurboPalsNag', {
    env: { account: '061525506239', region: 'ap-northeast-2' },
    vpcId: 'vpc-0dfa5610180dfa628',
    cloudfrontPrefixListId: 'pl-22a6434b',
    imageDirectory: fileURLToPath(new URL('./fixtures/', import.meta.url)),
  });
  extra?.(stack);
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));
  return app;
}

it('passes cdk-nag AWS Solutions checks with only the justified acknowledgements', () => {
  expect(() => checkedApp().synth()).not.toThrow();
});

it('fails synthesis when a new resource violates AWS Solutions (the checks are live)', () => {
  const app = checkedApp(stack => { new s3.Bucket(stack, 'Unencrypted', { enforceSSL: false }); });
  expect(() => app.synth()).toThrow(/AwsSolutions-S10/);
});
