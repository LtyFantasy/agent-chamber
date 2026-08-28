import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { AdminUserController } from './admin-user.controller';
import { User } from '../../database/entities/user.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([User]), AuditModule],
  providers: [UserService],
  controllers: [UserController, AdminUserController],
  exports: [UserService],
})
export class UserModule {}
