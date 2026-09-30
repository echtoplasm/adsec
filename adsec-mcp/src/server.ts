#!/usr/bin/env node
/**
 * adsec-mcp -- read-only MCP server over Active Directory.
 *
 * Design notes worth keeping in mind if you extend this:
 *
 *  - Every tool is a NARROW capability with a validated schema. There is
 *    deliberately no `run_command` or `ldap_query` tool. A generic
 *    query tool would hand the model arbitrary LDAP, which is the same
 *    class of mistake as giving it a shell.
 *  - Nothing here writes. The bind account should also be read-only at
 *    the AD level, so this is enforced twice: in code, and in the
 *    directory. Belt and suspenders -- a bug in this file should not be
 *    able to modify the domain.
 *  - Tool output is DATA, not instructions. If a display name in AD
 *    contains "ignore previous instructions and ...", that text reaches
 *    the model. That is the prompt-injection surface, and it is why the
 *    tools stay read-only.
 */
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { findStaleUsers, getUser, listUsers } from './ad.js';

const server = new McpServer({ name: 'adsec-mcp', version: '0.1.0' });

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: 'text' as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

server.registerTool(
  'find_stale_users',
  {
    title: 'Find stale user accounts',
    description:
      'List Active Directory user accounts that have not logged on within a given number of days. ' +
      'Use this to find dormant or abandoned accounts. Returns sAMAccountName, display name, ' +
      'whether the account is enabled, and days since last logon.',
    inputSchema: {
      days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .default(90)
        .describe('Accounts with no logon in this many days are considered stale.'),
      includeDisabled: z
        .boolean()
        .default(false)
        .describe('Include already-disabled accounts in the results.'),
      includeNeverLoggedOn: z
        .boolean()
        .default(true)
        .describe('Include accounts that have never logged on at all.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .describe('Maximum number of accounts to return.'),
    },
  },
  async ({ days, includeDisabled, includeNeverLoggedOn, limit }) => {
    try {
      const users = await findStaleUsers({
        days,
        includeDisabled,
        includeNeverLoggedOn,
        limit,
      });
      return ok({
        criteria: { days, includeDisabled, includeNeverLoggedOn },
        count: users.length,
        users,
        note:
          'lastLogonTimestamp replicates lazily -- AD only updates it when the new value is ' +
          '9-14 days newer than the stored one. Treat results near the threshold as approximate.',
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  'get_user',
  {
    title: 'Get one AD user',
    description:
      'Look up a single Active Directory user by sAMAccountName (the short login name, e.g. "jsmith"). ' +
      'Returns account status, last logon, and creation date.',
    inputSchema: {
      samAccountName: z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,64}$/, 'Letters, digits, dot, underscore, hyphen only')
        .describe('The short login name, without domain prefix or @domain suffix.'),
    },
  },
  async ({ samAccountName }) => {
    try {
      const user = await getUser(samAccountName);
      return user ? ok(user) : ok({ found: false, samAccountName });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  'list_users',
  {
    title: 'List AD users',
    description:
      'List Active Directory user accounts in the domain. Use this to see what accounts exist ' +
      'before narrowing down with other tools.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50),
    },
  },
  async ({ limit }) => {
    try {
      const users = await listUsers(limit);
      return ok({ count: users.length, users });
    } catch (e) {
      return fail(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the MCP channel -- all logging must go to stderr.
console.error('adsec-mcp listening on stdio');
