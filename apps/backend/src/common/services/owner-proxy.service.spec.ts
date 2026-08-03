import { OwnerProxyService } from './owner-proxy.service';
import { Agent } from '../../database/entities/agent.entity';
import { UnifiedActor } from '../types/actor.types';
import { ActorType } from '@agent-chamber/shared';
import { Repository } from 'typeorm';

describe('OwnerProxyService', () => {
  let service: OwnerProxyService;
  let agentRepo: jest.Mocked<Repository<Agent>>;

  beforeEach(() => {
    agentRepo = {
      exists: jest.fn(),
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<Agent>>;
    service = new OwnerProxyService(agentRepo);
  });

  afterEach(() => jest.clearAllMocks());

  const makeActor = (overrides: Partial<UnifiedActor> = {}): UnifiedActor =>
    ({
      id: 'human-1',
      type: ActorType.HUMAN,
      ...overrides,
    }) as UnifiedActor;

  describe('isOwnerProxy', () => {
    it('returns true when creator agent belongs to the human actor', async () => {
      agentRepo.exists.mockResolvedValue(true);
      const result = await service.isOwnerProxy('agent-1', makeActor());
      expect(result).toBe(true);
      expect(agentRepo.exists).toHaveBeenCalledWith({
        where: { id: 'agent-1', ownerId: 'human-1' },
      });
    });

    it('returns false when creator agent is not owned by the actor', async () => {
      agentRepo.exists.mockResolvedValue(false);
      const result = await service.isOwnerProxy('agent-2', makeActor());
      expect(result).toBe(false);
    });

    it('returns false for agent actor without querying DB (agent cannot own agent)', async () => {
      const result = await service.isOwnerProxy(
        'agent-1',
        makeActor({ type: ActorType.AGENT }),
      );
      expect(result).toBe(false);
      expect(agentRepo.exists).not.toHaveBeenCalled();
    });

    it('returns false for null actor without querying DB', async () => {
      const result = await service.isOwnerProxy('agent-1', null);
      expect(result).toBe(false);
      expect(agentRepo.exists).not.toHaveBeenCalled();
    });

    it('returns false for system actor without querying DB', async () => {
      const result = await service.isOwnerProxy(
        'agent-1',
        makeActor({ type: ActorType.SYSTEM }),
      );
      expect(result).toBe(false);
      expect(agentRepo.exists).not.toHaveBeenCalled();
    });

    it('short-circuits when creatorId equals actor id (direct creator, no DB query)', async () => {
      const result = await service.isOwnerProxy('human-1', makeActor());
      expect(result).toBe(false);
      expect(agentRepo.exists).not.toHaveBeenCalled();
    });

    it('short-circuits on empty creatorId without querying DB', async () => {
      const result = await service.isOwnerProxy('', makeActor());
      expect(result).toBe(false);
      expect(agentRepo.exists).not.toHaveBeenCalled();
    });
  });

  describe('getOwnedAgentIds', () => {
    it('returns owned agent ids for human actor', async () => {
      agentRepo.find.mockResolvedValue([{ id: 'agent-1' }, { id: 'agent-2' }] as Agent[]);
      const result = await service.getOwnedAgentIds(makeActor());
      expect(result).toEqual(['agent-1', 'agent-2']);
      expect(agentRepo.find).toHaveBeenCalledWith({ where: { ownerId: 'human-1' } });
    });

    it('returns empty array when human owns no agents', async () => {
      agentRepo.find.mockResolvedValue([]);
      const result = await service.getOwnedAgentIds(makeActor());
      expect(result).toEqual([]);
    });

    it('returns empty array for agent actor without querying DB', async () => {
      const result = await service.getOwnedAgentIds(makeActor({ type: ActorType.AGENT }));
      expect(result).toEqual([]);
      expect(agentRepo.find).not.toHaveBeenCalled();
    });

    it('returns empty array for null actor without querying DB', async () => {
      const result = await service.getOwnedAgentIds(null);
      expect(result).toEqual([]);
      expect(agentRepo.find).not.toHaveBeenCalled();
    });
  });
});
