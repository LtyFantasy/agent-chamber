/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: docs/api-definition.md §7. Tasks
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（task 写操作全量记；
 *     service 层插桩点=create/update/patchDescription/addComment/addDocLink（有内部
 *     调用方 batchCreate/reportResult），其余 controller 层决策 2；batch 不单独记）
 *
 * [踩坑索引] B-50(列表权限过滤) D5(权限盲区) B-42(单对象返回null) B-49(softDelete500) P1-1(findOne载荷瘦身)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #9(代理层透传)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: Task / Milestone 列表接口未接收 @CurrentActor()，导致 Service 层无法按 actor
 *         权限过滤。修复：findAll / findMilestones 接收 actor 并透传给 Service。
 *         见 Plan §3.2 / §3.5。
 *   D5: TaskController 新增 findOne/update/remove 权限检查。
 *       权限从 Service 迁移到 Controller，Service 新增 findById() 无权限检查。
 *       见 memory/2026-06-05.md
 *   P1-1: findOne 不再内嵌 comments/activities；getComments/getActivities 新增 limit query 参数。
 *       见 memory/2026-07-25.md
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { TaskService } from './task.service';
import { TaskDependencyService } from './task-dependency.service';
import { MilestoneService } from './milestone.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import {
  CreateTaskDto,
  UpdateTaskDto,
  MoveTaskDto,
  AssignTaskDto,
  AddCommentDto,
  AddTaskDependencyDto,
  CreateMilestoneDto,
  UpdateMilestoneDto,
  MarkMilestoneDeployedDto,
  QueryTaskDto,
  QueryMilestoneDto,
  BatchCreateTasksDto,
  ReportTaskResultDto,
  PatchTaskDescriptionDto,
} from './dto';
import { AddDocLinkDto } from '../docspace/dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { TaskStatus, AuditAction, ErrorCode } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';

