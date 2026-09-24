import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY } from '../../src/shared/csp.js';
import { TurboPalsStack, type TurboPalsStackProps } from '../../infra/lib/stack.js';

type Resource = { Type: string; Properties: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string };

const cdkJson = JSON.parse(readFileSync(new URL('../../cdk.json', import.meta.url), 'utf8')) as { context: Record<string, unknown> };
const lookups = JSON.parse(readFileSync(new URL('../../cdk.context.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const ENV = { account: '061525506239', region: 'ap-northeast-2' };
const PUBLIC_SUBNETS = ['subnet-08486a1e618b1991e', 'subnet-0c161777c4031c320'];
const PRIVATE_SUBNETS = ['subnet-07b1e65682847dce9', 'subnet-095297380cd45e1eb'];
const FIXTURE_IMAGE = fileURLToPath(new URL('./fixtures/', import.meta.url));
const scratch: string[] = [];

function synth(overrides: Partial<TurboPalsStackProps> = {}) {
  const outdir = mkdtempSync(join(tmpdir(), 'turbo-pals-infra-'));
  scratch.push(outdir);
  const app = new cdk.App({ outdir, context: { ...cdkJson.context, ...lookups } });
  const stack = new TurboPalsStack(app, 'TurboPalsTest', {
    env: ENV,
    vpcId: 'vpc-0dfa5610180dfa628',
    cloudfrontPrefixListId: 'pl-22a6434b',
    imageDirectory: FIXTURE_IMAGE,
    ...overrides,
  });
  return { app, stack, template: Template.fromStack(stack) };
}

let template: Template;
let app: cdk.App;
beforeAll(() => ({ template, app } = synth()));
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function all(type: string): Array<[string, Resource]> {
  return Object.entries(template.findResources(type) as Record<string, Resource>);
}
function only(type: string): [string, Resource] {
  const found = all(type);
  expect(found, `exactly one ${type}`).toHaveLength(1);
  return found[0]!;
}
function references(value: unknown, logicalId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(child => references(child, logicalId));
  const record = value as Record<string, unknown>;
  return record.Ref === logicalId
    || (Array.isArray(record['Fn::GetAtt']) && record['Fn::GetAtt'][0] === logicalId)
    || Object.values(record).some(child => references(child, logicalId));
}
function groupReferencedBy(value: unknown): string {
  const id = all('AWS::EC2::SecurityGroup').map(([logicalId]) => logicalId).find(logicalId => references(value, logicalId));
  expect(id).toBeDefined();
  return id!;
}
function rules(groupId: string, direction: 'Ingress' | 'Egress'): Array<Record<string, any>> {
  const group = template.findResources('AWS::EC2::SecurityGroup')[groupId] as Resource;
  const inline = (group.Properties[`SecurityGroup${direction}`] ?? []) as Array<Record<string, any>>;
  const standalone = all(`AWS::EC2::SecurityGroup${direction}`)
    .filter(([, rule]) => references(rule.Properties.GroupId, groupId))
    .map(([, rule]) => rule.Properties);
  return [...inline, ...standalone];
}
const container = () => only('AWS::ECS::TaskDefinition')[1].Properties.ContainerDefinitions[0];
const distributionConfig = () => only('AWS::CloudFront::Distribution')[1].Properties.DistributionConfig;

describe('existing network only', () => {
  it('creates no VPC, subnet, route, NAT gateway, internet gateway, EIP or endpoint', () => {
    for (const type of [
      'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::NatGateway', 'AWS::EC2::InternetGateway',
      'AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::Route', 'AWS::EC2::RouteTable',
      'AWS::EC2::SubnetRouteTableAssociation', 'AWS::EC2::EIP', 'AWS::EC2::VPCEndpoint',
      'AWS::EC2::TransitGatewayAttachment', 'AWS::EC2::FlowLog',
    ]) template.resourceCountIs(type, 0);
    const groups = all('AWS::EC2::SecurityGroup');
    expect(groups).toHaveLength(2);
    for (const [, group] of groups) expect(group.Properties.VpcId).toBe('vpc-0dfa5610180dfa628');
  });

  it('places the internet-facing ALB in the two public subnets', () => {
    const [, alb] = only('AWS::ElasticLoadBalancingV2::LoadBalancer');
    expect(alb.Properties.Scheme).toBe('internet-facing');
    expect([...alb.Properties.Subnets].sort()).toEqual([...PUBLIC_SUBNETS].sort());
    const attributes = Object.fromEntries((alb.Properties.LoadBalancerAttributes as Array<{ Key: string; Value: string }>)
      .map(({ Key, Value }) => [Key, Value]));
    expect(attributes['routing.http.drop_invalid_header_fields.enabled']).toBe('true');
    expect(attributes['access_logs.s3.enabled']).toBe('true');
    expect(attributes['idle_timeout.timeout_seconds']).toBe('60');
  });

  it('runs tasks only in the two private (NAT-routed) subnets without public IPs', () => {
    const [, service] = only('AWS::ECS::Service');
    const vpcConfig = service.Properties.NetworkConfiguration.AwsvpcConfiguration;
    expect(vpcConfig.AssignPublicIp).toBe('DISABLED');
    expect([...vpcConfig.Subnets].sort()).toEqual([...PRIVATE_SUBNETS].sort());
  });
});

describe('security groups', () => {
  it('ALB admits exactly one ingress rule: the CloudFront origin-facing prefix list on TCP 80', () => {
    const albGroup = groupReferencedBy(only('AWS::ElasticLoadBalancingV2::LoadBalancer')[1].Properties.SecurityGroups);
    const ingress = rules(albGroup, 'Ingress');
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourcePrefixListId: 'pl-22a6434b' });
    expect(ingress[0]!.CidrIp).toBeUndefined();
    expect(ingress[0]!.CidrIpv6).toBeUndefined();
  });

  it('ALB egress reaches only the task security group on 8080', () => {
    const albGroup = groupReferencedBy(only('AWS::ElasticLoadBalancingV2::LoadBalancer')[1].Properties.SecurityGroups);
    const taskGroup = groupReferencedBy(only('AWS::ECS::Service')[1].Properties.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups);
    const egress = rules(albGroup, 'Egress');
    expect(egress).toHaveLength(1);
    expect(egress[0]).toMatchObject({ IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080 });
    expect(references(egress[0]!.DestinationSecurityGroupId, taskGroup)).toBe(true);
  });

  it('tasks accept traffic only from the ALB security group and egress only HTTPS (via NAT)', () => {
    const albGroup = groupReferencedBy(only('AWS::ElasticLoadBalancingV2::LoadBalancer')[1].Properties.SecurityGroups);
    const taskGroup = groupReferencedBy(only('AWS::ECS::Service')[1].Properties.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups);
    expect(taskGroup).not.toBe(albGroup);
    const ingress = rules(taskGroup, 'Ingress');
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({ IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080 });
    expect(references(ingress[0]!.SourceSecurityGroupId, albGroup)).toBe(true);
    expect(ingress[0]!.CidrIp).toBeUndefined();
    expect(rules(taskGroup, 'Egress')).toEqual([expect.objectContaining({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' })]);
  });
});

describe('origin authentication', () => {
  it('the listener answers 403 by default and forwards only with the X-Origin-Verify secret', () => {
    const [, listener] = only('AWS::ElasticLoadBalancingV2::Listener');
    expect(listener.Properties).toMatchObject({
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '403' } }],
    });
    const [, rule] = only('AWS::ElasticLoadBalancingV2::ListenerRule');
    expect(rule.Properties.Actions).toEqual([expect.objectContaining({ Type: 'forward' })]);
    const header = rule.Properties.Conditions.find((condition: any) => condition.Field === 'http-header');
    expect(header.HttpHeaderConfig.HttpHeaderName).toBe('X-Origin-Verify');
    expect(header.HttpHeaderConfig.Values).toHaveLength(1);
    expect(JSON.stringify(header.HttpHeaderConfig.Values[0])).toContain('{{resolve:secretsmanager:');
  });

  it('CloudFront sends the same secret as an origin custom header over HTTP-only to the ALB', () => {
    const [ruleValue] = only('AWS::ElasticLoadBalancingV2::ListenerRule')[1].Properties.Conditions
      .find((condition: any) => condition.Field === 'http-header').HttpHeaderConfig.Values;
    const [origin] = distributionConfig().Origins;
    expect(origin.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'http-only', HTTPPort: 80 });
    expect(references(origin.DomainName, only('AWS::ElasticLoadBalancingV2::LoadBalancer')[0])).toBe(true);
    expect(origin.OriginCustomHeaders).toEqual([{ HeaderName: 'X-Origin-Verify', HeaderValue: ruleValue }]);
  });

  it('keeps the generated secret out of the task, IAM policies and outputs', () => {
    const [secretId, secret] = only('AWS::SecretsManager::Secret');
    expect(secret.Properties.SecretString).toBeUndefined();
    expect(secret.Properties.GenerateSecretString).toMatchObject({ ExcludePunctuation: true, PasswordLength: 48 });
    expect(references(container(), secretId)).toBe(false);
    expect(container().Secrets).toBeUndefined();
    expect(references(template.findResources('AWS::IAM::Policy'), secretId)).toBe(false);
    expect(references(template.toJSON().Outputs, secretId)).toBe(false);
  });
});

describe('origin secret rotation', () => {
  const headerValues = (t: Template) => {
    const [, rule] = Object.entries(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule') as Record<string, Resource>)[0]!;
    return rule.Properties.Conditions.find((condition: any) => condition.Field === 'http-header').HttpHeaderConfig.Values as unknown[];
  };
  const originHeader = (t: Template) => {
    const [, distribution] = Object.entries(t.findResources('AWS::CloudFront::Distribution') as Record<string, Resource>)[0]!;
    return distribution.Properties.DistributionConfig.Origins[0].OriginCustomHeaders[0].HeaderValue;
  };

  it('generation 2 keeps the generation-1 secret accepted while CloudFront switches to the new one', () => {
    const rotated = synth({ originSecretGeneration: 2 }).template;
    const secrets = Object.keys(rotated.findResources('AWS::SecretsManager::Secret'));
    expect(secrets).toHaveLength(2);
    // The generation-1 secret keeps its logical id, so CloudFormation does not replace it.
    const [originalId] = only('AWS::SecretsManager::Secret');
    expect(secrets).toContain(originalId);
    const values = headerValues(rotated);
    expect(values).toHaveLength(2);
    const newId = secrets.find(id => id !== originalId)!;
    expect(references(originHeader(rotated), newId)).toBe(true);
    expect(values.some(value => references(value, originalId))).toBe(true);
    expect(values.some(value => references(value, newId))).toBe(true);
  });

  it('updates the listener rule before the distribution', () => {
    const [ruleId] = only('AWS::ElasticLoadBalancingV2::ListenerRule');
    const [, distribution] = only('AWS::CloudFront::Distribution') as [string, Resource & { DependsOn?: string[] }];
    expect(distribution.DependsOn).toContain(ruleId);
  });

  it('generation 3 retires generation 1', () => {
    const [originalId] = only('AWS::SecretsManager::Secret');
    const rotated = synth({ originSecretGeneration: 3 }).template;
    expect(Object.keys(rotated.findResources('AWS::SecretsManager::Secret'))).not.toContain(originalId);
    expect(headerValues(rotated)).toHaveLength(2);
  });

  it('rejects invalid generations', () => {
    expect(() => synth({ originSecretGeneration: 0 })).toThrow(/originSecretGeneration/);
    expect(() => synth({ originSecretGeneration: Number.NaN })).toThrow(/originSecretGeneration/);
  });
});

describe('compute', () => {
  it('runs a 1 vCPU / 2 GB ARM64 Linux task, non-root, read-only root, no capabilities', () => {
    const [, task] = only('AWS::ECS::TaskDefinition');
    expect(task.Properties).toMatchObject({
      Cpu: '1024', Memory: '2048', NetworkMode: 'awsvpc', RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    });
    const app = container();
    expect(app.ReadonlyRootFilesystem).toBe(true);
    expect(app.User).toBe('1000:1000');
    expect(app.Privileged).toBe(false);
    expect(app.LinuxParameters).toMatchObject({ InitProcessEnabled: true, Capabilities: { Drop: ['ALL'] } });
    expect(app.StopTimeout).toBe(30);
    expect(app.PortMappings).toEqual([expect.objectContaining({ ContainerPort: 8080, Protocol: 'tcp' })]);
    expect(app.HealthCheck.Command.slice(0, 2)).toEqual(['CMD', 'node']);
    expect(app.HealthCheck.Command.join(' ')).toContain('127.0.0.1:8080/healthz');
    expect(app.LogConfiguration.LogDriver).toBe('awslogs');
  });

  it('configures the server through non-secret environment variables', () => {
    const environment = Object.fromEntries((container().Environment as Array<{ Name: string; Value: unknown }>).map(e => [e.Name, e.Value]));
    expect(environment).toMatchObject({ NODE_ENV: 'production', PORT: '8080', HOST: '0.0.0.0', STATIC_DIR: '/app/dist/client', AWS_REGION: 'ap-northeast-2' });
    expect(environment.APP_VERSION).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    expect(references(environment.TABLE_NAME, only('AWS::DynamoDB::Table')[0])).toBe(true);
    expect(references(environment.PUBLIC_ORIGIN, only('AWS::CloudFront::Distribution')[0])).toBe(true);
    // The distribution must not depend on the task definition (no cycle).
    expect(references(only('AWS::CloudFront::Distribution')[1], only('AWS::ECS::TaskDefinition')[0])).toBe(false);
  });

  it('keeps two tasks, rolls back failed deployments and scales 2-6 on CPU and ALB requests', () => {
    const [, service] = only('AWS::ECS::Service');
    expect(service.Properties.DesiredCount).toBe(2);
    expect(service.Properties.LaunchType).toBe('FARGATE');
    expect(service.Properties.EnableExecuteCommand ?? false).toBe(false);
    expect(service.Properties.DeploymentConfiguration).toMatchObject({
      DeploymentCircuitBreaker: { Enable: true, Rollback: true }, MinimumHealthyPercent: 100, MaximumPercent: 200,
    });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 2, MaxCapacity: 6 });
    const metrics = all('AWS::ApplicationAutoScaling::ScalingPolicy')
      .map(([, policy]) => policy.Properties.TargetTrackingScalingPolicyConfiguration)
      .map(config => [config.PredefinedMetricSpecification.PredefinedMetricType, config.TargetValue]);
    expect(metrics).toEqual(expect.arrayContaining([['ECSServiceAverageCPUUtilization', 60], ['ALBRequestCountPerTarget', 600]]));
    const [, targets] = only('AWS::ElasticLoadBalancingV2::TargetGroup');
    expect(targets.Properties).toMatchObject({ Port: 8080, Protocol: 'HTTP', TargetType: 'ip', HealthCheckPath: '/healthz', Matcher: { HttpCode: '200' } });
  });

  it('enables Container Insights and keeps application logs for one month', () => {
    const [, cluster] = only('AWS::ECS::Cluster');
    expect(cluster.Properties.ClusterSettings).toEqual([{ Name: 'containerInsights', Value: 'enabled' }]);
    const [, group] = only('AWS::Logs::LogGroup');
    expect(group.Properties.RetentionInDays).toBe(30);
  });

  it('grants the task only item/query access to its own table', () => {
    const [tableId] = only('AWS::DynamoDB::Table');
    const [, task] = only('AWS::ECS::TaskDefinition');
    const taskRoleId = all('AWS::IAM::Role').map(([id]) => id).find(id => references(task.Properties.TaskRoleArn, id))!;
    const statements = all('AWS::IAM::Policy')
      .filter(([, policy]) => references(policy.Properties.Roles, taskRoleId))
      .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement as Array<Record<string, any>>);
    expect(statements).toHaveLength(1);
    expect([statements[0]!.Action].flat().sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']);
    expect(references(statements[0]!.Resource, tableId)).toBe(true);
    expect(JSON.stringify(statements[0]!.Resource)).not.toContain('*');
  });

  it('builds exactly one linux/arm64 Docker image asset', () => {
    const assembly = app.synth();
    const manifest = JSON.parse(readFileSync(join(assembly.directory, 'TurboPalsTest.assets.json'), 'utf8'));
    const images = Object.values(manifest.dockerImages) as Array<{ source: { platform: string; dockerFile: string } }>;
    expect(images).toHaveLength(1);
    expect(images[0]!.source).toMatchObject({ platform: 'linux/arm64', dockerFile: 'Dockerfile' });
  });
});

