import dotenv from "dotenv";
dotenv.config();
import redis from '../config/redis'
const args = require('args-parser')(process.argv);
import { ragSyncJob } from './data_source';
import { delay } from "../utility";

const JOBS = new Map<string, Function>();
JOBS.set('rag-sync', ragSyncJob);

const jobName = args?.job;

for(const job of jobName.split(',')) {
    const jobFunc = JOBS.get(job);
    if (jobFunc) {
        jobFunc();
    }
}



process.on("SIGTERM", async () => {
    console.log("SIGTERM signal received.");
    await delay(5000);
    process.exit(0);
});