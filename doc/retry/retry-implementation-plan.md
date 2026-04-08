# WebClient Retry 구현 플랜

## 배경

Spring Framework 7.0의 core retry API(`RetryTemplate`, `RetryPolicy`)에서 영감을 받아,
`@app/web-client` 모듈에 retry 기능을 추가한다.

## 현재 구조

```
libs/web-client/src/
├── WebClient.ts                    # 인터페이스 (get/post/put/patch/delete/url/header/accept/body/timeout/retrieve)
├── FetchClient.ts                  # native fetch 구현체
├── GotClient.ts                    # got 라이브러리 구현체
├── WebClientModule.ts              # NestJS 모듈
├── creator/
│   ├── WebClientService.ts         # abstract create() 팩토리
│   └── GotClientService.ts         # GotClient 생성 서비스
└── http/
    ├── MediaType.ts                # Content-Type enum
    ├── ResponseSpec.ts             # 응답 래퍼 (statusCode, body, toEntity)
    ├── UrlBuilder.ts               # URL + queryParam 빌더
    └── BodyInserter.ts             # 요청 바디 래퍼 (JSON, Form, Text)
```

## 설계 방향

`WebClient` 인터페이스에 `retry(policy)` 메서드를 추가하고,
각 구현체(`FetchClient`, `GotClient`)의 `retrieve()` 내부에서 공통 `RetryExecutor`를 사용한다.

### 사용 이미지

```typescript
const policy = RetryPolicy.builder()
  .maxRetries(3)
  .delay(100)
  .jitter(10)
  .multiplier(2)
  .maxDelay(5000)
  .build();

const response = await client.get().url('/api/users').retry(policy).retrieve();
```

## 변경 후 구조

```
libs/web-client/src/
├── WebClient.ts                    # [수정] retry(policy) 메서드 추가
├── FetchClient.ts                  # [수정] retry() 구현, retrieve()에서 RetryExecutor 사용
├── GotClient.ts                    # [수정] 동일
├── retry/
│   ├── RetryPolicy.ts              # [신규] retry 설정 객체 + Builder API
│   └── RetryExecutor.ts            # [신규] 공통 retry 실행 엔진
└── ...기존 파일 변경 없음
```

## 구현 상세

### Step 1: RetryPolicy — retry 설정 객체

**파일:** `libs/web-client/src/retry/RetryPolicy.ts`

Spring 7의 `RetryPolicy.builder()` 패턴을 따른다.

```typescript
export class RetryPolicy {
  readonly maxRetries: number; // 최대 재시도 횟수 (기본: 3)
  readonly delay: number; // 초기 지연 ms (기본: 1000)
  readonly jitter: number; // 랜덤 지연 ms (기본: 0)
  readonly multiplier: number; // 지수 배수 (기본: 0, 0이면 fixed delay)
  readonly maxDelay: number; // 최대 지연 ms (기본: 0, 0이면 제한 없음)

  static builder(): RetryPolicyBuilder;
  static withDefaults(): RetryPolicy;
  static withMaxRetries(maxRetries: number): RetryPolicy;
}
```

**Builder API:**

```typescript
class RetryPolicyBuilder {
  maxRetries(value: number): this;
  delay(value: number): this;
  jitter(value: number): this;
  multiplier(value: number): this;
  maxDelay(value: number): this;
  build(): RetryPolicy;
}
```

**설계 포인트:**

- `RetryPolicy`는 immutable 객체 — 생성 후 변경 불가
- Builder에서만 값을 설정하고, `build()` 시 검증 수행
- 검증: `maxRetries >= 0`, `delay >= 0`, `jitter >= 0`, `multiplier >= 0`, `maxDelay >= 0`

---

### Step 2: RetryExecutor — 공통 retry 실행 엔진

**파일:** `libs/web-client/src/retry/RetryExecutor.ts`

```typescript
export class RetryExecutor {
  static async execute<T>(
    action: () => Promise<T>,
    policy: RetryPolicy,
  ): Promise<T>;
}
```

**retry 루프 로직:**

```
1. action() 실행
2. 성공 → 결과 반환
3. 실패 → 재시도 횟수 확인
   a. 남은 재시도 없음 → 마지막 에러 throw
   b. 남은 재시도 있음 → delay 계산 → 대기 → 1로 돌아감
```

**delay 계산 공식:**

```
currentDelay = delay * (multiplier ^ retryCount)    // multiplier가 0이면 fixed delay
actualDelay  = currentDelay + random(0, jitter)      // jitter 추가
finalDelay   = min(actualDelay, maxDelay)             // maxDelay가 0이면 제한 없음
```

**설계 포인트:**

- 순수 함수형 static 메서드 — 상태 없음
- `action`은 `() => Promise<T>` 타입으로 어떤 비동기 작업이든 래핑 가능
- sleep은 `new Promise(resolve => setTimeout(resolve, ms))`로 구현

---

### Step 3: WebClient 인터페이스 수정

**파일:** `libs/web-client/src/WebClient.ts`

