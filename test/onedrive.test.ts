import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { graphPath, OneDrive, OneDriveError, oneDriveFromEnv } from '../src/archive/onedrive.ts';
import { Catalog } from '../src/catalog.ts';
import { startMockOneDrive, type MockOneDrive } from './helpers/mock-onedrive.ts';

const CLIENT = '0a1b2c3d-1111-2222-3333-444455556666';
const MiB = 1024 * 1024;

describe('OneDrive', () => {
  let mock: MockOneDrive;
  before(async () => {
    mock = await startMockOneDrive();
  });
  after(async () => mock.close());
  beforeEach(() => mock.reset());

  function setUp(options: { now?: () => number; clientId?: string } = {}) {
    const state = new Catalog(':memory:');
    const waits: number[] = [];
    let clock = 1_800_000_000_000;
    const drive = new OneDrive({
      clientId: options.clientId ?? CLIENT,
      state,
      loginUrl: mock.loginUrl,
      graphUrl: mock.graphUrl,
      sleep: async (ms) => void waits.push(ms),
      now: options.now ?? (() => clock),
    });
    return { drive, state, waits, advance: (ms: number) => void (clock += ms) };
  }
  /** Signed in already: the sign-in the owner would have done. */
  async function signedIn(options: Parameters<typeof setUp>[0] = {}) {
    const s = setUp(options);
    await s.drive.startLogin();
    mock.approve();
    await s.drive.loginDone();
    return s;
  }

  describe('signing in', () => {
    test('gives the owner a code and an address, waits while they approve, then keeps the refresh token', async () => {
      const { drive, state } = setUp();
      const started = await drive.startLogin();
      assert.deepEqual({ ...started, expiresAt: undefined }, { state: 'pending', userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: undefined });
      assert.equal(drive.connected(), false);
      assert.equal(drive.status().login.state, 'pending');
      mock.approve();
      await drive.loginDone();
      assert.equal(drive.connected(), true);
      assert.equal(drive.status().login.state, 'connected');
      assert.equal(state.getState('onedrive.refresh'), 'refresh-1');
    });

    test('keeps asking while Microsoft says to wait, and slows down when told to', async () => {
      const { drive, waits } = setUp();
      mock.tokenErrors = ['authorization_pending', 'slow_down', 'authorization_pending'];
      await drive.startLogin();
      mock.approve();
      await drive.loginDone();
      assert.equal(drive.connected(), true);
      assert.deepEqual(waits, [1000, 1000, 1000 + 5000, 1000 + 5000]);
    });

    test('says so when the owner declines or the code runs out, and when Microsoft will not start one', async () => {
      const declined = setUp();
      mock.tokenErrors = ['authorization_declined'];
      await declined.drive.startLogin();
      await declined.drive.loginDone();
      assert.deepEqual(declined.drive.status().login, { state: 'failed', error: 'Sign-in did not finish: it was declined.' });
      assert.equal(declined.drive.connected(), false);

      const expired = setUp();
      mock.tokenErrors = ['expired_token'];
      await expired.drive.startLogin();
      await expired.drive.loginDone();
      assert.match(String((expired.drive.status().login as { error?: string }).error), /the code ran out/);

      const refused = setUp({ clientId: '00000000-0000-0000-0000-000000000000' });
      const result = await refused.drive.startLogin();
      assert.equal(result.state, 'failed');
      assert.match((result as { error: string }).error, /not set up for public client flows/);
    });

    test('gives up when the time to approve is over', async () => {
      let clock = 1_800_000_000_000;
      const state = new Catalog(':memory:');
      const drive = new OneDrive({ clientId: CLIENT, state, loginUrl: mock.loginUrl, graphUrl: mock.graphUrl, now: () => clock, sleep: async () => void (clock += 400_000) });
      await drive.startLogin();
      await drive.loginDone();
      assert.match(String((drive.status().login as { error?: string }).error), /the code ran out/);
    });
  });

  describe('tokens', () => {
    test('are reused until they near their end, then renewed, and the newest refresh token is kept', async () => {
      const { drive, state, advance } = await signedIn();
      assert.equal(await drive.accessToken(), 'access-1');
      assert.equal(await drive.accessToken(), 'access-1');
      assert.equal(mock.refreshesUsed, 0);
      advance(3600_000);
      assert.equal(await drive.accessToken(), 'access-2');
      assert.equal(state.getState('onedrive.refresh'), 'refresh-2');
      assert.equal(mock.refreshesUsed, 1);
    });

    test('renewing at the same moment from several places asks Microsoft once', async () => {
      const { drive, advance } = await signedIn();
      advance(3600_000);
      const tokens = await Promise.all([drive.accessToken(), drive.accessToken(), drive.accessToken()]);
      assert.deepEqual(new Set(tokens).size, 1);
      assert.equal(mock.refreshesUsed, 1);
    });

    test('a refresh token Microsoft no longer accepts means signing in again, and says so', async () => {
      const { drive, advance } = await signedIn();
      advance(3600_000);
      mock.revokeRefreshTokens();
      await assert.rejects(
        () => drive.accessToken(),
        (err: unknown) => err instanceof OneDriveError && err.needsLogin && /invalid_grant/.test(err.message) && /Sign in again/.test(err.message),
      );
    });

    test('not being signed in at all is the same: sign in', async () => {
      await assert.rejects(() => setUp().drive.accessToken(), (err: unknown) => err instanceof OneDriveError && err.needsLogin);
    });
  });

  describe('saving files', () => {
    test('a small file goes in one request, to its place in the app folder, replacing one of the same name', async () => {
      const { drive } = await signedIn();
      mock.autoCreateFolders = true;
      await drive.upload('Ishay Ribo/Singles/Derech.mp3', new Blob([Buffer.from('small song')]));
      assert.equal(mock.files.get('Ishay Ribo/Singles/Derech.mp3')?.toString(), 'small song');
      const put = mock.requests.find((r) => r.method === 'PUT')!;
      assert.match(put.path, /special\/approot:\/Ishay%20Ribo\/Singles\/Derech\.mp3:\/content\?@microsoft\.graph\.conflictBehavior=replace$/);
      assert.equal(put.authorized, true);
    });

    test('a large file goes in 10 MiB pieces in order, none of them carrying the token, and arrives whole', async () => {
      const { drive } = await signedIn();
      mock.autoCreateFolders = true;
      const song = Buffer.alloc(22 * MiB + 123);
      for (let i = 0; i < song.length; i += 4096) song[i] = i / 4096;
      await drive.upload('A/B/big.mp3', new Blob([song]));
      assert.ok(mock.files.get('A/B/big.mp3')!.equals(song));
      const chunks = mock.requests.filter((r) => r.range);
      assert.deepEqual(chunks.map((r) => r.range), [`bytes 0-${10 * MiB - 1}/${song.length}`, `bytes ${10 * MiB}-${20 * MiB - 1}/${song.length}`, `bytes ${20 * MiB}-${song.length - 1}/${song.length}`]);
      assert.ok(chunks.every((r) => !r.authorized), 'the upload address is used without the token');
      assert.equal(10 * MiB % 327_680, 0, '10 MiB is a multiple of 320 KiB, as Graph requires');
    });

    test('folders that do not exist yet are made, and the upload tried again', async () => {
      const { drive } = await signedIn();
      await drive.upload('New Artist/New Album/01 Song.mp3', new Blob([Buffer.from('x')]));
      assert.ok(mock.folders.has('New Artist') && mock.folders.has('New Artist/New Album'));
      assert.equal(mock.files.get('New Artist/New Album/01 Song.mp3')?.toString(), 'x');
      // A second song in the same folders needs no folder requests.
      mock.requests.length = 0;
      await drive.upload('New Artist/New Album/02 Song.mp3', new Blob([Buffer.from('y')]));
      assert.ok(!mock.requests.some((r) => r.path.endsWith('/children')));
    });

    test('a large file into a folder that does not exist yet also works', async () => {
      const { drive } = await signedIn();
      const song = Buffer.alloc(11 * MiB, 7);
      await drive.upload('Z/Y/big.mp3', new Blob([song]));
      assert.ok(mock.files.get('Z/Y/big.mp3')!.equals(song));
    });

    test('a request refused for a stale token is made again with a fresh one', async () => {
      const { drive } = await signedIn();
      mock.autoCreateFolders = true;
      mock.expireAccessTokens();
      await drive.upload('A/B/c.mp3', new Blob([Buffer.from('c')]));
      assert.equal(mock.files.get('A/B/c.mp3')?.toString(), 'c');
      assert.equal(mock.refreshesUsed, 1);
    });

    test('being told to slow down is obeyed, and the request made again', async () => {
      const { drive, waits } = await signedIn();
      mock.autoCreateFolders = true;
      mock.throttle = 2;
      await drive.upload('A/B/c.mp3', new Blob([Buffer.from('c')]));
      assert.deepEqual(waits.slice(-2), [3000, 3000]);
      assert.equal(mock.files.get('A/B/c.mp3')?.toString(), 'c');
    });

    test('a piece that fails with a server error is sent again; too many failures in a row give up', async () => {
      const { drive, waits } = await signedIn();
      mock.autoCreateFolders = true;
      const song = Buffer.alloc(11 * MiB, 1);
      mock.failChunks = 2;
      await drive.upload('A/B/retry.mp3', new Blob([song]));
      assert.ok(mock.files.get('A/B/retry.mp3')!.equals(song));
      assert.deepEqual(waits.slice(-2), [1000, 2000], 'it waits longer each time');

      mock.failChunks = 99;
      await assert.rejects(() => drive.upload('A/B/never.mp3', new Blob([song])), (err: unknown) => err instanceof OneDriveError && /HTTP 503/.test(err.message));
      assert.ok(!mock.files.has('A/B/never.mp3'));
    });

    test('knows whether a file is there', async () => {
      const { drive } = await signedIn();
      mock.autoCreateFolders = true;
      assert.equal(await drive.exists('A/B/c.mp3'), false);
      await drive.upload('A/B/c.mp3', new Blob([Buffer.from('c')]));
      assert.equal(await drive.exists('A/B/c.mp3'), true);
    });

    test('names OneDrive refuses are cleaned up', () => {
      assert.equal(graphPath('Artist: The Band/Album? (Live)/01 Why*.mp3'), 'Artist_%20The%20Band/Album_%20(Live)/01%20Why_.mp3');
      assert.equal(graphPath('A/B./C .mp3'), 'A/B/C%20.mp3');
      assert.equal(graphPath('/leading//double/'), 'leading/double');
      assert.equal(graphPath('Ünïcode/שיר.mp3'), 'N%C3%BCn%C3%AFcode/%D7%A9%D7%99%D7%A8.mp3'.replace('N%C3%BC', '%C3%9C'));
    });
  });

  test('is set up from ONEDRIVE_CLIENT_ID, and only when it is a client id', () => {
    const state = new Catalog(':memory:');
    assert.equal(oneDriveFromEnv({}, { state }), undefined);
    for (const word of ['', '  ', 'none', 'None', 'off', 'no', '-']) assert.equal(oneDriveFromEnv({ ONEDRIVE_CLIENT_ID: word }, { state }), undefined, `"${word}" means off`);
    assert.ok(oneDriveFromEnv({ ONEDRIVE_CLIENT_ID: CLIENT }, { state }) instanceof OneDrive);
    assert.throws(() => oneDriveFromEnv({ ONEDRIVE_CLIENT_ID: 'my-secret-value' }, { state }), /Application \(client\) ID/);
  });
});
