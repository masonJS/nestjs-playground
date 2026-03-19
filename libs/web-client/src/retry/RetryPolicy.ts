const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DELAY = 1000;
const DEFAULT_JITTER = 0;
const DEFAULT_MULTIPLIER = 0;
const DEFAULT_MAX_DELAY = 0;

interface RetryPolicyOptions {
  maxRetries: number;
  delay: number;
  jitter: number;
  multiplier: number;
  maxDelay: number;
}

export class RetryPolicy {
  readonly maxRetries: number;
  readonly delay: number;
  readonly jitter: number;
  readonly multiplier: number;
  readonly maxDelay: number;

  constructor(options: RetryPolicyOptions) {
    this.maxRetries = options.maxRetries;
    this.delay = options.delay;
    this.jitter = options.jitter;
    this.multiplier = options.multiplier;
    this.maxDelay = options.maxDelay;
  }

  static builder(): RetryPolicyBuilder {
    return new RetryPolicyBuilder();
  }

  static withDefaults(): RetryPolicy {
    return new RetryPolicy({
      maxRetries: DEFAULT_MAX_RETRIES,
      delay: DEFAULT_DELAY,
      jitter: DEFAULT_JITTER,
      multiplier: DEFAULT_MULTIPLIER,
      maxDelay: DEFAULT_MAX_DELAY,
    });
  }

  static withMaxRetries(maxRetries: number): RetryPolicy {
    return RetryPolicy.builder().maxRetries(maxRetries).build();
  }
}

class RetryPolicyBuilder {
  #maxRetries = DEFAULT_MAX_RETRIES;
  #delay = DEFAULT_DELAY;
  #jitter = DEFAULT_JITTER;
  #multiplier = DEFAULT_MULTIPLIER;
  #maxDelay = DEFAULT_MAX_DELAY;

  maxRetries(value: number): this {
    this.#maxRetries = value;

    return this;
  }

  delay(value: number): this {
    this.#delay = value;

    return this;
  }

  jitter(value: number): this {
    this.#jitter = value;

    return this;
  }

  multiplier(value: number): this {
    this.#multiplier = value;

    return this;
  }

  maxDelay(value: number): this {
    this.#maxDelay = value;

    return this;
  }

  build(): RetryPolicy {
    this.validate();

    return new RetryPolicy({
      maxRetries: this.#maxRetries,
      delay: this.#delay,
      jitter: this.#jitter,
      multiplier: this.#multiplier,
      maxDelay: this.#maxDelay,
    });
  }

  private validate(): void {
    if (this.#maxRetries < 0) {
      throw new Error('maxRetries must be >= 0');
    }

    if (this.#delay < 0) {
      throw new Error('delay must be >= 0');
    }

    if (this.#jitter < 0) {
      throw new Error('jitter must be >= 0');
    }

    if (this.#multiplier < 0) {
      throw new Error('multiplier must be >= 0');
    }

    if (this.#maxDelay < 0) {
      throw new Error('maxDelay must be >= 0');
    }
  }
}
