import '../src/load-env.ts';
import { checkCloud } from '../src/cloud/check.ts';

// Looks at the Cloudflare Worker and the Render host from the outside and says what is right and what to do about what isn't.
//   EDGE_TOKEN=… ADMIN_TOKEN=… npm run cloud:check -- --worker https://mors-edge.<you>.workers.dev --render https://<name>.onrender.com [--alert]
// The tokens come from the environment (not the command line, where they would stay in your shell history).
const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const results = await checkCloud({
  worker: value('--worker') ?? process.env.WORKER_URL,
  render: value('--render') ?? process.env.RENDER_URL,
  edgeToken: process.env.EDGE_TOKEN,
  adminToken: process.env.ADMIN_TOKEN,
  sendTestAlert: args.includes('--alert'),
});
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`);
  if (r.fix) console.log(`    → ${r.fix}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nAll good.' : `\n${failed} thing${failed === 1 ? '' : 's'} to fix.`);
process.exit(failed === 0 ? 0 : 1);
