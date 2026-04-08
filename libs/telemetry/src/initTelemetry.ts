import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Configuration } from '@app/config/Configuration';

let telemetrySdk: NodeSDK | undefined;

export const initTelemetry = (): NodeSDK | undefined => {
  if (telemetrySdk) {
    return telemetrySdk;
  }

  const { otel } = Configuration.getEnv();

  if (!otel.enabled) {
    return undefined;
  }

  const exporter = new OTLPTraceExporter({
    url: `${otel.exporterOtlpEndpoint.replace(/\/$/, '')}/v1/traces`,
  });

  telemetrySdk = new NodeSDK({
    serviceName: otel.serviceName,
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  telemetrySdk.start();
  return telemetrySdk;
};

export const shutdownTelemetry = async (): Promise<void> => {
  await telemetrySdk?.shutdown();
};
