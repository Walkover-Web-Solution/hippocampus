import dotenv from "dotenv";
dotenv.config();
const args = require('args-parser')(process.argv);
import { Connection, Channel } from "amqplib";
import logger from "../service/logger";
import rabbitmq from "../config/rabbitmq";
import rag from './rag';
import { mongoStoreConsumer, qdrantUSAStoreConsumer } from "./storage";
import { connectDB } from "../models";
import { delay } from "../utility";
connectDB();
const CONSUMERS: IConsumer[] = [];
console.log(args, "args");
switch (args?.consumer) {
  case "rag":
    CONSUMERS.push(rag);
    break;
  case "storage":
    CONSUMERS.push(mongoStoreConsumer);
    CONSUMERS.push(qdrantUSAStoreConsumer);
    break;
  default:
    break;
}

export interface IConsumer {
  queue: string,
  processor: Function,
  clean?: Function,
  batch: number
};

class Consumer {
  private connection?: Connection;
  private channel?: Channel;
  private queue: string;
  private processor: Function;
  private clean?: Function;
  private bufferSize: number = 1;
  private rabbitService;
  private shutdown = false;
  constructor(obj: IConsumer, connectionString?: string) {
    this.queue = obj.queue;
    this.processor = obj.processor;
    this.bufferSize = obj.batch;
    this.clean = obj.clean;
    this.rabbitService = rabbitmq(connectionString);
    // Setup the consumer
    this.rabbitService.on("connect", async (connection: Connection) => {
      this.connection = connection;
      this.channel = await this.connection?.createChannel();
      this.channel?.prefetch(this.bufferSize);
      this.channel?.assertQueue(this.queue, { durable: true });
      this.start();
    });
    // Stop the consumer if an error occurs
    this.rabbitService.on('error', (error: any) => {
      logger.error(error);
      this.stop();
    });
  }
  private start() {
    this.channel?.consume(this.queue, async (message: any) => {
      if (this.shutdown) {
        console.log("This consumer is shutting down, no longer processing messages");
        return;
      }
      try {
        await this.processor(message, this.channel);
      } catch (error) {
        logger.error(error);
        throw error;
      }
    }, { noAck: false });
    // Stop the consumer if an error occurs
    this.channel?.on('error', (error: any) => {
      this.stop();
      logger.error(error);
    });
  }
  public stop() {
    this.shutdown = true;
    this.clean?.();
  }
  public async queueStatus() {
    let status = { messageCount: 0, consumerCount: 0 };
    if (this.channel) {
      const queue = await this.channel.assertQueue(this.queue, { durable: true }).catch(error => { return { messageCount: 0, consumerCount: 0 } });
      status = queue;
    }
    return status;
  }
}

const consumers = CONSUMERS.map(consumer => new Consumer(consumer));

process.on('SIGINT', async () => {
  consumers.forEach(consumer => consumer.stop());
  await delay(10000);
});

process.on('SIGTERM', async () => {
  consumers.forEach(consumer => consumer.stop());
  await delay(10000);
});
