/** Pure editing contracts complement observer tests with partial-response and null boundaries. */
import {
  draftFromTask,
  changedFields,
  buildTaskPatch,
  mergeDraftFields,
  mergeTaskWrite,
  isEditableTaskRead,
  isTaskVersionConflict,
} from './task-editor';
import type { TaskDetail } from '@/types';
const task = {
  id: 'a',
  title: 'Title',
  description: null,
  status: 'todo',
  priority: 'p2',
  assigneeId: null,
  milestoneId: null,
  labels: [],
  listId: 'old-list',
  updatedAt: '2026-10-26T01:00:00.000Z',
} as TaskDetail;
it('normalizes nullable empty values without creating false changes and emits only real clear intents', () => {
  const baseline = draftFromTask(task);
  expect(buildTaskPatch(baseline, baseline, String(task.updatedAt))).toBeNull();
  const assigned = {
    ...baseline,
    description: 'Old',
    assigneeId: 'agent',
    milestoneId: 'milestone',
  };
  expect(buildTaskPatch(baseline, assigned, String(task.updatedAt))).toEqual({
    description: '',
    assigneeId: null,
    milestoneId: null,
    expectedUpdatedAt: task.updatedAt,
  });
});
it('per-field acceptance keeps later inputs while adopting normalized and untouched server values', () => {
  const submitted = draftFromTask(task);
  const current = { ...submitted, description: 'Later typing' };
  const server = { ...submitted, title: 'Normalized', labels: ['external'] };
  expect(mergeDraftFields(current, submitted, server)).toEqual({
    ...server,
    description: 'Later typing',
  });
  expect(changedFields(mergeDraftFields(current, submitted, server), server)).toEqual([
    'description',
  ]);
});
it('merges a partial write without dropping unrelated GET fields and clears all invalidated projections', () => {
  const previous = {
    ...task,
    assigneeId: 'old-agent',
    assigneeName: 'Old name',
    assigneeDeletedAt: 'yesterday',
    descriptionHash: 'old-hash',
    milestoneId: 'old-milestone',
    milestone: { id: 'old-milestone' },
    listName: 'Old column',
    docs: [{ docId: 'doc', title: 'Kept doc', path: 'kept.md' }],
  } as TaskDetail;
  const merged = mergeTaskWrite(previous, {
    ...task,
    description: '',
    assigneeId: 'new-agent',
    milestoneId: null,
    listId: 'new-list',
  });
  expect(merged?.docs).toEqual(previous.docs);
  for (const key of [
    'assigneeName',
    'assigneeDeletedAt',
    'descriptionHash',
    'milestone',
    'listName',
  ])
    expect(merged).not.toHaveProperty(key);
  expect(mergeTaskWrite(undefined, task)).toBeUndefined();
});
it('only complete target reads with an opaque string token can become an edit baseline', () => {
  expect(isEditableTaskRead(task, 'a')).toBe(true);
  for (const invalid of [
    { ...task, id: 'b' },
    { ...task, updatedAt: null },
    { ...task, updatedAt: new Date() },
    { ...task, updatedAt: '' },
    { ...task, labels: undefined },
    { ...task, milestoneId: undefined },
  ])
    expect(isEditableTaskRead(invalid, 'a')).toBe(false);
});
it('recognizes only the task version conflict envelope', () => {
  const body = { code: 9001, data: { currentUpdatedAt: 'opaque-token' } };
  expect(isTaskVersionConflict({ response: { status: 409, data: body } })).toBe(true);
  for (const error of [
    { response: { status: 500, data: body } },
    { response: { status: 409, data: { code: '9001', data: body.data } } },
    { response: { status: 409, data: { code: 9001 } } },
  ])
    expect(isTaskVersionConflict(error)).toBe(false);
});
