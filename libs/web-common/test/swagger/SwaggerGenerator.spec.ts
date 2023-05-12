import { SwaggerGenerator } from './SwaggerGenerator';
import * as path from 'path';

describe('SwaggerGenerator', () => {
  describe('addApiPropertyToResponse', () => {
    it('이미 ApiProperty를 import하고 있으면 무시한다.', () => {
      // given
      const content = `
import { ApiProperty } from '@nestjs/swagger';

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
              "import { ApiProperty } from '@nestjs/swagger';

              export class UserResponse {
                @ApiProperty()
                get name(): string {
                  return 'name';
                }
              }"
          `);
    });

    it('ApiProperty 데코레이터가 getter 프로퍼티에 있으면 데코레이터를 무시한다.', () => {
      // given
      const content = `
export class UserResponse {
  @ApiProperty({ deprecated: true })
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
          @ApiProperty({ deprecated: true })
          get name(): string {
            return 'name';
          }
        }"
      `);
    });

    it('getter 프로퍼티에 ApiProperty 데코레이터를 붙여준다.', () => {
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
          @ApiProperty({ type: String })
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
          @ApiProperty({ type: String, required: false })
            get name(): string | undefined {
            return 'name';
          }
          @ApiProperty({ type: [String], required: false })
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
          
          @ApiProperty({ type: String, required: false })
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
          
          @ApiProperty({ type: [String] })
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
    return ClassA;
  }
}
class ClassA {}
`;
      // when
      const generator = new SwaggerGenerator('response.ts', content);

      // when
      generator.addApiPropertyToResponse();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiProperty } from "@nestjs/swagger";

        export class UserResponse {
          
          @ApiProperty({ type: ClassA })
            get prop(): ClassA {
            return ClassA;
          }
        }
        class ClassA {}
        "
      `);
    });

    it('리턴 타입이 enum인 경우 enum 속성에 할당된다.', () => {
      // given

      const content = `
export class UserResponse {
  
  get prop(): UserStatus {
    return UserStatus.ACTIVE;
  }
}
enum UserStatus {
  ACTIVE = 'active',
} 
`;
      // when
      const generator = new SwaggerGenerator('response.ts', content);

      // when
      generator.addApiPropertyToResponse();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiProperty } from "@nestjs/swagger";

        export class UserResponse {
          
          @ApiProperty({ enum: UserStatus })
            get prop(): UserStatus {
            return UserStatus.ACTIVE;
          }
        }
        enum UserStatus {
          ACTIVE = 'active',
        } 
        "
      `);
    });

    it('import 되어지는 클래스, enum 타입을 추론한다.', () => {
      const generator = new SwaggerGenerator(
        path.join(__dirname, './UserResponse.ts'),
      );

      // when
      generator.addApiPropertyToResponse();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`undefined`);
    });
  });

  describe('addApiPropertyToRequest', () => {
    it('이미 ApiProperty를 import하고 있으면 무시한다.', () => {
      // given
      const content = `
import { ApiProperty } from '@nestjs/swagger';

export class UserRequest {
  @ApiProperty({ deprecated: true })
  name: string;
}`;
      const generator = new SwaggerGenerator('request.ts', content);

      // when
      generator.addApiPropertyToRequest();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiProperty } from '@nestjs/swagger';

        export class UserRequest {
          @ApiProperty({ deprecated: true })
          name: string;
        }"
      `);
    });

    it('프로퍼티에 ApiProperty 데코레이터를 붙여준다.', () => {
      // given
      const content = `
export class UserRequest {
  name: string;
}`;
      const generator = new SwaggerGenerator('request.ts', content);

      // when
      generator.addApiPropertyToRequest();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiProperty } from "@nestjs/swagger";

        export class UserRequest {
          @ApiProperty({ type: String })
            name: string;
        }"
      `);
    });
  });
});