```typescript
import { RetryPolicy } from '@app/web-client/retry/RetryPolicy';

export interface WebClient {
  // ...기존 메서드 유지
  retry(policy: RetryPolicy): this; // 추가
  retrieve(): Promise<ResponseSpec>;
}
```

---

### Step 4: FetchClient 수정

**파일:** `libs/web-client/src/FetchClient.ts`

변경사항:

1. `#retryPolicy: RetryPolicy | null` 필드 추가
2. `retry(policy)` 메서드 구현 — policy 저장 후 `this` 반환
3. `retrieve()` 수정 — retryPolicy가 있으면 `RetryExecutor.execute()`로 위임

```typescript
retry(policy: RetryPolicy): this {
  this.#retryPolicy = policy;
  return this;
}

async retrieve(): Promise<ResponseSpec> {
  const action = () => this.doFetch();

  if (this.#retryPolicy) {
    return RetryExecutor.execute(action, this.#retryPolicy);
  }
  return action();
}

// 기존 retrieve() 로직을 private 메서드로 추출
private async doFetch(): Promise<ResponseSpec> {
  // 기존 fetch 로직 그대로
}
```

---

### Step 5: GotClient 수정

**파일:** `libs/web-client/src/GotClient.ts`

FetchClient와 동일한 패턴. got의 내장 retry는 사용하지 않고 `RetryExecutor`로 통일한다.
(이유: 두 구현체 간 retry 동작 일관성 보장)

```typescript
retry(policy: RetryPolicy): this {
  this.#retryPolicy = policy;
  return this;
}

async retrieve(): Promise<ResponseSpec> {
  const action = () => this.doRequest();

  if (this.#retryPolicy) {
    return RetryExecutor.execute(action, this.#retryPolicy);
  }
  return action();
}

private async doRequest(): Promise<ResponseSpec> {
  // 기존 got 호출 로직 그대로
}
```

---

### Step 6: StubWebClient 수정

**파일:** `libs/web-client/test/StubWebClient.ts`

테스트용 스텁에도 `retry()` 메서드 추가. policy를 저장만 하고 retrieve() 동작은 기존과 동일.
(StubWebClient는 실제 HTTP 호출을 하지 않으므로 retry 루프 불필요)

```typescript
retryPolicy: RetryPolicy | null = null;

retry(policy: RetryPolicy): this {
  this.retryPolicy = policy;
  return this;
}
```

`clear()` 메서드에 `this.retryPolicy = null` 추가.

---

### Step 7: 테스트 작성

#### 7-1. RetryPolicy 단위 테스트

**파일:** `libs/web-client/test/retry/RetryPolicy.spec.ts`

| 테스트 케이스                | 설명                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `withDefaults()` 기본값 검증 | maxRetries=3, delay=1000, jitter=0, multiplier=0, maxDelay=0 |
| Builder로 전체 설정          | 모든 필드가 정확히 설정되는지                                |
| `withMaxRetries(n)`          | maxRetries만 변경, 나머지 기본값                             |
| 잘못된 값 검증               | 음수 값 입력 시 에러                                         |

#### 7-2. RetryExecutor 단위 테스트

**파일:** `libs/web-client/test/retry/RetryExecutor.spec.ts`

| 테스트 케이스            | 설명                                 |
| ------------------------ | ------------------------------------ |
| 첫 시도 성공             | retry 없이 즉시 반환                 |
| n번 실패 후 성공         | 재시도 후 성공 시 결과 반환          |
| 모든 재시도 소진         | maxRetries 초과 시 마지막 에러 throw |
| fixed delay 검증         | multiplier=0일 때 매번 같은 delay    |
| exponential backoff 검증 | multiplier>0일 때 지수 증가          |
| maxDelay 상한 검증       | delay가 maxDelay를 넘지 않는지       |
| jitter 범위 검증         | jitter 추가 시 delay 범위 확인       |

#### 7-3. FetchClient/GotClient retry 통합 테스트

**파일:** 기존 `FetchClient.spec.ts`, `GotClient.spec.ts`에 테스트 케이스 추가

| 테스트 케이스             | 설명                                   |
| ------------------------- | -------------------------------------- |
| retry 없이 기존 동작 유지 | 기존 테스트 깨지지 않음                |
| retry 설정 후 실패→성공   | 첫 요청 실패, 재시도 성공 시 정상 응답 |
| retry 모두 소진 시 에러   | 모든 재시도 실패 시 에러 throw         |

## 구현 순서

```
Step 1: RetryPolicy        → 의존성 없음, 독립 구현 가능
Step 2: RetryExecutor       → RetryPolicy에만 의존
Step 3: WebClient 인터페이스 → RetryPolicy import만 추가
Step 4: FetchClient 수정    → Step 1~3 완료 후
Step 5: GotClient 수정      → Step 1~3 완료 후 (Step 4와 병렬 가능)
Step 6: StubWebClient 수정  → Step 3 완료 후
Step 7: 테스트 작성          → 각 Step 완료 후 순차 작성
```
