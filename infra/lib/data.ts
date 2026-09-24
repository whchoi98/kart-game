import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * Rankings table and the CloudFront → ALB origin secret.
 *
 * Table layout (src/server/dynamo-repository.ts):
 *   LB#<track>#<cc>             / <ticks:9>#<runId>  ranking row
 *   PB#<track>#<cc>#<playerId>  / PB                 pointer to the player's best row
 *   GHOST#<runId>               / GHOST              input log for the ranking row
 *   LOG#<digest of the inputs>  / LOG                first player to register that input sequence (permanent)
 */
export interface DataProps {
  /**
   * Origin-secret generation (context `originSecretGeneration`, default 1).
   * Bumping it rotates the X-Origin-Verify value without downtime: the ALB
   * accepts the new and the previous generation while CloudFront propagates.
   */
  readonly originSecretGeneration?: number;
}

const secretId = (generation: number) => (generation === 1 ? 'OriginVerify' : `OriginVerifyG${generation}`);

export class Data extends Construct {
  readonly table: dynamodb.Table;
  /** Value CloudFront sends. */
  readonly originSecret: secretsmanager.Secret;
  /** Previous generation, still accepted by the ALB during a rotation. */
  readonly previousOriginSecret?: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataProps = {}) {
    super(scope, id);
    const generation = props.originSecretGeneration ?? 1;
    if (!Number.isInteger(generation) || generation < 1 || generation > 999) {
      throw new Error('originSecretGeneration must be an integer between 1 and 999.');
    }
    this.table = new dynamodb.Table(this, 'Rankings', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      // Player rankings outlive any stack: `cdk destroy` leaves the table behind.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Only CloudFront (origin custom header) and the ALB listener rule read these
    // values, both through CloudFormation dynamic references; the task never sees them.
    this.originSecret = this.originVerifySecret(generation);
    if (generation > 1) this.previousOriginSecret = this.originVerifySecret(generation - 1);
  }

  private originVerifySecret(generation: number): secretsmanager.Secret {
    const secret = new secretsmanager.Secret(this, secretId(generation), {
      description: `TURBO PALS: X-Origin-Verify value (generation ${generation}) shared by CloudFront and the ALB listener rule`,
      generateSecretString: { excludePunctuation: true, includeSpace: false, passwordLength: 48 },
    });
    cdk.Validations.of(secret).acknowledge({
      id: 'AwsSolutions-SMG4',
      reason: 'The origin-verify value is embedded in the CloudFront origin and the ALB rule by CloudFormation dynamic references, so Secrets Manager rotation could not propagate it. Rotation is a zero-downtime redeploy that bumps originSecretGeneration (docs/infra.md).',
    });
    return secret;
  }
}
