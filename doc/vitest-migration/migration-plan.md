# Jest → Vitest 마이그레이션 플랜

## 현황 요약

| 항목 | 현재 상태 |
|---|---|
| 테스트 파일 | 56개 (`*.spec.ts`) |
| Jest 버전 | 29.3.1 + ts-jest 29.0.3 |
| 커스텀 매처 | `toBeBetween`, `toBeTrue`, `toBeFalse`, `toBeEmpty`, `toMatchValidateErrorInlineSnapshot` |
| 모킹 패턴 | `jest.fn()`, `jest.Mock`, `jest.Mocked<T>`, `jest-mock-extended` (1파일) |
| 경로 별칭 | 17개 `@app/*` 매핑 |
| 통합 테스트 | Redis 실제 연결, TypeORM + pg-mem |
| E2E 테스트 | supertest + `INestApplication` |

---

## Phase 1: 의존성 교체

### 제거할 패키지

- `jest`
- `ts-jest`
- `@types/jest`
- `jest-mock-extended`

### 설치할 패키지

- `vitest` — 테스트 러너 + 어설션 + 모킹 통합
- `unplugin-swc` + `@swc/core` — NestJS 데코레이터/DI를 위한 SWC 트랜스폼
- `@vitest/coverage-v8` — 코드 커버리지
- `vite-tsconfig-paths` — tsconfig.json의 paths를 자동으로 읽어 별칭 매핑

> `ts-jest` 대신 SWC를 사용하는 이유: Vitest는 Vite 기반이라 `ts-jest`를 쓸 수 없고,
> SWC가 NestJS 데코레이터를 올바르게 처리하면서 속도도 빠르다.

---

## Phase 2: 설정 파일 변환

### 2-1. `vitest.config.ts` 생성

- `package.json`의 Jest 설정 → `vitest.config.ts`로 이전
- `test.include`: `['**/*.spec.ts']`
- `test.root`: 프로젝트 루트
- `test.globals`: `true` (describe/it/expect import 없이 사용)
- `test.environment`: `'node'` (기본값)
- `test.setupFiles`: `['./vitest.setup.ts']`
- `plugins`: `[swc.default(), tsconfigPaths()]`

경로 별칭은 `vite-tsconfig-paths` 플러그인이 `tsconfig.json`의 `paths`를 자동으로 읽으므로 별도 매핑 불필요.

### 2-2. `package.json` 정리

