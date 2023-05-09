import { SwaggerGenerator } from './SwaggerGenerator';

describe('SwaggerGenerator', () => {
  it('ApiProperty 데코레이터가 getter 프로퍼티에 있으면 무시한다.', () => {
    // given
    const content = `
export class UserResponse {
  @ApiProperty()
  get name(): string {
    return 'name';
  }
}`;
    const generator = new SwaggerGenerator('response.ts', content);

    // when
    generator.addApiPropertyToResponse();

    // then
    const text = generator.text()[0];
    expect(text).toMatchInlineSnapshot(`
      "import { ApiProperty } from "@nestjs/swagger";

      export class UserResponse {
        @ApiProperty()
        get name(): string {
          return 'name';
        }
      }"
    `);
  });

  it('ApiProperty 데코레이터가 getter 프로퍼티에 있으면 데코레이터를 붙여준다.', () => {
    // given
    const content = `
export class UserResponse {
  get name(): string {
    return 'name';
  }
}`;
    const generator = new SwaggerGenerator('response.ts', content);

    // when
    generator.addApiPropertyToResponse();

    // then
    const text = generator.text()[0];
    expect(text).toMatchInlineSnapshot(`
      "import { ApiProperty } from "@nestjs/swagger";

      export class UserResponse {
        @ApiProperty({ type: string, required: true   })
          get name(): string {
          return 'name';
        }
      }"
    `);
  });

  it('리턴 타입이 null 또는 undefined인 경우 required 속성값을 false로 반환한다.', () => {
    // given
    const content = `
export class UserResponse {
  get name(): string | undefined {
    return 'name';
  }
  get email(): string | string[] | null {
    return 'email';
  }
}`;
    const generator = new SwaggerGenerator('response.ts', content);

    // when
    generator.addApiPropertyToResponse();

    // then
    const text = generator.text()[0];
    expect(text).toMatchInlineSnapshot(`
      "import { ApiProperty } from "@nestjs/swagger";

      export class UserResponse {
        @ApiProperty({ type: string | undefined, required: false   })
          get name(): string | undefined {
          return 'name';
        }
        @ApiProperty({ type: string | string[] | null, required: false   })
          get email(): string | string[] | null {
          return 'email';
        }
      }"
    `);
  });

  it('리턴 타입을 명시하지 않은 경우 타입 추론을 한다', () => {
    // given
    const content = `
export class UserResponse {
  #prop?: string;
  
  get prop() {
    return this.#prop;
  }
}`;
    const generator = new SwaggerGenerator('response.ts', content);

    // when
    generator.addApiPropertyToResponse();

    // then
    const text = generator.text()[0];
    expect(text).toMatchInlineSnapshot(`
      "import { ApiProperty } from "@nestjs/swagger";

      export class UserResponse {
        #prop?: string;
        
        @ApiProperty({ type: string | undefined, required: false   })
          get prop() {
          return this.#prop;
        }
      }"
    `);
  });

  it('리턴 타입이 배열인 경우 타입 추론을 한다.', () => {
    // given

    const content = `
export class UserResponse {
  
  get prop() {
    return ['a', 'b'];
  }
}`;
    // when
    const generator = new SwaggerGenerator('response.ts', content);

    // when
    generator.addApiPropertyToResponse();

    // then
    const text = generator.text()[0];
    expect(text).toMatchInlineSnapshot(`
      "import { ApiProperty } from "@nestjs/swagger";

      export class UserResponse {
        
        @ApiProperty({ type: string, required: true , isArray: true  })
          get prop() {
          return ['a', 'b'];
        }
      }"
    `);
  });

  it('리턴 타입이 클래스인 경우 타입 추론을 한다.', () => {
    // given

    const content = `
export class UserResponse {
  
  get prop(): ClassA {
    return 'a';
  }
}`;
    // when
    const generator = new SwaggerGenerator('response.ts', content);

    // when
    generator.addApiPropertyToResponse();

    // then
    const text = generator.text()[0];
    expect(text).toMatchInlineSnapshot(`
      "import { ApiProperty } from "@nestjs/swagger";

      export class UserResponse {
        
        @ApiProperty({ type: ClassA, required: true   })
          get prop(): ClassA {
          return 'a';
        }
      }"
    `);
  });
});
