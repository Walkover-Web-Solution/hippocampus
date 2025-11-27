import { MongoClient } from 'mongodb';
import logger from '../service/logger';
import EventEmitter from 'events';
import { delay } from '../utility';
import env from './env';

const RETRY_INTERVAL = 5000; // in millis
const MONGO_CONNECTION_STRING = env.MONGO_URI;

class MongoService extends EventEmitter {
    private static instance: MongoService;
    private gracefulClose: boolean = false;
    private connectionString: string;
    private connection?: MongoClient;

    constructor(connectionString: string) {
        super();
        if (!connectionString) throw new Error("connectionString is required");
        this.connectionString = connectionString;
        this.setupConnection();
    }

    public static getSingletonInstance(connectionString: string): MongoService {
        return MongoService.instance ||= new MongoService(connectionString);
    }

    private async setupConnection(): Promise<MongoClient> {
        try {
            this.gracefulClose = false;
            const client = new MongoClient(this.connectionString);
            this.connection = await client.connect();
            this.initEventListeners();
            return this.connection;
        } catch (err) {
            logger.error('[MONGO](setupConnection)', err)
            this.emit("retry");
            await delay(RETRY_INTERVAL);
            return this.setupConnection();
        }
    }

    private initEventListeners() {
        if (!this.connection) return;
        logger.info(`[MONGO](onConnectionReady) Connection established to ${this.connectionString}`);
        this.emit("connect", this.connection);

        this.connection.on("serverClosed", (error) => {
            this.connection = undefined;

            if (this.gracefulClose) {
                logger.info('[MONGO](onConnectionClosed) Gracefully');
                this.emit("gracefulClose");
            } else {
                logger.error('[MONGO](onConnectionClosed) Abruptly', error);
                this.emit("error", error);
            }

            if (!this.gracefulClose) this.setupConnection();
        })
    }

    public closeConnection() {
        if (this.connection) {
            this.gracefulClose = true;
            logger.info('[MONGO](closeConnection) Closing connection...');
            this.connection.close();
        }
    }
}

export default (connectionString: string = MONGO_CONNECTION_STRING): MongoService => {
    return MongoService.getSingletonInstance(connectionString);
}