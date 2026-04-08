# OpenTelemetry HTTP Tracing 도입 계획

## 목표

NestJS 모노레포 프로젝트에 OpenTelemetry를 도입하여 HTTP 요청 트레이싱을 수집하고, Jaeger로 시각화한다.
AOP 패턴(DiscoveryService + 커스텀 데코레이터)으로 span 수집 관심사를 비즈니스 로직에서 분리한다.

## 아키텍처 개요

```
HTTP Request
    ↓
[NestJS auto-instrumentation] ─── root span (HTTP POST /api/v1/...)
    ↓
[@Traceable() 대상 서비스]
    ├─ [ServiceA.method] ─── child span (AOP)
    │      └─ [External API 호출] ─── child span (auto - HTTP outbound)
    ├─ [ServiceB.method] ─── child span (AOP)
    └─ [Repository.method] ─── child span (AOP)
         └─ [DB Query] ─── child span (auto - PostgreSQL)
    ↓
[OTLP Exporter] ──→ Jaeger (localhost:16686)
```

## 기술 스택

| 구성 요소            | 선택                                        | 이유                                |
| -------------------- | ------------------------------------------- | ----------------------------------- |
| SDK                  | `@opentelemetry/sdk-node`                   | Node.js 공식 SDK, 올인원 초기화     |
| Auto-instrumentation | `@opentelemetry/auto-instrumentations-node` | HTTP, PostgreSQL, Express 자동 계측 |
| Exporter             | `@opentelemetry/exporter-trace-otlp-http`   | Jaeger OTLP 네이티브 지원           |
| Propagator           | W3C TraceContext (SDK 기본값)               | 분산 트레이싱 표준                  |
| 시각화               | Jaeger all-in-one                           | Docker 한 줄 실행, OTLP 수신 지원   |

## 구현 단계

### Phase 1: 인프라 설정

#### 1-1. 패키지 설치

```bash
yarn add @opentelemetry/sdk-node \
         @opentelemetry/auto-instrumentations-node \
         @opentelemetry/exporter-trace-otlp-http \
         @opentelemetry/api \
         @opentelemetry/resources \
         @opentelemetry/semantic-conventions
```

#### 1-2. Docker Compose에 Jaeger 추가

`docker-compose.yml`에 Jaeger 서비스 추가:

```yaml
jaeger:
  image: jaegertracing/jaeger:latest
  container_name: jaeger
  ports:
    - '16686:16686' # Jaeger UI
    - '4318:4318' # OTLP HTTP receiver
  volumes:
    - ./jaeger-ui.json:/etc/jaeger/jaeger-ui.json
  environment:
    - JAEGER_UI_CONFIG=/etc/jaeger/jaeger-ui.json
```

#### 1-3. 환경 변수 추가

`env/env.local.yml`:

```yaml
otel:
  enabled: true
  exporterOtlpEndpoint: http://localhost:4318
  serviceName: nestjs-playground
```

또는 환경변수로 직접 설정:

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=nestjs-playground
```

### Phase 2: OpenTelemetry SDK 초기화

#### 2-1. Telemetry 초기화 파일

`libs/telemetry/src/initTelemetry.ts`:

auto-instrumentation은 HTTP, PostgreSQL 등의 모듈이 `require`되기 **전에** monkey-patch를 설치해야 한다. `main.ts`의 **첫 번째 import**로 `initTelemetry()`를 호출하여 NestJS 부트스트랩보다 먼저 실행되도록 한다.

> `initTelemetry()`는 동기 함수이므로 top-level에서 바로 호출 가능하다. `NodeSDK.start()`도 내부적으로 동기 실행이다.

#### 2-2. main.ts 최상단에서 SDK 초기화 (중요)

`apps/api/src/main.ts`:

```typescript
// 반드시 첫 번째 import - 다른 모듈보다 먼저 OTel을 초기화한다
import { initTelemetry } from '@app/telemetry/initTelemetry';
initTelemetry();

