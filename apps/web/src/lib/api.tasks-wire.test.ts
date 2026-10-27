/** Use real Axios transforms and a local adapter: no HTTP or mocked serialization. */
import { Api, axiosInstance } from './api';
import type { AxiosAdapter } from 'axios';
it('task PATCH serializes null and empty string, omits undefined, and keeps the original token', async () => {
  const originalAdapter = axiosInstance.defaults.adapter;
  const bodies: unknown[] = [];
  const adapter: AxiosAdapter = async (config) => {
    expect(config.method).toBe('patch');
    expect(config.url).toBe('/tasks/task-a');
    expect(typeof config.data).toBe('string');
    bodies.push(JSON.parse(config.data as string));
    return { data: { data: { id: 'task-a' } }, status: 200, statusText: 'OK', headers: {}, config };
  };
  axiosInstance.defaults.adapter = adapter;
  try {
    await Api.tasks.update('task-a', {
      description: '',
      assigneeId: null,
      milestoneId: null,
      title: undefined,
      expectedUpdatedAt: '2026-10-26T01:00:00.000Z',
    });
    await Api.tasks.update('task-a', {
      title: 'New title',
      description: 'Text',
      assigneeId: 'agent-id',
      milestoneId: 'milestone-id',
      expectedUpdatedAt: '2026-10-26T02:00:00.000Z',
    });
    expect(bodies).toEqual([
      {
        description: '',
        assigneeId: null,
        milestoneId: null,
        expectedUpdatedAt: '2026-10-26T01:00:00.000Z',
      },
      {
        title: 'New title',
        description: 'Text',
        assigneeId: 'agent-id',
        milestoneId: 'milestone-id',
        expectedUpdatedAt: '2026-10-26T02:00:00.000Z',
      },
    ]);
  } finally {
    axiosInstance.defaults.adapter = originalAdapter;
  }
});
