#!/bin/zsh

echo "init localstack"
awslocal sns create-topic --name test-topic --region=ap-northeast-2
