import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

let telemetrySdk: NodeSDK | undefined;

export const initTelemetry = (): NodeSDK | undefined => {
  if (telemetrySdk) {
    return telemetrySdk;
  }

  if (process.env.OTEL_ENABLED !== 'true') {
    return undefined;
  }

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const exporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
  });

  telemetrySdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'nestjs-playground',
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
