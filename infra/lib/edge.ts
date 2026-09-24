import * as cdk from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  CLIENT_IP_HEADER, CONTENT_SECURITY_POLICY, CROSS_ORIGIN_OPENER_POLICY, CROSS_ORIGIN_RESOURCE_POLICY,
  HSTS_MAX_AGE_SECONDS, PERMISSIONS_POLICY,
} from '../../src/shared/csp.js';
import { ORIGIN_VERIFY_HEADER } from './settings.js';

export interface EdgeProps {
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  /** Dynamic reference to the origin secret (resolved by CloudFormation). */
  readonly originVerifyValue: string;
  readonly accessLogs: s3.IBucket;
  /** Optional custom hostname served with `certificate` (us-east-1 ACM). */
  readonly domainName?: string;
  readonly certificate?: acm.ICertificate;
}

/** Viewer-request function source: the only trusted copy of the viewer IP. */
export const VIEWER_IP_FUNCTION_CODE = [
  'function handler(event) {',
  '  var request = event.request;',
  '  // Overwrite (never append to) any viewer-supplied value, including multi-value headers.',
  `  request.headers['${CLIENT_IP_HEADER}'] = { value: event.viewer.ip };`,
  '  return request;',
  '}',
].join('\n');

/** HTTPS entry point: CloudFront → (HTTP + X-Origin-Verify) → ALB. */
export class Edge extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  readonly viewerIpFunction: cloudfront.Function;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);

    const origin = new origins.HttpOrigin(props.loadBalancer.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      customHeaders: { [ORIGIN_VERIFY_HEADER]: props.originVerifyValue },
      readTimeout: cdk.Duration.seconds(30),
      // Below the ALB idle timeout (60 s) so CloudFront never reuses a connection the ALB closed.
      keepaliveTimeout: cdk.Duration.seconds(30),
    });

    this.viewerIpFunction = new cloudfront.Function(this, 'ViewerIp', {
      comment: 'TURBO PALS: stamp the viewer IP for origin rate limiting',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(VIEWER_IP_FUNCTION_CODE),
    });

    this.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'TURBO PALS self-hosted browser security policy (src/shared/csp.ts)',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(HSTS_MAX_AGE_SECONDS),
          includeSubdomains: true,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: PERMISSIONS_POLICY, override: true },
          { header: 'Cross-Origin-Opener-Policy', value: CROSS_ORIGIN_OPENER_POLICY, override: true },
          { header: 'Cross-Origin-Resource-Policy', value: CROSS_ORIGIN_RESOURCE_POLICY, override: true },
        ],
      },
    });

    // Vite emits content-hashed file names under /assets, so a year of caching is safe.
    const assetCache = new cloudfront.CachePolicy(this, 'ImmutableAssets', {
      comment: 'TURBO PALS content-hashed /assets/*: one year, no cookies, no query strings',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });
    const assetOriginRequest = new cloudfront.OriginRequestPolicy(this, 'AssetOriginRequest', {
      comment: 'TURBO PALS asset misses: forward only the stamped viewer IP',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(CLIENT_IP_HEADER),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
    });

    const common = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy: this.responseHeadersPolicy,
      functionAssociations: [{ function: this.viewerIpFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    };

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'TURBO PALS GRAND PRIX',
      defaultBehavior: {
        ...common,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: false,
      },
      additionalBehaviors: {
        '/assets/*': {
          ...common,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: assetCache,
          originRequestPolicy: assetOriginRequest,
          compress: true,
        },
        '/api/*': {
          ...common,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: false,
        },
      },
      // Never cache error responses at the edge (a transient 5xx must not stick for 10 s).
      errorResponses: [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504]
        .map(httpStatus => ({ httpStatus, ttl: cdk.Duration.seconds(0) })),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      enableIpv6: true,
      enableLogging: true,
      logBucket: props.accessLogs,
      logFilePrefix: 'cloudfront/',
      logIncludesCookies: false,
      ...(props.domainName && props.certificate ? {
        domainNames: [props.domainName],
        certificate: props.certificate,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        sslSupportMethod: cloudfront.SSLMethod.SNI,
      } : {}),
    });

    for (const acknowledgement of [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'The game is offered worldwide; there is no geographic restriction requirement.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'WAF is out of scope for this release. The origin is protected by the CloudFront prefix-list security group, the X-Origin-Verify listener rule and per-viewer application rate limits.',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason: 'The custom domain uses the ACM certificate with TLSv1.2_2021; the default *.cloudfront.net hostname (still served) uses the CloudFront-managed certificate whose viewer TLS policy cannot be pinned.',
      },
      {
        id: 'AwsSolutions-CFR5',
        reason: 'The required topology uses HTTP/80 from CloudFront to the ALB. Only CloudFront origin-facing IPs can reach the listener (managed prefix list) and only requests carrying the generated X-Origin-Verify secret are forwarded; viewers always use HTTPS.',
      },
    ]) cdk.Validations.of(this.distribution).acknowledge(acknowledgement);
  }
}
