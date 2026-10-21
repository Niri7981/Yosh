import { dirname, basename } from 'node:path';
import { privatePayJson, recordPayMainnetAcceptance } from '../src/modules/payment/pay-mainnet-control';

// Invoke only after explicit human approval of the reviewed exact receipt.
// There is no approval flag in Pay tool arguments or the public HTTP interface.
const [flag, input, dataFlag, directory, ...extra] = process.argv.slice(2);
if (flag !== '--operator-confirmed' || !input || dataFlag !== '--data-dir' || !directory || extra.length)
  throw new Error('PAY_OPERATOR_CONFIRMATION_REQUIRED');
recordPayMainnetAcceptance(directory, privatePayJson(dirname(input), basename(input)));
process.stdout.write('One exact operation confirmation recorded. No signing or payment requested.\n');
