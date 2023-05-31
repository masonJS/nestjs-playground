import { SwaggerGenerator } from './SwaggerGenerator';

describe('SwaggerGenerator', () => {
  describe('addApiPropertyToResponse', () => {
    it('이미 ApiProperty를 import하고 있으면 무시한다.', () => {
      // given
      const content = `
import { ApiProperty } from '@nestjs/swagger';

@ResponseDto()
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
        "import { ApiProperty } from '@nestjs/swagger';

        @ResponseDto()
        export class UserResponse {
          @ApiProperty({ type: String })
            get name(): string {
            return 'name';
          }
        }"
      `);
    });

    it('private 접근 제어자를 가진 getter는 무시한다.', () => {
      // given
      const content = `
@ResponseDto()
export class UserResponse {
  private get name(): string {
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

        @ResponseDto()
        export class UserResponse {
          private get name(): string {
            return 'name';
          }
        }"
      `);
    });

    it('ApiProperty 데코레이터가 getter 프로퍼티에 있으면 무시한다.', () => {
      // given
      const content = `
@ResponseDto()
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

        @ResponseDto()
        export class UserResponse {
          @ApiProperty()
          get name(): string {
            return 'name';
          }
        }"
      `);
    });

    it('getter 프로퍼티에 ApiProperty 데코레이터를 붙여준다.', () => {
      // given
      const content = `
@ResponseDto()
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

        @ResponseDto()
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
@ResponseDto()
export class UserResponse {
  get name(): string | undefined {
    return 'name';
  }
  get email(): string[]  {
    return ['email'];
  }
}`;
      const generator = new SwaggerGenerator('response.ts', content);

      // when
      generator.addApiPropertyToResponse();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiProperty } from "@nestjs/swagger";

        @ResponseDto()
        export class UserResponse {
          @ApiProperty({ type: String, required: false })
            get name(): string | undefined {
            return 'name';
          }
          @ApiProperty({ type: [String] })
            get email(): string[]  {
            return ['email'];
          }
        }"
      `);
    });

    it('리턴 타입을 명시하지 않은 경우 타입 추론을 한다', () => {
      // given
      const content = `
@ResponseDto()
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

        @ResponseDto()
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
@ResponseDto()
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

        @ResponseDto()
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
@ResponseDto()
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

        @ResponseDto()
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
@ResponseDto()
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

        @ResponseDto()
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
  });

  describe('addApiPropertyToRequest', () => {
    it('이미 ApiProperty를 import하고 있으면 무시한다.', () => {
      // given
      const content = `
import { ApiProperty } from '@nestjs/swagger';

@RequestDto()
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

        @RequestDto()
        export class UserRequest {
          @ApiProperty({ deprecated: true })
          name: string;
        }"
      `);
    });

    it('private 접근 제어자를 가진 프로퍼티는 무시한다.', () => {
      // given
      const content = `
@RequestDto()
export class UserRequest {
  private name: string;
}`;
      const generator = new SwaggerGenerator('request.ts', content);

      // when
      generator.addApiPropertyToRequest();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiProperty } from "@nestjs/swagger";

        @RequestDto()
        export class UserRequest {
          private name: string;
        }"
      `);
    });

    it('프로퍼티에 ApiProperty 데코레이터를 붙여준다.', () => {
      // given
      const content = `
@RequestDto()
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

        @RequestDto()
        export class UserRequest {
          @ApiProperty({ type: String })
            name: string;
        }"
      `);
    });
  });

  describe('addSwaggerToApi', () => {
    it('ApiOperation 이 이미 존재하면 무시한다.', () => {
      const content = `
import { ApiOperation } from "@nestjs/swagger";

export class UserController {
  @ApiOperation({ description: '설명' })
  save(): UserResponse {
    return new UserResponse();
  }
}

class UserResponse {}
`;
      const generator = new SwaggerGenerator('controller.ts', content);

      // when
      generator.addSwaggerToApi();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiOperation } from "@nestjs/swagger";
        import { ApiOkResponseBy } from "@app/web-common/res/swagger/ApiOkResponseBy";

        export class UserController {
          @ApiOperation({ description: '설명' })
            @ApiOkResponseBy(UserResponse)
          save(): UserResponse {
            return new UserResponse();
          }
        }

        class UserResponse {}
        "
      `);
    });

    it('ApiOkResponseBy가 이미 존재하면 무시한다.', () => {
      const content = `
import { ApiOkResponseBy } from '@app/web-common/res/swagger/ApiOkResponseBy';

export class UserController {
  @ApiOkResponseBy(UserResponse)
  save(): UserResponse {
    return new UserResponse();
  }
}

class UserResponse {}
`;
      const generator = new SwaggerGenerator('controller.ts', content);

      // when
      generator.addSwaggerToApi();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiOkResponseBy } from '@app/web-common/res/swagger/ApiOkResponseBy';
        import { ApiOperation } from "@nestjs/swagger";

        export class UserController {
          @ApiOkResponseBy(UserResponse)
            @ApiOperation({ summary: '' })
          save(): UserResponse {
            return new UserResponse();
          }
        }

        class UserResponse {}
        "
      `);
    });

    it('응답 타입이 배열이면 ApiOkArrayResponseBy 데코레이터를 생성한다.', () => {
      const content = `
export class UserController {
  save() {
    const response = new UserResponse();
    return [response];
  }
}

class UserResponse {}
`;
      const generator = new SwaggerGenerator('controller.ts', content);

      // when
      generator.addSwaggerToApi();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiOperation } from "@nestjs/swagger";
        import { ApiOkArrayResponseBy } from "@app/web-common/res/swagger/ApiOkResponseBy";

        export class UserController {
          @ApiOperation({ summary: '' })
            @ApiOkArrayResponseBy(UserResponse)
            save() {
            const response = new UserResponse();
            return [response];
          }
        }

        class UserResponse {}
        "
      `);
    });

    it('응답 타입이 Page 인스턴스 타입이면 ApiPaginateResponse 데코레이터를 생성한다.', () => {
      const content = `
export class UserController {
  save() {
   return new Page<UserResponse>();
  }
}

class Page<T> {}

class UserResponse {}
`;
      const generator = new SwaggerGenerator('controller.ts', content);

      // when
      generator.addSwaggerToApi();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiOperation } from "@nestjs/swagger";
        import { ApiPaginateResponse } from "@app/web-common/res/swagger/ApiOkResponseBy";

        export class UserController {
          @ApiOperation({ summary: '' })
            @ApiPaginateResponse(UserResponse)
            save() {
           return new Page<UserResponse>();
          }
        }

        class Page<T> {}

        class UserResponse {}
        "
      `);
    });

    it('응답 타입이 일반 인스턴스 타입이면 ApiOkResponseBy 데코레이터를 생성한다.', () => {
      const content = `
export class UserController {
  save() {
    return new UserResponse();
  }
}

class UserResponse {}
`;
      const generator = new SwaggerGenerator('controller.ts', content);

      // when
      generator.addSwaggerToApi();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiOperation } from "@nestjs/swagger";
        import { ApiOkResponseBy } from "@app/web-common/res/swagger/ApiOkResponseBy";

        export class UserController {
          @ApiOperation({ summary: '' })
            @ApiOkResponseBy(UserResponse)
            save() {
            return new UserResponse();
          }
        }

        class UserResponse {}
        "
      `);
    });

    it('응답 타입이 ResponseEntity<String> 타입이면 ApiOkResponseBy 데코레이터를 생성한다.', () => {
      const content = `
export class UserController {
  async save(): Promise<ResponseEntity<string>> {
    return ResponseEntity.OK();
  }
}

export class ResponseEntity<T> {
   static OK(): ResponseEntity<string> {
    return new ResponseEntity<string>(ResponseStatus.OK, '', '');
  }
}
`;
      const generator = new SwaggerGenerator('controller.ts', content);

      // when
      generator.addSwaggerToApi();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiOperation } from "@nestjs/swagger";
        import { ApiResponse } from "@nestjs/swagger";

        export class UserController {
          @ApiOperation({ summary: '' })
            @ApiResponse({ type: ResponseEntity })
            async save(): Promise<ResponseEntity<string>> {
            return ResponseEntity.OK();
          }
        }

        export class ResponseEntity<T> {
           @ApiOperation({ summary: '' })
            @ApiResponse({ type: ResponseEntity })
            static OK(): ResponseEntity<string> {
            return new ResponseEntity<string>(ResponseStatus.OK, '', '');
          }
        }
        "
      `);
    });

    it('응답 타입이 Promise<U<T>> 타입이면 T 타입을 반환한다.', () => {
      const content = `
export class UserController {
  async save(): Promise<ResponseEntity<UserResponse>> {
    return new ResponseEntity<UserResponse>();
  }
}

class UserResponse {}

class ResponseEntity<T> {}

`;
      const generator = new SwaggerGenerator('controller.ts', content);

      // when
      generator.addSwaggerToApi();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiOperation } from "@nestjs/swagger";
        import { ApiOkResponseBy } from "@app/web-common/res/swagger/ApiOkResponseBy";

        export class UserController {
          @ApiOperation({ summary: '' })
            @ApiOkResponseBy(UserResponse)
            async save(): Promise<ResponseEntity<UserResponse>> {
            return new ResponseEntity<UserResponse>();
          }
        }

        class UserResponse {}

        class ResponseEntity<T> {}

        "
      `);
    });

    it('응답 타입이 Promise<R<U<T>>>> 타입이면 T 타입을 반환한다.', () => {
      const content = `
export class UserController {
  async save(): Promise<ResponseEntity<Page<UserResponse>>> {
    const response = [new UserResponse()];
    
    return new Page<UserResponse>(response);
  }
}

class UserResponse {}

class ResponseEntity<T> {}

class Page<T> {
  items: T[];
  constructor(items: T[]) {
    this.items = items;
   }
}
`;
      const generator = new SwaggerGenerator('controller.ts', content);

      // when
      generator.addSwaggerToApi();

      // then
      const text = generator.text()[0];
      expect(text).toMatchInlineSnapshot(`
        "import { ApiOperation } from "@nestjs/swagger";
        import { ApiPaginateResponse } from "@app/web-common/res/swagger/ApiOkResponseBy";

        export class UserController {
          @ApiOperation({ summary: '' })
            @ApiPaginateResponse(UserResponse)
            async save(): Promise<ResponseEntity<Page<UserResponse>>> {
            const response = [new UserResponse()];
            
            return new Page<UserResponse>(response);
          }
        }

        class UserResponse {}

        class ResponseEntity<T> {}

        class Page<T> {
          items: T[];
          constructor(items: T[]) {
            this.items = items;
           }
        }
        "
      `);
    });
  });
});
