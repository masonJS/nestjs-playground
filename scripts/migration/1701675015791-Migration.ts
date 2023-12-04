import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migration1701675015791 implements MigrationInterface {
  name = 'Migration1701675015791';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "buyer" DROP COLUMN "country_number"
        `);
    await queryRunner.query(`
            ALTER TABLE "buyer" DROP COLUMN "phone_number"
        `);
    await queryRunner.query(`
            ALTER TABLE "buyer"
            ADD "phone" jsonb NOT NULL DEFAULT '{}'
        `);
    await queryRunner.query(`
            COMMENT ON COLUMN "buyer"."phone" IS '휴대폰 번호'
        `);
    await queryRunner.query(`
            ALTER TABLE "buyer"
            ADD "access_count" integer NOT NULL DEFAULT '0'
        `);
    await queryRunner.query(`
            ALTER TABLE "buyer"
            ADD CONSTRAINT "UQ_7911d7b9e729513dec55983fc50" UNIQUE ("email")
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "buyer" DROP CONSTRAINT "UQ_7911d7b9e729513dec55983fc50"
        `);
    await queryRunner.query(`
            ALTER TABLE "buyer" DROP COLUMN "access_count"
        `);
    await queryRunner.query(`
            COMMENT ON COLUMN "buyer"."phone" IS '휴대폰 번호'
        `);
    await queryRunner.query(`
            ALTER TABLE "buyer" DROP COLUMN "phone"
        `);
    await queryRunner.query(`
            ALTER TABLE "buyer"
            ADD "phone_number" character varying(20) NOT NULL
        `);
    await queryRunner.query(`
            ALTER TABLE "buyer"
            ADD "country_number" character varying(5) NOT NULL
        `);
  }
}