@ApiTags('Tasks')
@Controller('tasks')
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly taskDependencyService: TaskDependencyService,
    private readonly milestoneService: MilestoneService,
    private readonly permService: PermissionService,
    private readonly auditService: AuditService,
  ) {}

  // ===== Task 基础 CRUD =====

  @UseGuards(JwtOrApiKeyGuard)
  @Get()
  @ApiOperation({
    summary: 'List tasks',
    description:
      'List tasks with multi-dimensional filtering, full-text search, and pagination.' +
      'Query parameters include boardId, listId, status, assigneeId, labels, q, etc.' +
      'Returns PaginatedResponse<TaskSummaryDto>.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number, default 1', type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page, default 20, max 100',
    type: Number,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page (compatibility alias, same as pageSize)',
    type: Number,
  })
  @ApiQuery({ name: 'boardId', required: false, description: 'Filter by board ID', type: String })
  @ApiQuery({ name: 'listId', required: false, description: 'Filter by list ID', type: String })
  @ApiQuery({
    name: 'topicId',
    required: false,
    description: 'Filter by associated topic ID',
    type: String,
  })
  @ApiQuery({
    name: 'milestoneId',
    required: false,
    description: 'Filter by milestone ID',
    type: String,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by status: backlog/todo/in_progress/review/done/blocked/archived',
    enum: Object.values(TaskStatus),
  })
  @ApiQuery({
    name: 'assigneeId',
    required: false,
    description: 'Filter by assignee ID (UUID only)',
    type: String,
  })
  // assignee_type 列即将删除，不再提供按负责人类型过滤
  @ApiQuery({
    name: 'labels',
    required: false,
    description: 'Filter by labels, comma-separated e.g. bug,combat',
    type: String,
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Full-text search（title + description）',
    type: String,
  })
  @ApiQuery({
    name: 'unblocked',
    required: false,
    description: 'Return only unblocked tasks',
    type: Boolean,
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    description:
      'Sort order: createdAt (default, newest first) | statusPriority (in_progress > todo > blocked > backlog > others — review/done/archived always last; ties broken by updatedAt DESC then id ASC for stable pagination)',
    enum: ['createdAt', 'statusPriority'],
  })
  @ApiResponse({ status: 200, description: 'Paginated list of tasks' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  async findAll(@Query() query: QueryTaskDto, @CurrentActor() actor: UnifiedActor) {
    return this.taskService.findAll(query, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post()
  @ApiOperation({
    summary: 'Create task',
    description:
      'Create a single task. Required fields: title, and either listId or statusName (listId wins when both provided; statusName requires boardId).' +
      'Optional fields: boardId (auto-inferred from listId), description, priority, status, assigneeId, dueDate, labels, milestoneId, customFields.' +
      'Returns TaskDetailDto.',
  })
  @ApiResponse({ status: 201, description: 'Task created' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden (not a board participant)' })
  async create(@Body() dto: CreateTaskDto, @CurrentActor() actor: UnifiedActor) {
    // B-58：目标 board 的 write 校验（boardId 解析顺序与 service.create 对齐：
    // listId 优先、statusName 需 boardId、boardId 可从 listId 推断）——兑现
    // @ApiResponse 403 "Forbidden (not a board participant)" 契约（铁律 #20）
    const board = await this.taskService.resolveCreateBoard(dto);
    await this.permService.ensureCan(board, actor, 'write');
    return this.taskService.create(dto, actor.id, actor.type);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('batch')
  @ApiOperation({
    summary: 'Batch create tasks',
    description:
      'Batch create tasks, up to 50 at a time. Request body: tasks: CreateTaskDto[].' +
      'Returns { items: TaskDetailDto[], count: number }.',
  })
  @ApiResponse({ status: 201, description: 'Batch created' })
  @ApiResponse({ status: 400, description: 'Bad request or exceeds 50 tasks' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden (not a board participant)' })
  async batchCreate(@Body() dto: BatchCreateTasksDto, @CurrentActor() actor: UnifiedActor) {
    // B-58：批量任务允许跨 board——对每个去重后的目标 board 校验 write（任一无权即 403）
    const checkedBoards = new Set<string>();
    for (const taskDto of dto.tasks) {
      const board = await this.taskService.resolveCreateBoard(taskDto);
      if (!checkedBoards.has(board.id)) {
        await this.permService.ensureCan(board, actor, 'write');
        checkedBoards.add(board.id);
      }
    }
    return this.taskService.batchCreate(dto, actor.id, actor.type);
  }

  // ===== Milestones (must be before :id route to avoid conflict) =====

  @UseGuards(JwtOrApiKeyGuard)
  @Get('milestones')
  @ApiOperation({
    summary: 'List milestones',
    description:
      'List milestones with board filter and pagination.' +
      'Each milestone includes stats: { total, done, inProgress, open }.' +
      'Returns PaginatedResponse<Milestone>.',
  })
  @ApiQuery({ name: 'boardId', required: false, description: 'Filter by board ID', type: String })
  @ApiQuery({ name: 'page', required: false, description: 'Page number, default 1', type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page, default 20',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Paginated list of milestones' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  async findMilestones(@Query() query: QueryMilestoneDto, @CurrentActor() actor: UnifiedActor) {
    return this.milestoneService.findAll(query, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('milestones')
  @ApiOperation({
    summary: 'Create milestone',
    description:
      'Create a milestone. Required fields: name, boardId.' +
      'Optional fields: description, status (planned/active/completed/cancelled), startDate, targetDate.' +
      'Creator must have read access to the board.',
  })
  @ApiResponse({ status: 201, description: 'Milestone created' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async createMilestone(@Body() dto: CreateMilestoneDto, @CurrentActor() actor: UnifiedActor) {
    return this.milestoneService.create(dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('milestones/:id')
  @ApiOperation({
    summary: 'Get milestone',
    description:
      'Get a single milestone detail, including stats: { total, done, inProgress, open }. Returns Milestone.',
  })
  @ApiParam({ name: 'id', description: 'Milestone ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Milestone details' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 404, description: 'Milestone not found' })
  async findMilestone(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    return this.milestoneService.findOne(id, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch('milestones/:id')
  @ApiOperation({
    summary: 'Update milestone',
    description:
      'Update milestone info. Request body is Partial<CreateMilestoneDto>. Returns the updated Milestone.',
  })
  @ApiParam({ name: 'id', description: 'Milestone ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Milestone updated' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Milestone not found' })
  async updateMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMilestoneDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    return this.milestoneService.update(id, dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('milestones/:id/deployed')
  @ApiOperation({
    summary: 'Mark milestone as deployed',
    description:
      'Deploy a release milestone. Body is fully optional: { anchors?, backup?, migrations?, deployedAt? }.' +
      'Idempotent: re-deployment merges deployMeta and refreshes deployedAt (hotfix redeploys are the norm).' +
      'Requires write access to the board. Returns the milestone detail (same as GET /tasks/milestones/:id).' +
      'Deployed status can ONLY be set via this endpoint (PATCH status=deployed is rejected).',
  })
  @ApiParam({ name: 'id', description: 'Milestone ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Milestone marked as deployed' })
  @ApiResponse({ status: 400, description: 'Invalid transition (not dev/ready/deployed)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden (no write access to board)' })
  @ApiResponse({ status: 404, description: 'Milestone not found' })
  async deployMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkMilestoneDeployedDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    return this.milestoneService.markDeployed(id, dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete('milestones/:id')
  @ApiOperation({
    summary: 'Delete milestone',
    description:
      'Delete a milestone. Soft delete that preserves referential integrity. Returns true on success.',
  })
  @ApiParam({ name: 'id', description: 'Milestone ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Milestone deleted' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Milestone not found' })
  async removeMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    return this.milestoneService.remove(id, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id')
  @ApiOperation({
    summary: 'Get task',
    description:
      'Get a single task detail, including description, checklist, attachments, dependencies, dependents, blockers, assigneeName, etc.' +
      'Comments and activity logs can be fetched separately via GET /tasks/:id/comments and /tasks/:id/activities.' +
      'Returns TaskDetailDto. Requires board participant permission.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Task details' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden (not a board participant)' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'read');
    return this.taskService.findOne(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch(':id')
  @ApiOperation({
    summary: 'Update task',
    description:
      'Update task info. Request body is Partial<CreateTaskDto>.' +
      'Supports direct updates to assigneeId / assigneeType without calling a separate assign endpoint.' +
      'Agents can only update tasks assigned to themselves. Returns TaskDetailDto.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Task updated' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden (not a board participant or agent lacks update permission)',
  })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    return this.taskService.update(id, dto, actor.id, actor.type);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch(':id/description')
  @ApiOperation({
    summary: 'Patch task description (match mode)',
    description:
      'Local patch of the task description via exact substring replacement — the ' +
      'preferred channel for concurrent multi-agent description edits (replaces ' +
      'whole-description PATCH). ' +
      'oldString must match exactly once: 0 matches → 404, >1 matches → 409 with ' +
      'matchCount (expand context and retry). newString may be empty (delete the fragment). ' +
      'Optional expectedDescriptionHash (from GET /tasks/:id descriptionHash) is an ' +
      'optimistic-lock precondition: mismatch → 409 with currentDescriptionHash. ' +
      'With clientRequestId, retries return the first response snapshot (idempotentReplay: true); ' +
      'same key with a different payload is rejected with 409.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Task description patched' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden (not a board participant or agent lacks update permission)',
  })
  @ApiResponse({ status: 404, description: 'Task not found or oldString not found' })
  @ApiResponse({
    status: 409,
    description:
      'Ambiguous match (matchCount) / optimistic-lock conflict (currentDescriptionHash) / idempotency key conflict',
  })
  async patchDescription(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchTaskDescriptionDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    return this.taskService.patchDescription(id, dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete task',
    description:
      'Delete a task. Soft delete that preserves referential integrity. Returns true on success.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Task deleted' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden (not a board participant)' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'delete');
    await this.taskService.remove(id);
    // 审计（Phase 2）：DELETE + task；controller 层（remove 无 actor 参数，决策 2）；
    // newData 白名单 {taskId, title}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.TASK,
      entityId: id,
      actorId: actor.id,
      newData: { taskId: id, title: task.title },
      source: 'api',
    });
    return true;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/move')
  @ApiOperation({
    summary: 'Move task',
    description:
      'Move a task to a specified list. Required field: listId (target list ID).' +
      'position takes precedence over order; when both are provided, position is used.' +
      'If the target list has a mappedStatus configured, the task status will be automatically synced. Returns TaskDetailDto.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Task moved' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden (not a board participant)' })
  @ApiResponse({ status: 404, description: 'Task or target list not found' })
  async move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveTaskDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    const result = await this.taskService.move(id, dto, actor.id, actor.type);
    // 审计（Phase 2）：UPDATE + task（move）；controller 层（move 无 actor 参数，
    // 决策 2）；newData 白名单 {taskId, title, fromListId, toListId, status? 前后值}
    // （决策 6；position 不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.TASK,
      entityId: id,
      actorId: actor.id,
      newData: {
        taskId: id,
        title: task.title,
        fromListId: task.listId,
        toListId: dto.listId,
        ...(result.status !== task.status && {
          status: result.status,
          statusBefore: task.status,
        }),
      },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/assign')
  @ApiOperation({
    summary: 'Assign task',
    description:
      'Assign the task to a specified target. Required fields: assigneeId, assigneeType.' +
      'When append is true, appends the assignment; false (default) replaces it. Returns TaskDetailDto.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Task assigned' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden (not a board participant)' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignTaskDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    const result = await this.taskService.assign(id, dto, actor.id, actor.type);
    // 审计（Phase 2）：UPDATE + task（assign）；controller 层（assign 无 actor 参数，
    // 决策 2）；newData 白名单 {taskId, title, assigneeId 前后值}
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.TASK,
      entityId: id,
      actorId: actor.id,
      newData: {
        taskId: id,
        title: task.title,
        assigneeId: result.assigneeId,
        assigneeIdBefore: task.assigneeId,
      },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/report')
  @ApiOperation({
    summary: 'Report task result',
    description:
      'One-stop work-result report: post a comment (optional, comment/commitSha concatenation rules), ' +
      'update the task status, then link optional docIds to the task. ' +
      'Comment is posted first, then status is updated — producing a logical timeline. ' +
      'Per-doc failures are embedded in docLinks.failed — never fail the whole report. ' +
      'With clientRequestId, retries return the first response snapshot (idempotentReplay: true) ' +
      'without re-posting the comment; same key with a different payload is rejected with 409.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Report applied' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden (not a board participant or agent lacks update permission)',
  })
  @ApiResponse({ status: 404, description: 'Task not found' })
  @ApiResponse({ status: 409, description: 'Idempotency key conflict (different payload)' })
  async report(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportTaskResultDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    return this.taskService.reportResult(id, dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/doc-links')
  @ApiOperation({
    summary: 'Link a document to a task',
    description:
      "Add a document link to this task. Actor must have read access to the document's space. " +
      'Idempotent — re-adding the same link returns the existing one.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Document linked to task' })
  @ApiResponse({ status: 403, description: 'Forbidden (no read access to doc space)' })
  @ApiResponse({ status: 404, description: 'Task or document not found' })
  async addDocLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddDocLinkDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    return this.taskService.addDocLink(id, dto.docId, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id/doc-links/:docId')
  @ApiOperation({
    summary: 'Remove a document link from a task',
    description: 'Remove a document link from this task. Returns true on success.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiParam({ name: 'docId', description: 'Document ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Document link removed' })
  @ApiResponse({ status: 404, description: 'Task or doc link not found' })
  async removeDocLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    await this.taskService.removeDocLink(id, docId);
    // 审计（Phase 2）：DELETE + doc_link；controller 层（removeDocLink 无 actor
    // 参数，决策 2）；newData 白名单 {taskId, docId}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.DOC_LINK,
      entityId: docId,
      actorId: actor.id,
      newData: { taskId: id, docId },
      source: 'api',
    });
    return true;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/comments')
  @ApiOperation({
    summary: 'Get comments',
    description:
      'Get all comments for the task. Supports optional limit parameter to control returned count (default 50, max 200). Returns CommentDto[].',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max number of items to return, default 50, max 200',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Comment list' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async getComments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Query('limit') limit?: string,
  ) {
    // B-58：评论属 task 私有数据，task→board 的 read 校验（read 无权限 → 404）
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'read');
    return this.taskService.getComments(id, limit ? +limit : undefined);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/comments')
  @ApiOperation({
    summary: 'Add comment',
    description: 'Add a comment to a task. Required field: content. Returns CommentDto.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Comment added' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden (not a board participant)' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Body() dto: AddCommentDto,
  ) {
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    return this.taskService.addComment(id, actor.id, actor.type, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/activities')
  @ApiOperation({
    summary: 'Get activities',
    description:
      'Get the task activity log (create, update, move, assign, etc.). Supports optional limit parameter to control returned count (default 50, max 200). Returns ActivityDto[].',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max number of items to return, default 50, max 200',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Activity log list' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async getActivities(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Query('limit') limit?: string,
  ) {
    // B-58：活动日志属 task 私有数据，task→board 的 read 校验（read 无权限 → 404）
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'read');
    return this.taskService.getActivities(id, limit ? +limit : undefined);
  }

  // ===== Task Dependencies =====

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/dependencies')
  @ApiOperation({
    summary: 'Get task dependencies (tasks this task depends on)',
    description:
      "Get the task's dependency list (tasks this task depends on). " +
      'Each row is a summary projection {id, taskId, dependsOnTaskId, type, createdAt} ' +
      'with nested dependsOnTask {id, title, status} (id = dependency row id, used for DELETE; ' +
      'dependsOnTask.id = the task id). At most 100 rows.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Dependency list (tasks this task depends on)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async findDependencies(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // B-58：依赖图属 task 私有数据，task→board 的 read 校验（read 无权限 → 404）
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'read');
    return this.taskDependencyService.findDependencies(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/dependents')
  @ApiOperation({
    summary: 'Get task dependents (tasks that depend on this task)',
    description:
      "Get the task's dependent list (tasks that depend on this task). " +
      'Each row is a summary projection {id, taskId, dependsOnTaskId, type, createdAt} ' +
      'with nested task {id, title, status}. At most 100 rows.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Dependent list (tasks depending on this task)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async findDependents(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // B-58：依赖图属 task 私有数据，task→board 的 read 校验（read 无权限 → 404）
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'read');
    return this.taskDependencyService.findDependents(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/dependencies')
  @ApiOperation({
    summary: 'Add task dependency',
    description:
      'Add a task dependency. Required field: dependsOnTaskId (the depended-on task ID).' +
      'Optional field: type (blocks/relates_to/duplicates, default blocks).',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Dependency added' })
  @ApiResponse({
    status: 400,
    description: 'Bad request (self-dependency, circular dependency, or duplicate dependency)',
  })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async addDependency(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTaskDependencyDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // B-58：主 task 的 board write（与 addComment 等写端点一致）
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    // dependsOnTaskId 可能跨 board：既有设计允许跨 board 依赖边（无 board 一致性
    // 校验），但权限语义未定义——保守选择两端 board 都校验 write（防越权探测/
    // 写入私有 board 任务；若产品上需放宽为"被依赖 board 仅 read"，见 B-58 汇报）
    const dependsOnTask = await this.taskService.findById(dto.dependsOnTaskId);
    await this.permService.ensureCan(dependsOnTask, actor, 'write');
    const result = await this.taskDependencyService.addDependency(id, dto);
    // 审计（Phase 2）：CREATE + task_dependency；controller 层（addDependency 无
    // actor 参数，决策 2）；newData 白名单 {taskId, dependsOnTaskId, type}
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.TASK_DEPENDENCY,
      entityId: result.id,
      actorId: actor.id,
      newData: {
        taskId: id,
        dependsOnTaskId: dto.dependsOnTaskId,
        type: dto.type ?? 'blocks',
      },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id/dependencies/:depId')
  @ApiOperation({
    summary: 'Remove task dependency',
    description: 'Remove the specified dependency relationship. Returns true on success.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiParam({ name: 'depId', description: 'Depended-on task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Dependency removed' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Task or dependency not found' })
  async removeDependency(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('depId', ParseUUIDPipe) depId: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // B-58：删除依赖行只影响主 task 的依赖图，task→board 的 write 校验
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'write');
    await this.taskDependencyService.removeDependency(id, depId);
    // 审计（Phase 2）：DELETE + task_dependency；controller 层；newData 白名单
    // {taskId, dependsOnTaskId}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.TASK_DEPENDENCY,
      entityId: depId,
      actorId: actor.id,
      newData: { taskId: id, dependsOnTaskId: depId },
      source: 'api',
    });
    return true;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/blockers')
  @ApiOperation({
    summary: 'Get active blockers (blocks type + incomplete)',
    description:
      'Get active blockers for this task (type=blocks and the dependent task is incomplete). ' +
      'Each row is a summary projection {id, taskId, dependsOnTaskId, type, createdAt} ' +
      'with nested dependsOnTask {id, title, status}. At most 100 rows.',
  })
  @ApiParam({ name: 'id', description: 'Task ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Blocker list' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async findBlockers(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    // B-58：blockers 属 task 私有数据，task→board 的 read 校验（read 无权限 → 404）
    const task = await this.taskService.findById(id);
    await this.permService.ensureCan(task, actor, 'read');
    return this.taskDependencyService.findBlockers(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('blockers/batch')
  @ApiOperation({
    summary: 'Batch query hasBlockers for multiple tasks',
    description:
      'Batch query whether multiple tasks have active blockers.' +
      'ids is a comma-separated task ID list (e.g. tsk_1,tsk_2).' +
      'Returns Record<taskId, boolean>.',
  })
  @ApiQuery({
    name: 'ids',
    required: true,
    description: 'Comma-separated task ID list',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'Blocker status map per task' })
  @ApiResponse({ status: 401, description: 'Unauthenticated or token expired' })
  async batchBlockers(@Query('ids') ids: string, @CurrentActor() actor: UnifiedActor) {
    const taskIds = ids ? ids.split(',').filter(Boolean) : [];
    // B-61：逐段校验 UUID 格式——非法值 400 先于权限 403（铁律 #21 格式校验在
    // controller 层，不透传到 PG 绑定参数变成 22P02 500；写法对齐
    // task.service.ts move() 的 listId regex 先例）
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const invalid = taskIds.find((taskId) => !uuidRegex.test(taskId));
    if (invalid !== undefined) {
      throw new BadRequestException({
        message: `ids contains invalid UUID: ${invalid}`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    // B-58：多 task 可能跨多 board——对每个去重后的 board 校验 read，任一不可访问
    // 即 403（batch 场景 404 无法隐藏存在性——其他 task 正常返回——故与单任务端点
    // ensureCan(read→404) 不同，显式 403；权限判定在 B-61 格式校验之后执行）
    const checkedBoards = new Set<string>();
    for (const taskId of taskIds) {
      const task = await this.taskService.findById(taskId);
      const board = await this.taskService.resolveTaskBoard(task);
      if (!board) continue; // orphan task = 公开（TaskPolicy 同语义）
      if (!checkedBoards.has(board.id)) {
        const allowed = await this.permService.can(board, actor, 'read');
        if (!allowed) {
          throw new ForbiddenException({
            message: 'Access denied: read on Board',
            code: ErrorCode.PERMISSION_DENIED,
          });
        }
        checkedBoards.add(board.id);
      }
    }
    return this.taskDependencyService.hasBlockers(taskIds);
  }
}
