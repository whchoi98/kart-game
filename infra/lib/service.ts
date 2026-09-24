import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  APP_PORT, CPU_TARGET_PERCENT, MAX_TASKS, MIN_TASKS, ORIGIN_VERIFY_HEADER, REQUESTS_PER_TARGET,
  TASK_CPU, TASK_MEMORY_MIB,
} from './settings.js';

/**
 * Docker build context exclusions — the same list as .dockerignore, so the
 * asset hash (and therefore image rebuilds) ignores docs, tests and infra.
 */
export const IMAGE_CONTEXT_EXCLUDE = [
  '.git', '.github', '.claude', '.agents', '.codex', '.superpowers', '.vscode', '.idea',
  'node_modules', 'dist', 'coverage', 'cdk.out', 'cdk.out.*', 'cdk.json', 'cdk.context.json', 'cdk-outputs.json',
  'infra', 'test', 'test-results', 'playwright-report', 'docs', 'artifacts', '*.md',
  'tools/*', '!tools/build.mjs',
  '.env', '.env.*', '**/.env', '**/.env.*', '*.pem', '**/*.pem', '*.key', '**/*.key',
  '.npmrc', '**/.npmrc', '*.log', '**/*.log', '.DS_Store', '**/.DS_Store',
];

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export interface ServiceProps {
  readonly vpc: ec2.IVpc;
  readonly publicSubnets: ec2.SubnetSelection;
  readonly privateSubnets: ec2.SubnetSelection;
  readonly cloudfrontPrefixListId: string;
  readonly table: dynamodb.ITable;
  readonly originSecret: secretsmanager.ISecret;
  /** Previous secret generation, accepted only while a rotation propagates. */
  readonly previousOriginSecret?: secretsmanager.ISecret;
  readonly accessLogs: s3.IBucket;
  /** Docker build context; tests pass a tiny fixture instead of the project root. */
  readonly imageDirectory?: string;
}

/** Internet-facing ALB (CloudFront-only) → private ARM64 Fargate service. */
export class Service extends Construct {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;
  /** Forwards only requests that carry an accepted X-Origin-Verify value. */
  readonly originRule: elbv2.ApplicationListenerRule;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly taskSecurityGroup: ec2.SecurityGroup;
  readonly cluster: ecs.Cluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly container: ecs.ContainerDefinition;
  readonly service: ecs.FargateService;
  readonly logGroup: logs.LogGroup;
  /** CloudFormation dynamic reference to the origin secret — never a plaintext value. */
  readonly originVerifyValue: string;

