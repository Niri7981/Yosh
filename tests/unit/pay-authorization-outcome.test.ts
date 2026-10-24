import { expect, it } from 'vitest';
import { payMainnetConsentDecision } from '../../src/modules/payment/pay-authorization-outcome';
it('only known synchronous consent preconditions guarantee rejection before execution', () => {
  expect(payMainnetConsentDecision(() => {})).toBeUndefined();
  for (const error of [new Error('PAY_MAINNET_ACCEPTANCE_REQUIRED'), Object.assign(new Error('missing'), { code: 'ENOENT' })])
    expect(payMainnetConsentDecision(() => { throw error; })).toEqual({ decision: 'RejectBeforeExecution' });
});
it('unknown IO, malformed receipts and arbitrary internal failures stay fenced', () => {
  for (const error of [new Error('unknown'), Object.assign(new Error('IO'), { code: 'EIO' }),
    new Error('PAY_PRIVATE_CONTROL_REQUIRED'), new SyntaxError('malformed')])
    expect(() => payMainnetConsentDecision(() => { throw error; })).toThrow(error);
});
