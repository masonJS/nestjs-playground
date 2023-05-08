import { SwaggerGenerator } from './SwaggerGenerator';

describe('SwaggerGenerator', () => {
  it('getter 접근자에 @ApiProperty 데코레이터를 추가한다,', () => {
    // given
    const sourceFileText = `
    class BuyerCreateRequest {
      id: number;
      
      get name(): string | undefined {
        return 'name';
      }
    
      get email(): string {
        return 'email';
      }
    }
    `;
    const swaggerGenerator = new SwaggerGenerator('path', sourceFileText);

    // when
    const sourceFiles = swaggerGenerator.addApiPropertyToResponse();

    // then
    expect(sourceFiles[0].getText()).toMatchInlineSnapshot(`
      "class BuyerCreateRequest {
            id: number;
            
            @ApiProperty()
              get name(): string | undefined {
              return 'name';
            }
          
            @ApiProperty()
              get email(): string {
              return 'email';
            }
          }
          "
    `);
  });

  it('XXResponse 클래스의 getter 접근자에  @ApiProperty 데코레이터를 추가한다,', () => {
    // given
    const swaggerGenerator = new SwaggerGenerator('apps/**/*Response.ts');

    // when
    swaggerGenerator.addApiPropertyToResponse();
    swaggerGenerator.save();
  });
});