import { NestFactory } from '@nestjs/core';
// ... 기존 import ...
```

#### 2-3. TelemetryModule에서 graceful shutdown 처리

`main.ts`에 직접 SIGTERM/SIGINT 핸들러를 추가하는 대신, NestJS의 `enableShutdownHooks()` + `OnApplicationShutdown` 라이프사이클을 활용한다.

> `enableShutdownHooks()`가 SIGTERM/SIGINT를 수신하면, NestJS가 모든 모듈의 `onApplicationShutdown()`을 호출한 뒤 프로세스를 종료한다.

### Phase 3: AOP 기반 커스텀 Span 수집

auto-instrumentation은 HTTP, DB 경계만 계측한다. 내부 서비스 메서드 사이의 span은 **커스텀 AOP 모듈**로 수집한다.

#### 3-1. @Traceable 데코레이터

`libs/telemetry/src/TraceableDecorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const TRACEABLE_METADATA = Symbol('Traceable');

export const Traceable = (): ClassDecorator =>
  SetMetadata(TRACEABLE_METADATA, true);
```

> `@Injectable()`을 포함하지 않는 이유: 메타데이터 마킹과 DI 등록은 별개 관심사이므로 분리한다.

사용 예시:

```typescript
@Traceable()
@Injectable()  // 기존 @Injectable() 유지
export class SomeService { ... }
```

#### 3-2. TelemetryModule (AOP 모듈)

`libs/telemetry/src/TelemetryModule.ts`:

기존 `LoggerModule`의 AOP 패턴(DiscoveryService + MetadataScanner)과 동일한 접근 방식으로, `@Traceable()` 데코레이터가 붙은 클래스의 모든 메서드를 span으로 wrapping한다.

#### 3-3. @Traceable 적용

추적하고 싶은 클래스에 `@Traceable()` 데코레이터를 추가한다:

```typescript
@Traceable()
@Injectable()
export class BuyerService { ... }
```

> Controller는 auto-instrumentation이 HTTP span을 자동 생성하므로 `@Traceable()` 불필요.

#### 3-4. ApiModule에 TelemetryModule 등록

```typescript
@Module({
  imports: [
    // ...
    TelemetryModule,
    // ...
  ],
})
export class ApiModule {}
```

### Phase 4: Span Attribute 강화 (선택)

기본 span 이름(`ClassName.methodName`)에 더해, 주요 span에 비즈니스 컨텍스트 attribute를 추가할 수 있다.

```typescript
import { trace } from '@opentelemetry/api';

const activeSpan = trace.getActiveSpan();
activeSpan?.setAttributes({
  'custom.key': value,
});
```

## 디렉토리 구조 (추가분)

```
libs/
└── telemetry/
    ├── src/
    │   ├── initTelemetry.ts         # SDK 초기화 + shutdown (main.ts 최상단에서 호출)
    │   ├── TelemetryModule.ts       # AOP 모듈 (DiscoveryService + 메서드 wrapping) + graceful shutdown
    │   └── TraceableDecorator.ts    # @Traceable() 데코레이터
    └── tsconfig.lib.json

apps/api/src/
└── main.ts                          # initTelemetry() 최상단 호출
```

## 작업 순서

1. 패키지 설치 (`yarn add`)
2. Docker Compose에 Jaeger 추가 (로컬 개발용)
3. `libs/telemetry/` - SDK 초기화 + @Traceable 데코레이터 + AOP 모듈 구현
4. `main.ts` 최상단에 `initTelemetry()` 호출 추가
5. `ApiModule`에 `TelemetryModule` 등록
6. 대상 클래스에 `@Traceable()` 추가 (기존 `@Injectable()` 유지)
7. 로컬 실행 후 Jaeger UI에서 트레이스 확인

## 범위 밖 (향후)

- Metrics 수집 (Prometheus exporter)
- OTel Collector sidecar 전환
- 커스텀 span attribute 강화
- 로그와 trace 연결 (trace_id를 로그에 포함)
