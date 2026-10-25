import bcrypt from 'bcrypt';
import { User, Author } from '../models/index.js';
import { normalizeEmail } from '../auth/email.js';
import { BCRYPT_COST, NEW_PASSWORD_MIN_LENGTH, validNewPasswordInput, validPasswordHash } from '../auth/password-policy.js';
import { requireTransaction } from '../db/transaction.js';

export class ProvisionError extends Error {
  constructor(code) {super('Account provisioning could not complete');this.code=code;}
}
export function selection(role,authorId) {
  if(role==='admin' && authorId===undefined) return {role};
  if(role==='author' && typeof authorId==='string' && /^AUTH\d+$/.test(authorId)) return {role,authorId};
  throw new ProvisionError('USAGE');
}
export function parseSelection(args) {
  if(args.length===1) return selection(args[0]);
  if(args.length===2) return selection(args[0],args[1]);
  throw new ProvisionError('USAGE');
}
export async function prepareAccount(input) {
  const chosen=selection(input.role,input.authorId);
  const email=normalizeEmail(input.email);
  if(!email) throw new ProvisionError('EMAIL');
  if(!validNewPasswordInput(input.password)) throw new ProvisionError('PASSWORD');
  return {...chosen,email,passwordHash:await bcrypt.hash(input.password,BCRYPT_COST)};
}
export function checkInterrupted(signal) {
  if(signal?.aborted) throw new ProvisionError('INTERRUPTED');
}
// Only called inside withTransaction. No accounts are replaced or updated here.
export async function provisionAccount(input,session,signal) {
  requireTransaction(session);checkInterrupted(signal);
  const chosen=selection(input.role,input.authorId);
  const email=normalizeEmail(input.email);
  if(!email) throw new ProvisionError('EMAIL');
  if(!validPasswordHash(input.passwordHash)) throw new ProvisionError('PASSWORD');
  const user=new User({email,passwordHash:input.passwordHash,role:chosen.role,accountStatus:'active',tokenVersion:0});
  await user.validate();
  if(await User.findOne({email}).session(session)) throw new ProvisionError('DUPLICATE');
  let author;
  if(chosen.role==='author') {
    author=await Author.findOne({author_id:chosen.authorId}).session(session);
    if(!author) throw new ProvisionError('AUTHOR_MISSING');
    if(author.user!=null) throw new ProvisionError('AUTHOR_LINKED');
    // Validate the existing profile before inserting, but never normalize its fields.
    await author.validate();
  }
  requireTransaction(session);checkInterrupted(signal);
  await user.save({session});
  if(author) {
    requireTransaction(session);checkInterrupted(signal);
    author.user=user._id;
    await author.save({session});
  }
  checkInterrupted(signal);
}
export function safeProvisionError(error) {
  const messages={
    USAGE:'Usage: npm run account:provision -- admin OR npm run account:provision -- author AUTH_ID. Password arguments are not accepted.',
    EMAIL:'Invalid email address.',
    PASSWORD:'Invalid password: use at least '+NEW_PASSWORD_MIN_LENGTH+' characters and at most 72 UTF-8 bytes, without control characters or malformed Unicode. Retry the command.',
    PASSWORD_INPUT:'Forbidden password input; nothing was submitted. Retry the command without control characters or unsupported terminal keys.',
    CONFIRM:'Passwords did not match; nothing was submitted.',
    DUPLICATE:'Account email already exists; no password was reset.',
    AUTHOR_MISSING:'Source author does not exist; no account was created.',
    AUTHOR_LINKED:'Source author is already linked; no account was created.',
    TERMINAL:'An interactive terminal is required; piped credentials are not accepted.',
    INTERRUPTED:'Provisioning interrupted. If interrupted during commit, inspect account/link state before retrying; the outcome may be uncertain.',
  };
  if(error instanceof ProvisionError && messages[error.code]) return messages[error.code];
  if(error?.code===11000) return 'Duplicate account/link conflict; existing accounts were not overwritten.';
  return 'Provisioning failed. Check configuration and transaction support privately; if commit outcome is uncertain, inspect account/link state before retrying. No credentials were logged.';
}
