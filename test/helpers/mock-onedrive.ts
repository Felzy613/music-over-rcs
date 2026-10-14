import { listen, readBuffer, type Listening } from './servers.ts';

const CHUNK_UNIT = 327_680;

export interface MockOneDrive extends Listening {
  loginUrl: string;
  graphUrl: string;
  /** Files saved in the app folder, by path ("Artist/Album/01 Title.mp3"). */
  files: Map<string, Buffer>;
  folders: Set<string>;
  /** Every request, with whether it carried an Authorization header. */
  requests: Array<{ method: string; path: string; authorized: boolean; range?: string | undefined }>;
  /** The user approves the sign-in on microsoft.com. */
  approve(): void;
  /** Answer the next sign-in polls with these errors before anything else. */
  tokenErrors: string[];
  /** Makes every access token handed out so far stop working (the next Graph request gets 401). */
  expireAccessTokens(): void;
  /** Refuse refresh tokens with invalid_grant. */
  revokeRefreshTokens(): void;
  /** Make folders on the way automatically, as OneDrive does for some uploads. Off: a missing folder is a 404. */
  autoCreateFolders: boolean;
  /** Answer the next N upload-chunk requests with 503. */
  failChunks: number;
  /** Answer the next N Graph requests with 429 and Retry-After. */
  throttle: number;
  tokensIssued: number;
  refreshesUsed: number;
  reset(): void;
}

