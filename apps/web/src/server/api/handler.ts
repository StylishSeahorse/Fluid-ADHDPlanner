/**
 * The REST API's one way in.
 *
 * Every `/api/v1` route is a call to `apiRoute`, which authenticates the
 * bearer token, checks its scope, applies the rate limit, and turns errors
 * into RFC 9457 problem documents. The route then calls the same tRPC
 * procedures the app does, through a caller built for the token's owner — so
 * the API cannot do anything, or see anything, the app would not let that
 * person do or see.
 *
 * Session cookies are deliberately not accepted here. An API that honoured
 * them would be reachable by any page the person visits, CSRF and all.
 */
import 'server-only';
import { TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import type { User } from '@fluid/db';
import { appRouter } from '../routers/_app';
import { authenticateApiToken } from '../services/api-tokens';
import { notifyBoardChange } from '../live-notify';
import { allows, parseBearer, type Scope } from './token-format';
import { rateLimit } from './rate-limit';

export const RATE_LIMIT_PER_MINUTE = 300;

export type ApiCaller = ReturnType<typeof appRouter.createCaller>;

export interface ApiContext<P> {
  request: Request;
  params: P;
  user: User;
  caller: ApiCaller;
}

/** Throw from a route to answer with a specific problem. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail ?? title);
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Unprocessable content',
  429: 'Too many requests',
  500: 'Internal server error',
};

const TRPC_STATUS: Partial<Record<TRPCError['code'], number>> = {
  BAD_REQUEST: 400,
  PARSE_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
};

export function problem(status: number, detail?: string, extra?: Record<string, unknown>, headers?: HeadersInit): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: TITLES[status] ?? 'Error', status, ...(detail ? { detail } : {}), ...extra }),
    { status, headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store', ...headers } },
  );
}

function toProblem(error: unknown): Response {
  if (error instanceof ApiProblem) return problem(error.status, error.detail, error.extra);
  if (error instanceof ZodError) {
    return problem(400, 'The request body is not valid.', { errors: error.issues.map(({ path, message }) => ({ path, message })) });
  }
  if (error instanceof TRPCError) {
    const status = TRPC_STATUS[error.code] ?? 500;
    if (error.cause instanceof ZodError) return toProblem(error.cause);
    if (status === 500) {
      console.error('[api] procedure failed', error.cause ?? error);
      return problem(500);
    }
    // Procedure messages are written for people, so they are safe to pass on.
    return problem(status, error.message && error.message !== error.code ? error.message : undefined);
  }
  console.error('[api] unexpected error', error);
  return problem(500);
}

/** The JSON body, or a 400/415 problem. An empty body reads as `{}`. */
export async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (text.trim() === '') return {};
  if (!type.toLowerCase().includes('application/json')) {
    throw new ApiProblem(415, TITLES[415]!, 'Send the body as application/json.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiProblem(400, TITLES[400]!, 'The request body is not valid JSON.');
  }
}

interface Options {
  /** Status for a successful response with a body. */
  status?: number;
  /** Tell open tabs to refresh after a successful write. Defaults to true for write routes. */
  notify?: boolean;
}

export function apiRoute<P extends Record<string, string> = Record<string, never>>(
  scope: Scope,
  run: (context: ApiContext<P>) => Promise<unknown>,
  options: Options = {},
) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    const token = parseBearer(request.headers.get('authorization'));
    if (!token) {
      return problem(401, 'Send a personal access token as "Authorization: Bearer fluid_pat_…". Make one in Settings → API.', undefined, {
        'WWW-Authenticate': 'Bearer realm="fluid"',
      });
    }
    const auth = await authenticateApiToken(token);
    if (!auth) {
      return problem(401, 'That token is unknown, revoked or expired.', undefined, {
        'WWW-Authenticate': 'Bearer realm="fluid", error="invalid_token"',
      });
    }
    if (!allows(auth.scopes, scope)) {
      return problem(403, `This token does not have the "${scope}" scope.`, undefined, {
        'WWW-Authenticate': `Bearer realm="fluid", error="insufficient_scope", scope="${scope}"`,
      });
    }

    const limit = await rateLimit(`api:${auth.tokenId}`, RATE_LIMIT_PER_MINUTE, 60);
    const limitHeaders = {
      'RateLimit-Limit': String(limit.limit),
      'RateLimit-Remaining': String(limit.remaining),
      'RateLimit-Reset': String(limit.resetIn),
    };
    if (!limit.ok) {
      return problem(429, `Slow down: at most ${limit.limit} requests a minute per token.`, undefined, {
        ...limitHeaders,
        'Retry-After': String(limit.resetIn),
      });
    }

    try {
      const caller = appRouter.createCaller({ user: auth.user });
      const result = await run({ request, params: await context.params, user: auth.user, caller });
      if (scope === 'write' && (options.notify ?? true)) await notifyBoardChange(auth.user.id);

      if (result instanceof Response) return result;
      const headers = { 'Cache-Control': 'no-store', ...limitHeaders };
      if (result === undefined) return new Response(null, { status: 204, headers });
      return Response.json(result, { status: options.status ?? 200, headers });
    } catch (error) {
      return toProblem(error);
    }
  };
}
