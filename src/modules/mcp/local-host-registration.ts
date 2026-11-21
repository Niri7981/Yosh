import { StatementRegistration } from '../authority/local-statement-pairing';

/** Installed by the host registrar. Never derive the account member from a
 * model-supplied name or accept a member selector in a tool call. */
export function parseHostRegistration(args: string[]) {
  const [idFlag, hostId, labelFlag, label] = args;
  if (args.length !== 4 || idFlag !== '--registration' || labelFlag !== '--label') throw new Error('LOCAL_HOST_REGISTRATION_INVALID');
  const parsed = StatementRegistration.safeParse({ hostId, label });
  if (!parsed.success) throw new Error('LOCAL_HOST_REGISTRATION_INVALID');
  return { registration: parsed.data.hostId, label: parsed.data.label };
}
