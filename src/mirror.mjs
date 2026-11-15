// Optional MongoDB Atlas mirror of the call logs. The JSONL files stay the source of truth for
// curation; this copy is fire-and-forget so a slow or down database never blocks or breaks a call.
// Enabled only when MONGODB_URI is set. Collections: observations, sessions (latest summary per
// call), consent.

async function defaultConnect(uri) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, appName: 'genesis' });
  await client.connect();
  return client;
}

/**
 * @param {object} [o]
 * @param {string} [o.uri]
 * @param {string} [o.dbName]
 * @param {(uri: string) => Promise<{ db: (name: string) => any, close: () => Promise<void> }>} [o.connect]  injectable for tests
 * @param {(msg: string) => void} [o.warn]
 */
export function createMirror({
  uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || 'genesis', connect = defaultConnect, warn = console.warn,
} = {}) {
  if (!uri) return { enabled: false, record() {}, flush: async () => {}, close: async () => {} };

  let clientPromise = null;
  let queue = Promise.resolve();
  let lastWarn = 0;
  const getDb = () => {
    clientPromise ??= connect(uri).catch((err) => { clientPromise = null; throw err; }); // retry on the next write
    return clientPromise.then((c) => c.db(dbName));
  };

  async function write(kind, rec) {
    const db = await getDb();
    if (kind === 'observations') {
      // obs_id as _id: a retried write can't create a duplicate.
      await db.collection('observations').updateOne({ _id: rec.obs_id }, { $setOnInsert: { ...rec, _id: rec.obs_id } }, { upsert: true });
    } else if (kind === 'sessions') {
      // Curation uses the last summary per call; keep only that one.
      await db.collection('sessions').replaceOne({ _id: rec.session_id }, { ...rec, _id: rec.session_id }, { upsert: true });
    } else if (kind === 'consent') {
      await db.collection('consent').insertOne({ ...rec });
    } else {
      throw new Error(`unknown collection ${kind}`);
    }
  }

  return {
    enabled: true,
    /** Queue a write. Never throws; failures are logged at most once a minute. */
    record(kind, rec) {
      queue = queue.then(() => write(kind, rec)).catch((err) => {
        if (Date.now() - lastWarn > 60_000) { lastWarn = Date.now(); warn(`MongoDB mirror write failed (JSONL still has it): ${err.message}`); }
      });
    },
    /** Resolves when every queued write has finished (or failed). */
    flush: () => queue,
    async close() {
      await queue;
      if (clientPromise) await (await clientPromise.catch(() => null))?.close();
      clientPromise = null;
    },
  };
}

/** Process-wide mirror used by the tool handlers. */
export const defaultMirror = createMirror();