Jest 설정 섹션 전체 삭제 후 스크립트 변환:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:cov": "vitest run --coverage",
  "test:ci": "vitest run --coverage",
  "test:debug": "vitest --inspect-brk --single-thread"
}
```

### 2-3. tsconfig 업데이트

- `compilerOptions.types`에서 `@types/jest` 제거
- `vitest/globals` 타입 참조 추가 (globals 모드 사용 시)

### 2-4. `.swcrc` 생성

```json
{
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "decorators": true
    },
    "transform": {
      "decoratorMetadata": true
    }
  }
}
```

---

## Phase 3: 글로벌 API 변환 (56개 파일)

Vitest는 Jest와 거의 호환되는 API를 제공하지만, 아래 항목은 변환이 필요하다.

| Jest | Vitest | 영향 범위 |
|---|---|---|
| `jest.fn()` | `vi.fn()` | 대부분의 테스트 파일 |
| `jest.Mock` | `Mock` (vitest import) | 타입 선언 |
| `jest.Mocked<T>` | `Mocked<T>` (vitest import) | 타입 선언 |
| `jest.spyOn()` | `vi.spyOn()` | 일부 파일 |
| `jest.useFakeTimers()` | `vi.useFakeTimers()` | 해당 시 |
| `jest.clearAllMocks()` | `vi.clearAllMocks()` | 해당 시 |
| `jest.fn().mockResolvedValue()` | `vi.fn().mockResolvedValue()` → 동일 API | 변경 없음 (fn만 교체) |
| `jest.fn().mockRejectedValue()` | `vi.fn().mockRejectedValue()` → 동일 API | 변경 없음 (fn만 교체) |

### 변환 방식

`globals: true` 설정으로 `describe`, `it`, `expect`, `beforeAll`, `beforeEach`, `afterAll` 등은 import 없이 그대로 사용 가능.

`vi` 객체는 globals에 포함되므로 별도 import 불필요.

일괄 치환 대상:
- `jest.fn(` → `vi.fn(`
- `jest.spyOn(` → `vi.spyOn(`
- `jest.Mock` → Vitest의 `Mock` 타입
- `jest.Mocked<` → Vitest의 `Mocked<`
- `jest.clearAllMocks()` → `vi.clearAllMocks()`
- `jest.resetAllMocks()` → `vi.resetAllMocks()`

---

## Phase 4: 커스텀 매처 변환

### 4-1. `jest.setupAfterEnv.ts` → `vitest.setup.ts`

`expect.extend()` API는 Vitest에서도 동일하게 동작하므로 매처 구현 로직은 변경 불필요.

```typescript
// vitest.setup.ts
import { expect } from 'vitest'

expect.extend({
  toBeBetween(received, min, max) { /* 기존 로직 동일 */ },
  toBeTrue(received) { /* 기존 로직 동일 */ },
  toBeFalse(received) { /* 기존 로직 동일 */ },
  toBeEmpty(received) { /* 기존 로직 동일 */ },
  toMatchValidateErrorInlineSnapshot(received, property, snapshot) { /* 확인 필요 */ },
})
```

### 4-2. `jest.d.ts` → 타입 선언 변환

```typescript
// before (Jest)
declare namespace jest {
  interface Matchers<R> {
    toBeBetween(min: number, max: number): R
    toBeTrue(): R
    toBeFalse(): R
    toBeEmpty(): R
  }
}

// after (Vitest)
import 'vitest'

declare module 'vitest' {
  interface CustomMatchers<R = unknown> {
    toBeBetween(min: number, max: number): R
    toBeTrue(): R
    toBeFalse(): R
    toBeEmpty(): R
  }
}
```

---

## Phase 5: jest-mock-extended 대체

현재 1개 파일에서만 `mock<T>()` 패턴을 사용 중.

### 선택지

1. **`vitest-mock-extended` 패키지 사용** — drop-in 대체, import만 변경
2. **수동 변환** — `vi.fn()` + 타입 캐스팅으로 교체

파일이 1개이므로 수동 변환 권장.

---

## Phase 6: 통합/E2E 테스트 검증

### Redis 통합 테스트 순차 실행

Jest의 `--runInBand`에 대응하는 Vitest 설정:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
})
```

또는 CLI에서: `vitest run --pool=forks --poolOptions.forks.singleFork`

### NestJS Testing 모듈

`@nestjs/testing`의 `Test.createTestingModule()`은 프레임워크 무관하므로 변경 불필요.

### supertest

Jest/Vitest에 의존하지 않으므로 변경 불필요.

### nock

Vitest 환경에서도 정상 동작. 호환성 이슈 없음.

---

## Phase 7: Coverage 설정

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
})
```

---

## 주의사항

1. **인라인 스냅샷**: `toMatchValidateErrorInlineSnapshot` 커스텀 매처가 내부적으로 `toMatchInlineSnapshot`을 호출한다면, Vitest의 스냅샷 포맷과 호환되는지 확인 필요
2. **SWC 데코레이터**: `.swcrc`에 `decorators: true`, `decoratorMetadata: true` 필수
3. **순차 실행**: Redis 통합 테스트는 반드시 `singleFork` 모드로 실행하여 flushDatabase 충돌 방지
4. **E2E 설정**: 별도 `vitest.config.e2e.ts`가 필요할 수 있음 (현재 Jest에서 별도 `jest-e2e.json` 사용 중)

---

## 권장 실행 순서

| 순서 | 작업 | 검증 |
|---|---|---|
| 1 | Phase 1-2: 의존성 교체 + 설정 파일 세팅 | 단일 테스트 파일 1개 통과 확인 |
| 2 | Phase 4: 커스텀 매처 변환 | 매처 사용하는 테스트 통과 확인 |
| 3 | Phase 3: `jest.*` → `vi.*` 일괄 치환 | 전체 단위 테스트 통과 확인 |
| 4 | Phase 5: jest-mock-extended 대체 | 해당 파일 테스트 통과 확인 |
| 5 | Phase 6: 통합/E2E 테스트 검증 | Redis 통합 테스트 순차 실행 확인 |
| 6 | Phase 7: Coverage 설정 | 커버리지 리포트 생성 확인 |
| 7 | Phase 8: Jest 잔존물 제거 | `jest` 키워드가 프로젝트에 남아있지 않음을 확인 |

---

## Phase 8: Jest 잔존물 제거

전체 테스트가 Vitest로 성공적으로 통과한 후, Jest 관련 코드와 의존성을 완전히 제거한다.

### 8-1. devDependencies 제거

`package.json`에서 아래 패키지를 삭제한다:

```bash
npm uninstall jest ts-jest @types/jest jest-mock-extended
```

### 8-2. 설정 파일 삭제

| 파일 | 설명 |
|---|---|
| `jest.setupAfterEnv.ts` | vitest.setup.ts로 대체 완료 후 삭제 |
| `jest.d.ts` | Vitest 타입 선언으로 대체 완료 후 삭제 |
| `apps/nestjs-playground/test/jest-e2e.json` | E2E 설정 (존재 시 삭제) |

### 8-3. `package.json` Jest 설정 섹션 삭제

`package.json` 내 `"jest": { ... }` 블록 전체를 삭제한다 (Phase 2에서 이미 처리되었을 수 있으나 최종 확인).

### 8-4. 코드 내 잔존 참조 확인

프로젝트 전체에서 Jest 관련 키워드가 남아있지 않은지 검색한다:

```bash
# 아래 검색 결과가 모두 0건이어야 한다
grep -r "jest" --include="*.ts" --include="*.json" .
grep -r "@types/jest" .
grep -r "ts-jest" .
grep -r "jest-mock-extended" .
```

확인 대상:
- `tsconfig.json` / `tsconfig.*.json`의 `types` 배열에 `jest` 또는 `@types/jest` 참조
- 소스 코드 내 `from 'jest'` 또는 `from '@jest/'` import
- `.eslintrc` 등 lint 설정 내 Jest 관련 환경/플러그인 (`env: { jest: true }`)

### 8-5. 최종 검증

```bash
# 1. 전체 테스트 실행
npm test

# 2. 커버리지 리포트 생성
npm run test:cov

# 3. node_modules에 jest 패키지가 남아있지 않은지 확인
ls node_modules | grep jest
```

세 단계 모두 통과하면 마이그레이션 완료.
