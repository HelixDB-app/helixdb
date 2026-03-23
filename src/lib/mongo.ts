import { MongoClient } from "mongodb";
import type { Collection, Db, Document } from "mongodb";

let cachedClient: InstanceType<typeof MongoClient> | null = null;
let cachedDb: Db | null = null;

const DEFAULT_DB = process.env.MONGODB_DB_NAME || "pgstudio";

export async function getMongoDb(): Promise<Db> {
    if (cachedDb && cachedClient) return cachedDb;

    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is not set. Crash reporting requires MongoDB.");
    }

    const client = new MongoClient(uri, {
        maxPoolSize: 5,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 5_000,
        retryWrites: true,
    });

    await client.connect();
    cachedClient = client;
    cachedDb = client.db(DEFAULT_DB);
    return cachedDb;
}

export async function getCollection<T extends Document>(name: string): Promise<Collection<T>> {
    const db = await getMongoDb();
    return db.collection<T>(name);
}
