import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** CloudFront standard logs (cloudfront/) and ALB access logs (alb/), kept 30 days. */
export class AccessLogs extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // CloudFront standard logging delivers through bucket ACLs.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{
        id: 'expire-access-logs',
        expiration: cdk.Duration.days(30),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      }],
      // A non-empty bucket cannot be deleted by CloudFormation; objects expire on their own.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Validations.of(this.bucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'This bucket is itself the access-log destination for CloudFront and the ALB; logging it would create recursive log-of-log objects. Objects expire after 30 days.',
    });
  }
}