describe('data', () => {
  it('retains an on-demand pk/sk table with point-in-time recovery and deletion protection', () => {
    const [, table] = only('AWS::DynamoDB::Table');
    expect(table.Properties).toMatchObject({
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
      SSESpecification: { SSEEnabled: true },
    });
    expect(table.Properties.GlobalSecondaryIndexes).toBeUndefined();
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.UpdateReplacePolicy).toBe('Retain');
  });

  it('keeps access logs private, TLS-only and for 30 days', () => {
    const [bucketId, bucket] = only('AWS::S3::Bucket');
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.LifecycleConfiguration.Rules).toEqual([expect.objectContaining({ ExpirationInDays: 30, Status: 'Enabled' })]);
    const [, policy] = only('AWS::S3::BucketPolicy');
    expect(references(policy.Properties.Bucket, bucketId)).toBe(true);
    expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain('aws:SecureTransport');
    expect(distributionConfig().Logging).toMatchObject({ Prefix: 'cloudfront/', IncludeCookies: false });
  });
});

describe('edge', () => {
  const behaviors = () => {
    const config = distributionConfig();
    return { config, all: [config.DefaultCacheBehavior, ...config.CacheBehaviors] as Array<Record<string, any>> };
  };

  it('serves HTTPS only over HTTP/2+3, IPv6 and price class 200', () => {
    const { config, all: every } = behaviors();
    expect(config).toMatchObject({ HttpVersion: 'http2and3', IPV6Enabled: true, PriceClass: 'PriceClass_200', Enabled: true });
    for (const behavior of every) expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
  });

  it('never caches pages or API calls and caches /assets/* for a year with compression', () => {
    const { config } = behaviors();
    const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
    const ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
    expect(config.DefaultCacheBehavior).toMatchObject({ CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST });
    expect([...config.DefaultCacheBehavior.AllowedMethods].sort()).toEqual(['GET', 'HEAD']);
    const api = config.CacheBehaviors.find((behavior: any) => behavior.PathPattern === '/api/*');
    expect(api).toMatchObject({ CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST });
    expect([...api.AllowedMethods].sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    const assets = config.CacheBehaviors.find((behavior: any) => behavior.PathPattern === '/assets/*');
    expect(assets.Compress).toBe(true);
    const [policyId, policy] = only('AWS::CloudFront::CachePolicy');
    expect(references(assets.CachePolicyId, policyId)).toBe(true);
    expect(policy.Properties.CachePolicyConfig).toMatchObject({
      DefaultTTL: 31_536_000, MaxTTL: 31_536_000, MinTTL: 0,
      ParametersInCacheKeyAndForwardedToOrigin: {
        EnableAcceptEncodingBrotli: true, EnableAcceptEncodingGzip: true,
        CookiesConfig: { CookieBehavior: 'none' }, QueryStringsConfig: { QueryStringBehavior: 'none' },
      },
    });
    for (const code of [403, 404, 500, 502, 503, 504]) {
      expect(config.CustomErrorResponses).toContainEqual(expect.objectContaining({ ErrorCode: code, ErrorCachingMinTTL: 0 }));
    }
  });

  it('applies the shared CSP, HSTS, nosniff, frame DENY, no-referrer and Permissions-Policy everywhere', () => {
    const [policyId, policy] = only('AWS::CloudFront::ResponseHeadersPolicy');
    const config = policy.Properties.ResponseHeadersPolicyConfig;
    expect(config.SecurityHeadersConfig).toMatchObject({
      ContentSecurityPolicy: { ContentSecurityPolicy: CONTENT_SECURITY_POLICY, Override: true },
      ContentTypeOptions: { Override: true },
      FrameOptions: { FrameOption: 'DENY', Override: true },
      ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true },
    });
    expect(CONTENT_SECURITY_POLICY).toContain('upgrade-insecure-requests');
    expect(config.CustomHeadersConfig.Items).toContainEqual({ Header: 'Permissions-Policy', Value: PERMISSIONS_POLICY, Override: true });
    for (const behavior of behaviors().all) expect(references(behavior.ResponseHeadersPolicyId, policyId)).toBe(true);
  });

  it('stamps the viewer IP on every behavior, overwriting spoofed values', () => {
    const [functionId, edgeFunction] = only('AWS::CloudFront::Function');
    expect(edgeFunction.Properties.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
    const event = {
      viewer: { ip: '203.0.113.9' },
      request: {
        method: 'POST', uri: '/api/runs', querystring: {},
        headers: {
          'x-turbo-client-ip': { value: '1.2.3.4', multiValue: [{ value: '1.2.3.4' }, { value: '5.6.7.8' }] },
          'content-type': { value: 'application/json' },
        },
      },
    };
    const result = runInNewContext(`${edgeFunction.Properties.FunctionCode}\nhandler(event);`, { event });
    expect(result.headers['x-turbo-client-ip']).toEqual({ value: '203.0.113.9' });
    expect(result.headers['content-type']).toEqual({ value: 'application/json' });
    expect(result.uri).toBe('/api/runs');
    for (const behavior of behaviors().all) {
      expect(behavior.FunctionAssociations).toHaveLength(1);
      expect(behavior.FunctionAssociations[0].EventType).toBe('viewer-request');
      expect(references(behavior.FunctionAssociations[0].FunctionARN, functionId)).toBe(true);
    }
  });

  it('forwards only the stamped IP header on /assets/* cache misses', () => {
    const [policyId, policy] = only('AWS::CloudFront::OriginRequestPolicy');
    const assets = distributionConfig().CacheBehaviors.find((behavior: any) => behavior.PathPattern === '/assets/*');
    expect(references(assets.OriginRequestPolicyId, policyId)).toBe(true);
    expect(policy.Properties.OriginRequestPolicyConfig).toMatchObject({
      HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['x-turbo-client-ip'] },
      CookiesConfig: { CookieBehavior: 'none' },
      QueryStringsConfig: { QueryStringBehavior: 'none' },
    });
  });
});

