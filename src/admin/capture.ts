import { tapConsole } from './log-ring.ts';

// Imported first by the entry points: from here on everything the process logs is also kept (masked) in the admin console's
// bounded in-memory log, so the console can show recent activity. Importing it twice does nothing the second time.
tapConsole();
