import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migration1681980750896 implements MigrationInterface {
  name = 'Migration1681980750896';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "buyer" (
                "id" BIGSERIAL NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "email" character varying(255) NOT NULL,
                "password" character varying(255) NOT NULL,
                "name" character varying(255) NOT NULL,
                "country_number" character varying(5) NOT NULL,
                "phone_number" character varying(20) NOT NULL,
                "receive_alarm_type" character varying(20) NOT NULL,
                CONSTRAINT "pk_buyer_id" PRIMARY KEY ("id")
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TABLE "buyer"
        `);
  }
}