describe('stack contract', () => {
  it('exports the operational outputs', () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(Object.keys(outputs).sort()).toEqual(['AlbDnsName', 'ClusterName', 'DistributionId', 'NativeSiteUrl', 'ServiceName', 'SiteUrl', 'TableName']);
    expect(JSON.stringify(outputs.SiteUrl!.Value)).toContain('https://');
  });

  it('serves the custom domain with the us-east-1 certificate and TLS 1.2_2021', () => {
    const cert = 'arn:aws:acm:us-east-1:061525506239:certificate/7d53182a-2a2a-4225-a319-4f94030561b7';
    const custom = synth({ domainName: 'my-kart.whchoi.net', certificateArn: cert }).template;
    const dist = Object.values(custom.findResources('AWS::CloudFront::Distribution'))[0] as Resource;
    const cfg = dist.Properties.DistributionConfig as Record<string, any>;
    expect(cfg.Aliases).toEqual(['my-kart.whchoi.net']);
    expect(cfg.ViewerCertificate).toMatchObject({ AcmCertificateArn: cert, MinimumProtocolVersion: 'TLSv1.2_2021', SslSupportMethod: 'sni-only' });
    const task = Object.values(custom.findResources('AWS::ECS::TaskDefinition'))[0] as Resource;
    const env = ((task.Properties.ContainerDefinitions as any[])[0].Environment as Array<{ Name: string; Value: unknown }>);
    expect(env.find(e => e.Name === 'PUBLIC_ORIGIN')?.Value).toBe('https://my-kart.whchoi.net');
    expect(JSON.stringify(env.find(e => e.Name === 'ALLOWED_ORIGINS')?.Value)).toContain('DomainName');
    const outputs = custom.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(outputs.SiteUrl!.Value).toBe('https://my-kart.whchoi.net/');
  });

  it('rejects unauthorised domains and half-configured certificates', () => {
    const cert = 'arn:aws:acm:us-east-1:061525506239:certificate/x';
    expect(() => synth({ domainName: 'evil.example.com', certificateArn: cert })).toThrow(/Only the custom domain/);
    expect(() => synth({ domainName: 'my-kart.whchoi.net' })).toThrow(/together/);
    expect(() => synth({ domainName: 'my-kart.whchoi.net', certificateArn: 'arn:aws:acm:ap-northeast-2:061525506239:certificate/x' })).toThrow(/us-east-1/);
  });

  it('tags resources with Project=turbo-pals', () => {
    const [, table] = only('AWS::DynamoDB::Table');
    expect(table.Properties.Tags).toContainEqual({ Key: 'Project', Value: 'turbo-pals' });
  });

  it('refuses any other account, region, VPC or prefix list', () => {
    expect(() => synth({ env: { ...ENV, account: '123456789012' } })).toThrow(/account/);
    expect(() => synth({ env: { ...ENV, region: 'us-east-1' } })).toThrow(/region/);
    expect(() => synth({ vpcId: 'vpc-0123456789abcdef0' })).toThrow(/VPC/);
    expect(() => synth({ cloudfrontPrefixListId: 'pl-3b927c52' })).toThrow(/prefix list/);
  });
});
