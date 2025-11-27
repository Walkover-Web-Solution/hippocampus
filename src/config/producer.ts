import rabbitmqService, { Connection, Channel } from './rabbitmq';
import logger from "../service/logger";

let rabbitConnection: Connection;
let rabbitChannel: Channel;

class RabbitMqProducer {
    private static instance: RabbitMqProducer;

    constructor() {
        logger.info(`[PRODUCER] Listening for connection...`);
        // console.log(rabbitmqService());
        rabbitmqService().on("connect", async (connection) => {
            logger.info(`[PRODUCER] Connection received...`);
            rabbitConnection = connection;
            logger.info(`[PRODUCER] Creating channel...`);
            rabbitChannel = await rabbitConnection.createChannel();
        });
    }

    public static getSingletonInstance(): RabbitMqProducer {
        return RabbitMqProducer.instance ||= new RabbitMqProducer();
    }
    public async publish(exchange: string, content: any, routingKey: string = "default") {
        try {
            content = (typeof content === 'string') ? content : JSON.stringify(content);
            const payloadBuffer: Buffer = Buffer.from(content);
            rabbitChannel.publish(exchange, routingKey, payloadBuffer);
        } catch (error: any) {
            console.error('[RabbitMqProducer] publish', error);
            throw error;
        }
    }
    public async publishToQueue(queueName: string, payload: any) {
        try {
            logger.info(`[PRODUCER] Preparing payload...`);
            payload = (typeof payload === 'string') ? payload : JSON.stringify(payload);
            const payloadBuffer: Buffer = Buffer.from(payload);
            logger.info(`[PRODUCER] Asserting '${queueName}' queue...`);
            await rabbitChannel.assertQueue(queueName, { durable: true });
            logger.info(`[PRODUCER] Producing to '${queueName}' queue...`);
            rabbitChannel.sendToQueue(queueName, payloadBuffer);
        } catch (error: any) {
            console.error('[RabbitMqProducer] publishToQueue', error);
            throw error;
        }
    }
}

export default RabbitMqProducer.getSingletonInstance();
