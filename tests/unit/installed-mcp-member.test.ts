import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { verifiedMcpMember } from '../../src/modules/mcp/installed-host';

it('uses the verified registration for both old and newly paired internal workers', async () => {
  const id = randomUUID(), selected = { YOSH_CARD_MEMBER_ID: id };
  const host = { registration: randomUUID(), label: 'Local host', legacyMember: null };
  const owner = vi.fn(async () => ({ memberId: id }));
  await expect(verifiedMcpMember(host, selected, undefined, owner)).rejects.toThrow('LOCAL_HOST_BINDING_MISMATCH');
  expect(await verifiedMcpMember({...host, legacyMember: 'default'}, {}, undefined, owner)).toEqual({});
  expect(await verifiedMcpMember({...host, legacyMember: id}, selected, undefined, owner)).toEqual(selected);
  expect(owner).not.toHaveBeenCalled();
  expect(await verifiedMcpMember(host, selected, '1', owner)).toEqual({...selected, YOSH_INTERNAL_PURCHASE: '1'});
  expect(owner).toHaveBeenCalledWith(host.registration, host.label);
  await expect(verifiedMcpMember(host, {YOSH_CARD_MEMBER_ID: randomUUID()}, '1', owner)).rejects.toThrow('LOCAL_HOST_BINDING_MISMATCH');
  await expect(verifiedMcpMember(host, {}, '1', owner)).rejects.toThrow('LOCAL_HOST_BINDING_MISMATCH');
});
