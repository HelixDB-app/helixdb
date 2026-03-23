type MongoModule = typeof import("mongodb");

// Cached connection across hot reloads
let cachedClient: any = null;
let cachedDb: any = null;
let mongoModulePromise: Promise<MongoModule> | null = null;

const DEFAULT_DB = process.env.MONGODB_DB_NAME || "pgstudio";

async function loadMongo(): Promise<MongoModule> {
    if (!mongoModulePromise) {
        mongoModulePromise = import("mongodb").catch(() => import("next/dist/compiled/mongodb"));
    }
    return mongoModulePromise;
}

export async function getMongoDb(): Promise<any> {
    if (cachedDb && cachedClient) return cachedDb;

    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is not set. Crash reporting requires MongoDB.");
    }

    const { MongoClient } = await loadMongo();
    const client = new MongoClient(uri, {
        maxPoolSize: 5,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 5_000,
        retryWrites: true,
    });

    await client.connect();
    cachedClient = client;
    cachedDb = client.db(DEFAULT_DB);
    return cachedDb!;
}

export async function getCollection<T>(name: string): Promise<any> {
    const db = await getMongoDb();
    return db.collection(name) as any;
}