  constructor(scope: Construct, id: string, props: ServiceProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    this.originVerifyValue = props.originSecret.secretValue.unsafeUnwrap();

    // ── Security groups: CloudFront prefix list → ALB :80 → tasks :8080 → HTTPS egress via NAT ──
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      description: 'TURBO PALS ALB - CloudFront origin-facing prefix list on TCP 80 only',
      allowAllOutbound: false,
      disableInlineRules: true,
    });
    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc: props.vpc,
      description: 'TURBO PALS tasks - ALB ingress on 8080, HTTPS egress through the VPC NAT gateways',
      allowAllOutbound: false,
      disableInlineRules: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(props.cloudfrontPrefixListId), ec2.Port.tcp(80), 'CloudFront origin-facing servers only');
    this.albSecurityGroup.addEgressRule(this.taskSecurityGroup, ec2.Port.tcp(APP_PORT), 'Forward to Fargate tasks');
    this.taskSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(APP_PORT), 'Traffic and health checks from the ALB');
    this.taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'ECR, CloudWatch Logs and DynamoDB over HTTPS via the existing NAT gateways');

    // ── Load balancer ──
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      vpcSubnets: props.publicSubnets,
      internetFacing: true,
      ipAddressType: elbv2.IpAddressType.IPV4,
      securityGroup: this.albSecurityGroup,
      idleTimeout: cdk.Duration.seconds(60),
      dropInvalidHeaderFields: true,
      desyncMitigationMode: elbv2.DesyncMitigationMode.STRICTEST,
      http2Enabled: true,
    });
    this.loadBalancer.logAccessLogs(props.accessLogs, 'alb');

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'Targets', {
      vpc: props.vpc,
      port: APP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(20),
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    this.listener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'text/plain', messageBody: 'Forbidden' }),
    });
    const acceptedOriginValues = [
      this.originVerifyValue,
      ...(props.previousOriginSecret ? [props.previousOriginSecret.secretValue.unsafeUnwrap()] : []),
    ];
    this.originRule = new elbv2.ApplicationListenerRule(this, 'FromCloudFront', {
      listener: this.listener,
      priority: 10,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, acceptedOriginValues)],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // ── Compute ──
    const image = new ecrAssets.DockerImageAsset(this, 'Image', {
      directory: props.imageDirectory ?? PROJECT_ROOT,
      file: 'Dockerfile',
      platform: ecrAssets.Platform.LINUX_ARM64,
      exclude: IMAGE_CONTEXT_EXCLUDE,
      ignoreMode: cdk.IgnoreMode.DOCKER,
    });
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    this.logGroup = new logs.LogGroup(this, 'AppLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: TASK_CPU,
      memoryLimitMiB: TASK_MEMORY_MIB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const linux = new ecs.LinuxParameters(this, 'Linux', { initProcessEnabled: true });
    linux.dropCapabilities(ecs.Capability.ALL);
    this.container = this.taskDefinition.addContainer('App', {
      containerName: 'turbo-pals',
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      command: ['node', 'dist/server/index.js'],
      workingDirectory: '/app',
      user: '1000:1000',
      readonlyRootFilesystem: true,
      privileged: false,
      linuxParameters: linux,
      stopTimeout: cdk.Duration.seconds(30),
      portMappings: [{ containerPort: APP_PORT, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: 'app',
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        maxBufferSize: cdk.Size.mebibytes(8),
      }),
      healthCheck: {
        command: ['CMD', 'node', '-e',
          "fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(20),
      },
      environment: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: String(APP_PORT),
        STATIC_DIR: '/app/dist/client',
        TABLE_NAME: props.table.tableName,
        AWS_REGION: stack.region,
        // semver build metadata: clients compare only the core version.
        APP_VERSION: `${PACKAGE_VERSION}+${image.assetHash.slice(0, 12)}`,
      },
    });
    cdk.Validations.of(this.taskDefinition).acknowledge({
      id: 'AwsSolutions-ECS2',
      reason: 'The environment holds only non-secret deployment configuration (port, region, table name, static directory, public origin, build version). The origin-verify secret is intentionally never given to the task.',
    });
    this.taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      sid: 'RankingsTable',
      // TransactWriteItems is authorised per item action (PutItem/DeleteItem); no Scan, no UpdateItem.
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
      resources: [props.table.tableArn],
    }));
    cdk.Validations.of(this.taskDefinition.obtainExecutionRole()).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'ecr:GetAuthorizationToken does not support resource-level permissions; image pulls and log writes are scoped to this repository and log group.',
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: MIN_TASKS,
      vpcSubnets: props.privateSubnets,
      assignPublicIp: false,
      securityGroups: [this.taskSecurityGroup],
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      enableExecuteCommand: false,
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    const scaling = this.service.autoScaleTaskCount({ minCapacity: MIN_TASKS, maxCapacity: MAX_TASKS });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: CPU_TARGET_PERCENT,
      scaleInCooldown: cdk.Duration.seconds(180),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
    scaling.scaleOnRequestCount('Requests', {
      targetGroup: this.targetGroup,
      requestsPerTarget: REQUESTS_PER_TARGET,
      scaleInCooldown: cdk.Duration.seconds(180),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
  }
}
