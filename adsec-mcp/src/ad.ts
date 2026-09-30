/**
 * Thin, read-only Active Directory layer.
 *
 * Every function here binds, queries, unbinds. No connection pooling, no
 * caching, no writes. The LDAP filters are built from a small set of
 * validated inputs -- never from raw model output -- so there is no
 * LDAP-injection surface even if the model asks for something odd.
 */
import { Client, type Entry } from 'ldapts';

const AD_URL = process.env.AD_URL ?? 'ldap://DC1.lab.local:389';
const AD_BIND_DN = process.env.AD_BIND_DN ?? '';
const AD_BIND_PW = process.env.AD_BIND_PW ?? '';
const AD_BASE_DN = process.env.AD_BASE_DN ?? 'DC=lab,DC=local';

/** AD stores these as 100-nanosecond intervals since 1601-01-01 UTC. */
const FILETIME_EPOCH_DIFF_MS = 11644473600000;

export function fileTimeToDate(ft: string | number | undefined): Date | null {
  if (ft === undefined || ft === null) return null;
  const n = typeof ft === 'string' ? Number(ft) : ft;
  // 0 means "never"; 0x7FFFFFFFFFFFFFFF means "never expires"
  if (!Number.isFinite(n) || n === 0) return null;
  const ms = n / 10000 - FILETIME_EPOCH_DIFF_MS;
  if (ms < 0) return null;
  return new Date(ms);
}

export function dateToFileTime(d: Date): string {
  return String((d.getTime() + FILETIME_EPOCH_DIFF_MS) * 10000);
}

/**
 * userAccountControl is a bitfield. We only read two flags.
 * https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/useraccountcontrol-manipulate-account-properties
 */
const UAC_ACCOUNTDISABLE = 0x0002;
const UAC_DONT_EXPIRE_PASSWORD = 0x10000;

export function uacFlags(uac: string | number | undefined) {
  const n = typeof uac === 'string' ? Number(uac) : (uac ?? 0);
  return {
    disabled: (n & UAC_ACCOUNTDISABLE) !== 0,
    passwordNeverExpires: (n & UAC_DONT_EXPIRE_PASSWORD) !== 0,
  };
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  if (!AD_BIND_DN || !AD_BIND_PW) {
    throw new Error(
      'AD_BIND_DN and AD_BIND_PW must be set. Copy .env.example to .env and fill them in.'
    );
  }
  const client = new Client({ url: AD_URL, timeout: 10_000, connectTimeout: 10_000 });
  try {
    await client.bind(AD_BIND_DN, AD_BIND_PW);
    return await fn(client);
  } finally {
    try {
      await client.unbind();
    } catch {
      /* unbind failures are not interesting */
    }
  }
}

function str(e: Entry, k: string): string | undefined {
  const v = e[k];
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export interface AdUser {
  samAccountName: string;
  displayName?: string;
  distinguishedName: string;
  enabled: boolean;
  passwordNeverExpires: boolean;
  lastLogonTimestamp: string | null;
  daysSinceLogon: number | null;
  whenCreated: string | null;
}

function toUser(e: Entry): AdUser {
  const flags = uacFlags(str(e, 'userAccountControl'));
  const last = fileTimeToDate(str(e, 'lastLogonTimestamp'));
  const created = fileTimeToDate(str(e, 'whenCreated')) ?? null;
  return {
    samAccountName: str(e, 'sAMAccountName') ?? '(unknown)',
    displayName: str(e, 'displayName'),
    distinguishedName: str(e, 'distinguishedName') ?? String(e.dn ?? ''),
    enabled: !flags.disabled,
    passwordNeverExpires: flags.passwordNeverExpires,
    lastLogonTimestamp: last ? last.toISOString() : null,
    daysSinceLogon: last
      ? Math.floor((Date.now() - last.getTime()) / 86_400_000)
      : null,
    whenCreated: created ? created.toISOString() : null,
  };
}

const USER_ATTRS = [
  'sAMAccountName',
  'displayName',
  'distinguishedName',
  'userAccountControl',
  'lastLogonTimestamp',
  'whenCreated',
];

/** Only real user accounts: not computers, not the krbtgt/service noise. */
const USER_CLASS_FILTER =
  '(&(objectCategory=person)(objectClass=user)(!(sAMAccountName=krbtgt)))';

export async function findStaleUsers(opts: {
  days: number;
  includeDisabled: boolean;
  includeNeverLoggedOn: boolean;
  limit: number;
}): Promise<AdUser[]> {
  const cutoff = new Date(Date.now() - opts.days * 86_400_000);
  const ft = dateToFileTime(cutoff);

  // lastLogonTimestamp < cutoff, optionally OR'd with "never logged on at all"
  const staleClause = opts.includeNeverLoggedOn
    ? `(|(lastLogonTimestamp<=${ft})(!(lastLogonTimestamp=*)))`
    : `(lastLogonTimestamp<=${ft})`;

  const enabledClause = opts.includeDisabled ? '' : '(!(userAccountControl:1.2.840.113556.1.4.803:=2))';

  const filter = `(&${USER_CLASS_FILTER}${staleClause}${enabledClause})`;

  return withClient(async (c) => {
    const { searchEntries } = await c.search(AD_BASE_DN, {
      scope: 'sub',
      filter,
      attributes: USER_ATTRS,
      sizeLimit: Math.min(opts.limit, 500),
    });
    return searchEntries
      .map(toUser)
      .sort((a, b) => (b.daysSinceLogon ?? 1e9) - (a.daysSinceLogon ?? 1e9))
      .slice(0, opts.limit);
  });
}

export async function getUser(samAccountName: string): Promise<AdUser | null> {
  // Validated by the caller's zod schema; re-check here so this module is
  // safe to use on its own.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(samAccountName)) {
    throw new Error(`Invalid sAMAccountName: ${samAccountName}`);
  }
  return withClient(async (c) => {
    const { searchEntries } = await c.search(AD_BASE_DN, {
      scope: 'sub',
      filter: `(&${USER_CLASS_FILTER}(sAMAccountName=${samAccountName}))`,
      attributes: [...USER_ATTRS, 'memberOf', 'mail', 'lastLogon'],
      sizeLimit: 1,
    });
    return searchEntries.length ? toUser(searchEntries[0]) : null;
  });
}

export async function listUsers(limit: number): Promise<AdUser[]> {
  return withClient(async (c) => {
    const { searchEntries } = await c.search(AD_BASE_DN, {
      scope: 'sub',
      filter: USER_CLASS_FILTER,
      attributes: USER_ATTRS,
      sizeLimit: Math.min(limit, 500),
    });
    return searchEntries.map(toUser).slice(0, limit);
  });
}
