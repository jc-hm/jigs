import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwactions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

// CloudFront metrics are only published to us-east-1 regardless of where the
// distribution serves from. This stack is always deployed to us-east-1 so its
// alarms are co-located with the metrics they monitor.

interface MonitoringStackProps extends cdk.StackProps {
  stage: string;
  distributionId: string;
  alertEmail: string;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { stage, distributionId, alertEmail } = props;

    const alertTopic = new sns.Topic(this, "CfAlertTopic", {
      topicName: `jigs-cf-alerts-${stage}`,
      displayName: `Jigs ${stage} CloudFront Alerts`,
    });
    alertTopic.addSubscription(new snsSubs.EmailSubscription(alertEmail));

    // 5xx rate covers both our Lambda errors and infrastructure-level failures
    // (e.g. Lambda unreachable, platform-level throttle) that never reach
    // application code and are therefore invisible in Lambda logs and Sentry.
    const alarm = new cloudwatch.Alarm(this, "Cf5xxAlarm", {
      alarmName: `jigs-${stage}-cf-5xx`,
      alarmDescription: "CloudFront 5xx error rate ≥ 1% — includes errors that never reach Lambda",
      metric: new cloudwatch.Metric({
        namespace: "AWS/CloudFront",
        metricName: "5xxErrorRate",
        dimensionsMap: { DistributionId: distributionId, Region: "Global" },
        statistic: "Average",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cwactions.SnsAction(alertTopic));
  }
}