/** A stand-in for Microsoft's sign-in and OneDrive (Graph) as far as the bot uses them. */
export async function startMockOneDrive(): Promise<MockOneDrive> {
  let approved = false;
  let validAccess = new Set<string>();
  let refreshRevoked = false;
  let validRefresh = new Set<string>();
  const uploads = new Map<string, { path: string; received: number; total: number | undefined }>();
  const state = {
    files: new Map<string, Buffer>(),
    folders: new Set<string>(),
    requests: [] as MockOneDrive['requests'],
    tokenErrors: [] as string[],
    autoCreateFolders: false,
    failChunks: 0,
    throttle: 0,
    tokensIssued: 0,
    refreshesUsed: 0,
  };

  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const authorized = typeof req.headers.authorization === 'string';
    state.requests.push({ method: req.method ?? '', path: url.pathname + url.search, authorized, range: req.headers['content-range'] as string | undefined });
    const body = await readBuffer(req);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };

    // --- sign-in ---
    if (url.pathname === '/login/devicecode') {
      const form = new URLSearchParams(body.toString('utf8'));
      if (!form.get('client_id')) return json(400, { error: 'invalid_request', error_description: 'client_id is required\r\nTrace ID: x' });
      if (form.get('client_id') === '00000000-0000-0000-0000-000000000000') return json(400, { error: 'unauthorized_client', error_description: 'The application is not set up for public client flows\r\nTrace ID: x' });
      return json(200, { device_code: 'device-123', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 });
    }
    if (url.pathname === '/login/token') {
      const form = new URLSearchParams(body.toString('utf8'));
      const issue = () => {
        state.tokensIssued += 1;
        const access = `access-${state.tokensIssued}`;
        const refresh = `refresh-${state.tokensIssued}`;
        validAccess.add(access);
        validRefresh.add(refresh);
        return { token_type: 'Bearer', expires_in: 3600, access_token: access, refresh_token: refresh, scope: form.get('scope') ?? '' };
      };
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        const error = state.tokenErrors.shift();
        if (error) return json(400, { error });
        if (!approved) return json(400, { error: 'authorization_pending' });
        return json(200, issue());
      }
      if (form.get('grant_type') === 'refresh_token') {
        state.refreshesUsed += 1;
        if (refreshRevoked || !validRefresh.has(form.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant', error_description: 'The refresh token has expired' });
        return json(200, issue());
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    // --- uploading to an address a session gave out (no Authorization allowed on these) ---
    const upload = /^\/upload\/(\w+)$/.exec(url.pathname);
    if (upload) {
      const session = uploads.get(upload[1]!);
      if (!session) return json(404, { error: { code: 'itemNotFound' } });
      if (req.method === 'GET') return json(200, { nextExpectedRanges: [`${session.received}-`] });
      if (authorized) return json(401, { error: { code: 'unauthenticated', message: 'Authorization must not be sent to an upload address' } });
      if (state.failChunks > 0) {
        state.failChunks -= 1;
        return json(503, { error: { code: 'serviceNotAvailable' } });
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range']));
      if (!range) return json(400, { error: { code: 'invalidRange' } });
      const [start, end, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
      if (start < session.received) return json(416, { error: { code: 'invalidRange' } });
      if (start !== session.received) return json(416, { error: { code: 'invalidRange', message: 'out of order' } });
      const last = end + 1 === total;
      if (!last && (end + 1 - start) % CHUNK_UNIT !== 0) return json(400, { error: { code: 'invalidRange', message: 'chunk size must be a multiple of 320 KiB' } });
      if (body.length !== end + 1 - start) return json(400, { error: { code: 'invalidRange', message: 'body does not match range' } });
      const so_far = state.files.get(`~partial/${upload[1]}`) ?? Buffer.alloc(0);
      const joined = Buffer.concat([so_far, body]);
      session.received = end + 1;
      session.total = total;
      if (!last) {
        state.files.set(`~partial/${upload[1]}`, joined);
        return json(202, { expirationDateTime: '2099-01-01T00:00:00Z', nextExpectedRanges: [`${end + 1}-`] });
      }
      state.files.delete(`~partial/${upload[1]}`);
      state.files.set(session.path, joined);
      return json(201, { id: 'item', name: session.path.split('/').pop(), size: joined.length });
    }

    // --- Graph ---
    if (url.pathname.startsWith('/graph/')) {
      if (state.throttle > 0) {
        state.throttle -= 1;
        return json(429, { error: { code: 'activityLimitReached' } }, { 'retry-after': '3' });
      }
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization))?.[1];
      if (!bearer || !validAccess.has(bearer)) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired' } });
      // Graph accepts "approot:/A/B/c.mp3" and, before an action, "approot:/A/B/c.mp3:/content".
      let path: string;
      let action: string | undefined;
      let found = /^\/graph\/me\/drive\/special\/approot:\/(.+):(\/content|\/createUploadSession|\/children)$/.exec(url.pathname);
      if (found) {
        path = found[1]!.split('/').map(decodeURIComponent).join('/');
        action = found[2];
      } else if ((found = /^\/graph\/me\/drive\/special\/approot:\/(.+)$/.exec(url.pathname))) {
        path = found[1]!.split('/').map(decodeURIComponent).join('/');
      } else if (url.pathname === '/graph/me/drive/special/approot/children') {
        path = '';
        action = '/children';
      } else if (url.pathname === '/graph/me/drive/special/approot') {
        path = '';
      } else {
        return json(404, { error: { code: 'itemNotFound' } });
      }
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const parentExists = parent === '' || state.folders.has(parent);
      const makeParents = () => {
        const parts = parent.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) state.folders.add(parts.slice(0, i).join('/'));
      };

      if (action === '/children' && req.method === 'POST') {
        const made = JSON.parse(body.toString('utf8') || '{}') as { name?: string };
        const full = path ? `${path}/${made.name}` : String(made.name);
        if (path && !state.folders.has(path)) return json(404, { error: { code: 'itemNotFound' } });
        if (state.folders.has(full)) return json(409, { error: { code: 'nameAlreadyExists' } });
        state.folders.add(full);
        return json(201, { name: made.name, folder: {} });
      }
      if (action === '/content' && req.method === 'PUT') {
        if (!parentExists) {
          if (!state.autoCreateFolders) return json(404, { error: { code: 'itemNotFound' } });
          makeParents();
        }
        state.files.set(path, body);
        return json(201, { name: path.split('/').pop(), size: body.length });
      }
      if (action === '/createUploadSession' && req.method === 'POST') {
        if (!parentExists) {
          if (!state.autoCreateFolders) return json(404, { error: { code: 'itemNotFound' } });
          makeParents();
        }
        const id = String(uploads.size + 1);
        uploads.set(id, { path, received: 0, total: undefined });
        return json(200, { uploadUrl: `${server.url}/upload/${id}`, expirationDateTime: '2099-01-01T00:00:00Z' });
      }
      if (!action && req.method === 'GET') return state.files.has(path) ? json(200, { name: path.split('/').pop() }) : json(404, { error: { code: 'itemNotFound' } });
    }
    json(404, { error: { code: 'itemNotFound' } });
  });

  const mock: MockOneDrive = {
    ...server,
    loginUrl: `${server.url}/login`,
    graphUrl: `${server.url}/graph`,
    files: state.files,
    folders: state.folders,
    requests: state.requests,
    approve: () => void (approved = true),
    expireAccessTokens: () => void (validAccess = new Set()),
    revokeRefreshTokens: () => void (refreshRevoked = true),
    get tokenErrors() {
      return state.tokenErrors;
    },
    set tokenErrors(value) {
      state.tokenErrors = value;
    },
    get autoCreateFolders() {
      return state.autoCreateFolders;
    },
    set autoCreateFolders(value) {
      state.autoCreateFolders = value;
    },
    get failChunks() {
      return state.failChunks;
    },
    set failChunks(value) {
      state.failChunks = value;
    },
    get throttle() {
      return state.throttle;
    },
    set throttle(value) {
      state.throttle = value;
    },
    get tokensIssued() {
      return state.tokensIssued;
    },
    get refreshesUsed() {
      return state.refreshesUsed;
    },
    reset() {
      approved = false;
      validAccess = new Set();
      validRefresh = new Set();
      refreshRevoked = false;
      uploads.clear();
      state.files.clear();
      state.folders.clear();
      state.requests.length = 0;
      state.tokenErrors = [];
      state.autoCreateFolders = false;
      state.failChunks = 0;
      state.throttle = 0;
      state.tokensIssued = 0;
      state.refreshesUsed = 0;
    },
  };
  return mock;
}
