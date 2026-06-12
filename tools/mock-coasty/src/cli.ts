/** CLI: `pnpm dev:mock` — run the mock Coasty API for offline development. */
import { createMockCoasty } from './index';

const port = Number(process.env.PORT ?? process.env.MOCK_PORT ?? 4010);
const { app } = createMockCoasty({ logger: false, tickMs: 400, defaultRunSteps: 6 });

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => {
    console.log(`mock-coasty listening at http://127.0.0.1:${port}/v1`);
    console.log('Any sk-coasty-test-* / sk-coasty-live-* key works. Nothing here ever bills.');
  })
  .catch((err) => {
    console.error('mock-coasty failed to start:', err);
    process.exit(1);
  });
