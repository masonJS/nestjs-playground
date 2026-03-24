#!/bin/bash

echo "init localstack"

REGION="ap-northeast-2"

# SNS
awslocal sns create-topic --name test-topic --region $REGION

# S3
awslocal s3 mb s3://test-bucket

# SQS
awslocal sqs create-queue --queue-name test-queue --region $REGION

# SNS → SQS 구독
TOPIC_ARN="arn:aws:sns:${REGION}:000000000000:test-topic"
QUEUE_ARN="arn:aws:sqs:${REGION}:000000000000:test-queue"
awslocal sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol sqs \
  --notification-endpoint "$QUEUE_ARN" \
  --region $REGION

# SES
awslocal ses verify-email-identity --email-address test@test.com --region $REGION

echo "init localstack done"

